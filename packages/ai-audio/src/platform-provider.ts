import type { AiSceneRequest } from '@masterclip/performance-project'
import {
  assertGenerationAllowed,
  type AudioIntelligenceProvider,
  type GeneratedOption,
  type GenerationUsage,
  type SceneGenerationInput,
  type SceneGenerationResult,
} from './provider.js'
import { durationMsOf, wavDurationMs } from './wav.js'

/**
 * Bridges Live Lab's scene builder onto the platform's music-generation layer
 * (`@masterclip/audio-engine`'s registry — ElevenLabs when configured, the
 * platform mock otherwise).
 *
 * The composer is described *structurally* rather than imported from
 * `@masterclip/audio-core` on purpose. `ai-audio` is one of the packages the
 * desktop build takes with it, and it should not drag the entire audio
 * platform along to satisfy a type. Anything matching this shape works.
 */
export interface MusicComposer {
  readonly providerId: string
  isConfigured(): boolean
  generateMusic(input: {
    orgId: string
    prompt?: string
    musicLengthMs?: number
    instrumental?: boolean
    modelId?: string
    seed?: number
  }): Promise<{
    audio: { bytes: Uint8Array; contentType: string; filename?: string }
    seed?: number
    usage?: { unit: string; inputUnits?: number; outputUnits?: number; providerRequestId?: string }
  }>
}

const ENERGY_WORDS: Record<AiSceneRequest['energy'], string> = {
  sparse: 'very sparse, minimal, lots of space',
  low: 'restrained and understated',
  medium: 'steady, mid-energy',
  high: 'driving and energetic',
  peak: 'peak-energy, full and loud',
}

/**
 * Three takes per request, like the mock: same brief, deliberately different
 * readings, so the artist chooses rather than accepts.
 */
const SHAPES = [
  { label: 'OPTION A', note: 'as described', modifier: '' },
  { label: 'OPTION B', note: 'sparser take', modifier: ' Keep it sparser than the brief suggests; leave more space.' },
  { label: 'OPTION C', note: 'fuller take with a stronger lead-in', modifier: ' Build more insistently toward the end of the section.' },
] as const

export class PlatformMusicProvider implements AudioIntelligenceProvider {
  readonly id: string
  readonly displayName: string

  constructor(
    private readonly composer: MusicComposer,
    /** Reported as the model on generated lineage. */
    private readonly modelId = 'platform-music',
  ) {
    this.id = `platform:${composer.providerId}`
    this.displayName = `Platform music (${composer.providerId})`
  }

  available(): boolean {
    return this.composer.isConfigured()
  }

  async generateScene(input: SceneGenerationInput): Promise<SceneGenerationResult> {
    // Rights confirmation and imitation screening run before the platform
    // layer is touched, exactly as they do for the mock. This is the second
    // enforcement point, not the only one — the API route checks first.
    assertGenerationAllowed(input.request)

    const lengthMs = durationMsOf({ bpm: input.bpm, bars: input.request.bars, beatsPerBar: input.beatsPerBar })
    const options: GeneratedOption[] = []
    // Accumulated across the three renders: one job, three purchases.
    let usage: GenerationUsage | undefined
    for (const [index, shape] of SHAPES.entries()) {
      const result = await this.composer.generateMusic({
        orgId: input.orgId,
        prompt: buildPrompt(input, shape.modifier),
        musicLengthMs: lengthMs,
        // A performance section sits under an artist who is already singing.
        instrumental: true,
        seed: input.seed + index * 7919,
      })
      if (result.usage) {
        usage = {
          unit: result.usage.unit,
          inputUnits: (usage?.inputUnits ?? 0) + (result.usage.inputUnits ?? 0),
          outputUnits: (usage?.outputUnits ?? 0) + (result.usage.outputUnits ?? 0),
          // The last request's id: enough to find the job at the provider,
          // and honest that it identifies one of the three, not all.
          ...(result.usage.providerRequestId ? { providerRequestId: result.usage.providerRequestId } : {}),
        }
      }
      options.push({
        label: shape.label,
        wavBytes: result.audio.bytes,
        // The requested length is a request, not a promise: the platform mock
        // clamps to 3-30s and a hosted model returns what it returns. Reporting
        // the ask would have the engine schedule audio that is not there.
        durationMs: wavDurationMs(result.audio.bytes),
        // Stated on every option, because it is the one thing a generative
        // model cannot promise and a live show depends on: the length is
        // requested exactly, the *grid alignment* is not guaranteed. Preview
        // against the click before assigning it to a pad.
        description: `${shape.note} — ${input.request.bars} bars at ${Math.round(input.bpm)} BPM (check against the click before use)`,
      })
    }

    // costMicros stays 0: this layer does not price anything. The units below
    // are what the ledger records, and cost reconciliation is the platform's.
    return { options, model: this.modelId, costMicros: 0, ...(usage ? { usage } : {}) }
  }
}

/**
 * Composes the provider prompt from the artist's own words plus the structured
 * settings. The artist's text is passed through unaltered — it has already been
 * screened, and rewriting it would quietly change what they asked for.
 */
export function buildPrompt(input: SceneGenerationInput, modifier: string): string {
  const { request } = input
  const parts = [
    request.prompt.trim(),
    `${request.bars} bars at ${Math.round(input.bpm)} BPM in ${input.beatsPerBar}/4.`,
    `Energy: ${ENERGY_WORDS[request.energy] ?? request.energy}.`,
  ]
  if (request.instrumentation.length > 0) parts.push(`Instrumentation: ${request.instrumentation.join(', ')}.`)
  if (request.intendedTransition.trim().length > 0) parts.push(`It leads into: ${request.intendedTransition.trim()}.`)
  parts.push('Instrumental only, no vocals. Start and end cleanly so it can loop and be cut on the bar.')
  return (parts.join(' ') + modifier).trim()
}
