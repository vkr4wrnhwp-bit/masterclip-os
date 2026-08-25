import { describe, expect, it } from 'vitest'
import type { AiSceneRequest } from '@masterclip/performance-project'
import { checkPromptSafety } from '../src/safety.js'
import { durationMsOf, encodeWavPcm16, synthesize, synthesizeWav, SAMPLE_RATE } from '../src/wav.js'
import { MockAudioProvider } from '../src/mock-provider.js'
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
    const result = await provider.generateScene({ request: request(), bpm: 120, beatsPerBar: 4, sourceAudio: null, seed: 7 })
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
      provider.generateScene({ request: request({ rightsConfirmed: false }), bpm: 120, beatsPerBar: 4, sourceAudio: null, seed: 7 }),
    ).rejects.toThrow(/rights confirmation/)
  })

  it('refuses unsafe prompts at the provider layer too', () => {
    expect(() => assertGenerationAllowed(request({ prompt: 'in the style of Drake' }))).toThrow(/refused/)
  })
})
