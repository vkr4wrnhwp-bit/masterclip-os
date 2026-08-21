import { describe, expect, it } from 'vitest'
import { RateLimiter, fixedClock } from '../src/index.js'

/**
 * Every assertion here advances a fake clock rather than sleeping, which is the
 * whole reason this limiter takes a `Clock` instead of calling `Date.now()`.
 */
const POLICY = { limit: 5, windowMs: 1_000 }

describe('RateLimiter', () => {
  it('allows a full burst then refuses the next request', () => {
    const clock = fixedClock(0)
    const limiter = new RateLimiter({ clock })

    for (let i = 0; i < 5; i++) {
      expect(limiter.check('a', POLICY).allowed).toBe(true)
    }
    const refused = limiter.check('a', POLICY)
    expect(refused.allowed).toBe(false)
    expect(refused.remaining).toBe(0)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('reports remaining budget as it drains', () => {
    const limiter = new RateLimiter({ clock: fixedClock(0) })
    expect(limiter.check('a', POLICY).remaining).toBe(4)
    expect(limiter.check('a', POLICY).remaining).toBe(3)
  })

  it('refills over time rather than resetting on a window edge', () => {
    const clock = fixedClock(0)
    const limiter = new RateLimiter({ clock })
    for (let i = 0; i < 5; i++) limiter.check('a', POLICY)
    expect(limiter.check('a', POLICY).allowed).toBe(false)

    // One fifth of the window buys back exactly one request, not the whole budget.
    clock.advance(200)
    expect(limiter.check('a', POLICY).allowed).toBe(true)
    expect(limiter.check('a', POLICY).allowed).toBe(false)

    clock.advance(1_000)
    for (let i = 0; i < 5; i++) expect(limiter.check('a', POLICY).allowed).toBe(true)
    expect(limiter.check('a', POLICY).allowed).toBe(false)
  })

  it('never lets a bucket refill past its capacity while idle', () => {
    const clock = fixedClock(0)
    const limiter = new RateLimiter({ clock })
    limiter.check('a', POLICY)
    clock.advance(60 * 60_000) // an hour of silence
    for (let i = 0; i < 5; i++) expect(limiter.check('a', POLICY).allowed).toBe(true)
    expect(limiter.check('a', POLICY).allowed).toBe(false)
  })

  it('does not push a refused caller further away when it retries in a loop', () => {
    const clock = fixedClock(0)
    const limiter = new RateLimiter({ clock })
    for (let i = 0; i < 5; i++) limiter.check('a', POLICY)

    // A client hammering while blocked must not extend its own timeout, or a
    // buggy retry loop would lock its user out indefinitely.
    for (let i = 0; i < 50; i++) limiter.check('a', POLICY)
    clock.advance(200)
    expect(limiter.check('a', POLICY).allowed).toBe(true)
  })

  it('keeps buckets independent per key', () => {
    const limiter = new RateLimiter({ clock: fixedClock(0) })
    for (let i = 0; i < 5; i++) limiter.check('a', POLICY)
    expect(limiter.check('a', POLICY).allowed).toBe(false)
    expect(limiter.check('b', POLICY).allowed).toBe(true)
  })

  it('bounds memory when an attacker rotates keys', () => {
    const clock = fixedClock(0)
    const limiter = new RateLimiter({ clock, maxKeys: 100 })
    for (let i = 0; i < 5_000; i++) limiter.check(`addr-${i}`, POLICY)
    // Unbounded growth here would turn a rate limiter into the denial of
    // service it exists to prevent.
    expect(limiter.size).toBeLessThanOrEqual(100)
  })

  it('keeps limiting a live attacker even while eviction is running', () => {
    const clock = fixedClock(0)
    const limiter = new RateLimiter({ clock, maxKeys: 50 })
    for (let i = 0; i < 5; i++) limiter.check('victim', POLICY)
    expect(limiter.check('victim', POLICY).allowed).toBe(false)

    // Churn enough keys to force eviction, then confirm the exhausted bucket we
    // care about survived it — an attacker must not be able to flush their own
    // penalty by making noise from other addresses.
    for (let i = 0; i < 200; i++) limiter.check(`noise-${i}`, POLICY)
    expect(limiter.check('victim', POLICY).allowed).toBe(false)
  })

  it('resets a single key without disturbing the others', () => {
    const limiter = new RateLimiter({ clock: fixedClock(0) })
    for (let i = 0; i < 5; i++) limiter.check('a', POLICY)
    for (let i = 0; i < 5; i++) limiter.check('b', POLICY)
    limiter.reset('a')
    expect(limiter.check('a', POLICY).allowed).toBe(true)
    expect(limiter.check('b', POLICY).allowed).toBe(false)
  })

  it('honours a burst larger than the sustained rate', () => {
    const clock = fixedClock(0)
    const limiter = new RateLimiter({ clock })
    const bursty = { limit: 2, windowMs: 1_000, burst: 6 }
    for (let i = 0; i < 6; i++) expect(limiter.check('a', bursty).allowed).toBe(true)
    expect(limiter.check('a', bursty).allowed).toBe(false)
    clock.advance(500) // half a window at 2/window = one token
    expect(limiter.check('a', bursty).allowed).toBe(true)
  })
})
