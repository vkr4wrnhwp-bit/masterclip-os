import { findCurve, metricValue } from './analyze.js'
import { median, percentile } from './spectrum.js'
import type { MixCurve, MixMetric } from './types.js'

/**
 * Mix Doctor.
 *
 * Reads the analysis and returns *timestamped potential issues*. Three rules
 * are load-bearing and are enforced by the shapes in this file rather than by
 * how carefully anyone writes copy:
 *
 *   1. **Every issue is potential.** `headline` is generated from a fixed
 *      template per issue type, and every template is hedged. There is no code
 *      path that produces "your mix is wrong".
 *   2. **Every issue carries its evidence.** `evidence` holds the measurements
 *      that triggered it, so an engineer who disagrees can see exactly what the
 *      detector saw and dismiss it on the facts.
 *   3. **Detection is relative to the record itself.** Thresholds are the
 *      record's own median and percentiles, not absolute targets, so a
 *      deliberately dark or deliberately bright mix is not flagged for being
 *      what it is. Only the moments that stand out *within* the record are.
 */

export const MIX_ISSUE_TYPES = [
  'clipping',
  'phase_concern',
  'vocal_masking',
  'vocal_level_change',
  'kick_bass_collision',
  'upper_mid_harshness',
  'sibilance',
  'low_end_buildup',
  'midrange_congestion',
  'level_drop',
  'stereo_imbalance',
  'insufficient_headroom',
  'dc_offset',
] as const

export type MixIssueType = (typeof MIX_ISSUE_TYPES)[number]

export type MixIssueSeverity = 'low' | 'moderate' | 'high'

export interface MixDoctorIssue {
  issueType: MixIssueType
  severity: MixIssueSeverity
  /** 0–1. Inherited from the weakest measurement the detector relied on. */
  confidence: number
  startMs: number
  endMs: number
  headline: string
  detail: string
  whyItMatters: string
  suggestedAction: string
  evidence: Record<string, number | string | null>
}

export interface MixDoctorInput {
  metrics: MixMetric[]
  curves: MixCurve[]
  durationMs: number
}

/** Never return more than this many issues: a wall of findings is not a diagnosis. */
const MAX_ISSUES = 14
/** Per type, so one noisy detector cannot crowd out the rest. */
const MAX_PER_TYPE = 3

export function runMixDoctor(input: MixDoctorInput): MixDoctorIssue[] {
  const issues: MixDoctorIssue[] = [
    ...detectClipping(input),
    ...detectPhase(input),
    ...detectVocalMasking(input),
    ...detectVocalLevelChange(input),
    ...detectKickBassCollision(input),
    ...detectHarshness(input),
    ...detectSibilance(input),
    ...detectLowEndBuildup(input),
    ...detectMidrangeCongestion(input),
    ...detectLevelDrop(input),
    ...detectWholeRecordConditions(input),
  ]

  const perType = new Map<MixIssueType, number>()
  const kept: MixDoctorIssue[] = []
  // Strongest first while trimming, then chronological for display: an engineer
  // works down the timeline, but the trim must keep the findings that matter.
  for (const issue of [...issues].sort((a, b) => severityRank(b) - severityRank(a) || b.confidence - a.confidence)) {
    const seen = perType.get(issue.issueType) ?? 0
    if (seen >= MAX_PER_TYPE) continue
    perType.set(issue.issueType, seen + 1)
    kept.push(issue)
    if (kept.length >= MAX_ISSUES) break
  }
  return kept.sort((a, b) => a.startMs - b.startMs)
}

function severityRank(issue: MixDoctorIssue): number {
  return issue.severity === 'high' ? 3 : issue.severity === 'moderate' ? 2 : 1
}

// ---------------------------------------------------------------------------
// region finding
// ---------------------------------------------------------------------------

interface Region {
  startIndex: number
  endIndex: number
  peak: number
}

/**
 * Contiguous runs above a threshold, merged across single-bucket dropouts.
 *
 * Merging matters: a 4-second harsh passage measured in 500 ms buckets will dip
 * below the threshold once or twice, and reporting it as three separate issues
 * at 1:03, 1:04 and 1:06 is noise dressed as precision.
 */
function findRegions(points: Array<number | null>, threshold: number, minBuckets: number): Region[] {
  const regions: Region[] = []
  let start = -1
  let peak = -Infinity
  let gap = 0

  for (let i = 0; i < points.length; i++) {
    const value = points[i]
    const above = value !== null && value >= threshold
    if (above) {
      if (start < 0) start = i
      peak = Math.max(peak, value)
      gap = 0
    } else if (start >= 0) {
      gap++
      if (gap > 1) {
        const end = i - gap
        if (end - start + 1 >= minBuckets) regions.push({ startIndex: start, endIndex: end, peak })
        start = -1
        peak = -Infinity
        gap = 0
      }
    }
  }
  if (start >= 0 && points.length - gap - start >= minBuckets) {
    regions.push({ startIndex: start, endIndex: points.length - 1 - gap, peak })
  }
  return regions
}

function measured(points: Array<number | null>): number[] {
  return points.filter((value): value is number => value !== null && Number.isFinite(value))
}

function toMs(index: number, stepMs: number): number {
  return Math.round(index * stepMs)
}

/** The strongest few regions, so one detector reports moments rather than a list. */
function topRegions(regions: Region[], limit: number): Region[] {
  return [...regions].sort((a, b) => b.peak - a.peak).slice(0, limit)
}

function severityFrom(ratio: number): MixIssueSeverity {
  if (ratio >= 2) return 'high'
  if (ratio >= 1.4) return 'moderate'
  return 'low'
}

function clockOf(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// detectors
// ---------------------------------------------------------------------------

function detectClipping(input: MixDoctorInput): MixDoctorIssue[] {
  const curve = findCurve(input.curves, 'clipping_runs')
  if (!curve) return []
  const regions = findRegions(curve.points, 1, 1)
  return topRegions(regions, MAX_PER_TYPE).map((region) => ({
    issueType: 'clipping' as const,
    // Clipping is one of the few things this module can state rather than
    // suspect: samples pinned at full scale are a measurement, not an inference.
    severity: region.peak >= 8 ? ('high' as const) : ('moderate' as const),
    confidence: 0.95,
    startMs: toMs(region.startIndex, curve.stepMs),
    endMs: toMs(region.endIndex + 1, curve.stepMs),
    headline: 'Detected clipping',
    detail: `${region.peak} run${region.peak === 1 ? '' : 's'} of consecutive samples at full scale around ${clockOf(toMs(region.startIndex, curve.stepMs))}.`,
    whyItMatters: 'Samples pinned at full scale distort further on lossy encoding, so a streaming listener hears more of it than you do here.',
    suggestedAction: 'Consider lowering the level into whatever is limiting, or checking whether this passage was already clipped before it reached the master bus.',
    evidence: { clippingRuns: region.peak },
  }))
}

function detectPhase(input: MixDoctorInput): MixDoctorIssue[] {
  const curve = findCurve(input.curves, 'phase_correlation')
  if (!curve) return []
  // Inverted so findRegions can look for excursions above a threshold.
  const inverted = curve.points.map((value) => (value === null ? null : -value))
  const regions = findRegions(inverted, 0.15, 4)
  return topRegions(regions, MAX_PER_TYPE).map((region) => {
    const worst = -region.peak
    return {
      issueType: 'phase_concern' as const,
      severity: worst <= -0.5 ? ('high' as const) : worst <= -0.3 ? ('moderate' as const) : ('low' as const),
      confidence: 0.7,
      startMs: toMs(region.startIndex, curve.stepMs),
      endMs: toMs(region.endIndex + 1, curve.stepMs),
      headline: 'Possible phase concern',
      detail: `Channel correlation sits around ${worst.toFixed(2)} for about ${(((region.endIndex - region.startIndex + 1) * curve.stepMs) / 1000).toFixed(1)} s here.`,
      whyItMatters: 'Sustained negative correlation means the two channels partly cancel when the mix is summed to mono — which is what a phone speaker, a club sub and many broadcast paths do.',
      suggestedAction: 'Consider checking this passage in mono. A wide synth or a doubled guitar is the usual source, and narrowing it below ~200 Hz often recovers the level without losing the width.',
      evidence: { worstCorrelation: Math.round(worst * 100) / 100 },
    }
  })
}

function detectVocalMasking(input: MixDoctorInput): MixDoctorIssue[] {
  const vocal = findCurve(input.curves, 'vocal_band_share')
  const mid = findCurve(input.curves, 'midrange_share')
  if (!vocal || !mid) return []
  const vocalValues = measured(vocal.points)
  if (vocalValues.length < 8) return []

  const vocalBaseline = median(vocalValues)
  const confidence = metricValue(input.metrics, 'vocal_presence_index') === null ? 0.3 : 0.45

  // The shape being looked for is specific: the vocal band's *share* drops
  // below the record's own baseline while the surrounding midrange holds up.
  // A quiet passage where everything drops together is an arrangement, not
  // masking, and this misses it on purpose.
  const pressure: Array<number | null> = vocal.points.map((value, index) => {
    const around = mid.points[index]
    if (value === null || around === null || around === undefined) return null
    const deficit = (vocalBaseline - value) / Math.max(1e-6, vocalBaseline)
    return deficit > 0 && around >= median(measured(mid.points)) ? deficit : 0
  })

  return topRegions(findRegions(pressure, 0.18, 3), MAX_PER_TYPE).map((region) => ({
    issueType: 'vocal_masking' as const,
    severity: severityFrom(region.peak / 0.18),
    confidence,
    startMs: toMs(region.startIndex, vocal.stepMs),
    endMs: toMs(region.endIndex + 1, vocal.stepMs),
    headline: 'Possible vocal masking',
    detail: `The vocal band gives up about ${Math.round(region.peak * 100)}% of its usual share of the mix here while the rest of the midrange holds.`,
    whyItMatters: 'When the accompaniment occupies the same band as the voice at the same moment, the vocal reads as further away even though its fader has not moved.',
    suggestedAction: 'Worth listening to this section soloed against the vocal. A narrow cut in the accompaniment, or automation on the vocal, are the two usual routes.',
    evidence: {
      vocalShareBaseline: Math.round(vocalBaseline * 1000) / 1000,
      deficitAtWorst: Math.round(region.peak * 100) / 100,
      basis: 'full-mix spectral proxy unless an isolated vocal was supplied',
    },
  }))
}

function detectVocalLevelChange(input: MixDoctorInput): MixDoctorIssue[] {
  const curve = findCurve(input.curves, 'vocal_band_share')
  if (!curve) return []
  const values = measured(curve.points)
  if (values.length < 16) return []
  const baseline = median(values)
  if (baseline <= 0) return []

  // A step, not a slope: compare each 4-bucket window with the one before it.
  const window = 4
  const steps: Array<number | null> = curve.points.map((_, index) => {
    if (index < window * 2) return null
    const before = measured(curve.points.slice(index - window * 2, index - window))
    const after = measured(curve.points.slice(index - window, index))
    if (before.length < window / 2 || after.length < window / 2) return null
    const beforeMean = before.reduce((a, b) => a + b, 0) / before.length
    const afterMean = after.reduce((a, b) => a + b, 0) / after.length
    return Math.abs(afterMean - beforeMean) / Math.max(1e-6, baseline)
  })

  return topRegions(findRegions(steps, 0.3, 1), MAX_PER_TYPE).map((region) => ({
    issueType: 'vocal_level_change' as const,
    severity: severityFrom(region.peak / 0.3),
    confidence: 0.4,
    startMs: toMs(region.startIndex, curve.stepMs),
    endMs: toMs(region.endIndex + 1, curve.stepMs),
    headline: 'Detected vocal level change',
    detail: `The estimated vocal band level shifts by about ${Math.round(region.peak * 100)}% relative to the record's baseline around here.`,
    whyItMatters: 'A step in vocal level between sections is sometimes intended and sometimes a punch-in that never got matched. Only you know which this is.',
    suggestedAction: 'Consider A/Bing the two sides of this moment. If it was intended, mark it resolved and it will not be raised again.',
    evidence: { relativeStep: Math.round(region.peak * 100) / 100, basis: 'full-mix spectral proxy unless an isolated vocal was supplied' },
  }))
}

function detectKickBassCollision(input: MixDoctorInput): MixDoctorIssue[] {
  const kick = findCurve(input.curves, 'band_kick')
  const bass = findCurve(input.curves, 'band_bass')
  if (!kick || !bass) return []
  const kickValues = measured(kick.points)
  const bassValues = measured(bass.points)
  if (kickValues.length < 8 || bassValues.length < 8) return []

  const kickHigh = percentile(kickValues, 75)
  const bassHigh = percentile(bassValues, 75)

  // Both bands loud at once, in dB, is the measurable part of "the kick and the
  // bass are fighting". Whether that is a problem depends on the record, which
  // is why the copy asks rather than tells.
  const together: Array<number | null> = kick.points.map((value, index) => {
    const other = bass.points[index]
    if (value === null || other === null || other === undefined) return null
    const kickExcess = value - kickHigh
    const bassExcess = other - bassHigh
    return kickExcess > 0 && bassExcess > 0 ? Math.min(kickExcess, bassExcess) : 0
  })

  return topRegions(findRegions(together, 1.5, 2), MAX_PER_TYPE).map((region) => ({
    issueType: 'kick_bass_collision' as const,
    severity: severityFrom(region.peak / 1.5),
    confidence: 0.45,
    startMs: toMs(region.startIndex, kick.stepMs),
    endMs: toMs(region.endIndex + 1, kick.stepMs),
    headline: 'Possible kick and bass collision',
    detail: `Both 40–100 Hz and 80–250 Hz sit around ${region.peak.toFixed(1)} dB above their own busy-passage level at the same time here.`,
    whyItMatters: 'Two sources competing for the same octave usually costs the low end its definition on small speakers before it costs it anything on monitors.',
    suggestedAction: 'Worth checking whether the kick and the bass are sharing a fundamental here. Sidechaining, or moving one of them by a few Hz, are the common answers.',
    evidence: { simultaneousExcessDb: Math.round(region.peak * 10) / 10 },
  }))
}

function detectHarshness(input: MixDoctorInput): MixDoctorIssue[] {
  const curve = findCurve(input.curves, 'presence_share')
  if (!curve) return []
  const values = measured(curve.points)
  if (values.length < 8) return []
  const baseline = median(values)
  const excess: Array<number | null> = curve.points.map((value) => (value === null ? null : Math.max(0, (value - baseline) / Math.max(1e-6, baseline))))

  return topRegions(findRegions(excess, 0.45, 3), MAX_PER_TYPE).map((region) => ({
    issueType: 'upper_mid_harshness' as const,
    severity: severityFrom(region.peak / 0.45),
    confidence: 0.45,
    startMs: toMs(region.startIndex, curve.stepMs),
    endMs: toMs(region.endIndex + 1, curve.stepMs),
    headline: 'Detected upper-mid concentration',
    detail: `2–5 kHz runs about ${Math.round(region.peak * 100)}% above this record's own average for roughly ${(((region.endIndex - region.startIndex + 1) * curve.stepMs) / 1000).toFixed(1)} s.`,
    whyItMatters: 'This is the region ears fatigue in first, and consumer playback tends to emphasise it further. Sustained energy here is a different thing from a bright snare.',
    suggestedAction: 'Consider listening at a low level for this passage — upper-mid build-up is much more obvious quietly than loud.',
    evidence: { excessAboveOwnBaseline: Math.round(region.peak * 100) / 100, band: '2000–5000 Hz' },
  }))
}

function detectSibilance(input: MixDoctorInput): MixDoctorIssue[] {
  const curve = findCurve(input.curves, 'sibilance_share')
  if (!curve) return []
  const values = measured(curve.points)
  if (values.length < 8) return []
  const baseline = median(values)
  if (baseline <= 0) return []
  const excess: Array<number | null> = curve.points.map((value) => (value === null ? null : Math.max(0, (value - baseline) / baseline)))

  // Short by definition: a sibilant burst that lasts four seconds is something
  // else, and would be picked up as harshness instead.
  return topRegions(findRegions(excess, 1.2, 1).filter((region) => region.endIndex - region.startIndex <= 4), MAX_PER_TYPE).map((region) => ({
    issueType: 'sibilance' as const,
    severity: severityFrom(region.peak / 1.2),
    confidence: 0.4,
    startMs: toMs(region.startIndex, curve.stepMs),
    endMs: toMs(region.endIndex + 1, curve.stepMs),
    headline: 'Sibilance indicator',
    detail: `A short 5–10 kHz excursion about ${(region.peak + 1).toFixed(1)}× this record's own baseline.`,
    whyItMatters: 'Consonant energy that survives mastering tends to be the first thing a listener on earbuds notices.',
    suggestedAction: 'Worth hearing this word in isolation before reaching for a de-esser — a single take is often easier to fix than the whole vocal.',
    evidence: { multipleOfOwnBaseline: Math.round((region.peak + 1) * 10) / 10, band: '5000–10000 Hz' },
  }))
}

function detectLowEndBuildup(input: MixDoctorInput): MixDoctorIssue[] {
  const sub = findCurve(input.curves, 'band_sub')
  const low = findCurve(input.curves, 'band_low')
  if (!sub || !low) return []
  const combined: Array<number | null> = sub.points.map((value, index) => {
    const other = low.points[index]
    if (value === null || other === null || other === undefined) return null
    return value + other
  })
  const values = measured(combined)
  if (values.length < 8) return []
  const baseline = median(values)
  const excess: Array<number | null> = combined.map((value) => (value === null ? null : Math.max(0, (value - baseline) / Math.max(1e-6, baseline))))

  return topRegions(findRegions(excess, 0.5, 4), 2).map((region) => ({
    issueType: 'low_end_buildup' as const,
    severity: severityFrom(region.peak / 0.5),
    confidence: 0.5,
    startMs: toMs(region.startIndex, sub.stepMs),
    endMs: toMs(region.endIndex + 1, sub.stepMs),
    headline: 'Possible low-end build-up',
    detail: `Everything below 200 Hz takes about ${Math.round(region.peak * 100)}% more of the mix than it does across the rest of the record.`,
    whyItMatters: 'Sustained low-end weight eats the headroom the whole record shares, so it costs level everywhere, not only here.',
    suggestedAction: 'Consider whether this is the arrangement getting denser or one element ringing. A spectrum analyser on this passage alone usually answers it in seconds.',
    evidence: { excessAboveOwnBaseline: Math.round(region.peak * 100) / 100, band: 'below 200 Hz' },
  }))
}

function detectMidrangeCongestion(input: MixDoctorInput): MixDoctorIssue[] {
  const curve = findCurve(input.curves, 'midrange_share')
  const index = metricValue(input.metrics, 'midrange_congestion_index')
  // Only reported as a moment when the record as a whole shows the condition:
  // otherwise a dense chorus in an otherwise sparse arrangement gets flagged
  // for being a chorus.
  if (!curve || index === null || index < 0.35) return []
  const values = measured(curve.points)
  if (values.length < 8) return []
  const high = percentile(values, 80)
  const excess: Array<number | null> = curve.points.map((value) => (value === null ? null : Math.max(0, value - high)))

  return topRegions(findRegions(excess, 0.02, 4), 2).map((region) => ({
    issueType: 'midrange_congestion' as const,
    severity: index >= 0.6 ? ('moderate' as const) : ('low' as const),
    confidence: 0.4,
    startMs: toMs(region.startIndex, curve.stepMs),
    endMs: toMs(region.endIndex + 1, curve.stepMs),
    headline: 'Possible midrange congestion',
    detail: `200 Hz–2 kHz holds an unusually steady share of the mix through this passage, on a record that measures ${(index * 100).toFixed(0)}% on the congestion indicator overall.`,
    whyItMatters: 'A midrange that never moves reads as flat rather than loud, and small speakers reproduce almost nothing else.',
    suggestedAction: 'Consider whether two or three elements are occupying the same octave throughout. Carving one of them, rather than all of them, is usually enough.',
    evidence: { congestionIndex: index, shareAtWorst: Math.round((high + region.peak) * 1000) / 1000 },
  }))
}

function detectLevelDrop(input: MixDoctorInput): MixDoctorIssue[] {
  const curve = findCurve(input.curves, 'short_term_loudness')
  if (!curve) return []
  const values = measured(curve.points)
  if (values.length < 20) return []
  const typical = median(values)
  // A drop of more than 9 LU below the record's own median, lasting more than a
  // couple of seconds, inside the programme rather than at its edges.
  const drop: Array<number | null> = curve.points.map((value, index) => {
    if (value === null) return null
    if (index < 4 || index > curve.points.length - 5) return 0
    return Math.max(0, typical - value - 9)
  })

  return topRegions(findRegions(drop, 0.5, 2), 2).map((region) => ({
    issueType: 'level_drop' as const,
    severity: region.peak >= 6 ? ('moderate' as const) : ('low' as const),
    confidence: 0.55,
    startMs: toMs(region.startIndex, curve.stepMs),
    endMs: toMs(region.endIndex + 1, curve.stepMs),
    headline: 'Detected level drop',
    detail: `Short-term loudness falls about ${(region.peak + 9).toFixed(1)} LU below the record's typical level here.`,
    whyItMatters: 'A drop this size mid-record is either a deliberate breakdown or a dropout. Streaming normalisation will not put it back.',
    suggestedAction: 'Worth a listen. If it is the arrangement, mark it resolved.',
    evidence: { dropBelowMedianLu: Math.round((region.peak + 9) * 10) / 10 },
  }))
}

/**
 * Conditions that are properties of the whole record rather than a moment.
 *
 * They still carry a timestamp — the whole file — because the UI, the notes and
 * the engineer handoff all key on time ranges, and a special case for
 * "everywhere" would have to be handled at every one of them.
 */
function detectWholeRecordConditions(input: MixDoctorInput): MixDoctorIssue[] {
  const issues: MixDoctorIssue[] = []
  const wholeRecord = { startMs: 0, endMs: input.durationMs }

  const truePeak = metricValue(input.metrics, 'true_peak_dbtp')
  if (truePeak !== null && truePeak > -0.3) {
    issues.push({
      issueType: 'insufficient_headroom',
      severity: truePeak > 0 ? 'high' : 'moderate',
      confidence: 0.7,
      ...wholeRecord,
      headline: 'Little headroom before mastering',
      detail: `Estimated true peak is ${truePeak.toFixed(2)} dBTP.`,
      whyItMatters: 'A mix delivered at or above full scale leaves a mastering engineer — or this Master Station — nothing to work with, and lossy encoders overshoot further still.',
      suggestedAction: 'Consider delivering the mix with 3–6 dB of headroom and no limiter on the master bus. Nothing is lost: level is added later on purpose.',
      evidence: { truePeakDbtp: truePeak },
    })
  }

  const imbalance = metricValue(input.metrics, 'stereo_imbalance_db')
  if (imbalance !== null && Math.abs(imbalance) > 1.2) {
    issues.push({
      issueType: 'stereo_imbalance',
      severity: Math.abs(imbalance) > 2.5 ? 'moderate' : 'low',
      confidence: 0.8,
      ...wholeRecord,
      headline: 'Detected channel imbalance',
      detail: `The ${imbalance > 0 ? 'left' : 'right'} channel carries ${Math.abs(imbalance).toFixed(1)} dB more energy across the record.`,
      whyItMatters: 'A consistent lean pulls the whole image to one side on headphones, where it is most obvious and least forgivable.',
      suggestedAction: 'Consider whether the arrangement is genuinely asymmetric. If it is, this is nothing to fix.',
      evidence: { imbalanceDb: imbalance },
    })
  }

  const dc = metricValue(input.metrics, 'dc_offset')
  if (dc !== null && Math.abs(dc) > 0.002) {
    issues.push({
      issueType: 'dc_offset',
      severity: Math.abs(dc) > 0.01 ? 'moderate' : 'low',
      confidence: 0.9,
      ...wholeRecord,
      headline: 'Detected DC offset',
      detail: `Mean sample value is ${dc.toFixed(4)} rather than zero.`,
      whyItMatters: 'A standing offset spends headroom on silence and can make edits click.',
      suggestedAction: 'Consider a high-pass at the very bottom of the range, or checking the interface or plugin that introduced it.',
      evidence: { dcOffset: dc },
    })
  }

  return issues
}
