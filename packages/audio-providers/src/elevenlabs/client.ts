import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { AppError, classifyStatus, httpJson, silentLogger, type Logger } from '@masterclip/shared'
import type { AudioInput, ProviderUsage } from '@masterclip/audio-core'

export const ELEVENLABS_PROVIDER_ID = 'elevenlabs'

/**
 * ElevenLabs adapter configuration.
 *
 * Endpoint paths, parameter names and default model ids in this directory were
 * verified against the official `@elevenlabs/elevenlabs-js` SDK v2.64.0 on
 * 2026-08-25 (see docs/AUDIO_PROVIDERS.md). Model ids remain configuration, not
 * code: accounts differ in which models and tiers they carry.
 */
export interface ElevenLabsOptions {
  apiKey: string
  baseUrl: string
  sttModelId: string
  ttsModelId: string
  /** No default on purpose — a voice is an account-level choice, never guessed. */
  ttsDefaultVoiceId: string
  musicModelId: string
  sfxModelId: string
  /**
   * Operator attestation that the account is on a tier where
   * `enable_logging: false` (zero-retention mode) is available. Without it the
   * adapter reports zero-retention unsupported and the policy gate rejects
   * zero-retention jobs before upload.
   */
  zeroRetentionCapable: boolean
  timeoutMs?: number
  logger?: Logger
}

export class ElevenLabsClient {
  readonly logger: Logger
  constructor(readonly opts: ElevenLabsOptions) {
    this.logger = opts.logger ?? silentLogger
  }

  isConfigured(): boolean {
    return this.opts.apiKey.length > 0
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'xi-api-key': this.opts.apiKey, ...extra }
  }

  url(path: string, query?: Record<string, string | undefined>): string {
    const target = new URL(path, this.opts.baseUrl.endsWith('/') ? this.opts.baseUrl : `${this.opts.baseUrl}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') target.searchParams.set(key, value)
    }
    return target.toString()
  }

  async json<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}): Promise<{ body: T; requestId?: string }> {
    const response = await httpJson<T>(this.url(path, init.query), {
      method: init.method ?? 'GET',
      headers: this.headers(),
      body: init.body,
      timeoutMs: this.opts.timeoutMs ?? 120_000,
      provider: ELEVENLABS_PROVIDER_ID,
      logger: this.logger,
    })
    return { body: response.body, requestId: requestIdFrom(response.headers) }
  }

  /** Multipart POST. Node's global FormData/Blob keep this dependency-free. */
  async multipart<T>(path: string, fields: Record<string, string | undefined>, files: Array<{ field: string; input: AudioInput }>, query?: Record<string, string | undefined>): Promise<{ body: T; requestId?: string; raw: string; status: number }> {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, value)
    }
    for (const file of files) {
      const bytes = await materialize(file.input)
      form.append(file.field, new Blob([bytes as BlobPart], { type: file.input.mimeType }), file.input.filename ?? (file.input.path ? basename(file.input.path) : 'audio'))
    }
    const response = await this.fetch(this.url(path, query), { method: 'POST', body: form })
    const raw = Buffer.from(await response.arrayBuffer()).toString('utf8')
    this.throwOnError(response, raw)
    let body: T
    try {
      body = (raw.length > 0 ? JSON.parse(raw) : {}) as T
    } catch {
      throw new AppError({ kind: 'provider_failed', code: 'elevenlabs.bad_json', message: `unparseable response from ${path}` })
    }
    return { body, requestId: requestIdFrom(response.headers), raw, status: response.status }
  }

  /** Multipart POST whose success response is binary (stems, isolation). */
  async multipartBinary(path: string, fields: Record<string, string | undefined>, files: Array<{ field: string; input: AudioInput }>, query?: Record<string, string | undefined>): Promise<{ bytes: Uint8Array; contentType: string; requestId?: string }> {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, value)
    }
    for (const file of files) {
      const bytes = await materialize(file.input)
      form.append(file.field, new Blob([bytes as BlobPart], { type: file.input.mimeType }), file.input.filename ?? 'audio')
    }
    const response = await this.fetch(this.url(path, query), { method: 'POST', body: form })
    return this.binaryResult(response, path)
  }

  /** JSON POST whose success response is binary (TTS, SFX, music). */
  async jsonBinary(path: string, body: unknown, query?: Record<string, string | undefined>): Promise<{ bytes: Uint8Array; contentType: string; requestId?: string }> {
    const response = await this.fetch(this.url(path, query), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return this.binaryResult(response, path)
  }

  async getBinary(path: string): Promise<{ bytes: Uint8Array; contentType: string; requestId?: string }> {
    const response = await this.fetch(this.url(path), { method: 'GET' })
    return this.binaryResult(response, path)
  }

  private async fetch(url: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit }): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 300_000)
    try {
      return await fetch(url, { ...init, headers: this.headers(init.headers ?? {}), signal: controller.signal })
    } catch (err) {
      const aborted = controller.signal.aborted
      throw new AppError({
        kind: aborted ? 'timeout' : 'provider_unavailable',
        code: aborted ? 'elevenlabs.timeout' : 'elevenlabs.unreachable',
        message: aborted ? 'elevenlabs request timed out' : `elevenlabs unreachable: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async binaryResult(response: Response, path: string): Promise<{ bytes: Uint8Array; contentType: string; requestId?: string }> {
    if (!response.ok) {
      const raw = Buffer.from(await response.arrayBuffer()).toString('utf8')
      this.throwOnError(response, raw)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length === 0) {
      throw new AppError({ kind: 'provider_failed', code: 'elevenlabs.empty', message: `empty response body from ${path}` })
    }
    return { bytes, contentType: response.headers.get('content-type') ?? 'application/octet-stream', requestId: requestIdFrom(response.headers) }
  }

  private throwOnError(response: Response, raw: string): void {
    if (response.ok) return
    let detail = raw.slice(0, 400)
    try {
      const parsed = JSON.parse(raw) as { detail?: { message?: string; status?: string } | string }
      if (typeof parsed.detail === 'string') detail = parsed.detail
      else if (parsed.detail?.message) detail = parsed.detail.message
    } catch {
      /* keep the raw excerpt */
    }
    throw new AppError({
      kind: classifyStatus(response.status),
      code: `elevenlabs.http_${response.status}`,
      message: `elevenlabs ${response.status}: ${detail}`,
    })
  }
}

export interface ElevenLabsAccountUsage {
  tier: string
  characterCount: number
  characterLimit: number
  status: string
}

/**
 * Account-level usage as the provider reports it — `GET v1/user` carries the
 * subscription's character count/limit and tier. Shown to flagship admins;
 * never used to invent prices.
 */
export async function fetchElevenLabsAccountUsage(client: ElevenLabsClient): Promise<ElevenLabsAccountUsage | null> {
  if (!client.isConfigured()) return null
  const { body } = await client.json<{ subscription?: { tier?: string; character_count?: number; character_limit?: number; status?: string } }>(
    'v1/user',
  )
  const subscription = body.subscription
  if (!subscription) return null
  return {
    tier: subscription.tier ?? 'unknown',
    characterCount: subscription.character_count ?? 0,
    characterLimit: subscription.character_limit ?? 0,
    status: subscription.status ?? 'unknown',
  }
}

export function requestIdFrom(headers: Headers): string | undefined {
  return headers.get('request-id') ?? headers.get('x-request-id') ?? undefined
}

export function usageFrom(unit: ProviderUsage['unit'], inputUnits: number, outputUnits: number, requestId?: string): ProviderUsage {
  const usage: ProviderUsage = { unit, inputUnits, outputUnits }
  if (requestId) usage.providerRequestId = requestId
  return usage
}

async function materialize(input: AudioInput): Promise<Uint8Array> {
  if (input.bytes) return input.bytes
  if (input.path) return new Uint8Array(await readFile(input.path))
  throw new AppError({ kind: 'validation', code: 'audio.no_bytes', message: 'audio input has neither bytes nor a local path' })
}
