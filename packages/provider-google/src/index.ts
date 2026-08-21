import { readFile } from 'node:fs/promises'
import { AppError, httpJson, loadConfig, usdToMicros, type AppConfig, type MicroUsd } from '@masterclip/shared'
import type { TargetResolution } from '@masterclip/shot-schema'
import {
  BaseProvider,
  QUOTE_TTL_MS,
  downloadProviderOutputs,
  priceRequestHash,
  type AccountBalance,
  type CanonicalRenderRequest,
  type CompletedJob,
  type DownloadedAsset,
  type ModelCapabilities,
  type NormalizedModel,
  type PriceQuote,
  type ProviderDeps,
  type ProviderHealth,
  type ProviderJobStatus,
  type ProviderOutputRef,
  type SubmittedJob,
} from '@masterclip/provider-core'

const RETRIEVED_AT = '2026-08-17'
const PRICING_SOURCE = 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing'

/**
 * ⚠️ PRICING UNIT AMBIGUITY — read docs/current-pricing-snapshot.md.
 *
 * Google's published rate card prints these figures as "per 1 count" and never
 * defines "count" on the page. Every surrounding convention (and the widely
 * cited Veo 3 per-second rate) says one count is **one second of output**, but
 * that was not confirmable from an official page during research, and the two
 * readings differ by 8× on an 8-second clip.
 *
 * The adapter therefore treats these as per-second, marks every quote
 * `confidence: 'estimated'`, and attaches an explicit warning that the cost
 * controller surfaces before any live submission. Resolve against a real
 * invoice before running volume through this provider.
 */
const UNIT_WARNING =
  'Google publishes this rate as "per 1 count" without defining the unit. MASTERCLIP treats 1 count = 1 second of output. If Google bills per clip instead, this estimate is high by the clip duration; if the reverse, it is low. Verify against an invoice before volume production.'

interface VeoModelSpec {
  modelId: string
  displayName: string
  tier: ModelCapabilities['tier']
  /** USD per "count" (see UNIT_WARNING), by resolution, with audio. */
  withAudioUsd: Partial<Record<TargetResolution, number>>
  /** USD per "count" without audio. Veo 3.x always generates audio on the
   *  Gemini API — no flag disables it — so these rows exist for completeness
   *  and for the models where Google prices a video-only SKU. */
  videoOnlyUsd: Partial<Record<TargetResolution, number>>
  capabilities: ModelCapabilities
}

/**
 * What we know about a model Google lists but this build has never researched:
 * nothing. Declaring no modes and no durations keeps the capability matcher
 * from ever selecting it, which is the correct behaviour for a model whose
 * price and limits are unknown — it appears in the catalogue as visible but
 * unusable rather than being quietly guessed at.
 */
const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = {
  modes: [],
  duration: { minSeconds: 0, maxSeconds: 0, allowedSeconds: [] },
  resolutions: [],
  aspectRatios: [],
  fps: [],
  nativeAudio: false,
  dialogue: false,
  firstFrame: false,
  lastFrame: false,
  videoReference: false,
  extension: false,
  maxReferenceImages: 0,
  seed: false,
  negativePrompt: false,
  maxPromptChars: 0,
  tier: 'standard',
  safetyControls: [],
}

function veoCapabilities(overrides: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    modes: ['text_to_video', 'image_to_video', 'first_last_frame'],
    // Veo 3.1 accepts 4, 6 or 8 seconds. Anything else is rejected by the API,
    // so it is rejected here rather than silently snapped after billing.
    duration: { minSeconds: 4, maxSeconds: 8, allowedSeconds: [4, 6, 8] },
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    // fps is Vertex-only; the Gemini API raises on it.
    fps: [],
    nativeAudio: true,
    dialogue: true,
    firstFrame: true,
    lastFrame: true,
    videoReference: false,
    extension: true,
    maxReferenceImages: 3,
    // seed is rejected by the Gemini API (Vertex-only).
    seed: false,
    negativePrompt: true,
    maxPromptChars: 4000,
    tier: 'premium',
    safetyControls: ['personGeneration'],
    ...overrides,
  }
}

/**
 * Model IDs verified 2026-08-17 from Google's official cookbook
 * (google-gemini/cookbook, quickstarts/Get_started_Veo.ipynb). The `-001` GA
 * aliases appear on the rate card but could not be confirmed live — call
 * `GET /v1beta/models` with a real key before pinning one.
 */
const VEO_MODELS: VeoModelSpec[] = [
  {
    modelId: 'veo-3.1-generate-preview',
    displayName: 'Veo 3.1',
    tier: 'premium',
    withAudioUsd: { '720p': 0.4, '1080p': 0.4 },
    videoOnlyUsd: { '720p': 0.2, '1080p': 0.2 },
    capabilities: veoCapabilities({ tier: 'premium', maxReferenceImages: 3 }),
  },
  {
    modelId: 'veo-3.1-fast-generate-preview',
    displayName: 'Veo 3.1 Fast',
    tier: 'standard',
    withAudioUsd: { '720p': 0.1, '1080p': 0.12 },
    videoOnlyUsd: { '720p': 0.08, '1080p': 0.1 },
    // Reference-images-to-video is Veo 3.1 only, not Fast.
    capabilities: veoCapabilities({ tier: 'standard', maxReferenceImages: 1 }),
  },
  {
    modelId: 'veo-3.1-lite-generate-preview',
    displayName: 'Veo 3.1 Lite',
    tier: 'draft',
    withAudioUsd: { '720p': 0.05, '1080p': 0.08 },
    videoOnlyUsd: { '720p': 0.03, '1080p': 0.05 },
    capabilities: veoCapabilities({ tier: 'draft', maxReferenceImages: 1, extension: false }),
  },
]

export interface GoogleProviderOptions extends ProviderDeps {
  config?: AppConfig
  apiKey?: string
  baseUrl?: string
}

/**
 * Google Gemini API adapter for the Veo family.
 *
 * REST surface verified 2026-08-17 against Google's own API discovery document
 * (`generativelanguage.googleapis.com/$discovery/rest?version=v1beta`, revision
 * 20260814) and the official `googleapis/python-genai` SDK converters:
 *
 *   auth     x-goog-api-key: <key>
 *   submit   POST /v1beta/models/{model}:predictLongRunning
 *   poll     GET  /v1beta/{operation.name}       (no status enum — poll `done`)
 *   files    GET  /v1beta/files/{id}:download?alt=media   (API key required)
 *
 * Field-name traps handled here, both real and both from the SDK converters:
 *  - `image`/`lastFrame` use `bytesBase64Encoded` + `mimeType`, but the `video`
 *    input uses `encodedVideo` + `encoding`;
 *  - `webhookConfig` is a top-level sibling of `instances`/`parameters`, and is
 *    Gemini-API-only (Vertex rejects it).
 */
export class GoogleProvider extends BaseProvider {
  readonly providerId = 'google'
  readonly displayName = 'Google Gemini (Veo)'

  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(opts: GoogleProviderOptions) {
    super(opts)
    const config = opts.config ?? loadConfig()
    this.apiKey = opts.apiKey ?? config.GOOGLE_API_KEY
    this.baseUrl = (opts.baseUrl ?? config.GOOGLE_BASE_URL).replace(/\/+$/, '')
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' }
  }

  /**
   * The video models Google will actually accept today.
   *
   * This used to return the compiled-in list unconditionally, which made the
   * "live catalogues preferred" mitigation against provider drift untrue for
   * this adapter: a renamed or retired Veo model would have been discovered by
   * a failed submission rather than by asking. The live endpoint decides which
   * models *exist*; the compiled-in specs supply the capability and pricing
   * detail Google does not publish there.
   *
   * A model Google lists that we have no spec for is still returned, with
   * `pricing: null` — the cost controller refuses to authorize an unpriced
   * billable request, so a newly launched model surfaces as "needs pricing
   * research" instead of quietly failing or, worse, being priced by guesswork.
   *
   * Falls back to the static list when the catalogue cannot be read, so an
   * unconfigured or offline deployment still knows what Veo is.
   */
  async listModels(): Promise<NormalizedModel[]> {
    const fetchedAt = new Date(this.deps.now()).toISOString()
    if (!this.isConfigured()) return this.staticModels(fetchedAt)

    let live: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>
    try {
      const response = await httpJson<{ models?: typeof live }>(`${this.baseUrl}/v1beta/models?pageSize=200`, {
        headers: this.headers(),
        provider: this.providerId,
        logger: this.deps.logger,
        timeoutMs: 20_000,
      })
      live = response.body.models ?? []
    } catch (err) {
      this.deps.logger.warn('google.catalog_unavailable', { err: String(err), note: 'falling back to the compiled-in model list' })
      return this.staticModels(fetchedAt)
    }

    // `predictLongRunning` is the method this adapter submits with, so it is
    // the honest test of "can we drive this model" — more durable than matching
    // on the name containing "veo".
    const videoModels = live.filter((m) => (m.supportedGenerationMethods ?? []).includes('predictLongRunning'))
    if (videoModels.length === 0) return this.staticModels(fetchedAt)

    const specs = new Map(VEO_MODELS.map((spec) => [spec.modelId, spec]))
    const seen = new Set<string>()
    const models: NormalizedModel[] = []

    for (const entry of videoModels) {
      const modelId = String(entry.name ?? '').replace(/^models\//, '')
      if (!modelId) continue
      seen.add(modelId)
      const spec = specs.get(modelId)
      if (spec) {
        models.push({ ...this.fromSpec(spec, fetchedAt), source: 'catalog', displayName: entry.displayName || spec.displayName })
        continue
      }
      this.deps.logger.warn('google.unpriced_model', {
        modelId,
        note: 'Google lists a video model this build has no pricing or capability research for',
      })
      models.push({
        providerId: this.providerId,
        modelId,
        displayName: entry.displayName || modelId,
        family: 'veo',
        capabilities: UNKNOWN_MODEL_CAPABILITIES,
        pricing: null,
        enabled: false,
        raw: entry,
        fetchedAt,
        source: 'catalog',
      })
    }

    for (const spec of VEO_MODELS) {
      if (seen.has(spec.modelId)) continue
      this.deps.logger.warn('google.model_retired', {
        modelId: spec.modelId,
        note: 'compiled-in model is no longer in Google\'s catalogue; not offered for routing',
      })
    }

    return models
  }

  private staticModels(fetchedAt: string): NormalizedModel[] {
    return VEO_MODELS.map((spec) => this.fromSpec(spec, fetchedAt))
  }

  private fromSpec(spec: (typeof VEO_MODELS)[number], fetchedAt: string): NormalizedModel {
    return ({
      providerId: this.providerId,
      modelId: spec.modelId,
      displayName: spec.displayName,
      family: 'veo',
      capabilities: spec.capabilities,
      pricing: {
        basis: 'per_second' as const,
        rateMicros: usdToMicros(spec.withAudioUsd['720p'] ?? 0),
        perResolutionMicros: {
          '720p': usdToMicros(spec.withAudioUsd['720p'] ?? 0),
          '1080p': usdToMicros(spec.withAudioUsd['1080p'] ?? spec.withAudioUsd['720p'] ?? 0),
        },
        dynamic: false,
        retrievedAt: RETRIEVED_AT,
        sourceUrl: PRICING_SOURCE,
        notes: UNIT_WARNING,
      },
      enabled: true,
      raw: { spec, videoOnlyUsd: spec.videoOnlyUsd },
      fetchedAt,
      source: 'static' as const,
    })
  }

  /**
   * Google publishes a rate card and offers no estimate endpoint, so this is a
   * rate-card computation — reported as `estimated`, never as an exact provider
   * quote, and carrying the unit warning.
   */
  override async quote(request: CanonicalRenderRequest): Promise<PriceQuote> {
    const spec = VEO_MODELS.find((m) => m.modelId === request.modelId)
    if (!spec) {
      throw new AppError({ kind: 'not_found', code: 'google.unknown_model', message: `unknown Veo model ${request.modelId}` })
    }
    // On the Gemini API Veo 3.x always produces audio; the video-only SKU is not
    // selectable, so the with-audio rate is the honest one to quote.
    const rate = spec.withAudioUsd[request.resolution] ?? spec.withAudioUsd['720p'] ?? 0
    if (rate === 0) {
      throw new AppError({
        kind: 'validation',
        code: 'google.no_rate',
        message: `no published rate for ${request.modelId} at ${request.resolution}`,
      })
    }
    const micros: MicroUsd = Math.round(usdToMicros(rate) * request.durationSeconds)
    const now = this.deps.now()
    return {
      providerId: this.providerId,
      modelId: request.modelId,
      estimatedMicros: micros,
      credits: null,
      currency: 'USD',
      source: 'published_rate_card',
      confidence: 'estimated',
      quotedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
      requestHash: priceRequestHash(request),
      raw: { usdPerCount: rate, seconds: request.durationSeconds, retrievedAt: RETRIEVED_AT, sourceUrl: PRICING_SOURCE, warnings: [UNIT_WARNING] },
    }
  }

  async submit(request: CanonicalRenderRequest): Promise<SubmittedJob> {
    const validation = await this.validate(request)
    if (!validation.ok) {
      throw new AppError({
        kind: 'provider_rejected',
        code: 'google.invalid_request',
        message: `Google rejected the request before submission: ${validation.errors.join('; ')}`,
      })
    }

    const instance: Record<string, unknown> = { prompt: request.prompt }
    if (request.inputs.firstFrame) instance.image = await this.encodeImage(request.inputs.firstFrame)
    if (request.inputs.lastFrame) instance.lastFrame = await this.encodeImage(request.inputs.lastFrame)
    if (request.inputs.references.length > 0) {
      instance.referenceImages = await Promise.all(
        request.inputs.references.map(async (asset) => ({
          image: await this.encodeImage(asset),
          // The Gemini API accepts ASSET only; STYLE is Vertex-only.
          referenceType: 'ASSET',
        })),
      )
    }
    if (request.inputs.video) {
      const bytes = await this.readBytes(request.inputs.video)
      // Note the asymmetry: video uses encodedVideo/encoding, images use
      // bytesBase64Encoded/mimeType.
      instance.video = { encodedVideo: bytes.toString('base64'), encoding: request.inputs.video.mime }
    }

    const parameters: Record<string, unknown> = {
      sampleCount: 1,
      durationSeconds: Math.round(request.durationSeconds),
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
      personGeneration: request.metadata.person_generation ?? 'allow_adult',
    }
    if (request.negativePrompt) parameters.negativePrompt = request.negativePrompt

    const body: Record<string, unknown> = { instances: [instance], parameters }
    if (request.webhookUrl) {
      body.webhookConfig = { uris: [request.webhookUrl], userMetadata: { masterclip_request_id: request.requestId } }
    }

    const response = await httpJson<Record<string, unknown>>(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(request.modelId)}:predictLongRunning`,
      { method: 'POST', headers: this.headers(), body, provider: this.providerId, logger: this.deps.logger, timeoutMs: 120_000 },
    )

    const operationName = String(response.body.name ?? '')
    if (!operationName) {
      throw new AppError({
        kind: 'provider_failed',
        code: 'google.no_operation',
        message: 'predictLongRunning returned no operation name',
        details: { body: response.raw.slice(0, 400) },
      })
    }
    return {
      externalJobId: operationName,
      providerId: this.providerId,
      modelId: request.modelId,
      submittedAt: new Date(this.deps.now()).toISOString(),
      externalRequestId: request.requestId,
      raw: response.body,
    }
  }

  /**
   * The operation name returned by submit is already a full resource path
   * (`models/{model}/operations/{id}`) — it is appended to `/v1beta/` as-is.
   * There is no status enum: `done` is the signal.
   */
  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const path = externalJobId.startsWith('/') ? externalJobId.slice(1) : externalJobId
    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/v1beta/${path}`, {
      headers: this.headers(),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 30_000,
    })
    const body = response.body
    const done = body.done === true

    if (!done) {
      return {
        externalJobId,
        state: 'running',
        progress: null,
        outputs: [],
        error: null,
        actualMicros: null,
        actualCredits: null,
        billableSeconds: null,
        raw: body,
      }
    }

    const error = body.error as { code?: number; message?: string } | undefined
    if (error) {
      return {
        externalJobId,
        state: 'failed',
        progress: null,
        outputs: [],
        error: {
          code: `google.${error.code ?? 'error'}`,
          message: String(error.message ?? 'operation failed'),
          // 3 = INVALID_ARGUMENT, 9 = FAILED_PRECONDITION: caller-side problems
          // that will fail identically on retry.
          retryable: error.code !== 3 && error.code !== 9,
        },
        actualMicros: null,
        actualCredits: null,
        billableSeconds: null,
        raw: body,
      }
    }

    return {
      externalJobId,
      state: 'succeeded',
      progress: 1,
      outputs: this.extractOutputs(body),
      error: null,
      // Google reports no per-operation charge; actual cost comes from billing.
      actualMicros: null,
      actualCredits: null,
      billableSeconds: null,
      raw: body,
    }
  }

  private extractOutputs(body: Record<string, unknown>): ProviderOutputRef[] {
    const response = (body.response ?? {}) as Record<string, unknown>
    const nested = (response.generateVideoResponse ?? response) as Record<string, unknown>
    const samples =
      (nested.generatedSamples as Array<Record<string, unknown>> | undefined) ??
      (nested.generatedVideos as Array<Record<string, unknown>> | undefined) ??
      (nested.videos as Array<Record<string, unknown>> | undefined) ??
      []

    const refs: ProviderOutputRef[] = []
    samples.forEach((sample, index) => {
      const video = (sample.video ?? sample) as Record<string, unknown>
      const uri = String(video.uri ?? video.videoUri ?? '')
      if (!uri) return
      refs.push({
        // The files URI is not pre-signed: the API key must accompany the GET.
        url: uri.includes('alt=media') ? uri : `${uri}${uri.includes('?') ? '&' : '?'}alt=media`,
        mime: String(video.mimeType ?? 'video/mp4'),
        index,
        headers: { 'x-goog-api-key': this.apiKey },
      })
    })
    return refs
  }

  async downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
    return downloadProviderOutputs(job, destDir)
  }

  async getAccountBalance(): Promise<AccountBalance> {
    throw new AppError({
      kind: 'validation',
      code: 'google.no_balance_endpoint',
      message: 'the Gemini API exposes no balance endpoint — track spend in Google Cloud Billing',
    })
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.deps.now()).toISOString()
    if (!this.isConfigured()) {
      return { providerId: this.providerId, status: 'unconfigured', latencyMs: null, message: 'GOOGLE_API_KEY is not set', checkedAt }
    }
    try {
      const response = await httpJson(`${this.baseUrl}/v1beta/models`, {
        headers: this.headers(),
        provider: this.providerId,
        timeoutMs: 15_000,
      })
      return {
        providerId: this.providerId,
        status: response.latencyMs > 5_000 ? 'degraded' : 'healthy',
        latencyMs: response.latencyMs,
        message: 'models endpoint reachable',
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

  private async encodeImage(asset: { localPath?: string; url?: string; mime: string }): Promise<Record<string, unknown>> {
    const bytes = await this.readBytes(asset)
    return { bytesBase64Encoded: bytes.toString('base64'), mimeType: asset.mime }
  }

  private async readBytes(asset: { localPath?: string; url?: string }): Promise<Buffer> {
    if (asset.localPath) return Buffer.from(await readFile(asset.localPath))
    if (asset.url) {
      const response = await fetch(asset.url)
      if (!response.ok) {
        throw new AppError({ kind: 'io', code: 'google.reference_fetch_failed', message: `could not fetch reference asset (${response.status})` })
      }
      return Buffer.from(await response.arrayBuffer())
    }
    throw new AppError({
      kind: 'validation',
      code: 'google.reference_unavailable',
      message: 'reference asset has neither a local path nor a URL — the Gemini API needs inline bytes',
    })
  }
}

export function createGoogleProvider(opts: GoogleProviderOptions): GoogleProvider {
  return new GoogleProvider(opts)
}

export { UNIT_WARNING as GOOGLE_PRICING_UNIT_WARNING, VEO_MODELS }
