import type { Quantization } from '@masterclip/performance-project'

/**
 * Tempo math. Everything here is pure — beats in, beats out — which is what
 * makes launch quantization unit-testable without an AudioContext.
 */

export interface TimeSignature {
  beatsPerBar: number
  beatUnit: number
}

export function parseTimeSignature(value: string): TimeSignature {
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(value.trim())
  if (!match) return { beatsPerBar: 4, beatUnit: 4 }
  const beatsPerBar = Number(match[1])
  const beatUnit = Number(match[2])
  if (beatsPerBar < 1 || beatUnit < 1) return { beatsPerBar: 4, beatUnit: 4 }
  return { beatsPerBar, beatUnit }
}

export function secondsPerBeat(bpm: number): number {
  return 60 / bpm
}

export function beatsToSeconds(beats: number, bpm: number): number {
  return beats * secondsPerBeat(bpm)
}

export function secondsToBeats(seconds: number, bpm: number): number {
  return seconds / secondsPerBeat(bpm)
}

export function barsToBeats(bars: number, signature: TimeSignature): number {
  return bars * signature.beatsPerBar
}

/**
 * The quantization grid in beats. `none` is 0 (launch immediately);
 * `scene_end` returns null — the boundary is the playing scene's end, which
 * only the transport knows.
 */
export function quantizationGridBeats(quantization: Quantization, signature: TimeSignature): number | null {
  switch (quantization) {
    case 'none':
      return 0
    case '1/4':
      return 1
    case '1/2':
      return 2
    case '1bar':
      return signature.beatsPerBar
    case '2bars':
      return signature.beatsPerBar * 2
    case '4bars':
      return signature.beatsPerBar * 4
    case 'scene_end':
      return null
  }
}

/**
 * Floating-point slack when deciding whether "now" already sits on a boundary.
 * A trigger 2ms after the downbeat should launch on that downbeat's grid line,
 * not wait a whole bar.
 */
const BOUNDARY_EPSILON_BEATS = 1e-6

/**
 * The next launch boundary at or after `currentBeat` on a grid of `gridBeats`.
 * A grid of 0 means "no quantization": launch exactly now.
 */
export function nextBoundaryBeat(currentBeat: number, gridBeats: number): number {
  if (gridBeats <= 0) return currentBeat
  const gridsElapsed = currentBeat / gridBeats
  const rounded = Math.round(gridsElapsed)
  if (Math.abs(gridsElapsed - rounded) < BOUNDARY_EPSILON_BEATS) return rounded * gridBeats
  return Math.ceil(gridsElapsed) * gridBeats
}

/** Position display helpers: beat index within the bar, and the bar number, both 1-based. */
export function barBeat(currentBeat: number, signature: TimeSignature): { bar: number; beat: number } {
  const whole = Math.floor(Math.max(0, currentBeat))
  return {
    bar: Math.floor(whole / signature.beatsPerBar) + 1,
    beat: (whole % signature.beatsPerBar) + 1,
  }
}
