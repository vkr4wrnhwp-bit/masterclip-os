import { magnitudeSpectrum, rms, type PcmAudio } from '@masterclip/song-analysis'
import { MIX_BANDS, type MixBandKey, type MixSpectrogram } from './types.js'

/**
 * The single spectral pass.
 *
 * Runs at the *source* sample rate rather than Song Lab's fixed 22.05 kHz
 * analysis rate. Song Lab asks structural questions — where the chorus is, how
 * dense the arrangement is — which a downsampled signal answers perfectly well.
 * Mix Station asks where the harshness and the sibilance are, and those live at
 * 5–10 kHz, above the Nyquist of a 22.05 kHz analysis. Downsampling first would
 * make half this module's metrics unmeasurable while still returning numbers.
 *
 * A 4096-point window at 44.1 kHz is ~93 ms with ~11 Hz resolution: fine enough
 * to separate a kick fundamental from a bass note, coarse enough that a
 * five-minute record is a few thousand frames.
 */

export const MIX_FFT_SIZE = 4096
export const MIX_HOP_SIZE = 2048

export function computeSpectrogram(audio: PcmAudio, opts: { fftSize?: number; hopSize?: number } = {}): MixSpectrogram {
  const fftSize = opts.fftSize ?? MIX_FFT_SIZE
  const hopSize = opts.hopSize ?? MIX_HOP_SIZE
  const sampleRate = audio.sampleRate
  // Spectra are averaged across channels in *power*, not taken from the mono
  // sum. The difference matters: a mix with a strongly out-of-phase element
  // partly cancels when summed, and a mono-sum spectrogram would report that
  // material as simply absent — the analyzer going blind exactly where a mix
  // has a problem worth finding. Phase behaviour is the stereo analyzer's
  // question and is measured there; spectral balance is a question about what
  // the record contains, and the answer must not depend on how it folds down.
  const count = Math.max(0, Math.floor((audio.frameCount - fftSize) / hopSize) + 1)
  const nyquist = sampleRate / 2

  // Bin ranges are resolved once. Bands that reach above Nyquist are clamped,
  // and `measurableCeilingHz` travels with the result so an analyzer can say
  // "this file has no content above 11 kHz to measure" rather than reporting a
  // confident zero for air.
  //
  // Edges are *rounded*, not floored and ceiled. Flooring the lower edge and
  // ceiling the upper one makes adjacent bands share a bin, which double-counts
  // that bin's energy — enough, on a record with a strong 55 Hz fundamental, to
  // push the six band shares past 100% and make every "x% of the energy"
  // statement in the product wrong. Rounding both edges makes band N's upper
  // bin exactly band N+1's lower bin, and the ranges are half-open.
  const ranges = {} as Record<MixBandKey, [number, number]>
  for (const [key, [low, high]] of Object.entries(MIX_BANDS) as Array<[MixBandKey, readonly [number, number]]>) {
    const bins = fftSize >> 1
    const from = Math.max(0, Math.round((low / nyquist) * bins))
    const to = Math.min(bins, Math.round((Math.min(high, nyquist) / nyquist) * bins))
    ranges[key] = [from, Math.max(from, to)]
  }

  const bands = {} as Record<MixBandKey, number[]>
  for (const key of Object.keys(MIX_BANDS) as MixBandKey[]) bands[key] = new Array<number>(count).fill(0)

  const spectrogram: MixSpectrogram = {
    sampleRate,
    fftSize,
    hopSize,
    frameSeconds: hopSize / sampleRate,
    count,
    times: new Array<number>(count),
    bands,
    total: new Array<number>(count).fill(0),
    rms: new Array<number>(count).fill(0),
    centroidHz: new Array<number>(count).fill(0),
    measurableCeilingHz: nyquist,
  }

  const bins = fftSize >> 1
  const binHz = sampleRate / fftSize
  const power = new Float64Array(bins)

  for (let frame = 0; frame < count; frame++) {
    const offset = frame * hopSize
    spectrogram.times[frame] = offset / sampleRate

    power.fill(0)
    // Frame level is the energy mean across channels, for the same reason: a
    // frame where the channels cancel still carries signal a listener hears on
    // anything but a mono system, and must not be treated as silence.
    let energy = 0
    for (const channel of audio.channels) {
      const magnitudes = magnitudeSpectrum(channel, offset, fftSize)
      for (let bin = 0; bin < bins; bin++) power[bin] += (magnitudes[bin] * magnitudes[bin]) / audio.channels.length
      const level = rms(channel, offset, offset + fftSize)
      energy += (level * level) / audio.channels.length
    }
    spectrogram.rms[frame] = Math.sqrt(energy)

    let total = 0
    let weighted = 0
    for (let bin = 0; bin < bins; bin++) {
      total += power[bin]
      weighted += power[bin] * bin * binHz
    }
    spectrogram.total[frame] = total
    spectrogram.centroidHz[frame] = total > 0 ? weighted / total : 0

    for (const key of Object.keys(ranges) as MixBandKey[]) {
      const [from, to] = ranges[key]
      let band = 0
      for (let bin = from; bin < to; bin++) band += power[bin]
      bands[key][frame] = band
    }
  }

  return spectrogram
}

/** Band share of total energy at one frame. Null when the frame carries no energy. */
export function bandShare(spectrogram: MixSpectrogram, band: MixBandKey, frame: number): number | null {
  const total = spectrogram.total[frame]
  if (!total || total <= 0) return null
  return spectrogram.bands[band][frame] / total
}

/** Mean band share across every frame carrying meaningful energy. */
export function meanBandShare(spectrogram: MixSpectrogram, band: MixBandKey, floorRms = 0.001): number | null {
  let sum = 0
  let counted = 0
  for (let frame = 0; frame < spectrogram.count; frame++) {
    if (spectrogram.rms[frame] < floorRms) continue
    const share = bandShare(spectrogram, band, frame)
    if (share === null) continue
    sum += share
    counted++
  }
  return counted === 0 ? null : sum / counted
}

/** Frames whose RMS is above the floor — i.e. the programme, not the silence. */
export function activeFrames(spectrogram: MixSpectrogram, floorRms = 0.001): number[] {
  const active: number[] = []
  for (let frame = 0; frame < spectrogram.count; frame++) {
    if (spectrogram.rms[frame] >= floorRms) active.push(frame)
  }
  return active
}

export function toDb(power: number): number {
  return 10 * Math.log10(power + 1e-20)
}

export function mean(values: ArrayLike<number>): number {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  return sum / values.length
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[index]
}

export function standardDeviation(values: ArrayLike<number>): number {
  if (values.length < 2) return 0
  const average = mean(values)
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += (values[i] - average) ** 2
  return Math.sqrt(sum / (values.length - 1))
}

/** Moving average. Radius is in frames; a radius of 0 is the identity. */
export function smoothSeries(values: number[], radius: number): number[] {
  if (radius <= 0) return [...values]
  const out = new Array<number>(values.length)
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - radius)
    const to = Math.min(values.length - 1, i + radius)
    let sum = 0
    for (let j = from; j <= to; j++) sum += values[j]
    out[i] = sum / (to - from + 1)
  }
  return out
}
