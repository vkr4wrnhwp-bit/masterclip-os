import type { AnalysisFrames } from './frames.js'

/**
 * Key estimation — Krumhansl–Schmuckler profile correlation over the average
 * chroma vector.
 *
 * Well-understood, deterministic, and honest about ambiguity: relative
 * major/minor pairs correlate closely, so the margin between the best and
 * second-best key is what confidence is derived from. A modal or key-changing
 * record should report low confidence, not a decisive wrong answer.
 */

export const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

// Krumhansl & Kessler (1982) probe-tone profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export interface KeyEstimate {
  /** e.g. `F# minor`. Null when nothing correlates well enough to name. */
  key: string | null
  tonic: string | null
  mode: 'major' | 'minor' | null
  confidence: number
  method: string
  /** Runner-up, so the UI can show the ambiguity rather than hiding it. */
  alternative: string | null
}

export function estimateKey(frames: AnalysisFrames): KeyEstimate {
  if (frames.count === 0) {
    return { key: null, tonic: null, mode: null, confidence: 0, method: 'krumhansl_schmuckler', alternative: null }
  }

  const average = new Float64Array(12)
  for (const chroma of frames.chroma) {
    for (let i = 0; i < 12; i++) average[i] = average[i]! + (chroma[i] ?? 0)
  }
  let total = 0
  for (const value of average) total += value
  if (total <= 0) {
    return { key: null, tonic: null, mode: null, confidence: 0, method: 'krumhansl_schmuckler', alternative: null }
  }
  for (let i = 0; i < 12; i++) average[i] = average[i]! / total

  const scored: Array<{ label: string; tonic: string; mode: 'major' | 'minor'; score: number }> = []
  for (let rotation = 0; rotation < 12; rotation++) {
    for (const [mode, profile] of [
      ['major', MAJOR_PROFILE],
      ['minor', MINOR_PROFILE],
    ] as const) {
      const rotated = profile.map((_, index) => profile[(index - rotation + 12) % 12]!)
      scored.push({
        label: `${PITCH_CLASSES[rotation]} ${mode}`,
        tonic: PITCH_CLASSES[rotation]!,
        mode,
        score: correlate(Array.from(average), rotated),
      })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]!
  const second = scored[1]!

  // Correlation alone overstates certainty; the gap to the runner-up is what
  // separates "clearly in G minor" from "somewhere around G minor / Bb major".
  const margin = best.score > 0 ? (best.score - second.score) / Math.abs(best.score) : 0
  const confidence = Math.max(0, Math.min(1, best.score * 0.5 + margin * 2))
  if (best.score < 0.3 || confidence < 0.15) {
    return {
      key: null,
      tonic: null,
      mode: null,
      confidence,
      method: 'krumhansl_schmuckler',
      alternative: null,
    }
  }
  return {
    key: best.label,
    tonic: best.tonic,
    mode: best.mode,
    confidence,
    method: 'krumhansl_schmuckler',
    alternative: second.label,
  }
}

function correlate(a: number[], b: number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length
  let numerator = 0
  let denomA = 0
  let denomB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - meanA
    const db = b[i]! - meanB
    numerator += da * db
    denomA += da * da
    denomB += db * db
  }
  if (denomA === 0 || denomB === 0) return 0
  return numerator / Math.sqrt(denomA * denomB)
}

/**
 * Chord-change activity: how often the harmonic content turns over, per minute.
 *
 * Deliberately *not* presented as chord symbols. Naming chords from a mixed
 * master is unreliable enough that Producer View shows the rate of change,
 * which is defensible, instead of a chart that would look authoritative and be
 * wrong.
 */
export function harmonicChangeRate(frames: AnalysisFrames): { changesPerMinute: number | null; confidence: number } {
  if (frames.count < 8) return { changesPerMinute: null, confidence: 0 }
  let changes = 0
  let compared = 0
  for (let i = 1; i < frames.count; i++) {
    const previous = frames.chroma[i - 1]!
    const current = frames.chroma[i]!
    let distance = 0
    for (let bin = 0; bin < 12; bin++) distance += Math.abs(current[bin]! - previous[bin]!)
    compared++
    if (distance > 0.35) changes++
  }
  if (compared === 0) return { changesPerMinute: null, confidence: 0 }
  const minutes = (frames.count * frames.frameSeconds) / 60
  return {
    changesPerMinute: minutes > 0 ? Math.round((changes / minutes) * 10) / 10 : null,
    // Short recordings give the estimator too little to work with.
    confidence: Math.max(0, Math.min(0.7, minutes / 3)),
  }
}
