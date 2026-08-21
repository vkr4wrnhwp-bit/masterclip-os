import { readFile } from 'node:fs/promises'
import { AppError, httpJson, loadConfig, type AppConfig } from '@masterclip/shared'
import {
  BaseProvider,
  downloadProviderOutputs,
  perSecondUsd,
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
import { FAL_MODELS, type FalModelSpec } from './catalog.js'

export * from './catalog.js'

/**
 * fal.ai adapter.
 *
 * Queue surface verified 2026-08-17 against fal's own official clients
 * (`fal-ai/fal-js`, `fal-ai/fal`) — the code that actually calls the API:
 *
 *   auth     Authorization: Key <FAL_KEY>
 *   submit   POST https://queue.fal.run/{endpoint_id}[?fal_webhook=<url>]
 *   status   GET  .../requests/{id}/status
 *   result   GET  .../requests/{id}
 *   cancel   PUT  .../requests/{id}/cancel        (PUT, not DELETE)
 *   upload   POST https://rest.fal.ai/storage/upload/initiate  → PUT upload_url
 *
 * One trap matters enough to encode structurally: fal's own clients build the
 * status/result/cancel URLs from only `owner/alias`, **discarding the rest of
 * the endpoint path**. Rather than reconstruct them, this adapter persists the
 * `status_url` / `response_url` / `cancel_url` strings the submit response
 * returns, and the external job id carries them.
 */
export interface FalProviderOptions extends ProviderDeps {
  config?: AppConfig
  apiKey?: string
  baseUrl?: string
  restUrl?: string
}

/**
 * fal's per-request URLs are not derivable from the endpoint id, so the
 * external job id is an encoded envelope holding the request id and the URLs
 * fal handed us.
 */
interface FalJobRef {
  requestId: string
  statusUrl: string
  responseUrl: string
  cancelUrl: string
}

export function encodeJobRef(ref: FalJobRef): string {
  return `fal:${Buffer.from(JSON.stringify(ref), 'utf8').toString('base64url')}`
}

export function decodeJobRef(externalJobId: string): FalJobRef {
  if (!externalJobId.startsWith('fal:')) {
    throw new AppError({ kind: 'validation', code: 'fal.bad_job_ref', message: `not a fal job reference: ${externalJobId}` })
  }
  try {
    return JSON.parse(Buffer.from(externalJobId.slice(4), 'base64url').toString('utf8')) as FalJobRef
  } catch (err) {
    throw new AppError({ kind: 'validation', code: 'fal.bad_job_ref', message: 'fal job reference is unreadable', cause: err })
  }
}

export class FalProvider extends BaseProvider {
  readonly providerId = 'fal'
  readonly displayName = 'fal.ai'

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly restUrl: string

  constructor(opts: FalProviderOptions) {
    super(opts)
    const config = opts.config ?? loadConfig()
    this.apiKey = opts.apiKey ?? config.FAL_KEY
    this.baseUrl = (opts.baseUrl ?? config.FAL_BASE_URL).replace(/\/+$/, '')
    this.restUrl = (opts.restUrl ?? 'https://rest.fal.ai').replace(/\/+$/, '')
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  private headers(json = true): Record<string, string> {
    return {
      authorization: `Key ${this.apiKey}`,
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
    }
  }

  async listModels(): Promise<NormalizedModel[]> {
    const fetchedAt = new Date(this.deps.now()).toISOString()
    // fal publishes no machine-readable catalog endpoint in its official
    // clients; the model list is compiled in and every entry carries its own
    // price source and retrieval date.
    return FAL_MODELS.map((spec) => ({
      providerId: this.providerId,
      modelId: spec.endpointId,
      displayName: spec.displayName,
      family: spec.family,
      capabilities: spec.capabilities,
      pricing: spec.usdPerSecond
        ? {
            ...perSecondUsd(spec.usdPerSecond, { retrievedAt: spec.retrievedAt, sourceUrl: spec.sourceUrl, notes: spec.priceNotes ?? '' }),
            ...(spec.usdPerSecondByResolution
              ? {
                  perResolutionMicros: Object.fromEntries(
                    Object.entries(spec.usdPerSecondByResolution).map(([res, usd]) => [res, Math.round((usd as number) * 1_000_000)]),
                  ),
                }
              : {}),
          }
        : null,
      enabled: true,
      raw: spec,
      fetchedAt,
      source: 'static' as const,
    }))
  }

  async submit(request: CanonicalRenderRequest): Promise<SubmittedJob> {
    const validation = await this.validate(request)
    if (!validation.ok) {
      throw new AppError({
        kind: 'provider_rejected',
        code: 'fal.invalid_request',
        message: `fal request is invalid: ${validation.errors.join('; ')}`,
      })
    }

    const spec = FAL_MODELS.find((m) => m.endpointId === request.modelId)
    const payload = buildFalPayload(request, spec)
    const url = new URL(`${this.baseUrl}/${request.modelId}`)
    if (request.webhookUrl) url.searchParams.set('fal_webhook', request.webhookUrl)

    const response = await httpJson<Record<string, unknown>>(url.toString(), {
      method: 'POST',
      headers: { ...this.headers(), 'x-fal-queue-priority': 'normal' },
      body: payload,
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 120_000,
    })

    const requestId = String(response.body.request_id ?? '')
    if (!requestId) {
      throw new AppError({
        kind: 'provider_failed',
        code: 'fal.no_request_id',
        message: 'fal submit returned no request_id',
        details: { body: response.raw.slice(0, 400) },
      })
    }

    const ref: FalJobRef = {
      requestId,
      statusUrl: String(response.body.status_url ?? ''),
      responseUrl: String(response.body.response_url ?? ''),
      cancelUrl: String(response.body.cancel_url ?? ''),
    }

    return {
      externalJobId: encodeJobRef(ref),
      providerId: this.providerId,
      modelId: request.modelId,
      submittedAt: new Date(this.deps.now()).toISOString(),
      externalRequestId: requestId,
      raw: response.body,
    }
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const ref = decodeJobRef(externalJobId)
    if (!ref.statusUrl) {
      throw new AppError({ kind: 'validation', code: 'fal.no_status_url', message: 'fal job reference has no status URL' })
    }

    const status = await httpJson<Record<string, unknown>>(ref.statusUrl, {
      headers: this.headers(false),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 30_000,
    })
    // fal's status enum is exactly three values; there is no distinct failure
    // state — a failed job reports COMPLETED and the error surfaces on fetching
    // the result, which is why the result is fetched before reporting success.
    const state = String(status.body.status ?? '')

    if (state === 'IN_QUEUE') {
      return baseStatus(externalJobId, 'queued', status.body)
    }
    if (state === 'IN_PROGRESS') {
      return baseStatus(externalJobId, 'running', status.body)
    }
    if (state !== 'COMPLETED') {
      return baseStatus(externalJobId, 'running', status.body)
    }

    const result = await httpJson<Record<string, unknown>>(ref.responseUrl, {
      headers: this.headers(false),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 60_000,
    }).catch((err: unknown) => {
      if (err instanceof AppError && (err.kind === 'provider_rejected' || err.kind === 'provider_failed')) return null
      throw err
    })

    if (!result) {
      return {
        ...baseStatus(externalJobId, 'failed', status.body),
        error: { code: 'fal.result_unavailable', message: 'fal reported COMPLETED but the result could not be fetched', retryable: true },
      }
    }

    const outputs = extractFalOutputs(result.body)
    if (outputs.length === 0) {
      const detail = String((result.body as { detail?: unknown }).detail ?? (result.body as { error?: unknown }).error ?? 'no video in result')
      return {
        ...baseStatus(externalJobId, 'failed', result.body),
        error: { code: 'fal.no_output', message: detail, retryable: false },
      }
    }

    return {
      externalJobId,
      state: 'succeeded',
      progress: 1,
      outputs,
      error: null,
      actualMicros: null,
      actualCredits: null,
      billableSeconds: null,
      raw: result.body,
    }
  }

  async cancel(externalJobId: string): Promise<void> {
    const ref = decodeJobRef(externalJobId)
    if (!ref.cancelUrl) {
      throw new AppError({ kind: 'validation', code: 'fal.no_cancel_url', message: 'fal job reference has no cancel URL' })
    }
    // PUT, per fal's own clients.
    await httpJson(ref.cancelUrl, { method: 'PUT', headers: this.headers(false), provider: this.providerId, timeoutMs: 30_000 })
  }

  /**
   * fal ships no webhook-signature helper in either official client, and no
   * signature scheme was confirmable during research. The callback is therefore
   * treated as an unauthenticated wake-up: the URL carries our own HMAC token
   * (see provider-core/webhook.ts) and the payload's `request_id` is used only
   * to look the job up. Authoritative state comes from re-polling.
   */
  async normalizeWebhook(payload: unknown): Promise<ProviderEvent> {
    const body = (payload ?? {}) as Record<string, unknown>
    const requestId = String(body.request_id ?? body.gateway_request_id ?? '')
    if (!requestId) {
      throw new AppError({ kind: 'validation', code: 'fal.webhook_no_id', message: 'fal webhook carried no request_id' })
    }
    const status: ProviderJobStatus = {
      externalJobId: requestId,
      state: String(body.status ?? '') === 'OK' ? 'succeeded' : 'failed',
      progress: null,
      outputs: extractFalOutputs((body.payload ?? {}) as Record<string, unknown>),
      error:
        String(body.status ?? '') === 'OK'
          ? null
          : { code: 'fal.webhook_error', message: String(body.error ?? body.payload_error ?? 'fal reported an error'), retryable: true },
      actualMicros: null,
      actualCredits: null,
      billableSeconds: null,
      raw: payload,
    }
    return {
      providerId: this.providerId,
      externalJobId: requestId,
      dedupeKey: `${requestId}:${String(body.status ?? '')}`,
      status,
      receivedAt: new Date(this.deps.now()).toISOString(),
      raw: payload,
    }
  }

  async downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
    return downloadProviderOutputs(job, destDir)
  }

  /** Two-step signed-URL upload, matching fal's own JS client. */
  async uploadFile(localPath: string, filename: string, mime: string): Promise<string> {
    const initiate = await httpJson<{ file_url?: string; upload_url?: string }>(
      `${this.restUrl}/storage/upload/initiate?storage_type=fal-cdn-v3`,
      {
        method: 'POST',
        headers: this.headers(),
        body: { file_name: filename, content_type: mime },
        provider: this.providerId,
        logger: this.deps.logger,
        timeoutMs: 30_000,
      },
    )
    const uploadUrl = initiate.body.upload_url
    const fileUrl = initiate.body.file_url
    if (!uploadUrl || !fileUrl) {
      throw new AppError({ kind: 'provider_failed', code: 'fal.upload_initiate', message: 'fal upload initiate returned no URLs' })
    }
    const data = await readFile(localPath)
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': mime }, body: new Uint8Array(data) })
    if (!put.ok) {
      throw new AppError({ kind: 'io', code: 'fal.upload_put', message: `fal upload PUT failed with ${put.status}` })
    }
    return fileUrl
  }

  async getAccountBalance(): Promise<AccountBalance> {
    throw new AppError({
      kind: 'validation',
      code: 'fal.no_balance_endpoint',
      message: 'no balance endpoint is exposed by fal’s official clients — track spend in the fal dashboard',
    })
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.deps.now()).toISOString()
    if (!this.isConfigured()) {
      return { providerId: this.providerId, status: 'unconfigured', latencyMs: null, message: 'FAL_KEY is not set', checkedAt }
    }
    try {
      // No dedicated health route; a cheap authenticated 404 still proves the
      // host is reachable and the credential is accepted at the edge.
      const started = this.deps.now()
      const response = await fetch(`${this.baseUrl}/fal-ai/__masterclip_healthcheck__/requests/none/status`, {
        headers: this.headers(false),
      })
      const latencyMs = this.deps.now() - started
      const reachable = response.status < 500
      return {
        providerId: this.providerId,
        status: reachable ? (latencyMs > 5_000 ? 'degraded' : 'healthy') : 'unavailable',
        latencyMs,
        message: `queue endpoint responded ${response.status}`,
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

function baseStatus(externalJobId: string, state: ProviderJobStatus['state'], raw: unknown): ProviderJobStatus {
  return {
    externalJobId,
    state,
    progress: null,
    outputs: [],
    error: null,
    actualMicros: null,
    actualCredits: null,
    billableSeconds: null,
    raw,
  }
}

/** fal model outputs vary in shape; every known video shape is probed. */
export function extractFalOutputs(body: Record<string, unknown>): ProviderOutputRef[] {
  const candidates: Array<Record<string, unknown>> = []
  const video = body.video as Record<string, unknown> | undefined
  if (video && typeof video === 'object') candidates.push(video)
  for (const key of ['videos', 'output', 'outputs']) {
    const value = body[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') candidates.push(item as Record<string, unknown>)
        else if (typeof item === 'string') candidates.push({ url: item })
      }
    } else if (value && typeof value === 'object') {
      candidates.push(value as Record<string, unknown>)
    }
  }

  return candidates
    .map((candidate, index) => {
      const url = String(candidate.url ?? candidate.video_url ?? '')
      if (!url) return null
      return {
        url,
        mime: String(candidate.content_type ?? 'video/mp4'),
        index,
        ...(typeof candidate.file_size === 'number' ? { bytes: candidate.file_size } : {}),
      } satisfies ProviderOutputRef
    })
    .filter((ref): ref is ProviderOutputRef => ref !== null)
}

/** Maps our canonical request onto the input field names a fal video model expects. */
export function buildFalPayload(request: CanonicalRenderRequest, spec?: FalModelSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = { prompt: request.prompt }
  if (request.negativePrompt && spec?.capabilities.negativePrompt !== false) payload.negative_prompt = request.negativePrompt
  if (spec?.durationField === 'string') payload.duration = String(Math.round(request.durationSeconds))
  else payload.duration = Math.round(request.durationSeconds)
  payload.aspect_ratio = request.aspectRatio
  payload.resolution = request.resolution
  if (request.seed && spec?.capabilities.seed) payload.seed = Number(request.seed) || undefined
  if (spec?.capabilities.nativeAudio) payload.generate_audio = request.audio.mode === 'native_generated' || request.audio.mode === 'native_dialogue'

  const first = request.inputs.firstFrame ?? request.inputs.references[0]
  if (first) {
    const url = first.remoteRef ?? first.url
    if (!url) {
      throw new AppError({
        kind: 'validation',
        code: 'fal.reference_not_uploaded',
        message: 'fal needs a URL for reference images — upload the asset first via uploadFile()',
      })
    }
    payload.image_url = url
  }
  if (request.inputs.lastFrame) {
    const url = request.inputs.lastFrame.remoteRef ?? request.inputs.lastFrame.url
    if (url) payload.end_image_url = url
  }
  if (request.inputs.video) {
    const url = request.inputs.video.remoteRef ?? request.inputs.video.url
    if (url) payload.video_url = url
  }
  return payload
}

export function createFalProvider(opts: FalProviderOptions): FalProvider {
  return new FalProvider(opts)
}
