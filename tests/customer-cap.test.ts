import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, insertRow, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { CostController, CostLedger } from '@masterclip/cost-engine'
import { fixedClock, loadConfig, silentLogger, usdToMicros } from '@masterclip/shared'
import { createRuntime, RenderService, type Runtime } from '@masterclip/runtime'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'

/**
 * The per-customer monthly cap where it meets the rest of the product: the
 * visual-QC gate in the render service (the one live spend that never passes
 * through the cost controller's authorize()), and the numbers the screens read
 * from the API.
 */
const clock = fixedClock(Date.UTC(2026, 9, 13, 12, 0, 0))

async function seedOrgs(db: Db) {
  const orgs = [
    { id: 'org_house', identity: null, createdAt: Date.UTC(2026, 0, 1) },
    { id: 'org_a', identity: 'uid:101', createdAt: Date.UTC(2026, 5, 1) },
    { id: 'org_b', identity: 'uid:102', createdAt: Date.UTC(2026, 5, 2) },
  ]
  for (const org of orgs) {
    await insertRow(db, 'orgs', { id: org.id, name: org.id, created_at: new Date(org.createdAt).toISOString(), street_banker_identity: org.identity })
  }
  return { house: 'org_house', a: 'org_a', b: 'org_b' }
}

async function charge(ledger: CostLedger, orgId: string, usd: number, entryType: 'charge' | 'qc' = 'charge') {
  await ledger.append({ orgId, providerId: 'mock', modelId: 'm', entryType, micros: usdToMicros(usd), sandbox: false, createdBy: 'test' })
}

describe('visual QC and the customer cap', () => {
  let db: Db
  let orgs: Awaited<ReturnType<typeof seedOrgs>>

  beforeEach(async () => {
    db = await createTestDb()
    orgs = await seedOrgs(db)
  })

  /** The render service's QC gate, wired to a real controller and ledger on this database. */
  function gate(env: Record<string, string>) {
    const config = loadConfig({ NODE_ENV: 'test', MASTERCLIP_MODE: 'live', ...env }, true)
    const ledger = new CostLedger(db, clock)
    const service = new RenderService({ config, ledger, cost: new CostController(db, config, clock), clock } as unknown as Runtime)
    const check = (orgId: string) =>
      (service as unknown as { assertQcSpendAllowed(outputId: string, orgId: string): Promise<void> }).assertQcSpendAllowed('out_1', orgId)
    return { ledger, check }
  }

  it('refuses a customer who has used the month, in the same words and under the same code as a render', async () => {
    const { ledger, check } = gate({ LIVE_SPEND_CAP_USD: '1000', CUSTOMER_SPEND_CAP_USD: '10' })
    await charge(ledger, orgs.a, 9)
    await charge(ledger, orgs.a, 1, 'qc')
    await expect(check(orgs.a)).rejects.toMatchObject({
      code: 'spend.customer_cap',
      message: "You've used this month's $10 of MOTION renders. More renders need credits.",
    })
    // Another customer, and the owner's own account, are not held to A's month.
    await expect(check(orgs.b)).resolves.toBeUndefined()
    await expect(check(orgs.house)).resolves.toBeUndefined()
  })

  it('lets everyone through when no customer cap is set', async () => {
    const { ledger, check } = gate({ LIVE_SPEND_CAP_USD: '1000', CUSTOMER_SPEND_CAP_USD: '' })
    await charge(ledger, orgs.a, 400)
    await expect(check(orgs.a)).resolves.toBeUndefined()
  })

  it('holds the house to the whole-service ceiling, which counts this month only', async () => {
    const { ledger, check } = gate({ LIVE_SPEND_CAP_USD: '2', CUSTOMER_SPEND_CAP_USD: '10' })
    // Last month's spend, however large, is not this month's.
    await new CostLedger(db, fixedClock(Date.UTC(2026, 8, 20))).append({
      orgId: orgs.a, providerId: 'mock', modelId: 'm', entryType: 'charge', micros: usdToMicros(30), sandbox: false, createdBy: 'test',
    })
    await expect(check(orgs.house)).resolves.toBeUndefined()

    await charge(ledger, orgs.b, 2)
    await expect(check(orgs.house)).rejects.toMatchObject({ code: 'qc.live_cap' })
    await expect(check(orgs.a)).rejects.toMatchObject({ code: 'qc.live_cap' })
  })

  it('does nothing in sandbox mode, where nothing is billed', async () => {
    const { ledger, check } = gate({ MASTERCLIP_MODE: 'sandbox', LIVE_SPEND_CAP_USD: '1', CUSTOMER_SPEND_CAP_USD: '1' })
    await charge(ledger, orgs.a, 50)
    await expect(check(orgs.a)).resolves.toBeUndefined()
  })
})

describe('what /api/providers and the cost summary tell the customer', () => {
  let db: Db
  let runtime: Runtime
  let app: FastifyInstance
  let storageRoot: string

  async function start(env: Record<string, string>) {
    db = await createTestDb()
    storageRoot = await mkdtemp(join(tmpdir(), 'masterclip-customer-cap-'))
    const config = loadConfig(
      { NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: storageRoot, ASSET_SIGNING_SECRET: 'cap-test-secret', SESSION_SECRET: 'cap-test-session-secret', ...env },
      true,
    )
    runtime = await createRuntime({ config, db, logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root: storageRoot, signingSecret: 'cap-test-secret' }) })
    app = await buildServer({ runtime, logger: silentLogger })
    await app.ready()
  }

  afterEach(async () => {
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  })

  /** An account in this org, signed in, as a cookie jar. */
  async function signedIn(orgId: string, email: string) {
    const session = await runtime.auth.sessionForVouchedEmail({ email, displayName: email, orgId, orgRole: 'owner' })
    return { cookies: { [SESSION_COOKIE]: session.token }, userId: session.user.id }
  }

  async function seed() {
    const orgs = await seedOrgs(db)
    // The ledger and the screens read this runtime's clock; spend is written as of now.
    const spend = (orgId: string, usd: number, at = Date.now()) =>
      new CostLedger(db, fixedClock(at)).append({ orgId, providerId: 'mock', modelId: 'm', entryType: 'charge', micros: usdToMicros(usd), sandbox: false, createdBy: 'test' })
    await spend(orgs.a, 3.21)
    await spend(orgs.b, 1)
    await spend(orgs.house, 40)
    // Last month, which counts toward neither a customer's month nor the service's.
    const lastMonth = new Date()
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 2)
    await spend(orgs.a, 99, lastMonth.getTime())
    return orgs
  }

  it('gives each customer their own cap and month, and the service total this month, all customers', async () => {
    await start({ LIVE_SPEND_CAP_USD: '500', CUSTOMER_SPEND_CAP_USD: '10' })
    const orgs = await seed()
    const artist = await signedIn(orgs.a, 'a@artists.test')
    const owner = await signedIn(orgs.house, 'boss@label.test')

    const mine = (await app.inject({ method: 'GET', url: '/api/providers', cookies: artist.cookies })).json()
    expect(mine).toMatchObject({
      customerSpendCapUsd: 10,
      customerSpendCapConfigured: true,
      customerCapApplies: true,
      customerSpentThisMonthUsd: '$3.21',
      liveSpendCapUsd: 500,
      // 3.21 + 1 + 40, this month, every customer: last month's $99 is not in it.
      liveSpentUsd: '$44.2100',
    })

    const house = (await app.inject({ method: 'GET', url: '/api/providers', cookies: owner.cookies })).json()
    expect(house).toMatchObject({ customerSpendCapConfigured: true, customerSpendCapUsd: 10, customerCapApplies: false, customerSpentThisMonthUsd: '$40.00' })

    // The cost summary of a film says the same about the customer who owns it.
    const project = await runtime.projects.create({ orgId: orgs.a, name: 'A Song', createdBy: artist.userId })
    const costs = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/costs`, cookies: artist.cookies })
    expect(costs.statusCode).toBe(200)
    expect(costs.json().liveCap).toMatchObject({
      spent: '$44.2100',
      customerSpendCapUsd: 10,
      customerSpendCapConfigured: true,
      customerCapApplies: true,
      customerSpentThisMonthUsd: '$3.21',
    })
  })

  it('says there is no per-customer cap, with no number, when none is set', async () => {
    await start({ LIVE_SPEND_CAP_USD: '500' })
    const orgs = await seed()
    const artist = await signedIn(orgs.a, 'a@artists.test')
    const body = (await app.inject({ method: 'GET', url: '/api/providers', cookies: artist.cookies })).json()
    expect(body.customerSpendCapConfigured).toBe(false)
    expect(body.customerSpendCapUsd).toBeNull()
    expect(body.customerCapApplies).toBe(false)
  })
})
