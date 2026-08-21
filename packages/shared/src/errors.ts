/**
 * Error taxonomy shared by every layer. The `kind` drives three decisions that
 * would otherwise be re-invented per provider: the HTTP status the API returns,
 * whether the queue retries, and whether a retry is allowed to spend money again.
 */
export type ErrorKind =
  | 'validation' // caller sent something invalid — never retry
  | 'not_found'
  | 'conflict' // idempotency / optimistic concurrency
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited' // this API refused an inbound request — distinct from a provider refusing ours
  | 'budget_exceeded' // hard stop, never retry without new authorization
  | 'provider_rejected' // provider says the request is invalid or unsafe — never retry
  | 'provider_rate_limited' // retry with backoff
  | 'provider_unavailable' // retry with backoff
  | 'provider_failed' // generation attempted and failed — retry is a NEW paid attempt
  | 'timeout'
  | 'io'
  | 'internal'

export interface AppErrorOptions {
  kind: ErrorKind
  message: string
  /** Stable machine code, e.g. `quote.expired`. */
  code?: string
  /** Safe to serialize to API clients. Never put secrets here. */
  details?: Record<string, unknown>
  cause?: unknown
  /** Provider-supplied retry hint, in seconds. */
  retryAfterSeconds?: number
}

export class AppError extends Error {
  readonly kind: ErrorKind
  readonly code: string
  readonly details: Record<string, unknown>
  readonly retryAfterSeconds?: number

  constructor(opts: AppErrorOptions) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'AppError'
    this.kind = opts.kind
    this.code = opts.code ?? opts.kind
    this.details = opts.details ?? {}
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds
  }

  toJSON() {
    return { error: { kind: this.kind, code: this.code, message: this.message, details: this.details } }
  }
}

const HTTP_STATUS: Record<ErrorKind, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  budget_exceeded: 402,
  provider_rejected: 422,
  provider_rate_limited: 429,
  provider_unavailable: 503,
  provider_failed: 502,
  timeout: 504,
  io: 500,
  internal: 500,
}

export function httpStatusFor(kind: ErrorKind): number {
  return HTTP_STATUS[kind] ?? 500
}

/**
 * Retry classification. `provider_failed` is deliberately absent: a failed
 * generation may have already been billed, so re-running it is a new paid
 * attempt and must go through the cost controller rather than the retry loop.
 */
const TRANSIENT: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'provider_rate_limited',
  'provider_unavailable',
  'timeout',
  'io',
])

export function isTransient(err: unknown): boolean {
  return err instanceof AppError && TRANSIENT.has(err.kind)
}

/** True when re-running would submit a second billable generation. */
export function retryCostsMoney(err: unknown): boolean {
  return err instanceof AppError && err.kind === 'provider_failed'
}

export function asAppError(err: unknown, fallback: ErrorKind = 'internal'): AppError {
  if (err instanceof AppError) return err
  const schema = asSchemaError(err)
  if (schema) return schema
  const message = err instanceof Error ? err.message : String(err)
  return new AppError({ kind: fallback, message, cause: err })
}

interface SchemaIssue {
  path?: Array<string | number>
  message?: string
  code?: string
}

/**
 * Recognises a zod failure without importing zod.
 *
 * Every route validates its body with `Schema.parse`, and a thrown ZodError is
 * a *caller* mistake. Left to the generic fallback it became a 500 whose
 * message was the raw multi-line JSON dump of the issue array — the wrong
 * status, logged at error level as if the server had broken, and unreadable in
 * the UI. `shared` deliberately has no zod dependency, so this matches on the
 * shape instead of `instanceof`, which also survives two copies of zod in the
 * tree.
 */
function asSchemaError(err: unknown): AppError | null {
  if (!(err instanceof Error) || err.name !== 'ZodError') return null
  const issues = (err as Error & { issues?: SchemaIssue[] }).issues
  if (!Array.isArray(issues)) return null
  const described = issues.slice(0, 10).map((issue) => ({
    field: (issue.path ?? []).join('.') || '(body)',
    message: issue.message ?? 'invalid',
    code: issue.code ?? 'invalid',
  }))
  const summary = described.map((i) => `${i.field}: ${i.message}`).join('; ')
  return new AppError({
    kind: 'validation',
    code: 'schema.invalid',
    message: summary || 'request body failed validation',
    details: { issues: described },
    cause: err,
  })
}

export const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppError({ kind: 'validation', message, details })
export const notFound = (what: string, id?: string) =>
  new AppError({ kind: 'not_found', message: `${what} not found`, details: id ? { id } : {} })
export const forbidden = (message = 'forbidden') => new AppError({ kind: 'forbidden', message })
export const unauthorized = (message = 'unauthorized') => new AppError({ kind: 'unauthorized', message })
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new AppError({ kind: 'conflict', message, details })
export const rateLimited = (message: string, retryAfterSeconds: number, details?: Record<string, unknown>) =>
  new AppError({ kind: 'rate_limited', code: 'rate_limited', message, retryAfterSeconds, details })
