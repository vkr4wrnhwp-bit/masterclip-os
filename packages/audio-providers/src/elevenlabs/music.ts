import { AppError } from '@masterclip/shared'
import type {
  CompositionPlanRequest,
  CompositionPlanResult,
  MusicGenerationProvider,
  MusicGenerationRequest,
  MusicGenerationResult,
  MusicInpaintingRequest,
  OwnedMusicUploadRequest,
  OwnedMusicUploadResult,
  ProviderHealth,
  StemSeparationProvider,
  StemSeparationRequest,
  StemSeparationResult,
} from '@masterclip/audio-core'
import { ELEVENLABS_PROVIDER_ID, usageFrom, type ElevenLabsClient } from './client.js'
import { elevenLabsHealth } from './transcription.js'

interface MusicUploadResponse {
  song_id?: string
  composition_plan?: unknown
}

/**
 * Music adapter — `POST v1/music` (compose), `v1/music/upload` (owned audio),
 * `v1/music/plan` (composition plans), `v1/music/stem-separation`.
 *
 * Every prompt that reaches this adapter has already passed Remix Lab's rights
 * confirmation and imitation screening; the adapter itself stays mechanical.
 */
export class ElevenLabsMusicAdapter implements MusicGenerationProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  supportsZeroRetention(): boolean {
    return false
  }

  async generateMusic(input: MusicGenerationRequest): Promise<MusicGenerationResult> {
    const body: Record<string, unknown> = {}
    if (input.prompt !== undefined && input.compositionPlan !== undefined) {
      throw new AppError({ kind: 'validation', code: 'music.prompt_and_plan', message: 'prompt and composition plan are mutually exclusive' })
    }
    if (input.prompt !== undefined) {
      body.prompt = input.prompt
      if (input.musicLengthMs !== undefined) body.music_length_ms = input.musicLengthMs
      if (input.instrumental !== undefined) body.force_instrumental = input.instrumental
    } else if (input.compositionPlan !== undefined) {
      body.composition_plan = input.compositionPlan
      if (input.seed !== undefined) body.seed = input.seed
    } else {
      throw new AppError({ kind: 'validation', code: 'music.empty', message: 'either a prompt or a composition plan is required' })
    }
    if (input.modelId ?? this.client.opts.musicModelId) body.model_id = input.modelId ?? this.client.opts.musicModelId

    const { bytes, contentType, requestId } = await this.client.jsonBinary('v1/music', body)
    return {
      audio: { bytes, contentType, filename: 'composition.mp3' },
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      usage: usageFrom('requests', 1, Math.round((input.musicLengthMs ?? 0) / 1000), requestId),
    }
  }

  async uploadOwnedMusic(input: OwnedMusicUploadRequest): Promise<OwnedMusicUploadResult> {
    try {
      const { body, requestId } = await this.client.multipart<MusicUploadResponse>('v1/music/upload', {}, [
        { field: 'file', input: input.audio },
      ])
      return {
        providerSongId: body.song_id ?? null,
        screening: 'accepted',
        usage: usageFrom('requests', 1, 0, requestId),
      }
    } catch (err) {
      // A provider refusal is a screening outcome to record, not an accusation
      // to relay — the engine shows "provider rights review required".
      if (err instanceof AppError && err.kind === 'provider_rejected') {
        return { providerSongId: null, screening: 'rights_review_required', message: err.message }
      }
      throw err
    }
  }

  async createInpaintingVersion(input: MusicInpaintingRequest): Promise<MusicGenerationResult> {
    // Inpainting composes from a plan whose sections reference the uploaded
    // song (`store_for_inpainting` / `song_id` lineage handled engine-side).
    const body: Record<string, unknown> = {
      composition_plan: input.compositionPlan,
      store_for_inpainting: true,
    }
    if (this.client.opts.musicModelId) body.model_id = this.client.opts.musicModelId
    const { bytes, contentType, requestId } = await this.client.jsonBinary('v1/music', body)
    return {
      audio: { bytes, contentType, filename: 'inpainted.mp3' },
      ...(input.providerSongId ? { providerSongId: input.providerSongId } : {}),
      compositionPlan: input.compositionPlan,
      usage: usageFrom('requests', 1, 0, requestId),
    }
  }

  async extractCompositionPlan(input: CompositionPlanRequest): Promise<CompositionPlanResult> {
    const body: Record<string, unknown> = {}
    if (input.prompt !== undefined) body.prompt = input.prompt
    if (input.musicLengthMs !== undefined) body.music_length_ms = input.musicLengthMs
    const { body: plan, requestId } = await this.client.json<unknown>('v1/music/plan', { method: 'POST', body })
    return { plan, usage: usageFrom('requests', 1, 0, requestId) }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}

/** Stem separation — `POST v1/music/stem-separation`, returns an archive. */
export class ElevenLabsStemSeparationAdapter implements StemSeparationProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  supportsZeroRetention(): boolean {
    return false
  }

  async separateStems(input: StemSeparationRequest): Promise<StemSeparationResult> {
    const { bytes, contentType, requestId } = await this.client.multipartBinary('v1/music/stem-separation', {}, [
      { field: 'file', input: input.audio },
    ])
    // The endpoint returns one archive containing the stems; the engine stores
    // it as a single asset and Remix Lab unpacks per-stem entries on demand.
    return {
      stems: [{ name: 'stems-archive', audio: { bytes, contentType, filename: 'stems.zip' } }],
      usage: usageFrom('requests', 1, 0, requestId),
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}
