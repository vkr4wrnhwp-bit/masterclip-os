import { describe, expect, it } from 'vitest'
import { loadConfig, resetConfigCache } from '../src/index.js'

/**
 * CUSTOMER_SPEND_CAP_USD: the most one customer may spend on live renders in a
 * calendar month. Unset means "no per-customer cap", which must stay
 * distinguishable from zero, and anything that is not a plain non-negative
 * number must stop the service at startup instead of becoming NaN, a negative
 * limit, or a blank that quietly shuts every customer out.
 */
function load(env: Record<string, string>) {
  resetConfigCache()
  return loadConfig({ NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv, true)
}

describe('CUSTOMER_SPEND_CAP_USD', () => {
  it('is simply not set when the environment does not have it', () => {
    const config = load({})
    expect(config.CUSTOMER_SPEND_CAP_USD).toBeUndefined()
    expect(config.customerSpendCapConfigured).toBe(false)
    expect(config.customerSpendCapMicros).toBeNull()
  })

  it('treats a blank value, even just spaces, as not set rather than as zero dollars', () => {
    for (const blank of ['', '   ']) {
      const config = load({ CUSTOMER_SPEND_CAP_USD: blank })
      expect(config.customerSpendCapConfigured).toBe(false)
      expect(config.customerSpendCapMicros).toBeNull()
    }
  })

  it('reads a plain number of dollars', () => {
    const ten = load({ CUSTOMER_SPEND_CAP_USD: '10' })
    expect(ten.CUSTOMER_SPEND_CAP_USD).toBe(10)
    expect(ten.customerSpendCapConfigured).toBe(true)
    expect(ten.customerSpendCapMicros).toBe(10_000_000)

    expect(load({ CUSTOMER_SPEND_CAP_USD: ' 7.5 ' }).customerSpendCapMicros).toBe(7_500_000)
  })

  it('allows zero, which is a decision (no customer renders live) and not an absence', () => {
    const zero = load({ CUSTOMER_SPEND_CAP_USD: '0' })
    expect(zero.customerSpendCapConfigured).toBe(true)
    expect(zero.customerSpendCapMicros).toBe(0)
  })

  it('stops startup with a plain sentence for anything that is not a plain non-negative number', () => {
    for (const junk of ['ten', '$10', '10 dollars', 'NaN', 'Infinity', '-Infinity']) {
      expect(() => load({ CUSTOMER_SPEND_CAP_USD: junk }), junk).toThrow(
        /invalid environment configuration: CUSTOMER_SPEND_CAP_USD: must be a plain number of dollars, like 10/,
      )
    }
    expect(() => load({ CUSTOMER_SPEND_CAP_USD: '-5' })).toThrow(/CUSTOMER_SPEND_CAP_USD: must not be negative/)
  })

  it('does not change how the whole-service LIVE_SPEND_CAP_USD is read', () => {
    // Same two outcomes as before: unset falls back to the built-in limit and
    // says so, and junk stops startup.
    const unset = load({})
    expect(unset.LIVE_SPEND_CAP_USD).toBe(2)
    expect(unset.liveSpendCapConfigured).toBe(false)
    const set = load({ LIVE_SPEND_CAP_USD: '25', CUSTOMER_SPEND_CAP_USD: '10' })
    expect(set.liveSpendCapMicros).toBe(25_000_000)
    expect(set.customerSpendCapMicros).toBe(10_000_000)
    expect(() => load({ LIVE_SPEND_CAP_USD: 'ten' })).toThrow(/LIVE_SPEND_CAP_USD/)
  })
})
