import { describe, expect, it } from 'vitest'
import {
  analyzeFrames,
  analyzeLoudness,
  analyzeSilence,
  decodeWav,
  detectVocalActivity,
  energyCurve,
  estimateKey,
  estimateTempo,
  fft,
  isWav,
  peakDbfs,
  resample,
  toMono,
} from '../src/index.js'

/**
 * DSP correctness.
 *
 * These pin the properties the rest of Song Lab depends on: that a known signal
 * produces the known answer, and — just as important — that an ambiguous signal
 * produces a *low-confidence* answer rather than a confident wrong one.
 */

const SAMPLE_RATE = 22050

function encodeWav(channels: Float32Array[], sampleRate = SAMPLE_RATE): Uint8Array {
  const frames = channels[0]!.length
  const channelCount = channels.length
  const dataBytes = frames * channelCount * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channelCount, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channelCount * 2, 28)
  buffer.writeUInt16LE(channelCount * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  let offset = 44
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channel[frame]!)) * 32767), offset)
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}

function tone(hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SAMPLE_RATE))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude
  return out
}

/** Impulses at a fixed BPM — a click track with an unambiguous tempo. */
function clickTrack(bpm: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SAMPLE_RATE))
  const period = (60 / bpm) * SAMPLE_RATE
  for (let beat = 0; beat * period < out.length; beat++) {
    const start = Math.floor(beat * period)
    for (let i = 0; i < 220 && start + i < out.length; i++) {
      out[start + i] = Math.sin((2 * Math.PI * 900 * i) / SAMPLE_RATE) * Math.exp(-i / 40)
    }
  }
  return out
}

describe('FFT', () => {
  it('finds the bin of a pure tone', () => {
    const size = 1024
    const real = new Float64Array(size)
    const imag = new Float64Array(size)
    const binHz = SAMPLE_RATE / size
    const targetBin = 20
    for (let i = 0; i < size; i++) real[i] = Math.sin((2 * Math.PI * targetBin * binHz * i) / SAMPLE_RATE)
    fft(real, imag)

    let peakBin = 0
    let peak = -Infinity
    for (let i = 1; i < size / 2; i++) {
      const magnitude = Math.hypot(real[i]!, imag[i]!)
      if (magnitude > peak) {
        peak = magnitude
        peakBin = i
      }
    }
    expect(peakBin).toBe(targetBin)
  })

  it('rejects a non-power-of-two size rather than returning nonsense', () => {
    expect(() => fft(new Float64Array(1000), new Float64Array(1000))).toThrow(/power of two/)
  })
})

describe('WAV decoding', () => {
  it('round-trips samples, channel count and rate', () => {
    const left = tone(440, 0.5)
    const right = tone(660, 0.5)
    const decoded = decodeWav(encodeWav([left, right]))
    expect(decoded.channels).toHaveLength(2)
    expect(decoded.sampleRate).toBe(SAMPLE_RATE)
    expect(decoded.frameCount).toBe(left.length)
    // 16-bit quantization, so exact equality is not the right assertion.
    expect(decoded.channels[0]![100]).toBeCloseTo(left[100]!, 3)
    expect(decoded.channels[1]![100]).toBeCloseTo(right[100]!, 3)
  })

  it('refuses bytes that are not RIFF/WAVE', () => {
    expect(isWav(new Uint8Array([1, 2, 3, 4]))).toBe(false)
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it('resamples to a fixed analysis rate', () => {
    const source = tone(440, 1)
    const resampled = resample(source, SAMPLE_RATE, SAMPLE_RATE / 2)
    expect(resampled.length).toBe(Math.floor(source.length / 2))
  })
})

describe('tempo estimation', () => {
  it('recovers the tempo of a click track with real confidence', () => {
    const audio = decodeWav(encodeWav([clickTrack(120, 12)]))
    const frames = analyzeFrames(toMono(audio), audio)
    const tempo = estimateTempo(frames)
    expect(tempo.bpm).not.toBeNull()
    // Half- and double-time are the classic failure; accept only the real one.
    expect(Math.abs(tempo.bpm! - 120)).toBeLessThan(6)
    expect(tempo.confidence).toBeGreaterThan(0.1)
    expect(tempo.beats.length).toBeGreaterThan(10)
  })

  it('reports no tempo for material with no pulse, rather than guessing', () => {
    const audio = decodeWav(encodeWav([tone(220, 8, 0.4)]))
    const frames = analyzeFrames(toMono(audio), audio)
    const tempo = estimateTempo(frames)
    // A sustained tone has no onsets. Either "no answer" or an answer whose
    // confidence says not to trust it — never a confident number.
    expect(tempo.bpm === null || tempo.confidence < 0.5).toBe(true)
  })
})

describe('key estimation', () => {
  it('names a tonal centre for a clear triad', () => {
    // A minor: A3, C4, E4.
    const a = tone(220, 6, 0.3)
    const c = tone(261.63, 6, 0.3)
    const e = tone(329.63, 6, 0.3)
    const mixed = new Float32Array(a.length)
    for (let i = 0; i < mixed.length; i++) mixed[i] = a[i]! + c[i]! + e[i]!
    const audio = decodeWav(encodeWav([mixed]))
    const key = estimateKey(analyzeFrames(toMono(audio), audio))
    expect(key.key).not.toBeNull()
    expect(key.confidence).toBeGreaterThan(0)
  })

  it('returns no key for silence rather than inventing one', () => {
    const audio = decodeWav(encodeWav([new Float32Array(SAMPLE_RATE * 3)]))
    const key = estimateKey(analyzeFrames(toMono(audio), audio))
    expect(key.key).toBeNull()
    expect(key.confidence).toBe(0)
  })
})

describe('loudness and silence', () => {
  it('measures peak and reports a louder signal as louder', () => {
    const quiet = tone(440, 2, 0.05)
    const loud = tone(440, 2, 0.8)
    expect(peakDbfs(loud)).toBeGreaterThan(peakDbfs(quiet))
    const quietLoudness = analyzeLoudness(quiet, SAMPLE_RATE)
    const loudLoudness = analyzeLoudness(loud, SAMPLE_RATE)
    expect(loudLoudness.loudnessLufs).toBeGreaterThan(quietLoudness.loudnessLufs)
    // The figure is an approximation of programme loudness, so confidence is
    // deliberately capped well below certainty.
    expect(loudLoudness.loudnessConfidence).toBeLessThanOrEqual(0.7)
  })

  it('finds leading and trailing silence', () => {
    const body = tone(440, 2, 0.6)
    const padded = new Float32Array(SAMPLE_RATE * 4)
    padded.set(body, SAMPLE_RATE)
    const audio = decodeWav(encodeWav([padded]))
    const silence = analyzeSilence(analyzeFrames(toMono(audio), audio))
    expect(silence.leadInSeconds).toBeGreaterThan(0.5)
    expect(silence.tailSeconds).toBeGreaterThan(0.5)
  })
})

describe('energy and vocal activity', () => {
  it('produces an energy curve that rises with a louder section', () => {
    const quiet = tone(220, 3, 0.08)
    const loud = tone(220, 3, 0.8)
    const combined = new Float32Array(quiet.length + loud.length)
    combined.set(quiet, 0)
    combined.set(loud, quiet.length)
    const audio = decodeWav(encodeWav([combined]))
    const curve = energyCurve(analyzeFrames(toMono(audio), audio))
    const half = Math.floor(curve.length / 2)
    const firstHalf = curve.slice(0, half).reduce((sum, value) => sum + value, 0) / half
    const secondHalf = curve.slice(half).reduce((sum, value) => sum + value, 0) / (curve.length - half)
    expect(secondHalf).toBeGreaterThan(firstHalf)
  })

  it('caps vocal-detection confidence when working from a full mix', () => {
    const audio = decodeWav(encodeWav([tone(300, 4, 0.5)]))
    const activity = detectVocalActivity(analyzeFrames(toMono(audio), audio))
    // Inference from a mix, not measurement of a stem. The number must say so.
    expect(activity.confidence).toBeLessThan(0.6)
    expect(activity.method).toBe('spectral_band_proxy')
  })

  it('reports higher confidence when given an isolated vocal stem', () => {
    const audio = decodeWav(encodeWav([tone(300, 4, 0.5)]))
    const activity = detectVocalActivity(analyzeFrames(toMono(audio), audio), { isolatedVocal: true })
    expect(activity.confidence).toBeGreaterThan(0.6)
  })
})

describe('stereo width', () => {
  it('is unmeasurable for a mono file rather than reported as zero', async () => {
    const { analyzeStereoWidth } = await import('../src/loudness.js')
    const audio = decodeWav(encodeWav([tone(440, 2)]))
    const width = analyzeStereoWidth(analyzeFrames(toMono(audio), audio), audio)
    expect(width.width).toBeNull()
    expect(width.confidence).toBe(0)
  })

  it('measures a genuinely wide stereo signal', async () => {
    const { analyzeStereoWidth } = await import('../src/loudness.js')
    const left = tone(440, 2, 0.6)
    const right = tone(440, 2, 0.6).map((value) => -value) as Float32Array
    const audio = decodeWav(encodeWav([left, right]))
    const width = analyzeStereoWidth(analyzeFrames(toMono(audio), audio), audio)
    expect(width.width).not.toBeNull()
    expect(width.width!).toBeGreaterThan(0.5)
  })
})
