import type { Clock } from './clock.js'

/**
 * An in-process token-bucket rate limiter.
 *
 * Deliberately not a third-party plugin: every other timing-sensitive part of
 * this system takes an injectable `Clock` so its tests can advance time instead
 * of sleeping, and a limiter bound to real wall-clock time would have made the
 * only tests that matter here — "does the 11th login in a minute get refused?"
 * — either slow or flaky.
 *
 * A token bucket rather than a fixed window because fixed windows let a caller
 * spend the whole budget in the last millisecond of one window and the whole
 * budget again in the first millisecond of the next, which is 2x the intended
 * rate at exactly the moment an attacker cares about.
 *
 * Single-process only. Behind more than one API instance each process keeps its
 * own counters, so the effective limit multiplies by the instance count; that is
 * documented in docs/security-model.md and is why this is defence in depth
 * rather than a quota system.
 */
export interface RateLimitPolicy {
  /** Sustained requests allowed per `windowMs`. */
  limit: number
  windowMs: number
  /**
   * Bucket capacity — how much of the budget may be spent at once after an idle
   * period. Defaults to `limit` (a full window's worth).
   */
  burst?: number
}

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  /** Whole tokens left after this decision. */
  remaining: number
  /** Seconds until the next token is available. 0 when allowed. */
  retryAfterSeconds: number
}

interface Bucket {
  tokens: number
  updatedAtMs: number
  /** Kept per bucket so eviction can compare keys governed by different policies. */
  capacity: number
  refillPerMs: number
}

export interface RateLimiterOptions {
  clock: Clock
  /**
   * Cap on tracked keys. An attacker rotating source addresses would otherwise
   * grow this map without bound, turning a rate limiter into a memory
   * exhaustion vector — which is the same denial of service by another route.
   */
  maxKeys?: number
}

const DEFAULT_MAX_KEYS = 20_000

/** Tokens a bucket holds at `now`, capped at its capacity. */
function fill(bucket: Bucket, now: number): number {
  const elapsed = Math.max(0, now - bucket.updatedAtMs)
  return Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs)
}

export class RateLimiter {
  readonly #clock: Clock
  readonly #maxKeys: number
  readonly #buckets = new Map<string, Bucket>()

  constructor(opts: RateLimiterOptions) {
    this.#clock = opts.clock
    this.#maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS
  }

  /** Number of tracked keys. Exposed for tests and the ops health view. */
  get size(): number {
    return this.#buckets.size
  }

  /**
   * Consumes one token for `key` under `policy`.
   *
   * Consumption happens only when the request is allowed: a refused request
   * must not push the caller's recovery further away, or a client retrying in a
   * tight loop could hold itself out indefinitely.
   */
  check(key: string, policy: RateLimitPolicy): RateLimitDecision {
    const capacity = policy.burst ?? policy.limit
    const now = this.#clock.now()
    const refillPerMs = policy.limit / policy.windowMs

    let bucket = this.#buckets.get(key)
    if (!bucket) {
      this.#evictIfNeeded(now)
      bucket = { tokens: capacity, updatedAtMs: now, capacity, refillPerMs }
      this.#buckets.set(key, bucket)
    } else {
      bucket.tokens = fill(bucket, now)
      bucket.updatedAtMs = now
      bucket.capacity = capacity
      bucket.refillPerMs = refillPerMs
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true, limit: policy.limit, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 }
    }

    // Multiply by windowMs/limit rather than dividing by the rounded
    // refillPerMs: the division lands a hair above the true answer, and
    // Math.ceil then turns that hair into a whole extra second — an empty
    // 1-per-15-minutes bucket advertised 901s instead of 900s.
    const msUntilNextToken = (1 - bucket.tokens) * (policy.windowMs / policy.limit)
    return {
      allowed: false,
      limit: policy.limit,
      remaining: 0,
      // Always at least a second: a `Retry-After: 0` invites an immediate retry.
      retryAfterSeconds: Math.max(1, Math.ceil(msUntilNextToken / 1000)),
    }
  }

  /** Drops one key, or every key when called with no argument. */
  reset(key?: string): void {
    if (key === undefined) this.#buckets.clear()
    else this.#buckets.delete(key)
  }

  /**
   * Makes room when the map is at its cap, discarding the least useful state.
   *
   * Emptiness, not age, is what decides. A bucket that has refilled to capacity
   * is indistinguishable from a key never seen before, so it costs nothing to
   * forget; a bucket at zero is the only thing standing between a caller and
   * unlimited requests. Evicting by recency instead — the obvious LRU choice —
   * hands an attacker a way to erase their own penalty: exhaust a budget, then
   * make noise from a few hundred fresh addresses until the exhausted bucket
   * ages out of the map. Sorting by fullness makes that noise evict itself.
   */
  #evictIfNeeded(now: number): void {
    if (this.#buckets.size < this.#maxKeys) return

    const ranked: Array<{ key: string; fullness: number }> = []
    for (const [key, bucket] of this.#buckets) {
      const fullness = fill(bucket, now) / bucket.capacity
      if (fullness >= 1) this.#buckets.delete(key)
      else ranked.push({ key, fullness })
    }
    if (this.#buckets.size < this.#maxKeys) return

    ranked.sort((a, b) => b.fullness - a.fullness)
    const toDrop = Math.max(1, Math.floor(this.#maxKeys / 10))
    for (const { key } of ranked.slice(0, toDrop)) this.#buckets.delete(key)
  }
}
