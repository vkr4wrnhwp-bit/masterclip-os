/**
 * Pure-TypeScript audio synthesis and WAV encoding.
 *
 * This is what makes the whole AI layer exercisable with no credentials: the
 * mock provider renders genuine, decodable WAV files (and the demo seed builds
 * its placeholder stems the same way), so every downstream system — caching,
 * checksums, package verification, the Web Audio engine — handles real audio,
 * not empty placeholders.
 */

export const SAMPLE_RATE = 22050

/** Deterministic PRNG (mulberry32) so a given seed renders identical audio. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function encodeWavPcm16(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }
  return new Uint8Array(buffer)
}

export interface SynthesisSpec {
  bpm: number
  bars: number
  beatsPerBar?: number
  /** 0–1: how much is going on. */
  energy: number
  /** Which layers to render. */
  layers: {
    kick?: boolean
    hat?: boolean
    bass?: boolean
    pad?: boolean
    riser?: boolean
    click?: boolean
  }
  /** Root frequency in Hz for tonal layers. */
  rootHz?: number
  seed: number
  gain?: number
}

/**
 * Renders a musically plausible loop: four-on-the-floor kick, offbeat hats,
 * eighth-note bass, a sustained minor pad, and an optional riser. Not art —
 * but honest, tempo-locked audio that loops cleanly at the bar line.
 */
export function synthesize(spec: SynthesisSpec): Float32Array {
  const beatsPerBar = spec.beatsPerBar ?? 4
  const spb = 60 / spec.bpm
  const totalSeconds = spec.bars * beatsPerBar * spb
  const length = Math.round(totalSeconds * SAMPLE_RATE)
  const out = new Float32Array(length)
  const random = seededRandom(spec.seed)
  const root = spec.rootHz ?? 55 // A1
  const energy = Math.max(0, Math.min(1, spec.energy))
  const master = spec.gain ?? 0.8

  const totalBeats = spec.bars * beatsPerBar

  const addKick = (beat: number, gain: number) => {
    const start = Math.round(beat * spb * SAMPLE_RATE)
    const duration = Math.round(0.14 * SAMPLE_RATE)
    for (let i = 0; i < duration && start + i < length; i++) {
      const t = i / SAMPLE_RATE
      const freq = 130 * Math.exp(-t * 22) + 45
      const envelope = Math.exp(-t * 26)
      out[start + i]! += Math.sin(2 * Math.PI * freq * t) * envelope * gain
    }
  }

  const addHat = (beat: number, gain: number) => {
    const start = Math.round(beat * spb * SAMPLE_RATE)
    const duration = Math.round(0.03 * SAMPLE_RATE)
    for (let i = 0; i < duration && start + i < length; i++) {
      const envelope = Math.exp((-i / SAMPLE_RATE) * 180)
      out[start + i]! += (random() * 2 - 1) * envelope * gain
    }
  }

  const addBassNote = (beat: number, lengthBeats: number, freq: number, gain: number) => {
    const start = Math.round(beat * spb * SAMPLE_RATE)
    const duration = Math.round(lengthBeats * spb * SAMPLE_RATE * 0.9)
    for (let i = 0; i < duration && start + i < length; i++) {
      const t = i / SAMPLE_RATE
      const envelope = Math.min(1, t * 40) * Math.exp(-t * 2.2)
      const wave = Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(2 * Math.PI * freq * 2 * t)
      out[start + i]! += wave * envelope * gain
    }
  }

  const addClickTick = (beat: number, accent: boolean, gain: number) => {
    const start = Math.round(beat * spb * SAMPLE_RATE)
    const duration = Math.round(0.03 * SAMPLE_RATE)
    const freq = accent ? 1760 : 880
    for (let i = 0; i < duration && start + i < length; i++) {
      const t = i / SAMPLE_RATE
      const envelope = (1 - i / duration) ** 2
      out[start + i]! += Math.sin(2 * Math.PI * freq * t) * envelope * gain
    }
  }

  if (spec.layers.pad) {
    // Minor triad, softly detuned. Present even at low energy — it is the bed.
    const chord = [root * 2, root * 2 * 2 ** (3 / 12), root * 2 * 2 ** (7 / 12)]
    for (let i = 0; i < length; i++) {
      const t = i / SAMPLE_RATE
      let sample = 0
      for (const [index, freq] of chord.entries()) {
        sample += Math.sin(2 * Math.PI * (freq + index * 0.7) * t + index)
      }
      const fadeIn = Math.min(1, t / 0.5)
      const fadeOut = Math.min(1, (totalSeconds - t) / 0.5)
      out[i]! += sample * 0.06 * (0.5 + energy * 0.5) * fadeIn * Math.max(0, fadeOut)
    }
  }

  if (spec.layers.kick) {
    for (let beat = 0; beat < totalBeats; beat++) {
      const onFloor = beat % 1 === 0
      const sparseGate = energy > 0.6 || beat % beatsPerBar === 0 || (energy > 0.3 && beat % 2 === 0)
      if (onFloor && sparseGate) addKick(beat, 0.7 + energy * 0.3)
    }
  }

  if (spec.layers.hat) {
    for (let beat = 0.5; beat < totalBeats; beat += energy > 0.7 ? 0.5 : 1) {
      addHat(beat, 0.12 + energy * 0.15)
    }
  }

  if (spec.layers.bass) {
    const minorScale = [0, 3, 5, 7, 10]
    for (let beat = 0; beat < totalBeats; beat += 2) {
      const degree = minorScale[Math.floor(random() * minorScale.length)]!
      const freq = root * 2 ** (degree / 12)
      addBassNote(beat, 2, freq, 0.28 + energy * 0.18)
    }
  }

  if (spec.layers.riser) {
    // Noise riser over the final two bars.
    const riseBeats = Math.min(totalBeats, beatsPerBar * 2)
    const startSample = Math.round((totalBeats - riseBeats) * spb * SAMPLE_RATE)
    for (let i = startSample; i < length; i++) {
      const progress = (i - startSample) / Math.max(1, length - startSample)
      out[i]! += (random() * 2 - 1) * progress * progress * 0.22 * energy
    }
  }

  if (spec.layers.click) {
    for (let beat = 0; beat < totalBeats; beat++) {
      addClickTick(beat, beat % beatsPerBar === 0, 0.8)
    }
  }

  // Soft clip and apply master gain.
  for (let i = 0; i < length; i++) {
    out[i] = Math.tanh(out[i]!) * master
  }
  return out
}

/** Convenience: synthesize straight to an encoded WAV. */
export function synthesizeWav(spec: SynthesisSpec): Uint8Array {
  return encodeWavPcm16(synthesize(spec))
}

/**
 * Duration of a PCM WAV, read from its own header.
 *
 * Returns null for anything it cannot read — a hosted model may return mp3, and
 * a guess is worse than an admission here: the engine schedules against this
 * number, so a scene claimed longer than its audio runs into silence on stage.
 */
export function wavDurationMs(bytes: Uint8Array): number | null {
  try {
    return readWavDurationMs(bytes)
  } catch {
    // Unreadable is a real answer for this function, and the only safe one:
    // audio arrives here from a provider today and from uploads tomorrow.
    return null
  }
}

function readWavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset: number, text: string): boolean => {
    for (let i = 0; i < text.length; i++) if (view.getUint8(offset + i) !== text.charCodeAt(i)) return false
    return true
  }
  if (!ascii(0, 'RIFF') || !ascii(8, 'WAVE')) return null

  // Walk the chunk list rather than assuming a 44-byte canonical header: real
  // encoders insert LIST/fact chunks before the data.
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true)
    if (ascii(offset, 'fmt ')) {
      // The loop only guarantees the 8-byte chunk header is present, while a
      // fmt chunk is read through offset + 23. A file truncated inside its own
      // fmt chunk would otherwise throw out of a function documented to return
      // null for anything it cannot read.
      if (offset + 24 > bytes.length) return null
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bitsPerSample = view.getUint16(offset + 22, true)
    } else if (ascii(offset, 'data')) {
      const bytesPerFrame = (channels * bitsPerSample) / 8
      if (!sampleRate || !bytesPerFrame) return null
      // A truncated file reports more data than it carries; trust the bytes.
      const dataBytes = Math.min(size, bytes.length - (offset + 8))
      return Math.round((dataBytes / bytesPerFrame / sampleRate) * 1000)
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

export function durationMsOf(spec: Pick<SynthesisSpec, 'bpm' | 'bars' | 'beatsPerBar'>): number {
  const beatsPerBar = spec.beatsPerBar ?? 4
  return Math.round(spec.bars * beatsPerBar * (60 / spec.bpm) * 1000)
}
