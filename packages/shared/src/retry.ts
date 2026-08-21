import { AppError, isTransient } from './errors.js'

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  factor?: number
  /** Full jitter by default: `random(0, computed)`. Set 0 to disable for tests. */
  jitter?: number
}

/**
 * Exponential backoff with full jitter. Jitter is not decoration: without it,
 * every worker that hit the same provider 429 wakes up in the same millisecond
 * and reproduces the rate limit exactly.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}, random = Math.random): number {
  const base = opts.baseMs ?? 1_000
  const max = opts.maxMs ?? 5 * 60_000
  const factor = opts.factor ?? 2
  const jitter = opts.jitter ?? 1
  const raw = Math.min(max, base * Math.pow(factor, Math.max(0, attempt - 1)))
  if (jitter <= 0) return Math.round(raw)
  const jittered = raw * (1 - jitter) + random() * raw * jitter
  return Math.round(jittered)
}

export interface RetryDecision {
  retry: boolean
  delayMs: number
  reason: string
}

/**
 * Central retry policy. A provider's own `Retry-After` always wins over our
 * curve — providers know their own recovery window better than we do.
 */
export function decideRetry(
  err: unknown,
  attempt: number,
  maxAttempts: number,
  opts: BackoffOptions = {},
  random = Math.random,
): RetryDecision {
  if (attempt >= maxAttempts) {
    return { retry: false, delayMs: 0, reason: `attempts exhausted (${attempt}/${maxAttempts})` }
  }
  if (!isTransient(err)) {
    const kind = err instanceof AppError ? err.kind : 'unknown'
    return { retry: false, delayMs: 0, reason: `non-transient error (${kind})` }
  }
  const hinted = err instanceof AppError ? err.retryAfterSeconds : undefined
  if (typeof hinted === 'number' && hinted > 0) {
    return { retry: true, delayMs: Math.round(hinted * 1000), reason: 'provider Retry-After' }
  }
  return { retry: true, delayMs: backoffDelayMs(attempt, opts, random), reason: 'exponential backoff' }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `fn`, retrying transient failures per {@link decideRetry}. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: BackoffOptions & { maxAttempts?: number; onRetry?: (err: unknown, delayMs: number, attempt: number) => void } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4
  let attempt = 0
  for (;;) {
    attempt++
    try {
      return await fn(attempt)
    } catch (err) {
      const decision = decideRetry(err, attempt, maxAttempts, opts)
      if (!decision.retry) throw err
      opts.onRetry?.(err, decision.delayMs, attempt)
      await sleep(decision.delayMs)
    }
  }
}
