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
    // Only plain decimal dollars: no hex, exponents, signs, or sub-cent figures.
    for (const junk of ['ten', '$10', '10 dollars', 'NaN', 'Infinity', '-Infinity', '0x10', '1e3', '+5', '7.555', '1,000', '.5']) {
      expect(() => load({ CUSTOMER_SPEND_CAP_USD: junk }), junk).toThrow(
        /invalid environment configuration: CUSTOMER_SPEND_CAP_USD: must be a plain number of dollars, like 10/,
      )
    }
    expect(() => load({ CUSTOMER_SPEND_CAP_USD: '-5' })).toThrow(/CUSTOMER_SPEND_CAP_USD: must not be negative/)
  })

})

/**
 * LIVE_SPEND_CAP_USD is an optional monthly emergency brake for the whole
 * service. The owner manages CUSTOMER_SPEND_CAP_USD; three cases matter.
 */
describe('LIVE_SPEND_CAP_USD, the optional whole-service brake', () => {
  it('is the operator’s figure when it is set', () => {
    const set = load({ LIVE_SPEND_CAP_USD: '25', CUSTOMER_SPEND_CAP_USD: '10' })
    expect(set.liveSpendCapSource).toBe('env')
    expect(set.liveSpendCapConfigured).toBe(true)
    expect(set.LIVE_SPEND_CAP_USD).toBe(25)
    expect(set.liveSpendCapMicros).toBe(25_000_000)
    expect(set.customerSpendCapMicros).toBe(10_000_000)
    // Set without a customer cap is the old behaviour.
    expect(load({ LIVE_SPEND_CAP_USD: '25' }).liveSpendCapSource).toBe('env')
  })

  it('is no ceiling at all when it is unset or blank and the customer cap is set', () => {
    for (const live of [undefined, '', '   ']) {
      const config = load({ CUSTOMER_SPEND_CAP_USD: '10', ...(live === undefined ? {} : { LIVE_SPEND_CAP_USD: live }) })
      expect(config.liveSpendCapSource).toBe('none')
      expect(config.liveSpendCapConfigured).toBe(false)
      expect(config.LIVE_SPEND_CAP_USD).toBeNull()
      expect(config.liveSpendCapMicros).toBeNull()
    }
  })

  it('keeps the built-in $2 monthly ceiling when neither cap is set, so a service is never unlimited by accident', () => {
    for (const env of [{}, { LIVE_SPEND_CAP_USD: '', CUSTOMER_SPEND_CAP_USD: '' }] as Array<Record<string, string>>) {
      const config = load(env)
      expect(config.liveSpendCapSource).toBe('default')
      expect(config.liveSpendCapConfigured).toBe(false)
      expect(config.LIVE_SPEND_CAP_USD).toBe(2)
      expect(config.liveSpendCapMicros).toBe(2_000_000)
    }
  })

  it('keeps its parsing rules: zero is no live renders at all, and junk stops startup', () => {
    const zero = load({ LIVE_SPEND_CAP_USD: '0', CUSTOMER_SPEND_CAP_USD: '10' })
    expect(zero.liveSpendCapSource).toBe('env')
    expect(zero.liveSpendCapMicros).toBe(0)
    for (const junk of ['ten', '$5', '0x10', '1e3', '-1']) {
      expect(() => load({ LIVE_SPEND_CAP_USD: junk }), junk).toThrow(/LIVE_SPEND_CAP_USD/)
    }
  })
})
