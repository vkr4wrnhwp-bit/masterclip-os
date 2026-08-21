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
  type ProviderOutputRef,
  type SubmittedJob,
} from '@masterclip/provider-core'
import { verifyHmacSignature } from '@masterclip/provider-core'

const RETRIEVED_AT = '2026-08-17'

export interface ReplicateProviderOptions extends ProviderDeps {
  config?: AppConfig
  apiToken?: string
  baseUrl?: string
  /**
   * `owner/name` slugs to expose. Replicate has no video-model index and its
   * slugs change, so the operator configures the list rather than the code
   * hardcoding guesses.
   */
  models?: string[]
  webhookSecret?: string
}

/**
 * Replicate adapter.
 *
 * Surface verified 2026-08-17 against Replicate's official Python client:
 *
 *   auth     Authorization: Bearer <token>
 *   submit   POST /v1/models/{owner}/{name}/predictions   (current version)
 *            POST /v1/predictions                          (pinned version SHA)
 *   status   GET  /v1/predictions/{id}
 *            (starting · processing · succeeded · failed · canceled — one L)
 *   cancel   POST /v1/predictions/{id}/cancel
 *   schema   GET  /v1/models/{owner}/{name} → latest_version.openapi_schema
 *   secret   GET  /v1/webhooks/default/secret → { key: "whsec_…" }
 *
 * The architectural difference from every other adapter: **Replicate's `input`
 * is model-defined and untyped.** There is no fixed request schema, so this
 * adapter is schema-driven — it fetches each model's `openapi_schema` and maps
 * canonical fields onto whatever input names that model declares, rather than
 * hardcoding a payload shape that would be wrong for the next model.
 *
 * Replicate also has no balance or spend endpoint. `GET /v1/account` returns
 * identity only. Spend must be tracked internally from `metrics.predict_time`,
 * which is why the cost ledger — not the provider — is the source of truth here.
 */
export class ReplicateProvider extends BaseProvider {
  readonly providerId = 'replicate'
  readonly displayName = 'Replicate'

  private readonly apiToken: string
  private readonly baseUrl: string
  private readonly modelSlugs: string[]
  private readonly webhookSecret: string
  private readonly schemaCache = new Map<string, { schema: Record<string, unknown>; fetchedAtMs: number }>()

  constructor(opts: ReplicateProviderOptions) {
    super(opts)
    const config = opts.config ?? loadConfig()
    this.apiToken = opts.apiToken ?? config.REPLICATE_API_TOKEN
    this.baseUrl = (opts.baseUrl ?? config.REPLICATE_BASE_URL).replace(/\/+$/, '')
    this.modelSlugs = opts.models ?? []
    this.webhookSecret = opts.webhookSecret ?? ''
  }

  isConfigured(): boolean {
    return this.apiToken.length > 0
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' }
  }

  /**
   * Lists only the models the operator configured. Returning an invented
   * catalog would be worse than returning an empty one: Replicate slugs change,
   * and a stale hardcoded slug fails at submit time after the shot is planned.
   */
  async listModels(): Promise<NormalizedModel[]> {
    const fetchedAt = new Date(this.deps.now()).toISOString()
    const models: NormalizedModel[] = []
    for (const slug of this.modelSlugs) {
      try {
        const detail = await this.fetchModel(slug)
        models.push({
          providerId: this.providerId,
          modelId: slug,
          displayName: String(detail.name ?? slug),
          family: slug.split('/')[0] ?? 'replicate',
          capabilities: capabilitiesFromSchema(detail),
          pricing: dynamicPricing({
            retrievedAt: RETRIEVED_AT,
            sourceUrl: 'https://replicate.com/pricing',
            notes:
              'Replicate bills per second of hardware time; the rate depends on the SKU the model runs on and cannot be known before the prediction completes. Actual cost is derived from metrics.predict_time.',
          }),
          enabled: true,
          raw: detail,
          fetchedAt,
          source: 'catalog' as const,
        })
      } catch (err) {
        this.deps.logger.warn('replicate.model_unavailable', { slug, err })
      }
    }
    return models
  }

  private async fetchModel(slug: string): Promise<Record<string, unknown>> {
    const cached = this.schemaCache.get(slug)
    if (cached && this.deps.now() - cached.fetchedAtMs < 60 * 60_000) return cached.schema
    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/v1/models/${slug}`, {
      headers: this.headers(),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 30_000,
    })
    this.schemaCache.set(slug, { schema: response.body, fetchedAtMs: this.deps.now() })
    return response.body
  }

  async submit(request: CanonicalRenderRequest): Promise<SubmittedJob> {
    const detail = await this.fetchModel(request.modelId)
    const input = mapInputToSchema(request, detail)

    const body: Record<string, unknown> = { input }
    if (request.webhookUrl) {
      body.webhook = request.webhookUrl
      body.webhook_events_filter = ['completed']
    }

    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/v1/models/${request.modelId}/predictions`, {
      method: 'POST',
      headers: this.headers(),
      body,
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 120_000,
    })

    const id = String(response.body.id ?? '')
    if (!id) throw new AppError({ kind: 'provider_failed', code: 'replicate.no_id', message: 'Replicate returned no prediction id' })
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
    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/v1/predictions/${encodeURIComponent(externalJobId)}`, {
      headers: this.headers(),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 30_000,
    })
    return this.mapStatus(externalJobId, response.body)
  }

  private mapStatus(externalJobId: string, body: Record<string, unknown>): ProviderJobStatus {
    const status = String(body.status ?? '')
    const metrics = (body.metrics ?? {}) as Record<string, unknown>
    const predictTime = Number(metrics.predict_time)

    const state: ProviderJobStatus['state'] =
      status === 'succeeded'
        ? 'succeeded'
        : status === 'failed'
          ? 'failed'
          : status === 'canceled'
            ? 'cancelled'
            : status === 'starting'
              ? 'queued'
              : 'running'

    return {
      externalJobId,
      state,
      progress: null,
      outputs: state === 'succeeded' ? normalizeOutput(body.output) : [],
      error: state === 'failed' ? { code: 'replicate.failed', message: String(body.error ?? 'prediction failed'), retryable: true } : null,
      // Cost is hardware-time × SKU rate. The SKU rate is not exposed by the
      // API, so the seconds are reported and the ledger applies the operator's
      // configured rate rather than this adapter inventing one.
      actualMicros: null,
      actualCredits: null,
      billableSeconds: Number.isFinite(predictTime) ? predictTime : null,
      raw: body,
    }
  }

  async cancel(externalJobId: string): Promise<void> {
    await httpJson(`${this.baseUrl}/v1/predictions/${encodeURIComponent(externalJobId)}/cancel`, {
      method: 'POST',
      headers: this.headers(),
      provider: this.providerId,
      timeoutMs: 30_000,
    })
  }

  /**
   * Replicate signs webhooks with a shared secret fetched from
   * `GET /v1/webhooks/default/secret`. Verification runs against the raw body;
   * without a configured secret the delivery is rejected rather than trusted.
   */
  async normalizeWebhook(payload: unknown, headers: Headers): Promise<ProviderEvent> {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
    if (this.webhookSecret) {
      verifyHmacSignature({
        rawBody: raw,
        signatureHeader: headers.get('webhook-signature'),
        timestampHeader: headers.get('webhook-timestamp'),
        secret: this.webhookSecret,
        nowMs: this.deps.now(),
      })
    } else {
      throw new AppError({
        kind: 'forbidden',
        code: 'replicate.no_webhook_secret',
        message: 'Replicate webhook received but no signing secret is configured — fetch it from GET /v1/webhooks/default/secret',
      })
    }

    const body = (typeof payload === 'string' ? JSON.parse(payload) : payload) as Record<string, unknown>
    const id = String(body.id ?? '')
    return {
      providerId: this.providerId,
      externalJobId: id,
      dedupeKey: `${id}:${String(body.status ?? '')}`,
      status: this.mapStatus(id, body),
      receivedAt: new Date(this.deps.now()).toISOString(),
      raw: payload,
    }
  }

  async downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
    return downloadProviderOutputs(job, destDir)
  }

  async getAccountBalance(): Promise<AccountBalance> {
    throw new AppError({
      kind: 'validation',
      code: 'replicate.no_balance_endpoint',
      message:
        'Replicate exposes no balance or spend endpoint — GET /v1/account returns identity only. MASTERCLIP tracks Replicate spend internally from prediction hardware time.',
    })
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.deps.now()).toISOString()
    if (!this.isConfigured()) {
      return { providerId: this.providerId, status: 'unconfigured', latencyMs: null, message: 'REPLICATE_API_TOKEN is not set', checkedAt }
    }
    try {
      const response = await httpJson(`${this.baseUrl}/v1/account`, { headers: this.headers(), provider: this.providerId, timeoutMs: 15_000 })
      return {
        providerId: this.providerId,
        status: response.latencyMs > 5_000 ? 'degraded' : 'healthy',
        latencyMs: response.latencyMs,
        message: 'account endpoint reachable',
        checkedAt,
      }
    } catch (err) {
      return { providerId: this.providerId, status: 'unavailable', latencyMs: null, message: err instanceof Error ? err.message : String(err), checkedAt }
    }
  }
}

/**
 * Derives capabilities from the model's declared input schema. Conservative by
 * design: a field we do not recognise becomes an absent capability rather than
 * an assumed one.
 */
function capabilitiesFromSchema(detail: Record<string, unknown>): ModelCapabilities {
  const version = (detail.latest_version ?? {}) as Record<string, unknown>
  const openapi = (version.openapi_schema ?? {}) as Record<string, unknown>
  const components = (openapi.components ?? {}) as Record<string, unknown>
  const schemas = (components.schemas ?? {}) as Record<string, unknown>
  const input = (schemas.Input ?? {}) as Record<string, unknown>
  const properties = (input.properties ?? {}) as Record<string, unknown>
  const names = new Set(Object.keys(properties))

  const hasImage = names.has('image') || names.has('image_url') || names.has('start_image') || names.has('first_frame_image')
  const hasLast = names.has('end_image') || names.has('last_frame_image')
  const hasVideo = names.has('video') || names.has('video_url')

  return {
    modes: hasVideo ? ['video_to_video'] : hasImage ? ['image_to_video', 'text_to_video'] : ['text_to_video'],
    duration: { minSeconds: 1, maxSeconds: 20 },
    resolutions: ['480p', '540p', '720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    fps: [],
    nativeAudio: names.has('audio') || names.has('generate_audio'),
    dialogue: false,
    firstFrame: hasImage,
    lastFrame: hasLast,
    videoReference: hasVideo,
    extension: false,
    maxReferenceImages: hasImage ? 1 : 0,
    seed: names.has('seed'),
    negativePrompt: names.has('negative_prompt'),
    maxPromptChars: 2000,
    tier: 'standard',
    safetyControls: [],
  }
}

/** Maps canonical fields onto whatever input names this model declares. */
function mapInputToSchema(request: CanonicalRenderRequest, detail: Record<string, unknown>): Record<string, unknown> {
  const version = (detail.latest_version ?? {}) as Record<string, unknown>
  const openapi = (version.openapi_schema ?? {}) as Record<string, unknown>
  const components = (openapi.components ?? {}) as Record<string, unknown>
  const schemas = (components.schemas ?? {}) as Record<string, unknown>
  const inputSchema = (schemas.Input ?? {}) as Record<string, unknown>
  const properties = (inputSchema.properties ?? {}) as Record<string, unknown>
  const has = (name: string) => Object.prototype.hasOwnProperty.call(properties, name)

  const input: Record<string, unknown> = {}
  const set = (candidates: string[], value: unknown) => {
    if (value === undefined || value === null || value === '') return
    const field = candidates.find(has)
    if (field) input[field] = value
  }

  set(['prompt', 'text', 'prompt_text'], request.prompt)
  set(['negative_prompt'], request.negativePrompt)
  set(['duration', 'num_frames', 'video_length', 'duration_seconds'], Math.round(request.durationSeconds))
  set(['aspect_ratio'], request.aspectRatio)
  set(['resolution'], request.resolution)
  set(['fps', 'frames_per_second'], request.fps)
  set(['seed'], request.seed ? Number(request.seed) || undefined : undefined)

  const first = request.inputs.firstFrame ?? request.inputs.references[0]
  set(['image', 'image_url', 'start_image', 'first_frame_image'], first?.remoteRef ?? first?.url)
  set(['end_image', 'last_frame_image'], request.inputs.lastFrame?.remoteRef ?? request.inputs.lastFrame?.url)
  set(['video', 'video_url'], request.inputs.video?.remoteRef ?? request.inputs.video?.url)

  if (!('prompt' in input) && !('text' in input) && !('prompt_text' in input)) {
    throw new AppError({
      kind: 'validation',
      code: 'replicate.no_prompt_field',
      message: `Replicate model ${request.modelId} declares no prompt input — it is probably not a text-conditioned video model`,
    })
  }
  return input
}

function normalizeOutput(output: unknown): ProviderOutputRef[] {
  if (typeof output === 'string') return [{ url: output, mime: 'video/mp4', index: 0 }]
  if (Array.isArray(output)) {
    return output
      .map((item, index) => (typeof item === 'string' ? { url: item, mime: 'video/mp4', index } : null))
      .filter((ref): ref is ProviderOutputRef => ref !== null)
  }
  if (output && typeof output === 'object') {
    const url = String((output as { url?: unknown }).url ?? '')
    if (url) return [{ url, mime: 'video/mp4', index: 0 }]
  }
  return []
}

export function createReplicateProvider(opts: ReplicateProviderOptions): ReplicateProvider {
  return new ReplicateProvider(opts)
}
