import { AppError } from '@masterclip/shared'

/**
 * PCM decoding.
 *
 * Analysis runs on samples, not on containers. WAV is decoded here in pure
 * TypeScript so the whole diagnostic pipeline works on a clean checkout with no
 * native dependency; anything else is transcoded to WAV by ffmpeg first (see
 * decode.ts). Keeping the decoder here rather than behind ffmpeg also means the
 * deterministic test fixtures never shell out.
 */

export interface PcmAudio {
  /** One Float32Array per channel, each `frameCount` long, samples in −1…1. */
  channels: Float32Array[]
  sampleRate: number
  frameCount: number
  durationMs: number
}

export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  return (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
  )
}

/**
 * Decodes RIFF/WAVE: PCM 8/16/24/32-bit and IEEE float 32-bit, any channel
 * count. Chunks are walked rather than assumed at fixed offsets — real files
 * from real DAWs carry LIST/bext/fact chunks ahead of `data`.
 */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  if (!isWav(bytes)) {
    throw new AppError({ kind: 'validation', code: 'song_lab.not_wav', message: 'expected RIFF/WAVE bytes' })
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let format = 1
  let channelCount = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataStart = -1
  let dataLength = 0

  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channelCount = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE carries the real format tag in its GUID head.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataStart = body
      // A streamed file can declare size 0; trust what is actually present.
      dataLength = size > 0 && body + size <= bytes.length ? size : bytes.length - body
    }
    offset = body + size + (size % 2)
    if (dataStart >= 0 && channelCount > 0) break
  }

  if (dataStart < 0 || channelCount <= 0 || sampleRate <= 0 || bitsPerSample <= 0) {
    throw new AppError({ kind: 'validation', code: 'song_lab.wav_unreadable', message: 'the WAV header is incomplete' })
  }
  const bytesPerSample = bitsPerSample >> 3
  const blockAlign = bytesPerSample * channelCount
  if (blockAlign <= 0) {
    throw new AppError({ kind: 'validation', code: 'song_lab.wav_unreadable', message: 'the WAV block alignment is invalid' })
  }
  const frameCount = Math.floor(dataLength / blockAlign)
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount))

  for (let frame = 0; frame < frameCount; frame++) {
    const base = dataStart + frame * blockAlign
    for (let channel = 0; channel < channelCount; channel++) {
      const at = base + channel * bytesPerSample
      channels[channel]![frame] = readSample(view, at, format, bitsPerSample)
    }
  }

  return { channels, sampleRate, frameCount, durationMs: Math.round((frameCount / sampleRate) * 1000) }
}

function readSample(view: DataView, at: number, format: number, bits: number): number {
  if (format === 3) return bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true)
  switch (bits) {
    case 8:
      // 8-bit WAV is unsigned by definition of the format.
      return (view.getUint8(at) - 128) / 128
    case 16:
      return view.getInt16(at, true) / 32768
    case 24: {
      const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
      return (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608
    }
    case 32:
      return view.getInt32(at, true) / 2147483648
    default:
      return 0
  }
}

/** Channel-average. Used by everything that does not care about the stereo field. */
export function toMono(audio: PcmAudio): Float32Array {
  if (audio.channels.length === 1) return audio.channels[0]!
  const out = new Float32Array(audio.frameCount)
  for (let i = 0; i < audio.frameCount; i++) {
    let sum = 0
    for (const channel of audio.channels) sum += channel[i] ?? 0
    out[i] = sum / audio.channels.length
  }
  return out
}

/**
 * Linear-interpolating resample. Analysis runs at a fixed rate so a 44.1k and a
 * 48k master produce comparable frame indices and, therefore, comparable
 * feature vectors.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples
  const ratio = fromRate / toRate
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const next = Math.min(index + 1, samples.length - 1)
    const fraction = position - index
    out[i] = (samples[index] ?? 0) * (1 - fraction) + (samples[next] ?? 0) * fraction
  }
  return out
}

/** Peak absolute sample, in dBFS. `-Infinity` for digital silence. */
export function peakDbfs(samples: Float32Array): number {
  let peak = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) peak = magnitude
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity
}

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  const start = Math.max(0, Math.floor(from))
  const end = Math.min(samples.length, Math.floor(to))
  if (end <= start) return 0
  let sum = 0
  for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / (end - start))
}

export function dbfs(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -120
}
