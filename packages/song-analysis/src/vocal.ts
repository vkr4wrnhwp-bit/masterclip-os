import { mean, normalize, smooth } from './dsp.js'
import type { AnalysisFrames } from './frames.js'

/**
 * Vocal-activity detection.
 *
 * Without source separation this is a *proxy*, and it is named one everywhere
 * it surfaces. Lead vocal concentrates energy in roughly 200 Hz–2 kHz, is more
 * tonal than percussion, and moves its spectral centroid continuously — the
 * detector scores those three properties per frame. Confidence is capped
 * accordingly; a dense guitar record will score higher than it should, and the
 * UI says so rather than presenting occupancy as a fact.
 *
 * When real stems exist, the caller passes the isolated vocal stem in as the
 * analysed signal and confidence rises — same code path, better input.
 */

export interface VocalActivity {
  /** Per-frame vocal-likelihood, 0–1. */
  likelihood: number[]
  /** Per-frame boolean after thresholding and hysteresis. */
  active: boolean[]
  /** Continuous phrases as `[startSeconds, endSeconds]`. */
  phrases: Array<[number, number]>
  /** Share of runtime with detected vocal, 0–1. */
  occupancy: number
  /** Time of the first sustained vocal onset, or null when none is detected. */
  firstVocalSeconds: number | null
  confidence: number
  method: string
}

/** Below this the frame is a rest, not a quiet vocal. */
const ACTIVATION_THRESHOLD = 0.55
/** Hysteresis: an already-active phrase survives down to here. */
const SUSTAIN_THRESHOLD = 0.4
/** Phrases shorter than this are transients, not sung phrases. */
const MIN_PHRASE_SECONDS = 0.35
/** Rests shorter than this are breaths inside a phrase, not phrase boundaries. */
const MAX_BREATH_SECONDS = 0.3

export function detectVocalActivity(frames: AnalysisFrames, opts: { isolatedVocal?: boolean } = {}): VocalActivity {
  if (frames.count === 0) {
    return { likelihood: [], active: [], phrases: [], occupancy: 0, firstVocalSeconds: null, confidence: 0, method: 'spectral_band_proxy' }
  }

  const midBand = normalize(frames.midBand)
  // Vocals are more tonal than drums and cymbals: low flatness scores high.
  const tonality = normalize(frames.flatness.map((value) => 1 - value))
  // A held or moving pitch shifts the centroid frame to frame; steady machinery
  // does not. Small continuous motion is the signature.
  const motion = normalize(centroidMotion(frames.centroid))
  const level = normalize(frames.energy.map((value) => Math.log10(value + 1e-6)))

  const likelihood = smooth(
    frames.energy.map((_, i) => 0.4 * midBand[i]! + 0.25 * tonality[i]! + 0.2 * motion[i]! + 0.15 * level[i]!),
    2,
  )

  const active = new Array<boolean>(frames.count)
  let inPhrase = false
  for (let i = 0; i < frames.count; i++) {
    const value = likelihood[i]!
    inPhrase = inPhrase ? value >= SUSTAIN_THRESHOLD : value >= ACTIVATION_THRESHOLD
    active[i] = inPhrase
  }

  const phrases = phrasesFrom(active, frames.frameSeconds)
  const activeFrames = active.reduce((count, value) => count + (value ? 1 : 0), 0)

  return {
    likelihood: likelihood.map((value) => Math.round(value * 1000) / 1000),
    active,
    phrases,
    occupancy: frames.count > 0 ? activeFrames / frames.count : 0,
    firstVocalSeconds: phrases.length > 0 ? Math.round(phrases[0]![0] * 100) / 100 : null,
    // A separated vocal stem is direct evidence; a full mix is inference.
    confidence: opts.isolatedVocal ? 0.85 : 0.45,
    method: opts.isolatedVocal ? 'isolated_stem_envelope' : 'spectral_band_proxy',
  }
}

function centroidMotion(centroid: number[]): number[] {
  const motion = new Array<number>(centroid.length).fill(0)
  for (let i = 1; i < centroid.length; i++) {
    const delta = Math.abs(centroid[i]! - centroid[i - 1]!)
    // Vibrato and melodic movement are small continuous changes; a cymbal crash
    // is a large discontinuity, and scoring it as vocal motion would be wrong.
    motion[i] = delta > 0.001 && delta < 0.05 ? delta : 0
  }
  return motion
}

function phrasesFrom(active: boolean[], frameSeconds: number): Array<[number, number]> {
  const raw: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i < active.length; i++) {
    if (active[i] && start < 0) start = i
    else if (!active[i] && start >= 0) {
      raw.push([start * frameSeconds, i * frameSeconds])
      start = -1
    }
  }
  if (start >= 0) raw.push([start * frameSeconds, active.length * frameSeconds])

  // Merge across breaths, then drop what is left that is too short to be sung.
  const merged: Array<[number, number]> = []
  for (const phrase of raw) {
    const previous = merged[merged.length - 1]
    if (previous && phrase[0] - previous[1] <= MAX_BREATH_SECONDS) previous[1] = phrase[1]
    else merged.push([...phrase])
  }
  return merged
    .filter((phrase) => phrase[1] - phrase[0] >= MIN_PHRASE_SECONDS)
    .map((phrase) => [Math.round(phrase[0] * 100) / 100, Math.round(phrase[1] * 100) / 100] as [number, number])
}

export interface VocalPhraseMetrics {
  averagePhraseSeconds: number | null
  longestPhraseSeconds: number | null
  averageRestSeconds: number | null
  restRatio: number | null
  /** Longest continuous phrase with no centroid movement — a held-note proxy. */
  heldNoteSeconds: number | null
}

export function vocalPhraseMetrics(activity: VocalActivity, durationSeconds: number, frames: AnalysisFrames): VocalPhraseMetrics {
  if (activity.phrases.length === 0) {
    return { averagePhraseSeconds: null, longestPhraseSeconds: null, averageRestSeconds: null, restRatio: null, heldNoteSeconds: null }
  }
  const lengths = activity.phrases.map(([from, to]) => to - from)
  const rests: number[] = []
  for (let i = 1; i < activity.phrases.length; i++) {
    rests.push(activity.phrases[i]![0] - activity.phrases[i - 1]![1])
  }
  const sung = lengths.reduce((sum, value) => sum + value, 0)

  return {
    averagePhraseSeconds: round(mean(lengths)),
    longestPhraseSeconds: round(Math.max(...lengths)),
    averageRestSeconds: rests.length > 0 ? round(mean(rests)) : null,
    restRatio: durationSeconds > 0 ? round(Math.max(0, 1 - sung / durationSeconds)) : null,
    heldNoteSeconds: longestSteadyPitch(activity, frames),
  }
}

/** Longest run of active frames whose spectral centroid barely moves. */
function longestSteadyPitch(activity: VocalActivity, frames: AnalysisFrames): number | null {
  let best = 0
  let run = 0
  for (let i = 1; i < frames.count; i++) {
    const steady = activity.active[i] && Math.abs(frames.centroid[i]! - frames.centroid[i - 1]!) < 0.004
    run = steady ? run + 1 : 0
    if (run > best) best = run
  }
  const seconds = best * frames.frameSeconds
  return seconds >= 0.4 ? round(seconds) : null
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Melodic range proxy from the spectral centroid of voiced frames.
 *
 * Reported as a normalized register band rather than note names: deriving a
 * lead-vocal pitch from a full mix is not reliable enough to print "your chorus
 * tops out at G5". What *is* defensible is whether two sections sit in the same
 * register, which is the question that matters for section contrast.
 */
export interface RegisterProfile {
  medianRegister: number | null
  lowRegister: number | null
  highRegister: number | null
  confidence: number
  method: string
}

/**
 * How far a register measurement is allowed to be trusted.
 *
 * From a full mix there are two independent doubts: whether the frames scored
 * as voiced are the voice at all, and whether a spectral centroid tracks sung
 * pitch. A separated stem settles the first outright — the frames *are* the
 * vocal — and leaves only the second.
 *
 * So the stem ceiling is higher, but deliberately below the 0.85 that vocal
 * *detection* earns on a stem: centroid is not pitch, and no amount of source
 * separation makes it pitch. The uplift is for the doubt that was removed,
 * not for the one that remains.
 */
export const REGISTER_CONFIDENCE_CEILING = { fullMix: 0.5, isolatedStem: 0.7 } as const

export interface RegisterOptions {
  /** True when the measured signal is a separated vocal rather than the mix. */
  isolatedVocal?: boolean
}

/**
 * Per-frame voiced register: the spectral centroid where a vocal is active,
 * `null` where it is not.
 *
 * Extracted so a register can be re-measured over a *different* signal than the
 * one a section was detected from — section boundaries come from the full mix,
 * because an instrumental break is a section change and a vocal stem is silent
 * there, while the register of those sections is better measured from the stem.
 * The curve is what lets those two live on different sources.
 */
export function voicedRegisterCurve(activity: VocalActivity, frames: AnalysisFrames): Array<number | null> {
  const curve = new Array<number | null>(frames.count)
  for (let i = 0; i < frames.count; i++) curve[i] = activity.active[i] ? frames.centroid[i]! : null
  return curve
}

export function registerProfile(
  activity: VocalActivity,
  frames: AnalysisFrames,
  fromFrame = 0,
  toFrame = frames.count,
  opts: RegisterOptions = {},
): RegisterProfile {
  return registerProfileFromCurve(voicedRegisterCurve(activity, frames), fromFrame, toFrame, {
    ...opts,
    detectionConfidence: activity.confidence,
  })
}

export function registerProfileFromCurve(
  curve: Array<number | null>,
  fromFrame = 0,
  toFrame = curve.length,
  opts: RegisterOptions & { detectionConfidence?: number } = {},
): RegisterProfile {
  const values: number[] = []
  for (let i = Math.max(0, fromFrame); i < Math.min(curve.length, toFrame); i++) {
    const value = curve[i]
    if (value !== null && value !== undefined) values.push(value)
  }
  const method = opts.isolatedVocal ? 'isolated_stem_centroid_percentiles' : 'voiced_centroid_percentiles'
  if (values.length < 8) return { medianRegister: null, lowRegister: null, highRegister: null, confidence: 0, method }

  values.sort((a, b) => a - b)
  const at = (p: number) => values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]!
  const ceiling = opts.isolatedVocal ? REGISTER_CONFIDENCE_CEILING.isolatedStem : REGISTER_CONFIDENCE_CEILING.fullMix
  return {
    medianRegister: round(at(50)),
    lowRegister: round(at(10)),
    highRegister: round(at(90)),
    // Still bounded by the detection behind it: a stem measured by a detector
    // that found almost nothing is not a confident register.
    confidence: Math.min(ceiling, opts.detectionConfidence ?? ceiling),
    method,
  }
}

/**
 * Melodic contour.
 *
 * The same caveat as `registerProfile` applies — this is the voiced spectral
 * centroid, not a transcribed melody — so the contour is normalized to shape
 * rather than kept in absolute terms. Shape is the comparable quantity: two
 * choruses sung a tone apart trace the same contour, and *that* is what
 * "melodic contour similarity" is asking about.
 *
 * Values are peak-normalized into -1..1 around the window's own mean, so a
 * contour is comparable across sections of different length and register.
 */
export const MELODIC_CONTOUR_POINTS = 8

/** Below this many voiced frames a window has no comparable shape. */
const MIN_CONTOUR_FRAMES = 12

export function melodicContour(
  activity: VocalActivity,
  frames: AnalysisFrames,
  fromFrame = 0,
  toFrame = frames.count,
  points = MELODIC_CONTOUR_POINTS,
): number[] {
  return melodicContourFromCurve(voicedRegisterCurve(activity, frames), fromFrame, toFrame, points)
}

export function melodicContourFromCurve(
  curve: Array<number | null>,
  fromFrame = 0,
  toFrame = curve.length,
  points = MELODIC_CONTOUR_POINTS,
): number[] {
  const voiced: number[] = []
  for (let i = Math.max(0, fromFrame); i < Math.min(curve.length, toFrame); i++) {
    const value = curve[i]
    if (value !== null && value !== undefined) voiced.push(value)
  }
  if (voiced.length < MIN_CONTOUR_FRAMES) return []

  // Resample by bucket mean rather than by picking frames: a sung note lasts
  // many frames, and averaging keeps the note rather than whichever frame the
  // sampling grid happened to land on.
  const buckets: number[] = []
  for (let p = 0; p < points; p++) {
    const from = Math.floor((p / points) * voiced.length)
    const to = Math.max(from + 1, Math.floor(((p + 1) / points) * voiced.length))
    buckets.push(mean(voiced.slice(from, to)))
  }

  const centre = mean(buckets)
  const spread = Math.max(...buckets.map((value) => Math.abs(value - centre)))
  // A dead-flat window has a real shape — flat — and normalizing it by a zero
  // spread would invent movement that is not there.
  if (spread < 1e-6) return buckets.map(() => 0)
  return buckets.map((value) => Math.round(((value - centre) / spread) * 1000) / 1000)
}

/**
 * How alike two contours are, 0–1. `null` when either window had too little
 * voiced content to have a shape — never 0, which would read as "completely
 * different" rather than "not measured".
 */
export function contourSimilarity(a: number[], b: number[]): number | null {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return null
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!)
  // Both contours live in -1..1, so the worst possible mean difference is 2.
  const similarity = 1 - total / a.length / 2
  return Math.round(Math.max(0, Math.min(1, similarity)) * 1000) / 1000
}
