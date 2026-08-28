import { describe, expect, it } from 'vitest'
import { CostController } from '@masterclip/cost-engine'
import { createTestDb, insertRow, type Db } from '@masterclip/database'
import { quoteFromProvider, sampleRequest } from '@masterclip/provider-core'
import { fixedClock, loadConfig, usdToMicros } from '@masterclip/shared'
import { isFreeProvider } from '../src/render.js'

const clock = fixedClock(Date.UTC(2026, 7, 28, 12, 0, 0))

/**
 * The safety property: `sandbox: true` means "this request cannot cost money",
 * and it is the flag the cost controller reads to decide NOT to enforce.
 *
 * `isFreeProvider` once also returned true whenever MASTERCLIP_MODE=sandbox.
 * That inverted every rail in the default posture — a real provider request was
 * stamped sandbox, so the live-spend cap, the approval gate and both price
 * denials were skipped, the HTTP call went out, and the charge was ledgered as
 * sandbox so the cap would never see it later either.
 *
 * cost-engine's own "blocks every billable submission while the mode is
 * sandbox" test passed throughout, because it hands the controller
 * `sandbox: false` by hand — it proves the gate works, never that anything
 * reaches it. These tests close that gap from both ends.
 */

const REAL_PROVIDERS = ['muapi', 'google', 'fal', 'runway', 'luma', 'replicate', 'selfhosted']

describe('sandbox is a provider fact, not a deployment posture', () => {
  it('classifies only the mock provider as free', () => {
    expect(isFreeProvider('mock')).toBe(true)
    for (const providerId of REAL_PROVIDERS) {
      expect(isFreeProvider(providerId), `${providerId} bills real money`).toBe(false)
    }
  })

  // The regression itself: re-adding `|| config.isSandbox` flips every provider
  // below to free, and this fails.
  it('does not change with MASTERCLIP_MODE', () => {
    for (const mode of ['sandbox', 'live']) {
      loadConfig({ MASTERCLIP_MODE: mode } as NodeJS.ProcessEnv, true)
      expect(isFreeProvider('mock'), `mock under ${mode}`).toBe(true)
      expect(isFreeProvider('google'), `google under ${mode}`).toBe(false)
    }
    loadConfig({} as NodeJS.ProcessEnv, true)
  })
})

describe('a request classified by that fact is actually refused', () => {
  const ORG = 'org_t'
  const PROJECT = 'proj_t'
  const SHOT = 'shot_t'

  async function controllerInSandbox(): Promise<{ db: Db; controller: CostController }> {
    const db = await createTestDb()
    await insertRow(db, 'orgs', { id: ORG, name: 'Test', created_at: clock.isoNow() })
    await insertRow(db, 'projects', {
      id: PROJECT, org_id: ORG, name: 'P', slug: 'p', brief: '', style_bible: '{}',
      status: 'active', created_at: clock.isoNow(), updated_at: clock.isoNow(), archived_at: null,
    })
    const config = loadConfig({ NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LIVE_SPEND_CAP_USD: '2' }, true)
    return { db, controller: new CostController(db, config, clock) }
  }

  // The request carries whatever the classifier decided — that is the value
  // under test, not a hand-set boolean.
  function authorizationFor(providerId: string) {
    const request = sampleRequest({
      durationSeconds: 4,
      maxCostMicros: usdToMicros(5),
      providerId,
      sandbox: isFreeProvider(providerId),
    })
    const quote = quoteFromProvider({
      providerId, request, micros: usdToMicros(0.4), nowMs: clock.now(), raw: {},
    })
    return { request, quote }
  }

  it('refuses a real provider under MASTERCLIP_MODE=sandbox', async () => {
    const { controller } = await controllerInSandbox()
    const { request, quote } = authorizationFor('google')
    const result = await controller.authorize({
      orgId: ORG, projectId: PROJECT, shotId: SHOT, request, quote, tier: 'standard', humanApproved: true,
    })
    expect(result.allowed).toBe(false)
    expect(result.denials.map((d) => d.code)).toContain('mode.sandbox_required')
  })

  it('still lets the free mock provider through', async () => {
    const { controller } = await controllerInSandbox()
    const { request, quote } = authorizationFor('mock')
    const result = await controller.authorize({
      orgId: ORG, projectId: PROJECT, shotId: SHOT, request, quote, tier: 'standard', humanApproved: true,
    })
    expect(result.denials.map((d) => d.code)).not.toContain('mode.sandbox_required')
  })
})
