import { metricValue } from './analyze.js'
import type { MixMetric } from './types.js'

/**
 * Release Readiness.
 *
 * A translation indicator, not a measure of whether the record is good. The
 * distinction is not a disclaimer bolted on at the UI — it is what the scoring
 * actually does: every band scores how *predictably* the record will survive
 * playback it was not mixed on, and nothing here can distinguish a great song
 * from a dull one.
 *
 * Two consequences the implementation takes seriously:
 *
 *   - A band whose inputs could not be measured scores `null`, not zero, and is
 *     excluded from the overall figure. A mono file has no stereo field to be
 *     bad at.
 *   - Scores are non-monotonic where the underlying property is. A record can
 *     be too quiet *or* too crushed, and both cost the same band.
 */

export const READINESS_BANDS = [
  'dynamics',
  'low_end',
  'midrange',
  'high_frequency',
  'stereo_field',
  'headroom',
  'competitive_loudness',
  'streaming_translation',
] as const

export type ReadinessBand = (typeof READINESS_BANDS)[number]

export interface ReadinessBandResult {
  band: ReadinessBand
  label: string
  /** 0–100, or null when the inputs could not be measured. */
  score: number | null
  /** What was actually measured. Numbers, not adjectives. */
  detected: string
  whyItMatters: string
  recommendation: string
  /** 0–1, inherited from the weakest input. */
  confidence: number
}

export interface ReleaseReadiness {
  /** 0–100 over the bands that could be scored, or null when none could. */
  score: number | null
  /** How many of the eight bands contributed. Printed with the score. */
  bandsScored: number
  bands: ReadinessBandResult[]
  /** The sentence that must travel with the number wherever it is shown. */
  caveat: string
}

export const READINESS_CAVEAT =
  'These are technical translation indicators, not a judgement of the record. A high score means the mix is likely to survive playback it was not made on; it says nothing about whether the song works.'

export function computeReleaseReadiness(metrics: MixMetric[]): ReleaseReadiness {
  const bands: ReadinessBandResult[] = [
    scoreDynamics(metrics),
    scoreLowEnd(metrics),
    scoreMidrange(metrics),
    scoreHighFrequency(metrics),
    scoreStereoField(metrics),
    scoreHeadroom(metrics),
    scoreCompetitiveLoudness(metrics),
    scoreStreamingTranslation(metrics),
  ]

  const scored = bands.filter((band) => band.score !== null)
  // An overall figure from two of eight bands would be a number nobody should
  // act on. Below half the bands, the product says so instead.
  const score = scored.length >= 4 ? Math.round(scored.reduce((sum, band) => sum + (band.score ?? 0), 0) / scored.length) : null

  return { score, bandsScored: scored.length, bands, caveat: READINESS_CAVEAT }
}

/** Maps a value onto 0–100 with a flat-topped plateau between `idealLow` and `idealHigh`. */
function plateau(value: number, idealLow: number, idealHigh: number, tolerance: number): number {
  if (value >= idealLow && value <= idealHigh) return 100
  const distance = value < idealLow ? idealLow - value : value - idealHigh
  return Math.round(Math.max(0, 100 - (distance / tolerance) * 100))
}

/** Maps a 0–1 index where lower is better onto 0–100. */
function inverseIndex(value: number, tolerated: number): number {
  return Math.round(Math.max(0, Math.min(100, 100 - (value / tolerated) * 100)))
}

function unscored(band: ReadinessBand, label: string, reason: string, whyItMatters: string): ReadinessBandResult {
  return {
    band,
    label,
    score: null,
    detected: reason,
    whyItMatters,
    recommendation: 'No recommendation: there is not enough information to make one.',
    confidence: 0,
  }
}

function scoreDynamics(metrics: MixMetric[]): ReadinessBandResult {
  const range = metricValue(metrics, 'dynamic_range_db')
  const transients = metricValue(metrics, 'transient_retention')
  if (range === null) {
    return unscored('dynamics', 'Dynamics', 'Dynamic range could not be measured on this file.', 'Dynamic range is what survives — or does not — when a platform turns the record down.')
  }
  // 6–14 dB is where most contemporary masters sit without sounding crushed.
  // Below 4 is heavily limited; above 18 will be turned down hard by streaming
  // normalisation and lose its impact relative to what is around it.
  const rangeScore = plateau(range, 6, 14, 8)
  const transientScore = transients === null ? rangeScore : Math.round(transients * 100)
  return {
    band: 'dynamics',
    label: 'Dynamics',
    score: Math.round(rangeScore * 0.6 + transientScore * 0.4),
    detected: `Dynamic range ${range.toFixed(1)} dB${transients === null ? '' : `, transient retention ${(transients * 100).toFixed(0)}%`}.`,
    whyItMatters: 'Streaming platforms normalise level but not dynamics, so a heavily limited record arrives quieter *and* flatter than one that kept its transients.',
    recommendation:
      range < 5
        ? 'Consider whether the limiting is doing work the arrangement could do. Backing off 1–2 dB is usually inaudible as level and very audible as life.'
        : range > 18
          ? 'Consider whether this much range is intended. It will survive perfectly on a good system and may feel quiet in a playlist.'
          : 'This sits in the range most contemporary masters occupy. Nothing suggests a change.',
    confidence: 0.6,
  }
}

function scoreLowEnd(metrics: MixMetric[]): ReadinessBandResult {
  const sub = metricValue(metrics, 'sub_energy_pct')
  const low = metricValue(metrics, 'low_energy_pct')
  const centroid = metricValue(metrics, 'low_end_centroid_hz')
  const overlap = metricValue(metrics, 'kick_bass_masking_index')
  if (sub === null || low === null) {
    return unscored('low_end', 'Low End', 'Low-frequency balance could not be measured on this file.', 'The bottom end is what changes most between a studio and everywhere else.')
  }
  const total = sub + low
  // 18–38 % of total energy below 200 Hz covers most of what translates. The
  // window is wide on purpose: a folk record and a trap record both belong in
  // it, and narrowing it would turn a genre into a fault.
  const balanceScore = plateau(total, 18, 38, 20)
  const overlapScore = overlap === null ? balanceScore : inverseIndex(overlap, 0.9)
  return {
    band: 'low_end',
    label: 'Low End',
    score: Math.round(balanceScore * 0.7 + overlapScore * 0.3),
    detected: `${total.toFixed(1)}% of total energy sits below 200 Hz${centroid === null ? '' : `, centred around ${Math.round(centroid)} Hz`}.`,
    whyItMatters: 'Phones and laptops reproduce almost none of this band, and a club system reproduces far more of it than your room does. A record weighted at the extremes of it translates least predictably.',
    recommendation:
      total > 40
        ? 'Consider checking this on a speaker with no sub. If the record loses its foundation entirely, some of that weight may be sitting below where most listeners can hear it.'
        : total < 16
          ? 'Consider whether the bottom is thinner than intended. It will read as clean on monitors and thin in a car.'
          : 'The low-frequency balance sits where most records that translate well sit.',
    confidence: 0.6,
  }
}

function scoreMidrange(metrics: MixMetric[]): ReadinessBandResult {
  const congestion = metricValue(metrics, 'midrange_congestion_index')
  const vocalMasking = metricValue(metrics, 'vocal_masking_index')
  if (congestion === null) {
    return unscored('midrange', 'Midrange', 'Midrange behaviour could not be measured on this file.', 'The midrange is the only band every playback system reproduces.')
  }
  const congestionScore = inverseIndex(congestion, 0.8)
  const maskingScore = vocalMasking === null ? congestionScore : inverseIndex(vocalMasking, 0.9)
  return {
    band: 'midrange',
    label: 'Midrange',
    score: Math.round(congestionScore * 0.6 + maskingScore * 0.4),
    detected: `Congestion indicator ${(congestion * 100).toFixed(0)}%${vocalMasking === null ? '' : `, vocal-band co-occurrence ${(vocalMasking * 100).toFixed(0)}%`}.`,
    whyItMatters: 'A phone speaker, a laptop and a TV reproduce the midrange and very little else. Whatever is unclear here is unclear on most of the devices your record will be heard on.',
    recommendation:
      congestion > 0.5
        ? 'Worth checking this on a single small speaker. Carving one element rather than every element is usually what opens it up.'
        : 'Nothing in the midrange measurements suggests a change.',
    confidence: 0.45,
  }
}

function scoreHighFrequency(metrics: MixMetric[]): ReadinessBandResult {
  const harshness = metricValue(metrics, 'harshness_index')
  const sibilance = metricValue(metrics, 'sibilance_index')
  const highShare = metricValue(metrics, 'high_energy_pct')
  if (harshness === null && sibilance === null) {
    return unscored('high_frequency', 'High Frequency', 'Top-end behaviour could not be measured on this file.', 'The top end is where consumer playback and lossy encoding diverge most from a studio.')
  }
  const harshScore = harshness === null ? null : inverseIndex(harshness, 0.85)
  const sibilanceScore = sibilance === null ? null : inverseIndex(sibilance, 0.8)
  const parts = [harshScore, sibilanceScore].filter((value): value is number => value !== null)
  return {
    band: 'high_frequency',
    label: 'High Frequency',
    score: Math.round(parts.reduce((sum, value) => sum + value, 0) / parts.length),
    detected: [
      harshness === null ? null : `harshness indicator ${(harshness * 100).toFixed(0)}%`,
      sibilance === null ? null : `sibilance indicator ${(sibilance * 100).toFixed(0)}%`,
      highShare === null ? null : `${highShare.toFixed(1)}% of energy above 6 kHz`,
    ]
      .filter(Boolean)
      .join(', '),
    whyItMatters: 'Earbuds and cheap Bluetooth speakers lift this region, and lossy encoding is least accurate in it. What is merely bright here is often abrasive there.',
    recommendation:
      (harshness ?? 0) > 0.5 || (sibilance ?? 0) > 0.5
        ? 'Consider auditioning the record on earbuds at a low level before mastering. Top-end problems are much easier to hear that way than on monitors.'
        : 'The top-end measurements do not suggest a change.',
    confidence: 0.45,
  }
}

function scoreStereoField(metrics: MixMetric[]): ReadinessBandResult {
  const correlation = metricValue(metrics, 'phase_correlation')
  const width = metricValue(metrics, 'stereo_width')
  const monoLoss = metricValue(metrics, 'mono_fold_loss_db')
  const imbalance = metricValue(metrics, 'stereo_imbalance_db')
  if (correlation === null) {
    return unscored(
      'stereo_field',
      'Stereo Field',
      'This file is mono, or its channels are identical, so there is no stereo field to assess.',
      'Stereo behaviour decides how much of the record survives a mono fold-down.',
    )
  }
  // Correlation near +1 is safe but narrow; near 0 is wide and still mono-safe;
  // negative is where level disappears in mono. The curve reflects that rather
  // than treating "more correlated" as better.
  const correlationScore = correlation >= 0.2 ? 100 : correlation >= 0 ? Math.round(60 + correlation * 200) : Math.round(Math.max(0, 60 + correlation * 120))
  const monoScore = monoLoss === null ? correlationScore : Math.round(Math.max(0, 100 - Math.abs(Math.min(0, monoLoss)) * 25))
  const imbalanceScore = imbalance === null ? 100 : Math.round(Math.max(0, 100 - Math.abs(imbalance) * 20))
  return {
    band: 'stereo_field',
    label: 'Stereo Field',
    score: Math.round(correlationScore * 0.45 + monoScore * 0.35 + imbalanceScore * 0.2),
    detected: [
      `correlation ${correlation.toFixed(2)}`,
      width === null ? null : `width ${width.toFixed(2)}`,
      monoLoss === null ? null : `${monoLoss.toFixed(1)} dB on mono fold-down`,
      imbalance === null ? null : `${imbalance >= 0 ? 'L' : 'R'} ${Math.abs(imbalance).toFixed(1)} dB`,
    ]
      .filter(Boolean)
      .join(', '),
    whyItMatters: 'A great many listens happen in mono — one phone speaker, one Bluetooth cube, a club sub. What cancels there is simply gone.',
    recommendation:
      correlation < 0
        ? 'Worth checking the record in mono. Sustained negative correlation usually traces to one wide element rather than the whole mix.'
        : 'The stereo measurements suggest the mix folds down without losing much.',
    confidence: 0.7,
  }
}

function scoreHeadroom(metrics: MixMetric[]): ReadinessBandResult {
  const truePeak = metricValue(metrics, 'true_peak_dbtp')
  const clipping = metricValue(metrics, 'clipping_runs')
  if (truePeak === null) {
    return unscored('headroom', 'Headroom', 'Peak level could not be measured on this file.', 'Headroom is what a mastering stage has to work with.')
  }
  // −1 dBTP is the conventional delivery ceiling; a mix with 3–6 dB spare is
  // ideal for mastering. Both "too hot" and "far too quiet" cost this band.
  const peakScore = truePeak > 0 ? 0 : truePeak > -1 ? 45 : truePeak > -12 ? 100 : Math.round(Math.max(30, 100 - (Math.abs(truePeak) - 12) * 6))
  const clipScore = clipping === null || clipping === 0 ? 100 : Math.max(0, 100 - clipping * 12)
  return {
    band: 'headroom',
    label: 'Headroom',
    score: Math.round(peakScore * 0.7 + clipScore * 0.3),
    detected: `Estimated true peak ${truePeak.toFixed(2)} dBTP${clipping ? `, ${clipping} clipping run${clipping === 1 ? '' : 's'}` : ', no clipping runs detected'}.`,
    whyItMatters: 'A lossy encoder reconstructs peaks slightly higher than the file contains, so a master at 0 dBTP distorts on the platform even though it measures clean here.',
    recommendation:
      truePeak > -1
        ? 'Consider leaving the ceiling at −1 dBTP or lower for streaming delivery.'
        : truePeak < -12
          ? 'There is plenty of headroom. Nothing is wrong; a mastering stage simply has room to work.'
          : 'Headroom is in good shape for mastering.',
    confidence: 0.7,
  }
}

function scoreCompetitiveLoudness(metrics: MixMetric[]): ReadinessBandResult {
  const lufs = metricValue(metrics, 'integrated_lufs')
  if (lufs === null) {
    return unscored('competitive_loudness', 'Competitive Loudness', 'Programme loudness could not be measured on this file.', 'Loudness decides how the record sits against what plays before and after it.')
  }
  // The plateau is −16 to −8 LUFS: everything in that range plays at the same
  // level once a platform normalises, so being louder than −14 buys nothing and
  // costs dynamics. This band is deliberately generous — it is a translation
  // indicator, and there is no loudness a record is obliged to be.
  const score = plateau(lufs, -16, -8, 8)
  return {
    band: 'competitive_loudness',
    label: 'Competitive Loudness',
    score,
    detected: `Integrated loudness ${lufs.toFixed(1)} LUFS (±1 LU — this is an approximation, not a certified meter).`,
    whyItMatters: 'Major platforms normalise playback to roughly −14 LUFS. Above that, extra level is turned back down and only the lost dynamics remain.',
    recommendation:
      lufs > -7
        ? 'Consider that anything above about −14 LUFS is turned down on playback anyway. The loudness is real; the advantage is not.'
        : lufs < -18
          ? 'This will be turned up rather than down, which is fine — though it may feel reserved next to louder material in a playlist.'
          : 'This sits where platform normalisation leaves the record roughly where you intended.',
    confidence: 0.6,
  }
}

function scoreStreamingTranslation(metrics: MixMetric[]): ReadinessBandResult {
  const truePeak = metricValue(metrics, 'true_peak_dbtp')
  const lufs = metricValue(metrics, 'integrated_lufs')
  const monoLoss = metricValue(metrics, 'mono_fold_loss_db')
  const highShare = metricValue(metrics, 'high_energy_pct')
  if (truePeak === null || lufs === null) {
    return unscored(
      'streaming_translation',
      'Streaming Translation',
      'Loudness and peak level could not both be measured, so translation cannot be estimated.',
      'This band estimates what changes between this file and what a platform actually plays.',
    )
  }
  // What a platform does to the file: normalise by (target − integrated), then
  // reconstruct peaks slightly above what the file contains. A master that
  // clips *after* normalisation is the specific failure this band predicts.
  const normalisationGain = -14 - lufs
  const peakAfterNormalisation = truePeak + normalisationGain
  const encodeOvershoot = 0.3
  const clipsAfterEncode = peakAfterNormalisation + encodeOvershoot > 0

  let score = clipsAfterEncode ? 40 : 100
  if (monoLoss !== null && monoLoss < -1.5) score -= 20
  if (highShare !== null && highShare > 14) score -= 10
  score = Math.max(0, Math.min(100, score))

  return {
    band: 'streaming_translation',
    label: 'Streaming Translation',
    score,
    detected: `Normalised to −14 LUFS this file would move by ${normalisationGain >= 0 ? '+' : ''}${normalisationGain.toFixed(1)} dB, reaching about ${peakAfterNormalisation.toFixed(2)} dBTP.`,
    whyItMatters: 'Platforms adjust level and encode lossily. Both happen after you deliver, and both can undo decisions that measured fine in the studio.',
    recommendation: clipsAfterEncode
      ? 'Consider lowering the ceiling: after normalisation and encoding this material would sit at or above full scale.'
      : 'Nothing in these measurements suggests the record changes character on the way to a listener.',
    confidence: 0.5,
  }
}
