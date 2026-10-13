import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, insertRow, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { CostController, CostLedger } from '@masterclip/cost-engine'
import { fixedClock, loadConfig, silentLogger, usdToMicros, type Logger } from '@masterclip/shared'
import { AppError } from '@masterclip/shared'
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

/** A job already with the provider (`downloading`: charged, but in flight until ingest ends). */
async function inFlightJob(db: Db, orgId: string, usd: number, status = 'downloading'): Promise<string> {
  const id = `${orgId}_${status}_${Math.round(usd * 100)}`
  const at = clock.isoNow()
  await insertRow(db, 'projects', { id: `proj_${id}`, org_id: orgId, name: id, slug: id, brief: '', style_bible: '{}', status: 'active', created_at: at, updated_at: at, archived_at: null })
  await insertRow(db, 'shots', { id: `shot_${id}`, project_id: `proj_${id}`, scene_id: null, shot_key: id, title: id, current_version: 1, ordinal: 1, created_at: at, updated_at: at })
  await insertRow(db, 'shot_versions', { id: `sver_${id}`, shot_id: `shot_${id}`, version: 1, spec: '{}', spec_hash: id, created_by: 'test', created_at: at, note: '', locked: 0 })
  await insertRow(db, 'render_jobs', {
    id: `job_${id}`, batch_id: null, project_id: `proj_${id}`, scene_id: null, shot_id: `shot_${id}`,
    shot_version_id: `sver_${id}`, provider_id: 'mock', model_id: 'm', routing_profile: 'STANDARD',
    compiled_prompt: 'p', request: '{}', request_hash: id, idempotency_key: id, status,
    external_job_id: 'x', quote_id: null, estimated_micros: usdToMicros(usd), actual_micros: 0,
    attempts: 1, seed: null, sandbox: 0, priority: 0, error: null, created_by: 'test',
    created_at: at, updated_at: at, submitted_at: at, completed_at: null, failed_at: null, cancelled_at: null,
  })
  return `job_${id}`
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
    const check = (orgId: string, jobId?: string) =>
      (service as unknown as { assertQcSpendAllowed(outputId: string, orgId: string, jobId?: string): Promise<void> }).assertQcSpendAllowed(
        'out_1',
        orgId,
        jobId,
      )
    return { ledger, check, config, service }
  }

  /** The render service's choice of vision checker, with a stub runtime that has (or lacks) an Anthropic key. */
  function chooser(env: Record<string, string>, anthropicKey: boolean) {
    const config = loadConfig({ NODE_ENV: 'test', MASTERCLIP_MODE: 'live', ...env }, true)
    const ledger = new CostLedger(db, clock)
    const warnings: string[] = []
    const logger = { warn: (msg: string) => void warnings.push(msg), debug: () => undefined, info: () => undefined, error: () => undefined } as unknown as Logger
    const service = new RenderService({ config, ledger, cost: new CostController(db, config, clock), clock, logger, agents: { available: anthropicKey } } as unknown as Runtime)
    const mayUseClaude = (orgId: string, jobId: string) =>
      (service as unknown as { qcMayUseClaude(o: string, g: string, j: string): Promise<boolean> }).qcMayUseClaude('out_1', orgId, jobId)
    return { ledger, mayUseClaude, warnings }
  }

  it('falls back to the free heuristic checker instead of failing QC when the spend is refused', async () => {
    const { ledger, mayUseClaude, warnings } = chooser({ LIVE_SPEND_CAP_USD: '1000', CUSTOMER_SPEND_CAP_USD: '10' }, true)
    await charge(ledger, orgs.a, 10)
    expect(await mayUseClaude(orgs.a, 'job_other')).toBe(false)
    expect(warnings).toContain('qc.spend_refused_using_heuristic')
    // Another customer is not affected, and keeps the paid checker.
    expect(await mayUseClaude(orgs.b, 'job_other')).toBe(true)
  })

  it('never checks spend when there is no Anthropic key, because QC is then free', async () => {
    const { ledger, mayUseClaude, warnings } = chooser({ LIVE_SPEND_CAP_USD: '1000', CUSTOMER_SPEND_CAP_USD: '10' }, false)
    await charge(ledger, orgs.a, 10)
    expect(await mayUseClaude(orgs.a, 'job_other')).toBe(false)
    expect(warnings).toEqual([])
  })

  it('lets a failure that is not a spend refusal through, rather than hiding it', async () => {
    const { mayUseClaude } = chooser({ CUSTOMER_SPEND_CAP_USD: '10' }, true)
    await db.run('DROP TABLE cost_ledger')
    await expect(mayUseClaude(orgs.a, 'job_x')).rejects.not.toBeInstanceOf(AppError)
  })


  it('refuses a customer who has used the month, in the same words and under the same code as a render', async () => {
    const { ledger, check } = gate({ LIVE_SPEND_CAP_USD: '1000', CUSTOMER_SPEND_CAP_USD: '10' })
    await charge(ledger, orgs.a, 9)
    await charge(ledger, orgs.a, 1, 'qc')
    await expect(check(orgs.a)).rejects.toMatchObject({
      code: 'spend.customer_cap',
      message: "You've used this month's $10 of MOTION renders. It resets on the 1st.",
    })
    // Another customer, and the owner's own account, are not held to A's month.
    await expect(check(orgs.b)).resolves.toBeUndefined()
    await expect(check(orgs.house)).resolves.toBeUndefined()
  })

  it('does not refuse QC of the render that took the customer to the cap, which is already paid for and still in flight', async () => {
    const { ledger, check } = gate({ LIVE_SPEND_CAP_USD: '1000', CUSTOMER_SPEND_CAP_USD: '10' })
    await charge(ledger, orgs.a, 9.8)
    // The render was charged when it finished (9.8 + 0.5 would pass 10), and its job
    // stays in flight until ingest ends: the QC job runs inside that window.
    const own = await inFlightJob(db, orgs.a, 0.5)
    await expect(check(orgs.a)).rejects.toMatchObject({ code: 'spend.customer_cap' })
    await expect(check(orgs.a, own)).resolves.toBeUndefined()
    // Genuinely used up is still refused, with the render left out.
    await charge(ledger, orgs.a, 0.2)
    await expect(check(orgs.a, own)).rejects.toMatchObject({ code: 'spend.customer_cap' })
  })

  it('leaves the whole-service brake to count other jobs only, for the same reason', async () => {
    const { ledger, check } = gate({ LIVE_SPEND_CAP_USD: '2', CUSTOMER_SPEND_CAP_USD: '' })
    await charge(ledger, orgs.a, 1.9)
    const own = await inFlightJob(db, orgs.b, 0.5)
    await expect(check(orgs.b)).rejects.toMatchObject({ code: 'qc.live_cap' })
    await expect(check(orgs.b, own)).resolves.toBeUndefined()
  })

  it('has no whole-service ceiling to hit when only the customer cap is set', async () => {
    const { ledger, check } = gate({ LIVE_SPEND_CAP_USD: '', CUSTOMER_SPEND_CAP_USD: '10' })
    await charge(ledger, orgs.house, 5000, 'charge')
    await expect(check(orgs.b)).resolves.toBeUndefined()
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

  it('gives each customer their own cap and month, and only the operator the service total this month, all customers', async () => {
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
      operatorView: false,
    })
    // Other customers' spend adds up in the whole-service figures, so a customer is sent none of them.
    for (const key of ['liveSpentUsd', 'liveSpendCapUsd', 'liveSpendCapConfigured', 'liveSpendCapSource']) expect(mine).not.toHaveProperty(key)
    expect(JSON.stringify(mine)).not.toMatch(/44\.21|\$1\.0000/)

    const house = (await app.inject({ method: 'GET', url: '/api/providers', cookies: owner.cookies })).json()
    expect(house).toMatchObject({
      operatorView: true,
      customerSpendCapConfigured: true,
      customerSpendCapUsd: 10,
      customerCapApplies: false,
      customerSpentThisMonthUsd: '$40.00',
      liveSpendCapUsd: 500,
      liveSpendCapConfigured: true,
      liveSpendCapSource: 'env',
      // 3.21 + 1 + 40, this month, every customer: last month's $99 is not in it.
      liveSpentUsd: '$44.2100',
    })

    // The cost summary of a film says the same about the customer who owns it.
    const project = await runtime.projects.create({ orgId: orgs.a, name: 'A Song', createdBy: artist.userId })
    const costs = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/costs`, cookies: artist.cookies })
    expect(costs.statusCode).toBe(200)
    expect(costs.json().liveCap).toMatchObject({
      operatorView: false,
      customerSpendCapUsd: 10,
      customerSpendCapConfigured: true,
      customerCapApplies: true,
      customerSpentThisMonthUsd: '$3.21',
    })
    for (const key of ['spent', 'capUsd', 'capConfigured', 'capSource']) expect(costs.json().liveCap).not.toHaveProperty(key)

    // The operator reading the same film's summary gets the whole-service figures.
    const operatorProject = await runtime.projects.create({ orgId: orgs.house, name: 'House Film', createdBy: owner.userId })
    const operatorCosts = await app.inject({ method: 'GET', url: `/api/projects/${operatorProject.id}/costs`, cookies: owner.cookies })
    expect(operatorCosts.json().liveCap).toMatchObject({ operatorView: true, spent: '$44.2100', capUsd: 500, capConfigured: true, capSource: 'env' })
  })

  it('reports no whole-service limit to the operator when only the customer cap is set', async () => {
    await start({ CUSTOMER_SPEND_CAP_USD: '10' })
    const orgs = await seed()
    const owner = await signedIn(orgs.house, 'boss@label.test')
    const body = (await app.inject({ method: 'GET', url: '/api/providers', cookies: owner.cookies })).json()
    expect(body).toMatchObject({ operatorView: true, liveSpendCapUsd: null, liveSpendCapConfigured: false, liveSpendCapSource: 'none', liveSpentUsd: '$44.2100' })
  })

  it('reports the built-in limit when neither cap is set', async () => {
    await start({})
    const orgs = await seed()
    const owner = await signedIn(orgs.house, 'boss@label.test')
    const body = (await app.inject({ method: 'GET', url: '/api/providers', cookies: owner.cookies })).json()
    expect(body).toMatchObject({ liveSpendCapUsd: 2, liveSpendCapConfigured: false, liveSpendCapSource: 'default' })
  })

  it('says there is no per-customer cap, with no number, when none is set', async () => {
    await start({ LIVE_SPEND_CAP_USD: '500' })
    const orgs = await seed()
    const artist = await signedIn(orgs.a, 'a@artists.test')
    const body = (await app.inject({ method: 'GET', url: '/api/providers', cookies: artist.cookies })).json()
    expect(body.customerSpendCapConfigured).toBe(false)
    expect(body.customerSpendCapUsd).toBeNull()
    expect(body.customerCapApplies).toBe(false)
    expect(body.operatorView).toBe(false)
  })
})
