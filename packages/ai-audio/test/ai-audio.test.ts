import { describe, expect, it } from 'vitest'
import type { AiSceneRequest } from '@masterclip/performance-project'
import { checkPromptSafety } from '../src/safety.js'
import { durationMsOf, encodeWavPcm16, synthesize, synthesizeWav, wavDurationMs, SAMPLE_RATE } from '../src/wav.js'
import { MockAudioProvider } from '../src/mock-provider.js'
import { PlatformMusicProvider } from '../src/platform-provider.js'
import { assertGenerationAllowed } from '../src/provider.js'

const request = (over: Partial<AiSceneRequest> = {}): AiSceneRequest => ({
  prompt: 'a dark sparse 8 bar intro with heavy sub bass',
  bars: 8,
  tempoBehavior: 'keep',
  customBpm: null,
  keyBehavior: 'keep',
  customKey: null,
  energy: 'medium',
  instrumentation: [],
  intendedTransition: 'into the chorus',
  rightsConfirmed: true,
  ...over,
})

describe('prompt safety', () => {
  it('allows neutral musical descriptors', () => {
    expect(checkPromptSafety('dark, sparse, 90 BPM, heavy sub bass, drums enter after 8 bars').allowed).toBe(true)
    expect(checkPromptSafety('four bar drum transition into the next song').allowed).toBe(true)
  })

  it('blocks real-artist imitation phrasing', () => {
    expect(checkPromptSafety('make it in the style of Drake').allowed).toBe(false)
    expect(checkPromptSafety('should sound like Metro').allowed).toBe(false)
    expect(checkPromptSafety('a Travis type beat').allowed).toBe(false)
    expect(checkPromptSafety('imitate the producer').allowed).toBe(false)
    expect(checkPromptSafety('produced by Timbaland').allowed).toBe(false)
  })

  it('blocks voice cloning and protected-song recreation', () => {
    expect(checkPromptSafety('clone the voice of the singer').allowed).toBe(false)
    expect(checkPromptSafety('in the voice of a famous rapper').allowed).toBe(false)
    expect(checkPromptSafety('an AI cover of a hit song').allowed).toBe(false)
    expect(checkPromptSafety('sample "Billie Jean" here').allowed).toBe(false)
  })

  it('refuses empty prompts', () => {
    expect(checkPromptSafety('   ').allowed).toBe(false)
  })
})

describe('WAV synthesis', () => {
  it('encodes a valid RIFF/WAVE file of the right length', () => {
    const samples = synthesize({ bpm: 120, bars: 1, energy: 0.5, layers: { kick: true }, seed: 1 })
    expect(samples.length).toBe(2 * SAMPLE_RATE) // 1 bar of 4/4 at 120 BPM = 2s
    const wav = encodeWavPcm16(samples)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(wav.length).toBe(44 + samples.length * 2)
  })

  it('is deterministic per seed', () => {
    const spec = { bpm: 100, bars: 2, energy: 0.7, layers: { kick: true, bass: true }, seed: 42 } as const
    expect(synthesizeWav({ ...spec })).toEqual(synthesizeWav({ ...spec }))
  })

  it('actually makes sound', () => {
    const samples = synthesize({ bpm: 120, bars: 1, energy: 1, layers: { kick: true, bass: true, pad: true }, seed: 3 })
    const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0)
    expect(peak).toBeGreaterThan(0.1)
    expect(peak).toBeLessThanOrEqual(1)
  })

  it('computes tempo-locked durations', () => {
    expect(durationMsOf({ bpm: 120, bars: 8 })).toBe(16000)
    expect(durationMsOf({ bpm: 112, bars: 16, beatsPerBar: 4 })).toBe(Math.round((16 * 4 * 60 * 1000) / 112))
  })
})

describe('mock provider', () => {
  it('renders three distinct tempo-locked options', async () => {
    const provider = new MockAudioProvider()
    const result = await provider.generateScene({ orgId: 'org', request: request(), bpm: 120, beatsPerBar: 4, sourceAudio: null, seed: 7 })
    expect(result.options.map((o) => o.label)).toEqual(['OPTION A', 'OPTION B', 'OPTION C'])
    for (const option of result.options) {
      expect(option.durationMs).toBe(16000)
      expect(String.fromCharCode(...option.wavBytes.slice(0, 4))).toBe('RIFF')
    }
    // Distinct takes, not three copies.
    expect(result.options[0]!.wavBytes).not.toEqual(result.options[1]!.wavBytes)
    expect(result.costMicros).toBe(0)
  })

  it('refuses without rights confirmation — at the provider layer, not just the API', async () => {
    const provider = new MockAudioProvider()
    await expect(
      provider.generateScene({ orgId: 'org', request: request({ rightsConfirmed: false }), bpm: 120, beatsPerBar: 4, sourceAudio: null, seed: 7 }),
    ).rejects.toThrow(/rights confirmation/)
  })

  it('refuses unsafe prompts at the provider layer too', () => {
    expect(() => assertGenerationAllowed(request({ prompt: 'in the style of Drake' }))).toThrow(/refused/)
  })
})

describe('platform music bridge', () => {
  /** Records what the platform layer was asked for. */
  class RecordingComposer {
    readonly providerId = 'recording'
    readonly calls: Array<Record<string, unknown>> = []
    constructor(private readonly configured = true) {}
    isConfigured() {
      return this.configured
    }
    async generateMusic(input: Record<string, unknown>) {
      this.calls.push(input)
      return { audio: { bytes: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), contentType: 'audio/mpeg', filename: 'c.mp3' } }
    }
  }

  it('asks the platform for exactly the section length the tempo implies', async () => {
    const composer = new RecordingComposer()
    const provider = new PlatformMusicProvider(composer)
    const result = await provider.generateScene({
      orgId: 'org_1',
      request: request({ bars: 8 }),
      bpm: 120,
      beatsPerBar: 4,
      sourceAudio: null,
      seed: 5,
    })
    // 8 bars of 4/4 at 120 BPM = 16s.
    expect(composer.calls).toHaveLength(3)
    for (const call of composer.calls) {
      expect(call.musicLengthMs).toBe(16000)
      expect(call.orgId).toBe('org_1')
      expect(call.instrumental).toBe(true)
    }
    expect(result.options.map((o) => o.label)).toEqual(['OPTION A', 'OPTION B', 'OPTION C'])
    // Three takes must be genuinely different requests, not the same one thrice.
    expect(new Set(composer.calls.map((c) => c.seed)).size).toBe(3)
    expect(new Set(composer.calls.map((c) => c.prompt)).size).toBe(3)
  })

  it('carries the artist’s own words through unaltered', async () => {
    const composer = new RecordingComposer()
    await new PlatformMusicProvider(composer).generateScene({
      orgId: 'org_1',
      request: request({ prompt: 'dark sparse intro, sub bass only', bars: 4, instrumentation: ['sub bass'] }),
      bpm: 90,
      beatsPerBar: 4,
      sourceAudio: null,
      seed: 1,
    })
    const prompt = String(composer.calls[0]!.prompt)
    expect(prompt).toContain('dark sparse intro, sub bass only')
    expect(prompt).toContain('4 bars at 90 BPM')
    expect(prompt).toContain('sub bass')
  })

  it('enforces rights and prompt safety before the platform is touched', async () => {
    const composer = new RecordingComposer()
    const provider = new PlatformMusicProvider(composer)
    await expect(
      provider.generateScene({
        orgId: 'org_1',
        request: request({ rightsConfirmed: false }),
        bpm: 120,
        beatsPerBar: 4,
        sourceAudio: null,
        seed: 1,
      }),
    ).rejects.toThrow(/rights confirmation/)
    await expect(
      provider.generateScene({
        orgId: 'org_1',
        request: request({ prompt: 'in the style of Drake' }),
        bpm: 120,
        beatsPerBar: 4,
        sourceAudio: null,
        seed: 1,
      }),
    ).rejects.toThrow(/refused/)
    // The provider was never called for either.
    expect(composer.calls).toHaveLength(0)
  })

  it('reports itself unavailable when the platform provider has no credentials', () => {
    expect(new PlatformMusicProvider(new RecordingComposer(false)).available()).toBe(false)
    expect(new PlatformMusicProvider(new RecordingComposer(true)).available()).toBe(true)
  })

  it('warns on every option that grid alignment is not guaranteed', async () => {
    const provider = new PlatformMusicProvider(new RecordingComposer())
    const result = await provider.generateScene({
      orgId: 'org_1',
      request: request({ bars: 8 }),
      bpm: 128,
      beatsPerBar: 4,
      sourceAudio: null,
      seed: 2,
    })
    for (const option of result.options) expect(option.description).toMatch(/check against the click/)
  })
})

describe('wavDurationMs', () => {
  it('reads the length of a WAV from its own header', () => {
    const seconds = 2.5
    const wav = encodeWavPcm16(new Float32Array(Math.round(SAMPLE_RATE * seconds)), SAMPLE_RATE)
    expect(wavDurationMs(wav)).toBe(2500)
  })

  it('agrees with the requested length for audio rendered to order', () => {
    const spec = { bpm: 128, bars: 4, energy: 0.5, layers: { kick: true }, seed: 3 }
    const wav = synthesizeWav(spec)
    // Within a millisecond of the arithmetic: the same audio, measured instead
    // of assumed.
    expect(Math.abs((wavDurationMs(wav) ?? 0) - durationMsOf(spec))).toBeLessThanOrEqual(1)
  })

  it('returns null rather than guessing for anything it cannot read', () => {
    expect(wavDurationMs(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(wavDurationMs(new Uint8Array(64))).toBeNull()
    // An mp3 frame header — what a hosted music model actually returns.
    const mp3 = new Uint8Array(64)
    mp3[0] = 0xff
    mp3[1] = 0xfb
    expect(wavDurationMs(mp3)).toBeNull()
  })

  it('returns null for a fmt chunk that runs off the end of the file', () => {
    // Long enough to pass the 44-byte floor, but with a leading LIST chunk that
    // pushes 'fmt ' close to EOF: the chunk header fits, the fields it declares
    // do not. Reading past the end must be an answer, not a throw.
    const bytes = new Uint8Array(48)
    const view = new DataView(bytes.buffer)
    const ascii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }
    ascii(0, 'RIFF')
    view.setUint32(4, 40, true)
    ascii(8, 'WAVE')
    ascii(12, 'LIST') // 16 bytes of padding, so the next chunk starts at 36
    view.setUint32(16, 16, true)
    ascii(36, 'fmt ') // header fits in 48 bytes; its fields reach to 60
    view.setUint32(40, 16, true)

    expect(wavDurationMs(bytes)).toBeNull()
  })

  it('trusts the bytes present over a header that overstates them', () => {
    const wav = encodeWavPcm16(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)
    // Truncated in transit: the data chunk still claims the full length.
    const truncated = wav.slice(0, 44 + (wav.length - 44) / 2)
    const measured = wavDurationMs(truncated) ?? 0
    expect(measured).toBeGreaterThan(0)
    expect(measured).toBeLessThan(1000)
  })
})

describe('generation usage', () => {
  class MeteredComposer {
    readonly providerId = 'metered'
    isConfigured() {
      return true
    }
    async generateMusic() {
      return {
        audio: { bytes: new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), contentType: 'audio/mpeg' },
        usage: { unit: 'requests', inputUnits: 1, outputUnits: 30, providerRequestId: 'req_abc' },
      }
    }
  }

  const meteredRequest: AiSceneRequest = {
    prompt: 'a rolling section',
    bars: 8,
    tempoBehavior: 'keep',
    keyBehavior: 'keep',
    energy: 'medium',
    instrumentation: ['bass'],
    intendedTransition: '',
    rightsConfirmed: true,
  }

  it('reports what the provider measured, summed across the three options', async () => {
    const provider = new PlatformMusicProvider(new MeteredComposer())
    const result = await provider.generateScene({
      orgId: 'org_1',
      request: meteredRequest,
      bpm: 120,
      beatsPerBar: 4,
      sourceAudio: null,
      seed: 3,
    })

    // Three renders, so three purchases — not one.
    expect(result.options).toHaveLength(3)
    expect(result.usage?.unit).toBe('requests')
    expect(result.usage?.inputUnits).toBe(3)
    expect(result.usage?.outputUnits).toBe(90)
    expect(result.usage?.providerRequestId).toBe('req_abc')
    // Still unpriced here: the ledger reconciles cost, product logic does not.
    expect(result.costMicros).toBe(0)
  })

  it('reports no usage for a provider that bought nothing', async () => {
    const result = await new MockAudioProvider().generateScene({
      orgId: 'org_1',
      request: meteredRequest,
      bpm: 120,
      beatsPerBar: 4,
      sourceAudio: null,
      seed: 3,
    })
    // The local synthesizer costs nothing and does not belong in a ledger of
    // purchases — absent, not zero.
    expect(result.usage).toBeUndefined()
  })
})
