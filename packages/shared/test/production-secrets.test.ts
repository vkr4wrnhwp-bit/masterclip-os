import { describe, expect, it } from 'vitest'
import { DEV_ASSET_SIGNING_SECRET, DEV_SESSION_SECRET, loadConfig, resetConfigCache } from '../src/index.js'

/**
 * A production deployment must not boot signing anything with a value printed
 * in this repository.
 *
 * `createStorage()` already refused an empty ASSET_SIGNING_SECRET, but only on
 * the local-driver path — with STORAGE_DRIVER=s3 nothing refused it — and
 * nothing refused an empty SESSION_SECRET anywhere. The guard now lives at
 * config load so it covers the API, the worker and the CLI alike.
 */
const GOOD = {
  SESSION_SECRET: 'x'.repeat(32),
  ASSET_SIGNING_SECRET: 'y'.repeat(32),
}

function load(env: Record<string, string>) {
  resetConfigCache()
  return loadConfig(env as NodeJS.ProcessEnv, true)
}

describe('production secret guard', () => {
  it('refuses to start in production with no SESSION_SECRET', () => {
    expect(() => load({ NODE_ENV: 'production', ASSET_SIGNING_SECRET: GOOD.ASSET_SIGNING_SECRET })).toThrow(
      /SESSION_SECRET is not set/,
    )
  })

  it('refuses to start in production with no ASSET_SIGNING_SECRET', () => {
    expect(() => load({ NODE_ENV: 'production', SESSION_SECRET: GOOD.SESSION_SECRET })).toThrow(
      /ASSET_SIGNING_SECRET is not set/,
    )
  })

  // The specific hole: STORAGE_DRIVER=s3 never constructs LocalStorage, so the
  // driver-level guard never ran and an empty asset secret sailed through.
  it('refuses in production even when the storage driver would never check', () => {
    expect(() => load({ NODE_ENV: 'production', STORAGE_DRIVER: 's3', SESSION_SECRET: GOOD.SESSION_SECRET })).toThrow(
      /ASSET_SIGNING_SECRET is not set/,
    )
  })

  it('refuses the development secrets published in this repository', () => {
    expect(() =>
      load({ NODE_ENV: 'production', SESSION_SECRET: DEV_SESSION_SECRET, ASSET_SIGNING_SECRET: GOOD.ASSET_SIGNING_SECRET }),
    ).toThrow(/SESSION_SECRET is the development value published in this repository/)

    expect(() =>
      load({ NODE_ENV: 'production', SESSION_SECRET: GOOD.SESSION_SECRET, ASSET_SIGNING_SECRET: DEV_ASSET_SIGNING_SECRET }),
    ).toThrow(/ASSET_SIGNING_SECRET is the development value published in this repository/)
  })

  it('refuses a secret too short to be worth signing with', () => {
    expect(() => load({ NODE_ENV: 'production', SESSION_SECRET: 'short', ASSET_SIGNING_SECRET: GOOD.ASSET_SIGNING_SECRET })).toThrow(
      /SESSION_SECRET is 5 characters; use at least 16/,
    )
  })

  it('reports every problem at once rather than one per restart', () => {
    expect(() => load({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET is not set; ASSET_SIGNING_SECRET is not set/)
  })

  it('starts in production once both secrets are real', () => {
    const config = load({ NODE_ENV: 'production', ...GOOD })
    expect(config.NODE_ENV).toBe('production')
    expect(config.SESSION_SECRET).toBe(GOOD.SESSION_SECRET)
  })

  // A clean checkout must still run with no secrets configured at all; the
  // guard exists to stop a production deployment, not to add local ceremony.
  it('leaves development and test alone', () => {
    expect(() => load({ NODE_ENV: 'development' })).not.toThrow()
    expect(() => load({ NODE_ENV: 'test' })).not.toThrow()
    expect(() => load({})).not.toThrow()
  })
})
