import { AppError, httpJson, loadConfig, usdToMicros, type AppConfig } from '@masterclip/shared'
import {
  BaseProvider,
  QUOTE_TTL_MS,
  downloadProviderOutputs,
  dynamicPricing,
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
  type SubmittedJob,
} from '@masterclip/provider-core'

const RETRIEVED_AT = '2026-08-17'

/** Runway's own spec states $0.01 per credit. */
export const USD_PER_CREDIT = 0.01

interface RunwayModelSpec {
  modelId: string
  displayName: string
  endpoint: '/v1/image_to_video' | '/v1/text_to_video' | '/v1/video_to_video'
  capabilities: ModelCapabilities
}

function caps(overrides: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    modes: ['image_to_video'],
    duration: { minSeconds: 5, maxSeconds: 10, allowedSeconds: [5, 10] },
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '21:9'],
    fps: [],
    nativeAudio: false,
    dialogue: false,
    firstFrame: true,
    lastFrame: false,
    videoReference: false,
    extension: false,
    maxReferenceImages: 1,
    seed: true,
    negativePrompt: false,
    maxPromptChars: 1000,
    tier: 'standard',
    safetyControls: ['contentModeration'],
    ...overrides,
  }
}

const RUNWAY_MODELS: RunwayModelSpec[] = [
  {
    modelId: 'gen4_turbo',
    displayName: 'Runway Gen-4 Turbo (image-to-video)',
    endpoint: '/v1/image_to_video',
    capabilities: caps({ tier: 'standard' }),
  },
  {
    modelId: 'gen4.5',
    displayName: 'Runway Gen-4.5 (image-to-video)',
    endpoint: '/v1/image_to_video',
    capabilities: caps({ tier: 'premium', resolutions: ['720p', '1080p'] }),
  },
  {
    modelId: 'gen4.5_t2v',
    displayName: 'Runway Gen-4.5 (text-to-video)',
    endpoint: '/v1/text_to_video',
    capabilities: caps({ modes: ['text_to_video'], firstFrame: false, maxReferenceImages: 0, tier: 'premium' }),
  },
  {
    modelId: 'aleph2',
    displayName: 'Runway Aleph 2 (video-to-video)',
    endpoint: '/v1/video_to_video',
    capabilities: caps({
      modes: ['video_to_video'],
      videoReference: true,
      firstFrame: false,
      maxReferenceImages: 0,
      tier: 'premium',
    }),
  },
]

export interface RunwayProviderOptions extends ProviderDeps {
  config?: AppConfig
  apiKey?: string
  baseUrl?: string
  apiVersion?: string
}

/**
 * Runway Developer API adapter.
 *
 * Surface verified 2026-08-17 against Runway's official OpenAPI spec and
 * `sdk-node`:
 *
 *   auth     Authorization: Bearer <key>   +   X-Runway-Version: 2024-11-06
 *   submit   POST /v1/image_to_video | /v1/text_to_video | /v1/video_to_video
 *   status   GET  /v1/tasks/{id}   (PENDING·THROTTLED·RUNNING·SUCCEEDED·FAILED·CANCELLED)
 *   cancel   DELETE /v1/tasks/{id}
 *   balance  GET  /v1/organization → creditBalance
 *
 * Cost handling is the notable part. Runway publishes no rate-card endpoint,
 * but **submit returns `estimatedCost.credits`** ("the maximum credits this
 * task may charge") and the terminal task returns `cost.credits` — so the quote
 * is genuinely dynamic and the invoice is genuinely reported. This adapter
 * treats submit-time estimate as the quote and the terminal `cost.credits` as
 * the charge, and never invents a per-second rate.
 *
 * Two field-name traps, both real: `estimatedCost` (pre-terminal) and `cost`
 * (terminal) are different keys, and Runway spells it `CANCELLED` where
 * Replicate spells it `canceled`.
 */
export class RunwayProvider extends BaseProvider {
  readonly providerId = 'runway'
  readonly displayName = 'Runway'

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly apiVersion: string

  constructor(opts: RunwayProviderOptions) {
    super(opts)
    const config = opts.config ?? loadConfig()
    this.apiKey = opts.apiKey ?? config.RUNWAY_API_KEY
    this.baseUrl = (opts.baseUrl ?? config.RUNWAY_BASE_URL).replace(/\/+$/, '')
    this.apiVersion = opts.apiVersion ?? config.RUNWAY_API_VERSION
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'x-runway-version': this.apiVersion,
      'content-type': 'application/json',
    }
  }

  async listModels(): Promise<NormalizedModel[]> {
    const fetchedAt = new Date(this.deps.now()).toISOString()
    return RUNWAY_MODELS.map((spec) => ({
      providerId: this.providerId,
      modelId: spec.modelId,
      displayName: spec.displayName,
      family: 'runway',
      capabilities: spec.capabilities,
      pricing: dynamicPricing({
        retrievedAt: RETRIEVED_AT,
        sourceUrl: 'https://docs.dev.runwayml.com (OpenAPI spec: $0.01 per credit)',
        notes:
          'Runway exposes no rate-card endpoint. The price for a specific request is the estimatedCost.credits returned by submit; the invoice is cost.credits on the terminal task. Non-mp4 output (ProRes, PNG sequence) adds 5 credits per second on gen4.5 and aleph2.',
      }),
      enabled: true,
      raw: spec,
      fetchedAt,
      source: 'static' as const,
    }))
  }

  /**
   * Runway can only price a request by accepting it, so there is no free quote.
   * Rather than fabricate one, this reports `unknown` confidence — which the
   * cost controller refuses for live spend, forcing the caller through
   * {@link submitWithQuote}, where the estimate arrives with the task.
   */
  override async quote(request: CanonicalRenderRequest): Promise<PriceQuote> {
    const now = this.deps.now()
    return {
      providerId: this.providerId,
      modelId: request.modelId,
      estimatedMicros: 0,
      credits: null,
      currency: 'USD',
      source: 'provider_quote',
      confidence: 'unknown',
      quotedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
      requestHash: priceRequestHash(request),
      raw: {
        note: 'Runway returns estimatedCost.credits only on submit; there is no pre-submission pricing endpoint. Use submitWithQuote() and enforce the ceiling against the returned estimate.',
      },
    }
  }

  async submit(request: CanonicalRenderRequest): Promise<SubmittedJob> {
    return (await this.submitWithQuote(request)).job
  }

  /**
   * Submits and returns the estimate Runway attached to the task.
   *
   * The caller must compare `estimateMicros` against the shot ceiling
   * immediately: Runway has already accepted the task at this point, so an
   * over-budget estimate means cancelling, not declining.
   */
  async submitWithQuote(request: CanonicalRenderRequest): Promise<{ job: SubmittedJob; estimateMicros: number | null; credits: number | null }> {
    const spec = RUNWAY_MODELS.find((m) => m.modelId === request.modelId)
    if (!spec) {
      throw new AppError({ kind: 'not_found', code: 'runway.unknown_model', message: `unknown Runway model ${request.modelId}` })
    }

    const body: Record<string, unknown> = {
      model: spec.modelId.replace(/_t2v$/, ''),
      promptText: request.prompt.slice(0, spec.capabilities.maxPromptChars),
      ratio: runwayRatio(request.aspectRatio, request.resolution),
      duration: Math.round(request.durationSeconds),
    }
    if (request.seed) body.seed = Number(request.seed) || undefined

    if (spec.endpoint === '/v1/image_to_video') {
      const image = request.inputs.firstFrame ?? request.inputs.references[0]
      const uri = image?.remoteRef ?? image?.url
      if (!uri) {
        throw new AppError({
          kind: 'validation',
          code: 'runway.missing_image',
          message: 'Runway image_to_video needs a promptImage URI — upload the reference first',
        })
      }
      body.promptImage = uri
    }
    if (spec.endpoint === '/v1/video_to_video') {
      const uri = request.inputs.video?.remoteRef ?? request.inputs.video?.url
      if (!uri) {
        throw new AppError({ kind: 'validation', code: 'runway.missing_video', message: 'Runway video_to_video needs a videoUri' })
      }
      body.videoUri = uri
    }

    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}${spec.endpoint}`, {
      method: 'POST',
      headers: this.headers(),
      body,
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 120_000,
    })

    const taskId = String(response.body.id ?? '')
    if (!taskId) {
      throw new AppError({
        kind: 'provider_failed',
        code: 'runway.no_task_id',
        message: 'Runway submit returned no task id',
        details: { body: response.raw.slice(0, 400) },
      })
    }

    const credits = extractCredits(response.body.estimatedCost)
    return {
      job: {
        externalJobId: taskId,
        providerId: this.providerId,
        modelId: request.modelId,
        submittedAt: new Date(this.deps.now()).toISOString(),
        externalRequestId: request.requestId,
        ...(credits !== null ? { chargedMicros: usdToMicros(credits * USD_PER_CREDIT) } : {}),
        raw: response.body,
      },
      estimateMicros: credits === null ? null : usdToMicros(credits * USD_PER_CREDIT),
      credits,
    }
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/v1/tasks/${encodeURIComponent(externalJobId)}`, {
      headers: this.headers(),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 30_000,
    })
    const body = response.body
    const status = String(body.status ?? '')
    // Terminal cost lives under `cost`; pre-terminal under `estimatedCost`.
    const credits = extractCredits(body.cost) ?? extractCredits(body.estimatedCost)

    const state: ProviderJobStatus['state'] =
      status === 'SUCCEEDED'
        ? 'succeeded'
        : status === 'FAILED'
          ? 'failed'
          : status === 'CANCELLED'
            ? 'cancelled'
            : status === 'PENDING' || status === 'THROTTLED'
              ? 'queued'
              : 'running'

    const outputs =
      state === 'succeeded' && Array.isArray(body.output)
        ? (body.output as string[]).map((url, index) => ({ url: String(url), mime: 'video/mp4', index }))
        : []

    return {
      externalJobId,
      state,
      progress: typeof body.progress === 'number' ? body.progress : null,
      outputs,
      error:
        state === 'failed'
          ? {
              code: String(body.failureCode ?? 'runway.failed'),
              message: String(body.failure ?? 'generation failed'),
              // A content-moderation refusal will refuse identically forever.
              retryable: !/moderat|safety|policy/i.test(String(body.failure ?? '')),
            }
          : null,
      actualMicros: state === 'succeeded' || state === 'failed' ? (credits === null ? null : usdToMicros(credits * USD_PER_CREDIT)) : null,
      actualCredits: credits,
      billableSeconds: null,
      raw: body,
    }
  }

  async cancel(externalJobId: string): Promise<void> {
    await httpJson(`${this.baseUrl}/v1/tasks/${encodeURIComponent(externalJobId)}`, {
      method: 'DELETE',
      headers: this.headers(),
      provider: this.providerId,
      timeoutMs: 30_000,
    })
  }

  async downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
    return downloadProviderOutputs(job, destDir)
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/v1/organization`, {
      headers: this.headers(),
      provider: this.providerId,
      timeoutMs: 20_000,
    })
    const credits = Number(response.body.creditBalance ?? 0)
    return {
      providerId: this.providerId,
      balanceMicros: Number.isFinite(credits) ? usdToMicros(credits * USD_PER_CREDIT) : null,
      credits: Number.isFinite(credits) ? credits : null,
      currency: 'USD',
      raw: response.body,
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.deps.now()).toISOString()
    if (!this.isConfigured()) {
      return { providerId: this.providerId, status: 'unconfigured', latencyMs: null, message: 'RUNWAY_API_KEY is not set', checkedAt }
    }
    try {
      const response = await httpJson(`${this.baseUrl}/v1/organization`, {
        headers: this.headers(),
        provider: this.providerId,
        timeoutMs: 15_000,
      })
      return {
        providerId: this.providerId,
        status: response.latencyMs > 5_000 ? 'degraded' : 'healthy',
        latencyMs: response.latencyMs,
        message: 'organization endpoint reachable',
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

function extractCredits(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null
  const credits = Number((value as { credits?: unknown }).credits)
  return Number.isFinite(credits) ? credits : null
}

/** Runway takes an explicit pixel ratio string rather than an aspect name. */
function runwayRatio(aspect: string, resolution: string): string {
  const height = resolution === '1080p' ? 1080 : 720
  const map: Record<string, [number, number]> = {
    '16:9': [16, 9],
    '9:16': [9, 16],
    '1:1': [1, 1],
    '4:3': [4, 3],
    '3:4': [3, 4],
    '21:9': [21, 9],
    '4:5': [4, 5],
    '2.39:1': [239, 100],
  }
  const [w, h] = map[aspect] ?? [16, 9]
  const width = Math.round(((height * w) / h / 2)) * 2
  return `${width}:${height}`
}

export function createRunwayProvider(opts: RunwayProviderOptions): RunwayProvider {
  return new RunwayProvider(opts)
}

export { RUNWAY_MODELS }
