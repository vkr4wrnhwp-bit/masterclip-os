import { mean, smooth } from './dsp.js'
import type { AnalysisFrames } from './frames.js'

/**
 * Tempo and meter.
 *
 * Onset-strength autocorrelation: robust on programme material, cheap, and —
 * critically for this product — able to say how sure it is. A tempo estimate
 * that cannot express doubt has no business driving a "+4 BPM" experiment.
 */

export interface TempoEstimate {
  bpm: number | null
  /** 0–1, from how dominant the winning lag is over the runners-up. */
  confidence: number
  /** 0–1: how consistent the tempo is across the song's halves and quarters. */
  stability: number | null
  /** Detected beat times in seconds, for section snapping and bar maths. */
  beats: number[]
  method: string
}

const MIN_BPM = 60
const MAX_BPM = 200
/**
 * Peak-to-mean flux below this means the material has no transients worth
 * calling onsets — a pad, a drone, a solo voice. Reporting a tempo for it would
 * be reporting the analysis window's own periodicity.
 */
const MIN_ONSET_SALIENCE = 4

/**
 * Autocorrelates the onset-strength envelope over musically plausible lags.
 *
 * The 60–200 BPM window is a deliberate constraint: outside it, autocorrelation
 * reliably finds half- and double-time peaks that are not what a musician would
 * call the tempo.
 */
export function estimateTempo(frames: AnalysisFrames): TempoEstimate {
  if (frames.count < 32) {
    return { bpm: null, confidence: 0, stability: null, beats: [], method: 'onset_autocorrelation' }
  }
  const onset = onsetStrength(frames)
  const secondsPerFrame = frames.frameSeconds
  const minLag = Math.max(1, Math.floor(60 / MAX_BPM / secondsPerFrame))
  const maxLag = Math.min(frames.count - 1, Math.ceil(60 / MIN_BPM / secondsPerFrame))
  if (maxLag <= minLag) {
    return { bpm: null, confidence: 0, stability: null, beats: [], method: 'onset_autocorrelation' }
  }

  // Before trusting any peak, ask whether this material has onsets at all.
  // The onset envelope is peak-normalized, which means a signal with no
  // transients still produces a full-scale curve — so salience has to be
  // measured on the raw flux, where a sustained tone is visibly flat.
  const salience = onsetSalience(frames.flux)
  if (salience < MIN_ONSET_SALIENCE) {
    return { bpm: null, confidence: 0, stability: null, beats: [], method: 'onset_autocorrelation' }
  }

  const scores = autocorrelate(onset, minLag, maxLag)
  const best = pickPeak(scores, minLag)
  if (!best) return { bpm: null, confidence: 0, stability: null, beats: [], method: 'onset_autocorrelation' }

  const bpm = 60 / (best.lag * secondsPerFrame)
  const beats = beatsFromLag(onset, best.lag, secondsPerFrame)
  const stability = tempoStability(onset, minLag, maxLag, secondsPerFrame, bpm)

  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence: best.confidence,
    stability,
    beats,
    method: 'onset_autocorrelation',
  }
}

/** Normalized, smoothed, half-wave-rectified onset strength. */
export function onsetStrength(frames: AnalysisFrames): number[] {
  const smoothed = smooth(frames.flux, 1)
  const average = mean(smoothed)
  // Subtracting the local mean is what turns "energy" into "onsets": sustained
  // loudness contributes nothing, changes contribute everything.
  const rectified = smoothed.map((value) => Math.max(0, value - average))
  const peak = Math.max(...rectified, 1e-9)
  return rectified.map((value) => value / peak)
}

function autocorrelate(onset: number[], minLag: number, maxLag: number): number[] {
  const scores = new Array<number>(maxLag + 1).fill(0)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = lag; i < onset.length; i++) sum += onset[i]! * onset[i - lag]!
    // Normalizing by overlap stops long lags from being penalized purely for
    // having fewer terms.
    scores[lag] = sum / (onset.length - lag)
  }
  return scores
}

/** Ratio of the strongest flux frame to the typical one. */
function onsetSalience(flux: number[]): number {
  if (flux.length === 0) return 0
  const average = mean(flux)
  if (average <= 1e-9) return 0
  return Math.max(...flux) / average
}

function pickPeak(scores: number[], minLag: number): { lag: number; confidence: number } | null {
  let bestLag = -1
  let bestScore = -Infinity
  for (let lag = minLag; lag < scores.length; lag++) {
    if (scores[lag]! > bestScore) {
      bestScore = scores[lag]!
      bestLag = lag
    }
  }
  if (bestLag < 0 || bestScore <= 0) return null

  // Confidence is the share of the winning peak that stands above the typical
  // lag. Expressed as a fraction of the peak itself rather than in units of the
  // spread: dividing by a near-zero spread would make a *flat* autocorrelation
  // — the one case that means "no clear pulse" — score highest of all.
  const others = scores.slice(minLag).filter((_, index) => Math.abs(index + minLag - bestLag) > 2)
  const baseline = mean(others)
  const prominence = (bestScore - baseline) / bestScore
  return { lag: bestLag, confidence: Math.max(0, Math.min(1, prominence)) }
}

/** Places beats on the strongest onset near each expected beat position. */
function beatsFromLag(onset: number[], lag: number, secondsPerFrame: number): number[] {
  let start = 0
  let bestStart = -Infinity
  for (let i = 0; i < Math.min(lag, onset.length); i++) {
    if (onset[i]! > bestStart) {
      bestStart = onset[i]!
      start = i
    }
  }
  const beats: number[] = []
  const window = Math.max(1, Math.round(lag * 0.15))
  for (let position = start; position < onset.length; position += lag) {
    let peakIndex = Math.round(position)
    let peakValue = -Infinity
    for (let i = Math.max(0, peakIndex - window); i <= Math.min(onset.length - 1, peakIndex + window); i++) {
      if (onset[i]! > peakValue) {
        peakValue = onset[i]!
        peakIndex = i
      }
    }
    beats.push(peakIndex * secondsPerFrame)
  }
  return beats
}

/**
 * Re-estimates tempo on each quarter of the song and reports how tightly the
 * quarters agree. A programmed track lands near 1; a live band or a track with
 * a half-time section lands lower, and that difference is worth surfacing
 * before anyone runs a time-stretch experiment on it.
 */
function tempoStability(onset: number[], minLag: number, maxLag: number, secondsPerFrame: number, globalBpm: number): number | null {
  const quarter = Math.floor(onset.length / 4)
  if (quarter < minLag * 4) return null
  const estimates: number[] = []
  for (let part = 0; part < 4; part++) {
    const slice = onset.slice(part * quarter, (part + 1) * quarter)
    const scores = autocorrelate(slice, minLag, Math.min(maxLag, slice.length - 1))
    const peak = pickPeak(scores, minLag)
    if (peak) estimates.push(60 / (peak.lag * secondsPerFrame))
  }
  if (estimates.length < 2) return null
  const deviations = estimates.map((bpm) => Math.abs(bpm - globalBpm) / globalBpm)
  return Math.max(0, Math.min(1, 1 - mean(deviations) * 4))
}

export interface MeterEstimate {
  beatsPerBar: number | null
  confidence: number
  method: string
}

/**
 * Meter from accent periodicity.
 *
 * Reported only when 4/4 or 3/4 wins clearly. Time signature is the feature
 * most often stated with false confidence by automatic analysis, and a wrong
 * meter silently corrupts every bar-based experiment, so the honest answer here
 * is frequently "not enough information".
 */
export function estimateMeter(beats: number[], onset: number[], frameSeconds: number): MeterEstimate {
  if (beats.length < 12) return { beatsPerBar: null, confidence: 0, method: 'beat_accent_periodicity' }
  const strengths = beats.map((time) => onset[Math.min(onset.length - 1, Math.round(time / frameSeconds))] ?? 0)
  const candidates = [4, 3]
  let bestMeter = 0
  let bestScore = -Infinity
  let runnerUp = -Infinity
  for (const meter of candidates) {
    let downbeat = 0
    let offbeat = 0
    for (let i = 0; i < strengths.length; i++) {
      if (i % meter === 0) downbeat += strengths[i]!
      else offbeat += strengths[i]!
    }
    const downbeatCount = Math.ceil(strengths.length / meter)
    const offbeatCount = strengths.length - downbeatCount
    const score = offbeatCount > 0 ? downbeat / downbeatCount - offbeat / offbeatCount : 0
    if (score > bestScore) {
      runnerUp = bestScore
      bestScore = score
      bestMeter = meter
    } else if (score > runnerUp) {
      runnerUp = score
    }
  }
  if (bestScore <= 0) return { beatsPerBar: null, confidence: 0, method: 'beat_accent_periodicity' }
  const margin = Number.isFinite(runnerUp) ? (bestScore - Math.max(0, runnerUp)) / bestScore : 0.5
  const confidence = Math.max(0, Math.min(1, margin))
  // Below a clear margin the estimate is a coin toss; say so instead of guessing.
  if (confidence < 0.2) return { beatsPerBar: null, confidence, method: 'beat_accent_periodicity' }
  return { beatsPerBar: bestMeter, confidence, method: 'beat_accent_periodicity' }
}

/** Seconds per bar, for bar-accurate experiment edits. */
export function barSeconds(bpm: number, beatsPerBar: number): number {
  return (60 / bpm) * beatsPerBar
}
