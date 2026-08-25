import type {
  DubbingJobStatus,
  DubbingProjectResult,
  DubbingProvider,
  DubbingRequest,
  ProviderAsset,
  ProviderHealth,
} from '@masterclip/audio-core'
import { ELEVENLABS_PROVIDER_ID, type ElevenLabsClient } from './client.js'
import { elevenLabsHealth } from './transcription.js'

interface DubbingCreateResponse {
  dubbing_id: string
  expected_duration_sec?: number
}

interface DubbingMetadataResponse {
  dubbing_id: string
  status: string
  target_languages?: string[]
  error?: string
}

/**
 * Dubbing adapter — `POST v1/dubbing`, `GET v1/dubbing/{id}`,
 * `GET v1/dubbing/{id}/audio/{language}`.
 *
 * The API dubs one target language per project, so the engine submits one
 * provider project per selected language and aggregates them under a single
 * Global Release Pack.
 */
export class ElevenLabsDubbingAdapter implements DubbingProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  supportsZeroRetention(): boolean {
    // Dubbing projects are stored provider-side while they render.
    return false
  }

  async createDubbingProject(input: DubbingRequest): Promise<DubbingProjectResult> {
    const target = input.targetLanguages[0]
    const fields: Record<string, string | undefined> = {
      source_lang: input.sourceLanguage,
      target_lang: target,
      num_speakers: input.numSpeakers !== undefined ? String(input.numSpeakers) : undefined,
      watermark: input.watermark ? 'true' : undefined,
    }
    const files = input.source.url && !input.source.bytes && !input.source.path ? [] : [{ field: 'file', input: input.source }]
    if (files.length === 0) fields.source_url = input.source.url
    const { body } = await this.client.multipart<DubbingCreateResponse>('v1/dubbing', fields, files)
    return {
      providerJobId: body.dubbing_id,
      ...(body.expected_duration_sec !== undefined ? { expectedDurationSeconds: body.expected_duration_sec } : {}),
    }
  }

  async getDubbingStatus(providerJobId: string): Promise<DubbingJobStatus> {
    const { body } = await this.client.json<DubbingMetadataResponse>(`v1/dubbing/${encodeURIComponent(providerJobId)}`)
    const status = body.status === 'dubbed' ? 'complete' : body.status === 'failed' ? 'failed' : 'dubbing'
    return {
      status,
      readyLanguages: status === 'complete' ? (body.target_languages ?? []) : [],
      ...(body.error ? { error: body.error } : {}),
    }
  }

  async downloadDubbingAsset(providerJobId: string, languageCode: string): Promise<ProviderAsset> {
    const { bytes, contentType } = await this.client.getBinary(
      `v1/dubbing/${encodeURIComponent(providerJobId)}/audio/${encodeURIComponent(languageCode)}`,
    )
    return { bytes, contentType, filename: `dub-${languageCode}` }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}
