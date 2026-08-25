import { mean } from './dsp.js'
import { dbfs, peakDbfs, rms, type PcmAudio } from './pcm.js'
import type { AnalysisFrames } from './frames.js'

/**
 * Loudness, dynamics, silence and fades.
 *
 * The loudness figure is an *approximation* of programme loudness — mean-square
 * over gated 400 ms blocks, without the ITU-R BS.1770 K-weighting filter. It is
 * reported as an estimate with bounded confidence and labelled as such
 * everywhere it appears; Song Lab is a diagnostic tool, not a compliance meter,
 * and pretending otherwise would be exactly the fake precision this product
 * refuses.
 */

export interface LoudnessAnalysis {
  /** Approximate integrated programme loudness, LUFS-like. */
  loudnessLufs: number
  loudnessConfidence: number
  /** Loudness range: 95th minus 10th percentile of block loudness, in dB. */
  dynamicRangeDb: number
  peakDbfs: number
  /** Per-block loudness for the loudness-progression graph in Producer View. */
  blockLoudness: number[]
  method: string
}

const BLOCK_SECONDS = 0.4

export function analyzeLoudness(mono: Float32Array, sampleRate: number): LoudnessAnalysis {
  const blockSize = Math.max(1, Math.floor(BLOCK_SECONDS * sampleRate))
  const blocks: number[] = []
  for (let offset = 0; offset + blockSize <= mono.length; offset += blockSize) {
    const amplitude = rms(mono, offset, offset + blockSize)
    blocks.push(-0.691 + 10 * Math.log10(amplitude * amplitude + 1e-12))
  }
  if (blocks.length === 0) {
    return { loudnessLufs: -70, loudnessConfidence: 0, dynamicRangeDb: 0, peakDbfs: -Infinity, blockLoudness: [], method: 'gated_block_rms' }
  }

  // Absolute gate at −70 LUFS, then a relative gate 10 dB below the ungated
  // mean — the two-stage gate from BS.1770, which is what stops silence between
  // sections from dragging the figure down.
  const aboveAbsolute = blocks.filter((value) => value > -70)
  const gateReference = aboveAbsolute.length > 0 ? mean(aboveAbsolute) : mean(blocks)
  const gated = aboveAbsolute.filter((value) => value > gateReference - 10)
  const integrated = gated.length > 0 ? mean(gated) : mean(blocks)

  const sorted = [...gated.length > 0 ? gated : blocks].sort((a, b) => a - b)
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))]!

  return {
    loudnessLufs: Math.round(integrated * 10) / 10,
    // Bounded well below 1: this is an approximation of a standardized
    // measurement, not the measurement itself.
    loudnessConfidence: Math.min(0.7, blocks.length / 100),
    dynamicRangeDb: Math.round((percentile(95) - percentile(10)) * 10) / 10,
    peakDbfs: Math.round(peakDbfs(mono) * 10) / 10,
    blockLoudness: blocks.map((value) => Math.round(value * 10) / 10),
    method: 'gated_block_rms',
  }
}

export interface SilenceAnalysis {
  /** Leading silence in seconds. */
  leadInSeconds: number
  /** Trailing silence in seconds. */
  tailSeconds: number
  /** Detected fade-in duration, or null when the track starts abruptly. */
  fadeInSeconds: number | null
  /** Detected fade-out duration, or null when the track ends abruptly. */
  fadeOutSeconds: number | null
  /** Internal silences longer than 250 ms: `[startSeconds, endSeconds]`. */
  gaps: Array<[number, number]>
}

const SILENCE_DB = -50

export function analyzeSilence(frames: AnalysisFrames): SilenceAnalysis {
  const levels = frames.energy.map(dbfs)
  const isSilent = levels.map((level) => level < SILENCE_DB)

  let leadFrames = 0
  while (leadFrames < isSilent.length && isSilent[leadFrames]) leadFrames++
  let tailFrames = 0
  while (tailFrames < isSilent.length && isSilent[isSilent.length - 1 - tailFrames]) tailFrames++

  const gaps: Array<[number, number]> = []
  let gapStart = -1
  for (let i = leadFrames; i < isSilent.length - tailFrames; i++) {
    if (isSilent[i] && gapStart < 0) gapStart = i
    else if (!isSilent[i] && gapStart >= 0) {
      if ((i - gapStart) * frames.frameSeconds >= 0.25) gaps.push([gapStart * frames.frameSeconds, i * frames.frameSeconds])
      gapStart = -1
    }
  }

  return {
    leadInSeconds: Math.round(leadFrames * frames.frameSeconds * 100) / 100,
    tailSeconds: Math.round(tailFrames * frames.frameSeconds * 100) / 100,
    fadeInSeconds: detectFade(levels, leadFrames, 'in', frames.frameSeconds),
    fadeOutSeconds: detectFade(levels, tailFrames, 'out', frames.frameSeconds),
    gaps,
  }
}

/**
 * A fade is a monotonic level ramp of at least 12 dB. Programme material that
 * simply starts loud returns null rather than a spurious "0.0 s fade".
 */
function detectFade(levels: number[], edgeFrames: number, direction: 'in' | 'out', frameSeconds: number): number | null {
  const maxFadeFrames = Math.min(levels.length, Math.ceil(20 / frameSeconds))
  let previous = -Infinity
  let ramped = 0
  for (let step = 0; step < maxFadeFrames; step++) {
    const index = direction === 'in' ? edgeFrames + step : levels.length - 1 - edgeFrames - step
    if (index < 0 || index >= levels.length) break
    const level = levels[index]!
    if (level < -60) break
    if (level >= previous - 0.5) {
      ramped++
      previous = Math.max(previous, level)
    } else break
  }
  const rampSeconds = ramped * frameSeconds
  if (rampSeconds < 0.75) return null
  const startIndex = direction === 'in' ? edgeFrames : levels.length - 1 - edgeFrames
  const endIndex = direction === 'in' ? edgeFrames + ramped - 1 : levels.length - edgeFrames - ramped
  const gain = Math.abs((levels[endIndex] ?? -60) - (levels[startIndex] ?? -60))
  return gain >= 12 ? Math.round(rampSeconds * 10) / 10 : null
}

/**
 * Mean side/mid ratio across the song. `null` for mono sources — a mono file
 * has no stereo field to measure, which is different from a very narrow one.
 */
export function analyzeStereoWidth(frames: AnalysisFrames, audio: PcmAudio): { width: number | null; confidence: number } {
  if (audio.channels.length < 2 || frames.stereoWidth.length === 0) return { width: null, confidence: 0 }
  const width = mean(frames.stereoWidth)
  // A "stereo" file whose channels are identical is a mono file in a stereo
  // container; report no information rather than a width of zero.
  if (width < 1e-6) return { width: null, confidence: 0 }
  return { width: Math.round(width * 1000) / 1000, confidence: 0.7 }
}
