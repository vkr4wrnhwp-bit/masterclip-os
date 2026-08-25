import { magnitudeSpectrum, spectralCentroid, spectralFlatness, spectralFlux, bandEnergyRatio, normalize, smooth } from './dsp.js'
import { rms, toMono, type PcmAudio } from './pcm.js'

/**
 * Frame-level analysis.
 *
 * Everything downstream — structure, energy, contrast, vocal activity, tempo —
 * reads these frames rather than the samples, so the audio is walked once. The
 * frame rate is fixed (not derived from the file) so two songs at different
 * sample rates yield directly comparable frame series.
 */

export const ANALYSIS_SAMPLE_RATE = 22050
export const FFT_SIZE = 2048
/** ~46 ms hop at 22.05 kHz: fine enough for onsets, coarse enough to stay cheap. */
export const HOP_SIZE = 1024

export interface AnalysisFrames {
  sampleRate: number
  hopSize: number
  fftSize: number
  /** Seconds per frame. */
  frameSeconds: number
  count: number
  /** Frame start time in seconds. */
  times: number[]
  /** RMS amplitude, 0–1. */
  energy: number[]
  /** Spectral centroid as a fraction of Nyquist. */
  centroid: number[]
  /** Spectral flatness, 0 (tonal) – 1 (noisy). */
  flatness: number[]
  /** Half-wave-rectified spectral flux, raw. */
  flux: number[]
  /** Energy share below ~200 Hz. */
  lowBand: number[]
  /** Energy share in the ~200 Hz–2 kHz band where most lead vocals sit. */
  midBand: number[]
  /** Energy share above ~4 kHz. */
  highBand: number[]
  /** 12-bin chroma per frame, for key estimation and harmonic similarity. */
  chroma: Float64Array[]
  /** Side/mid ratio per frame. Empty for mono sources. */
  stereoWidth: number[]
}

export interface FrameOptions {
  sampleRate?: number
  fftSize?: number
  hopSize?: number
}

/**
 * Walks the audio once and produces every per-frame descriptor.
 *
 * The band splits are expressed as fractions of Nyquist rather than Hz because
 * the analysis rate is fixed — at 22.05 kHz, 200 Hz is 0.018 of Nyquist.
 */
export function analyzeFrames(mono: Float32Array, audio: PcmAudio | null, opts: FrameOptions = {}): AnalysisFrames {
  const sampleRate = opts.sampleRate ?? ANALYSIS_SAMPLE_RATE
  const fftSize = opts.fftSize ?? FFT_SIZE
  const hopSize = opts.hopSize ?? HOP_SIZE
  const nyquist = sampleRate / 2
  const count = Math.max(0, Math.floor((mono.length - fftSize) / hopSize) + 1)

  const frames: AnalysisFrames = {
    sampleRate,
    hopSize,
    fftSize,
    frameSeconds: hopSize / sampleRate,
    count,
    times: new Array<number>(count),
    energy: new Array<number>(count),
    centroid: new Array<number>(count),
    flatness: new Array<number>(count),
    flux: new Array<number>(count),
    lowBand: new Array<number>(count),
    midBand: new Array<number>(count),
    highBand: new Array<number>(count),
    chroma: new Array<Float64Array>(count),
    stereoWidth: [],
  }

  let previous: Float64Array | null = null
  for (let i = 0; i < count; i++) {
    const offset = i * hopSize
    const magnitudes = magnitudeSpectrum(mono, offset, fftSize)
    frames.times[i] = offset / sampleRate
    frames.energy[i] = rms(mono, offset, offset + fftSize)
    frames.centroid[i] = spectralCentroid(magnitudes)
    frames.flatness[i] = spectralFlatness(magnitudes)
    frames.flux[i] = previous ? spectralFlux(previous, magnitudes) : 0
    frames.lowBand[i] = bandEnergyRatio(magnitudes, 0, 200 / nyquist)
    frames.midBand[i] = bandEnergyRatio(magnitudes, 200 / nyquist, 2000 / nyquist)
    frames.highBand[i] = bandEnergyRatio(magnitudes, 4000 / nyquist, 1)
    frames.chroma[i] = chromaFromSpectrum(magnitudes, sampleRate, fftSize)
    previous = magnitudes
  }

  if (audio && audio.channels.length >= 2) {
    frames.stereoWidth = stereoWidthPerFrame(audio, count, hopSize, fftSize, sampleRate)
  }

  return frames
}

/**
 * Folds the spectrum into 12 pitch classes.
 *
 * Bins below 65 Hz and above 2 kHz are skipped: below is where kick fundamentals
 * smear the estimate, above is mostly harmonics and cymbals.
 */
export function chromaFromSpectrum(magnitudes: Float64Array, sampleRate: number, fftSize: number): Float64Array {
  const chroma = new Float64Array(12)
  for (let bin = 1; bin < magnitudes.length; bin++) {
    const frequency = (bin * sampleRate) / fftSize
    if (frequency < 65 || frequency > 2000) continue
    // MIDI note number, then pitch class. 69 = A4 = 440 Hz.
    const note = 69 + 12 * Math.log2(frequency / 440)
    const pitchClass = ((Math.round(note) % 12) + 12) % 12
    chroma[pitchClass] += magnitudes[bin]!
  }
  let total = 0
  for (const value of chroma) total += value
  if (total > 0) for (let i = 0; i < 12; i++) chroma[i] = chroma[i]! / total
  return chroma
}

/**
 * Side/mid energy per frame.
 *
 * Reported only for genuinely multi-channel sources: a mono file has no stereo
 * field, and returning 0 for it would read as "extremely narrow mix" rather
 * than "no information".
 */
function stereoWidthPerFrame(audio: PcmAudio, count: number, hopSize: number, fftSize: number, sampleRate: number): number[] {
  const ratio = audio.sampleRate / sampleRate
  const left = audio.channels[0]!
  const right = audio.channels[1]!
  const out = new Array<number>(count)
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * hopSize * ratio)
    const to = Math.min(left.length, Math.floor((i * hopSize + fftSize) * ratio))
    let midEnergy = 0
    let sideEnergy = 0
    for (let j = from; j < to; j++) {
      const mid = ((left[j] ?? 0) + (right[j] ?? 0)) / 2
      const side = ((left[j] ?? 0) - (right[j] ?? 0)) / 2
      midEnergy += mid * mid
      sideEnergy += side * side
    }
    const total = midEnergy + sideEnergy
    out[i] = total > 0 ? sideEnergy / total : 0
  }
  return out
}

/**
 * The composite energy curve.
 *
 * Not LUFS. Perceived section energy is loudness *and* how much is happening:
 * spectral spread, transient activity, low-end weight and brightness all move
 * it. Weights are held here rather than scattered across callers so the curve
 * has one documented definition.
 */
export const ENERGY_WEIGHTS = {
  loudness: 0.4,
  transient: 0.2,
  spectralSpread: 0.15,
  lowEnd: 0.15,
  brightness: 0.1,
} as const

export function energyCurve(frames: AnalysisFrames): number[] {
  if (frames.count === 0) return []
  const loudness = normalize(frames.energy.map((value) => Math.log10(value + 1e-6)))
  const transient = normalize(smooth(frames.flux, 3))
  const spread = normalize(frames.flatness)
  const lowEnd = normalize(frames.lowBand)
  const brightness = normalize(frames.highBand)
  const curve = new Array<number>(frames.count)
  for (let i = 0; i < frames.count; i++) {
    curve[i] =
      ENERGY_WEIGHTS.loudness * loudness[i]! +
      ENERGY_WEIGHTS.transient * transient[i]! +
      ENERGY_WEIGHTS.spectralSpread * spread[i]! +
      ENERGY_WEIGHTS.lowEnd * lowEnd[i]! +
      ENERGY_WEIGHTS.brightness * brightness[i]!
  }
  return smooth(curve, 4)
}

/** Convenience: decode-free entry point when the caller already has PCM. */
export function framesFromAudio(audio: PcmAudio, opts: FrameOptions = {}): AnalysisFrames {
  return analyzeFrames(toMono(audio), audio, opts)
}
