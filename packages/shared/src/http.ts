import { AppError, type ErrorKind } from './errors.js'
import { redactHeaders } from './redact.js'
import type { Logger } from './logger.js'

export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  /** Sent as-is (multipart, raw bytes). Takes precedence over `body`. */
  rawBody?: BodyInit
  timeoutMs?: number
  signal?: AbortSignal
  logger?: Logger
  /** Included in errors so a failure names the adapter that produced it. */
  provider?: string
}

export interface HttpResponse<T> {
  status: number
  headers: Headers
  body: T
  raw: string
  /** Wall-clock latency, fed into provider health and routing. */
  latencyMs: number
}

/**
 * Maps transport and HTTP status outcomes onto the shared error taxonomy so
 * every adapter retries, gives up, and reports identically. Adapters override
 * this only when a provider encodes something more specific in the body.
 */
export function classifyStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 402) return 'budget_exceeded'
  if (status === 422 || status === 400) return 'provider_rejected'
  if (status === 429) return 'provider_rate_limited'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500) return 'provider_unavailable'
  return 'provider_failed'
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber)) return asNumber
  const asDate = Date.parse(raw)
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000))
  return undefined
}

/**
 * The single outbound HTTP path for every provider adapter. Centralising it
 * means timeouts, redaction, latency capture, and error classification are
 * uniform and testable rather than re-implemented seven times.
 */
export async function httpJson<T = unknown>(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
  const method = opts.method ?? 'GET'
  const timeoutMs = opts.timeoutMs ?? 60_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true })

  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) }
  let body: BodyInit | undefined = opts.rawBody
  if (body === undefined && opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers['content-type'] = headers['content-type'] ?? 'application/json'
  }

  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal })
  } catch (err) {
    clearTimeout(timer)
    const aborted = controller.signal.aborted
    throw new AppError({
      kind: aborted ? 'timeout' : 'provider_unavailable',
      code: aborted ? 'http.timeout' : 'http.transport',
      message: aborted ? `request to ${redactUrl(url)} timed out after ${timeoutMs}ms` : `request to ${redactUrl(url)} failed`,
      details: { provider: opts.provider, method, url: redactUrl(url) },
      cause: err,
    })
  } finally {
    clearTimeout(timer)
  }

  const latencyMs = Date.now() - startedAt
  const raw = await response.text()

  opts.logger?.debug('http', {
    provider: opts.provider,
    method,
    url: redactUrl(url),
    status: response.status,
    latency_ms: latencyMs,
    req_headers: redactHeaders(headers),
  })

  if (!response.ok) {
    throw new AppError({
      kind: classifyStatus(response.status),
      code: `http.${response.status}`,
      message: `${opts.provider ?? 'http'} ${method} ${redactUrl(url)} → ${response.status}`,
      details: { provider: opts.provider, status: response.status, body: raw.slice(0, 2000) },
      retryAfterSeconds: parseRetryAfter(response.headers),
    })
  }

  let parsed: T
  if (raw.length === 0) {
    parsed = undefined as unknown as T
  } else {
    try {
      parsed = JSON.parse(raw) as T
    } catch (err) {
      throw new AppError({
        kind: 'provider_failed',
        code: 'http.invalid_json',
        message: `${opts.provider ?? 'http'} returned non-JSON body`,
        details: { provider: opts.provider, body: raw.slice(0, 500) },
        cause: err,
      })
    }
  }

  return { status: response.status, headers: response.headers, body: parsed, raw, latencyMs }
}

/** Strips query strings, which routinely carry signed tokens and API keys. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.search ? `${parsed.origin}${parsed.pathname}?[REDACTED]` : `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split('?')[0] ?? url
  }
}
