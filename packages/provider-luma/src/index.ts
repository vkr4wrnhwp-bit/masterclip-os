import { AppError, httpJson, loadConfig, type AppConfig } from '@masterclip/shared'
import {
  BaseProvider,
  downloadProviderOutputs,
  dynamicPricing,
  type AccountBalance,
  type CanonicalRenderRequest,
  type CompletedJob,
  type DownloadedAsset,
  type ModelCapabilities,
  type NormalizedModel,
  type ProviderDeps,
  type ProviderEvent,
  type ProviderHealth,
  type ProviderJobStatus,
  type SubmittedJob,
} from '@masterclip/provider-core'

const RETRIEVED_AT = '2026-08-17'

function caps(overrides: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    modes: ['text_to_video', 'image_to_video', 'first_last_frame'],
    duration: { minSeconds: 5, maxSeconds: 9, allowedSeconds: [5, 9] },
    resolutions: ['540p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    fps: [],
    nativeAudio: false,
    dialogue: false,
    firstFrame: true,
    lastFrame: true,
    videoReference: false,
    extension: true,
    maxReferenceImages: 2,
    seed: false,
    negativePrompt: false,
    maxPromptChars: 1500,
    tier: 'standard',
    safetyControls: [],
    ...overrides,
  }
}

const LUMA_MODELS = [
  { modelId: 'ray-2', displayName: 'Luma Ray 2', capabilities: caps({ tier: 'premium' }) },
  { modelId: 'ray-flash-2', displayName: 'Luma Ray Flash 2', capabilities: caps({ tier: 'standard' }) },
]

export interface LumaProviderOptions extends ProviderDeps {
  config?: AppConfig
  apiKey?: string
  baseUrl?: string
}

/**
 * Luma Dream Machine adapter.
 *
 * Surface verified 2026-08-17 against Luma's official OpenAPI spec:
 *
 *   base     https://api.lumalabs.ai/dream-machine/v1   (the path prefix is part
 *                                                        of the base — hitting
 *                                                        /v1/generations is the
 *                                                        classic mistake)
 *   auth     Authorization: Bearer <key>   (no version header; version is in the path)
 *   submit   POST /generations/video       (text→video and image→video unified)
 *   status   GET  /generations/{id}        (queued · dreaming · completed · failed)
 *   balance  GET  /credits
 *
 * `dreaming` is Luma's running state, and `assets.progress_video` is a live
 * partial render available during it — surfaced here as progress metadata so
 * the queue UI can show something real while a shot cooks.
 */
export class LumaProvider extends BaseProvider {
  readonly providerId = 'luma'
  readonly displayName = 'Luma Dream Machine'

  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(opts: LumaProviderOptions) {
    super(opts)
    const config = opts.config ?? loadConfig()
    this.apiKey = opts.apiKey ?? config.LUMA_API_KEY
    this.baseUrl = `${(opts.baseUrl ?? config.LUMA_BASE_URL).replace(/\/+$/, '')}/dream-machine/v1`
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }
  }

  async listModels(): Promise<NormalizedModel[]> {
    const fetchedAt = new Date(this.deps.now()).toISOString()
    return LUMA_MODELS.map((spec) => ({
      providerId: this.providerId,
      modelId: spec.modelId,
      displayName: spec.displayName,
      family: 'luma',
      capabilities: spec.capabilities,
      pricing: dynamicPricing({
        retrievedAt: RETRIEVED_AT,
        sourceUrl: 'https://docs.lumalabs.ai',
        notes: 'Luma bills in credits; no rate-card endpoint was reachable during research. Track spend via GET /credits before and after a batch.',
      }),
      enabled: true,
      raw: spec,
      fetchedAt,
      source: 'static' as const,
    }))
  }

  async submit(request: CanonicalRenderRequest): Promise<SubmittedJob> {
    const body: Record<string, unknown> = {
      model: request.modelId,
      prompt: request.prompt,
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution,
      duration: `${Math.round(request.durationSeconds)}s`,
      loop: false,
    }

    // Luma expresses first/last frame as typed keyframes rather than separate fields.
    const keyframes: Record<string, unknown> = {}
    const first = request.inputs.firstFrame ?? request.inputs.references[0]
    if (first?.remoteRef ?? first?.url) keyframes.frame0 = { type: 'image', url: first?.remoteRef ?? first?.url }
    if (request.inputs.lastFrame) {
      keyframes.frame1 = { type: 'image', url: request.inputs.lastFrame.remoteRef ?? request.inputs.lastFrame.url }
    }
    if (Object.keys(keyframes).length > 0) body.keyframes = keyframes
    if (request.webhookUrl) body.callback_url = request.webhookUrl

    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/generations/video`, {
      method: 'POST',
      headers: this.headers(),
      body,
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 120_000,
    })

    const id = String(response.body.id ?? '')
    if (!id) {
      throw new AppError({ kind: 'provider_failed', code: 'luma.no_id', message: 'Luma submit returned no generation id' })
    }
    return {
      externalJobId: id,
      providerId: this.providerId,
      modelId: request.modelId,
      submittedAt: new Date(this.deps.now()).toISOString(),
      externalRequestId: request.requestId,
      raw: response.body,
    }
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/generations/${encodeURIComponent(externalJobId)}`, {
      headers: this.headers(),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 30_000,
    })
    return this.mapStatus(externalJobId, response.body)
  }

  private mapStatus(externalJobId: string, body: Record<string, unknown>): ProviderJobStatus {
    const state = String(body.state ?? '')
    const assets = (body.assets ?? {}) as Record<string, unknown>
    const videoUrl = String(assets.video ?? '')

    return {
      externalJobId,
      state: state === 'completed' ? 'succeeded' : state === 'failed' ? 'failed' : state === 'queued' ? 'queued' : 'running',
      progress: null,
      outputs: state === 'completed' && videoUrl ? [{ url: videoUrl, mime: 'video/mp4', index: 0 }] : [],
      error: state === 'failed' ? { code: 'luma.failed', message: String(body.failure_reason ?? 'generation failed'), retryable: true } : null,
      actualMicros: null,
      actualCredits: null,
      billableSeconds: null,
      raw: { ...body, progress_video: assets.progress_video ?? null },
    }
  }

  async cancel(externalJobId: string): Promise<void> {
    await httpJson(`${this.baseUrl}/generations/${encodeURIComponent(externalJobId)}`, {
      method: 'DELETE',
      headers: this.headers(),
      provider: this.providerId,
      timeoutMs: 30_000,
    })
  }

  async normalizeWebhook(payload: unknown): Promise<ProviderEvent> {
    const body = (payload ?? {}) as Record<string, unknown>
    const id = String(body.id ?? '')
    if (!id) throw new AppError({ kind: 'validation', code: 'luma.webhook_no_id', message: 'Luma callback carried no generation id' })
    const status = this.mapStatus(id, body)
    return {
      providerId: this.providerId,
      externalJobId: id,
      dedupeKey: `${id}:${String(body.state ?? '')}`,
      status,
      receivedAt: new Date(this.deps.now()).toISOString(),
      raw: payload,
    }
  }

  async downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
    return downloadProviderOutputs(job, destDir)
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/credits`, {
      headers: this.headers(),
      provider: this.providerId,
      timeoutMs: 20_000,
    })
    const credits = Number(response.body.credit_balance ?? response.body.credits ?? 0)
    return {
      providerId: this.providerId,
      balanceMicros: null,
      credits: Number.isFinite(credits) ? credits : null,
      currency: 'credits',
      raw: response.body,
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.deps.now()).toISOString()
    if (!this.isConfigured()) {
      return { providerId: this.providerId, status: 'unconfigured', latencyMs: null, message: 'LUMA_API_KEY is not set', checkedAt }
    }
    try {
      const response = await httpJson(`${this.baseUrl}/credits`, { headers: this.headers(), provider: this.providerId, timeoutMs: 15_000 })
      return {
        providerId: this.providerId,
        status: response.latencyMs > 5_000 ? 'degraded' : 'healthy',
        latencyMs: response.latencyMs,
        message: 'credits endpoint reachable',
        checkedAt,
      }
    } catch (err) {
      return {
        providerId: this.providerId,
        status: 'unavailable',
        latencyMs: null,
        message: err instanceof Error ? err.message : String(err),
        checkedAt,
      }
    }
  }
}

export function createLumaProvider(opts: LumaProviderOptions): LumaProvider {
  return new LumaProvider(opts)
}

export { LUMA_MODELS }
