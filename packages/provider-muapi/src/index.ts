import { readFile } from 'node:fs/promises'
import { AppError, httpJson, loadConfig, usdToMicros, type AppConfig } from '@masterclip/shared'
import {
  BaseProvider,
  downloadProviderOutputs,
  quoteFromProvider,
  type AccountBalance,
  type CanonicalRenderRequest,
  type CompletedJob,
  type DownloadedAsset,
  type NormalizedModel,
  type PriceQuote,
  type ProviderDeps,
  type ProviderEvent,
  type ProviderHealth,
  type ProviderJobStatus,
  type ProviderOutputRef,
  type SubmittedJob,
} from '@masterclip/provider-core'
import { normalizeCatalogEntry, staticCatalog, usesArrayImageInput } from './catalog.js'

export * from './catalog.js'

/**
 * MuAPI adapter (https://api.muapi.ai).
 *
 * Surface verified 2026-08-17 against MuAPI's official CLI source
 * (github.com/SamurAIGPT/muapi-cli) — the client MuAPI ships, so its paths,
 * headers and field names are what the wire actually sees:
 *
 *   auth      x-api-key: <key>                       (note: the hosted MCP server
 *                                                     uses Bearer — different scheme)
 *   submit    POST /api/v1/{model_slug}              (per-model slugs; no generic /generate)
 *   status    GET  /api/v1/predictions/{id}/result   (terminal: completed | failed)
 *   upload    POST /api/v1/upload_file               (multipart, field name "file")
 *   balance   GET  /api/v1/account/balance
 *   estimate  POST /api/v1/models/{model}/estimate-cost
 *
 * Two behaviours here exist because of documented MuAPI quirks:
 *
 *  - the reference-image field name varies by model family (`image_url` string
 *    vs `images_list` array). MuAPI's own LangChain adapter treats this as a
 *    runtime recovery loop rather than static knowledge, and so does
 *    {@link MuapiProvider.submit}: a 422 naming a missing field retries once
 *    with the other shape.
 *  - MuAPI webhooks carry **no signature**. The callback is therefore treated
 *    strictly as a wake-up signal: {@link MuapiProvider.normalizeWebhook}
 *    re-fetches authoritative state from the result endpoint before anything is
 *    recorded or spent.
 */
export interface MuapiProviderOptions extends ProviderDeps {
  config?: AppConfig
  apiKey?: string
  baseUrl?: string
}

const CATALOG_PATH = '/api/v1/models'
const TERMINAL_SUCCESS = 'completed'
const TERMINAL_FAILURE = 'failed'

export class MuapiProvider extends BaseProvider {
  readonly providerId = 'muapi'
  readonly displayName = 'MuAPI'

  private readonly apiKey: string
  private readonly baseUrl: string
  private catalogCache: { models: NormalizedModel[]; fetchedAtMs: number } | null = null

  constructor(opts: MuapiProviderOptions) {
    super(opts)
    const config = opts.config ?? loadConfig()
    this.apiKey = opts.apiKey ?? config.MUAPI_API_KEY
    this.baseUrl = (opts.baseUrl ?? config.MUAPI_BASE_URL).replace(/\/+$/, '')
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  private headers(json = true): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      ...(json ? { 'content-type': 'application/json' } : {}),
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  async listModels(): Promise<NormalizedModel[]> {
    const now = this.deps.now()
    if (this.catalogCache && now - this.catalogCache.fetchedAtMs < 60 * 60_000) return this.catalogCache.models
    return this.refreshCatalog()
  }

  override async refreshCatalog(): Promise<NormalizedModel[]> {
    const fetchedAt = new Date(this.deps.now()).toISOString()
    try {
      const response = await httpJson<unknown>(this.url(CATALOG_PATH), {
        headers: this.headers(false),
        provider: this.providerId,
        logger: this.deps.logger,
        timeoutMs: 30_000,
      })
      const entries = extractArray(response.body)
      const models = entries
        .map((entry) => normalizeCatalogEntry(entry, fetchedAt))
        .filter((m): m is NormalizedModel => m !== null)
      if (models.length === 0) throw new AppError({ kind: 'provider_failed', message: 'MuAPI catalog returned no video models' })
      this.catalogCache = { models, fetchedAtMs: this.deps.now() }
      return models
    } catch (err) {
      // A dead catalog endpoint must not take the whole provider offline; the
      // static descriptors are clearly labelled `source: 'static'` downstream.
      this.deps.logger.warn('muapi.catalog_fallback', { err })
      const models = staticCatalog(fetchedAt)
      this.catalogCache = { models, fetchedAtMs: this.deps.now() }
      return models
    }
  }

  /**
   * Live estimate via `estimate-cost`. Falls back to the catalog's fixed cost
   * only when the model is not dynamically priced; a request that can be
   * neither quoted nor rate-carded is refused rather than guessed at.
   */
  override async quote(request: CanonicalRenderRequest): Promise<PriceQuote> {
    const body = this.buildPayload(request, false)
    try {
      const response = await httpJson<Record<string, unknown>>(
        this.url(`/api/v1/models/${encodeURIComponent(request.modelId)}/estimate-cost`),
        { method: 'POST', headers: this.headers(), body, provider: this.providerId, logger: this.deps.logger, timeoutMs: 30_000 },
      )
      const cost = extractCost(response.body)
      if (cost.usd === null) {
        throw new AppError({
          kind: 'provider_failed',
          code: 'muapi.quote_missing_amount',
          message: 'MuAPI estimate-cost response contained no USD amount',
          details: { body: response.raw.slice(0, 400) },
        })
      }
      return quoteFromProvider({
        providerId: this.providerId,
        request,
        micros: usdToMicros(cost.usd),
        credits: cost.credits,
        nowMs: this.deps.now(),
        raw: response.body,
      })
    } catch (err) {
      const model = (await this.listModels()).find((m) => m.modelId === request.modelId)
      if (model?.pricing && !model.pricing.dynamic && model.pricing.basis !== 'unknown') {
        return super.quote(request)
      }
      throw err
    }
  }

  async submit(request: CanonicalRenderRequest): Promise<SubmittedJob> {
    const validation = await this.validate(request)
    if (!validation.ok) {
      throw new AppError({
        kind: 'provider_rejected',
        code: 'muapi.invalid_request',
        message: `MuAPI request is invalid: ${validation.errors.join('; ')}`,
      })
    }

    let payload = this.buildPayload(request, true)
    let response
    try {
      response = await this.post(request.modelId, payload)
    } catch (err) {
      const swapped = swapImageFieldShape(err, payload)
      if (!swapped) throw err
      this.deps.logger.warn('muapi.image_field_swap', { model: request.modelId })
      payload = swapped
      response = await this.post(request.modelId, payload)
    }

    const externalJobId = String(
      (response.body as Record<string, unknown>).request_id ??
        (response.body as Record<string, unknown>).id ??
        (response.body as Record<string, unknown>).task_id ??
        '',
    )
    if (!externalJobId) {
      throw new AppError({
        kind: 'provider_failed',
        code: 'muapi.no_request_id',
        message: 'MuAPI submit response contained no request id',
        details: { body: response.raw.slice(0, 400) },
      })
    }

    const charged = costFromHeaders(response.headers) ?? extractCost(response.body)
    return {
      externalJobId,
      providerId: this.providerId,
      modelId: request.modelId,
      submittedAt: new Date(this.deps.now()).toISOString(),
      externalRequestId: request.requestId,
      ...(charged.usd !== null ? { chargedMicros: usdToMicros(charged.usd) } : {}),
      raw: response.body,
    }
  }

  private post(modelSlug: string, payload: Record<string, unknown>) {
    return httpJson<Record<string, unknown>>(this.url(`/api/v1/${modelSlug}`), {
      method: 'POST',
      headers: this.headers(),
      body: payload,
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 120_000,
    })
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const response = await httpJson<Record<string, unknown>>(
      this.url(`/api/v1/predictions/${encodeURIComponent(externalJobId)}/result`),
      { headers: this.headers(false), provider: this.providerId, logger: this.deps.logger, timeoutMs: 30_000 },
    )
    return this.mapStatus(externalJobId, response.body, response.headers)
  }

  private mapStatus(externalJobId: string, body: Record<string, unknown>, headers?: Headers): ProviderJobStatus {
    const status = String(body.status ?? '').toLowerCase()
    // MuAPI's own client treats the enum as open: only `completed` and `failed`
    // are terminal, everything else means keep polling.
    const state = status === TERMINAL_SUCCESS ? 'succeeded' : status === TERMINAL_FAILURE ? 'failed' : status === 'queued' ? 'queued' : 'running'
    const cost = (headers ? costFromHeaders(headers) : null) ?? extractCost(body)

    return {
      externalJobId,
      state,
      progress: null,
      outputs: state === 'succeeded' ? normalizeOutputs(body.outputs) : [],
      error:
        state === 'failed'
          ? { code: 'muapi.generation_failed', message: String(body.error ?? 'generation failed'), retryable: true }
          : null,
      actualMicros: cost.usd === null ? null : usdToMicros(cost.usd),
      actualCredits: cost.credits,
      billableSeconds: null,
      raw: body,
    }
  }

  async cancel(): Promise<void> {
    throw new AppError({
      kind: 'validation',
      code: 'muapi.cancel_unsupported',
      message: 'MuAPI exposes no cancel endpoint — the job will run to completion and be billed',
    })
  }

  /**
   * MuAPI does not sign webhooks. The payload is used only to learn *which*
   * job changed; authoritative state is re-fetched before anything is recorded.
   */
  async normalizeWebhook(payload: unknown): Promise<ProviderEvent> {
    const body = (payload ?? {}) as Record<string, unknown>
    const externalJobId = String(body.id ?? body.request_id ?? '')
    if (!externalJobId) {
      throw new AppError({ kind: 'validation', code: 'muapi.webhook_no_id', message: 'MuAPI webhook carried no job id' })
    }
    const authoritative = await this.getStatus(externalJobId)
    return {
      providerId: this.providerId,
      externalJobId,
      dedupeKey: `${externalJobId}:${authoritative.state}`,
      status: authoritative,
      receivedAt: new Date(this.deps.now()).toISOString(),
      raw: payload,
    }
  }

  async downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
    return downloadProviderOutputs(job, destDir)
  }

  /** Uploads a local reference file and returns MuAPI's hosted URL. */
  async uploadFile(localPath: string, filename: string, mime: string): Promise<string> {
    const data = await readFile(localPath)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(data)], { type: mime }), filename)
    // No content-type header: the runtime sets the multipart boundary.
    const response = await httpJson<Record<string, unknown>>(this.url('/api/v1/upload_file'), {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey },
      rawBody: form,
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 120_000,
    })
    const url = String(response.body.url ?? response.body.file_url ?? response.body.output ?? '')
    if (!url) {
      throw new AppError({ kind: 'provider_failed', code: 'muapi.upload_no_url', message: 'MuAPI upload returned no URL' })
    }
    return url
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const response = await httpJson<Record<string, unknown>>(this.url('/api/v1/account/balance'), {
      headers: this.headers(false),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 20_000,
    })
    const balance = Number(response.body.balance ?? 0)
    return {
      providerId: this.providerId,
      balanceMicros: Number.isFinite(balance) ? usdToMicros(balance) : null,
      credits: null,
      currency: String(response.body.currency ?? 'USD'),
      raw: response.body,
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.deps.now()).toISOString()
    if (!this.isConfigured()) {
      return { providerId: this.providerId, status: 'unconfigured', latencyMs: null, message: 'MUAPI_API_KEY is not set', checkedAt }
    }
    try {
      const response = await httpJson(this.url(CATALOG_PATH), {
        headers: this.headers(false),
        provider: this.providerId,
        timeoutMs: 15_000,
      })
      return {
        providerId: this.providerId,
        status: response.latencyMs > 5_000 ? 'degraded' : 'healthy',
        latencyMs: response.latencyMs,
        message: 'catalog reachable',
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

  /**
   * Builds the model payload. MuAPI takes flat model-specific bodies, so this
   * maps our canonical request onto the field names its CLI sends.
   */
  private buildPayload(request: CanonicalRenderRequest, includeWebhook: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      duration: Math.round(request.durationSeconds),
      aspect_ratio: request.aspectRatio,
    }
    if (request.negativePrompt) payload.negative_prompt = request.negativePrompt
    if (request.seed) payload.seed = Number(request.seed) || request.seed
    if (request.resolution) payload.resolution = request.resolution

    const image = request.inputs.firstFrame ?? request.inputs.references[0]
    if (image) {
      const url = image.remoteRef ?? image.url
      if (!url) {
        throw new AppError({
          kind: 'validation',
          code: 'muapi.reference_not_uploaded',
          message: 'MuAPI needs a URL for reference images — upload the asset first via uploadFile()',
        })
      }
      if (usesArrayImageInput(request.modelId)) payload.images_list = [url]
      else payload.image_url = url
    }
    if (request.inputs.video) {
      const url = request.inputs.video.remoteRef ?? request.inputs.video.url
      if (url) payload.video_url = url
    }
    if (includeWebhook && request.webhookUrl) payload.webhook_url = request.webhookUrl
    return payload
  }
}

function extractArray(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>
  if (body && typeof body === 'object') {
    for (const key of ['models', 'data', 'items', 'results']) {
      const value = (body as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>
    }
  }
  return []
}

/** `outputs` is polymorphic: an array of URL strings or of objects. */
function normalizeOutputs(outputs: unknown): ProviderOutputRef[] {
  if (!Array.isArray(outputs)) return []
  const refs: ProviderOutputRef[] = []
  outputs.forEach((output, index) => {
    if (typeof output === 'string') {
      refs.push({ url: output, mime: mimeFromUrl(output), index })
      return
    }
    if (output && typeof output === 'object') {
      const obj = output as Record<string, unknown>
      const url = String(obj.url ?? obj.video_url ?? obj.image_url ?? obj.output ?? '')
      if (url) {
        refs.push({
          url,
          mime: String(obj.content_type ?? mimeFromUrl(url)),
          index,
          ...(typeof obj.file_size === 'number' ? { bytes: obj.file_size } : {}),
          ...(typeof obj.duration === 'number' ? { durationSeconds: obj.duration } : {}),
        })
      }
    }
  })
  return refs
}

function mimeFromUrl(url: string): string {
  const path = url.split('?')[0] ?? ''
  if (path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.mov')) return 'video/quicktime'
  if (path.endsWith('.webm')) return 'video/webm'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  return 'video/mp4'
}

function extractCost(body: unknown): { usd: number | null; credits: number | null } {
  if (!body || typeof body !== 'object') return { usd: null, credits: null }
  const cost = (body as Record<string, unknown>).cost
  const source = (cost && typeof cost === 'object' ? cost : body) as Record<string, unknown>
  const usd = Number(source.amount_usd ?? source.usd ?? source.cost_usd)
  const credits = Number(source.amount_credits ?? source.credits)
  return {
    usd: Number.isFinite(usd) ? usd : null,
    credits: Number.isFinite(credits) ? credits : null,
  }
}

/** MuAPI mirrors the wallet charge into response headers — the cheapest capture point. */
function costFromHeaders(headers: Headers): { usd: number | null; credits: number | null } | null {
  const usd = Number(headers.get('x-muapi-cost-usd'))
  const credits = Number(headers.get('x-muapi-cost-credits'))
  if (!Number.isFinite(usd) && !Number.isFinite(credits)) return null
  return { usd: Number.isFinite(usd) ? usd : null, credits: Number.isFinite(credits) ? credits : null }
}

/**
 * MuAPI returns 422 when a model wants `images_list` and got `image_url` (or
 * vice versa). Returns a corrected payload, or null when the error is something
 * else entirely.
 */
function swapImageFieldShape(err: unknown, payload: Record<string, unknown>): Record<string, unknown> | null {
  if (!(err instanceof AppError) || err.kind !== 'provider_rejected') return null
  const body = String((err.details as { body?: string }).body ?? '')
  if (!/field required/i.test(body)) return null

  if (/images_list/.test(body) && typeof payload.image_url === 'string') {
    const { image_url, ...rest } = payload
    return { ...rest, images_list: [image_url] }
  }
  if (/image_url/.test(body) && Array.isArray(payload.images_list)) {
    const { images_list, ...rest } = payload
    return { ...rest, image_url: (images_list as string[])[0] }
  }
  if (/videos_list/.test(body) && typeof payload.video_url === 'string') {
    const { video_url, ...rest } = payload
    return { ...rest, videos_list: [video_url] }
  }
  return null
}

export function createMuapiProvider(opts: MuapiProviderOptions): MuapiProvider {
  return new MuapiProvider(opts)
}
