/**
 * Pure-Node WAV synthesis for the mock audio provider.
 *
 * Real, playable files matter: the pipeline stores them, signs URLs for them,
 * probes their duration, and the UI plays them — so demo mode exercises the
 * same code paths a paid render would, at zero cost and with no ffmpeg
 * dependency in this package.
 */

const SAMPLE_RATE = 22_050

export interface ToneSpec {
  /** Base frequency in Hz. */
  frequency: number
  durationSeconds: number
  /** 0..1 — kept low by default so demo audio is not startling. */
  amplitude?: number
}

/** Deterministic PRNG so identical seeds render identical bytes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFromString(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Renders a short melodic figure derived from the seed — distinct inputs sound
 * different, which makes "did the right asset come back?" audible in demos.
 */
export function renderWav(spec: ToneSpec & { seed?: number }): Uint8Array {
  const amplitude = Math.min(0.9, spec.amplitude ?? 0.25)
  const totalSamples = Math.max(1, Math.round(spec.durationSeconds * SAMPLE_RATE))
  const random = mulberry32(spec.seed ?? 1)
  const noteCount = Math.max(1, Math.min(16, Math.round(spec.durationSeconds * 2)))
  const samplesPerNote = Math.ceil(totalSamples / noteCount)
  const scale = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8, 2]

  const pcm = new Int16Array(totalSamples)
  for (let note = 0; note < noteCount; note++) {
    const ratio = scale[Math.floor(random() * scale.length)]!
    const freq = spec.frequency * ratio
    const start = note * samplesPerNote
    const end = Math.min(totalSamples, start + samplesPerNote)
    for (let i = start; i < end; i++) {
      const t = i / SAMPLE_RATE
      const local = (i - start) / Math.max(1, end - start)
      // Attack/decay envelope avoids clicks at note boundaries.
      const envelope = Math.min(1, local * 8) * Math.min(1, (1 - local) * 4)
      const sample = Math.sin(2 * Math.PI * freq * t) * amplitude * envelope
      pcm[i] = Math.round(sample * 32767)
    }
  }
  return pcmToWav(pcm, SAMPLE_RATE)
}

export function pcmToWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // PCM chunk size
  buffer.writeUInt16LE(1, 20) // PCM format
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(pcm[i]!, 44 + i * 2)
  return new Uint8Array(buffer)
}
