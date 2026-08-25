import type { AiSceneRequest } from '@masterclip/performance-project'
import { checkPromptSafety } from './safety.js'

/**
 * The provider-agnostic AI audio layer.
 *
 * Mirrors the video side's provider architecture: a narrow interface, a
 * registry, and a mock that produces real output so the whole pipeline runs
 * with zero credentials. An ElevenLabs (or other music-model) adapter slots in
 * as another implementation of AudioIntelligenceProvider — nothing upstream
 * changes.
 */

export interface SceneGenerationInput {
  request: AiSceneRequest
  /** Effective tempo after tempoBehavior is applied. */
  bpm: number
  beatsPerBar: number
  /** Bytes of the owned source audio, when a source asset was selected. */
  sourceAudio: Uint8Array | null
  seed: number
}

export interface GeneratedOption {
  /** OPTION A / B / C. */
  label: string
  wavBytes: Uint8Array
  durationMs: number
  description: string
}

export interface SceneGenerationResult {
  options: GeneratedOption[]
  model: string
  costMicros: number
}

export interface AudioIntelligenceProvider {
  readonly id: string
  readonly displayName: string
  /** True when the provider can run right now (credentials present, reachable). */
  available(): boolean
  generateScene(input: SceneGenerationInput): Promise<SceneGenerationResult>
}

export class AudioProviderRegistry {
  private readonly providers = new Map<string, AudioIntelligenceProvider>()

  register(provider: AudioIntelligenceProvider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: string): AudioIntelligenceProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new Error(`unknown audio provider: ${id}`)
    return provider
  }

  list(): AudioIntelligenceProvider[] {
    return [...this.providers.values()]
  }
}

/**
 * Validates a generation request before any provider sees it. Rights
 * confirmation and prompt safety are enforced here — at the layer boundary —
 * in addition to the API route, so a future caller cannot skip them.
 */
export function assertGenerationAllowed(request: AiSceneRequest): void {
  if (!request.rightsConfirmed) {
    throw new Error('rights confirmation is required before AI processing of uploaded audio')
  }
  const verdict = checkPromptSafety(request.prompt)
  if (!verdict.allowed) {
    throw new Error(`prompt refused: ${verdict.reason}`)
  }
}
