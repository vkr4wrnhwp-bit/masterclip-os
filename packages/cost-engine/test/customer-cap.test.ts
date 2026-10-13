import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, insertRow, type Db } from '@masterclip/database'
import { fixedClock, loadConfig, usdToMicros } from '@masterclip/shared'
import { quoteFromProvider, sampleRequest } from '@masterclip/provider-core'
import { CostController, CostLedger, customerCapMessage } from '../src/index.js'

/**
 * The per-customer monthly cap (CUSTOMER_SPEND_CAP_USD) and the whole-service
 * ceiling (LIVE_SPEND_CAP_USD) that now counts only the current calendar month.
 *
 * Three organizations: the house (the operator's own, no Street Banker
 * identity), and two customers, A and B, each with a Street Banker identity and
 * a project of their own.
 */
let db: Db
// 13 October 2026, midday UTC: well inside a month, so "earlier this month" and
// "last month" are both easy to write down.
const clock = fixedClock(Date.UTC(2026, 9, 13, 12, 0, 0))
const HOUSE = { org: 'org_house', project: 'proj_house' }
const A = { org: 'org_a', project: 'proj_a' }
const B = { org: 'org_b', project: 'proj_b' }
type Who = typeof HOUSE
const SHOT = 'shot_test'

beforeEach(async () => {
  db = await createTestDb()
  const orgs: Array<[Who, string | null, number]> = [
    [HOUSE, null, Date.UTC(2026, 0, 1)],
    [A, 'uid:101', Date.UTC(2026, 5, 1)],
    [B, 'uid:102', Date.UTC(2026, 5, 2)],
  ]
  for (const [who, identity, createdAt] of orgs) {
    await insertRow(db, 'orgs', {
      id: who.org,
      name: who.org,
      created_at: new Date(createdAt).toISOString(),
      street_banker_identity: identity,
    })
    await insertRow(db, 'projects', {
      id: who.project,
      org_id: who.org,
      name: who.project,
      slug: who.project,
      brief: '',
      style_bible: '{}',
      status: 'active',
      created_at: clock.isoNow(),
      updated_at: clock.isoNow(),
      archived_at: null,
    })
  }
})

function config(overrides: Record<string, string> = {}) {
  return loadConfig(
    { NODE_ENV: 'test', MASTERCLIP_MODE: 'live', LIVE_SPEND_CAP_USD: '1000', CUSTOMER_SPEND_CAP_USD: '10', ...overrides },
    true,
  )
}

function quoteFor(usd: number, sandbox = false) {
  const request = sampleRequest({ durationSeconds: 8, maxCostMicros: usdToMicros(5), sandbox })
  return { request, quote: quoteFromProvider({ providerId: 'mock', request, micros: usdToMicros(usd), nowMs: clock.now(), raw: {} }) }
}

/** A settled live charge, written as of `at` (default: now) so it lands in that month. */
async function charge(who: Who, usd: number, at: number = clock.now(), entryType: 'charge' | 'qc' = 'charge') {
  await new CostLedger(db, fixedClock(at)).append({
    orgId: who.org,
    projectId: who.project,
    providerId: 'mock',
    modelId: 'm',
    entryType,
    micros: usdToMicros(usd),
    sandbox: false,
    createdBy: 'test',
  })
}

async function render(controller: CostController, who: Who, usd: number, extra: { jobId?: string } = {}) {
  const { request, quote } = quoteFor(usd)
  return controller.authorize({ orgId: who.org, projectId: who.project, shotId: SHOT, request, quote, tier: 'standard', humanApproved: true, ...extra })
}

let jobCounter = 0
/** A job already with the provider (or about to be), as `status`. */
async function jobFor(who: Who, usd: number, status = 'submitted'): Promise<string> {
  const id = `${who.project}_${++jobCounter}`
  await insertRow(db, 'shots', {
    id: `shot_${id}`, project_id: who.project, scene_id: null, shot_key: id, title: id,
    current_version: 1, ordinal: 1, created_at: clock.isoNow(), updated_at: clock.isoNow(),
  })
  await insertRow(db, 'shot_versions', {
    id: `sver_${id}`, shot_id: `shot_${id}`, version: 1, spec: '{}', spec_hash: id,
    created_by: 'test', created_at: clock.isoNow(), note: '', locked: 0,
  })
  await insertRow(db, 'render_jobs', {
    id: `job_${id}`, batch_id: null, project_id: who.project, scene_id: null, shot_id: `shot_${id}`,
    shot_version_id: `sver_${id}`, provider_id: 'mock', model_id: 'm', routing_profile: 'STANDARD',
    compiled_prompt: 'p', request: '{}', request_hash: id, idempotency_key: id, status,
    external_job_id: 'x', quote_id: null, estimated_micros: usdToMicros(usd), actual_micros: 0,
    attempts: 1, seed: null, sandbox: 0, priority: 0, error: null, created_by: 'test',
    created_at: clock.isoNow(), updated_at: clock.isoNow(), submitted_at: clock.isoNow(),
    completed_at: null, failed_at: null, cancelled_at: null,
  })
  return `job_${id}`
}

const codes = (result: { denials: Array<{ code: string }> }) => result.denials.map((d) => d.code)

describe('the per-customer monthly cap', () => {
  it('refuses a customer who has used the month, in plain words, while another customer can still render', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 10)

    const refused = await render(controller, A, 0.4)
    expect(refused.allowed).toBe(false)
    expect(codes(refused)).toContain('spend.customer_cap')
    expect(refused.denials.find((d) => d.code === 'spend.customer_cap')?.message).toBe(
      "You've used this month's $10 of MOTION renders. More renders need credits.",
    )
    // The cap speaks for itself: no second, technical denial for the same thing.
    expect(codes(refused)).not.toContain('budget.org_monthly')

    // B has spent nothing, and A's spend is not B's.
    const other = await render(controller, B, 0.4)
    expect(other.allowed).toBe(true)
    expect(codes(other)).not.toContain('spend.customer_cap')
  })

  it('says what a render would cost when it is the render that goes over, not just that the month is gone', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 9.8)

    const refused = await render(controller, A, 0.4)
    expect(refused.allowed).toBe(false)
    expect(refused.denials.find((d) => d.code === 'spend.customer_cap')?.message).toBe(
      "This render would take you past this month's $10 of MOTION renders ($9.80 used so far). More renders need credits.",
    )
    // A render that still fits is let through.
    expect((await render(controller, A, 0.2)).allowed).toBe(true)
  })

  it('shows a cap that is not a whole number of dollars the way a person says it', () => {
    expect(customerCapMessage(usdToMicros(7.5), usdToMicros(7.5))).toBe(
      "You've used this month's $7.50 of MOTION renders. More renders need credits.",
    )
  })

  it('counts QC and agent spend as spend, not only generation charges', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 6)
    await charge(A, 4, clock.now(), 'qc')
    expect(codes(await render(controller, A, 0.1))).toContain('spend.customer_cap')
  })

  it('warns, without refusing, once a customer is close to the cap', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 7.5)
    const result = await render(controller, A, 0.6)
    expect(result.allowed).toBe(true)
    expect(result.warnings).toContain("after this render you'll have used $8.10 of this month's $10 of MOTION renders")
    expect(result.remaining.customerCapMicros).toBe(usdToMicros(2.5))
  })

  it('exempts the house organization, which is still under the whole-service ceiling', async () => {
    const controller = new CostController(db, config(), clock)
    // Spent on an earlier day, so the $50 daily budget is not what is under test.
    await charge(HOUSE, 50, Date.UTC(2026, 9, 2, 12, 0, 0))
    const owner = await render(controller, HOUSE, 0.4)
    expect(owner.allowed).toBe(true)
    expect(codes(owner)).not.toContain('spend.customer_cap')
    expect(owner.remaining.customerCapMicros).toBeNull()

    // The exemption is from the customer cap only.
    const tight = new CostController(db, config({ LIVE_SPEND_CAP_USD: '50.2' }), clock)
    const stopped = await render(tight, HOUSE, 0.4)
    expect(codes(stopped)).toEqual(['spend.live_cap'])
  })

  it('starts a customer over on the first of the month, and not before', async () => {
    const controller = new CostController(db, config(), clock)
    // The whole allowance, spent in the last second of September (UTC).
    await charge(A, 10, Date.UTC(2026, 8, 30, 23, 59, 59))
    expect((await render(controller, A, 0.4)).allowed).toBe(true)

    // The same allowance spent in the first second of October is this month's.
    await charge(A, 10, Date.UTC(2026, 9, 1, 0, 0, 0))
    expect(codes(await render(controller, A, 0.4))).toContain('spend.customer_cap')

    // Then November comes, and the slate is clean again.
    clock.set(Date.UTC(2026, 10, 1, 0, 0, 0))
    expect((await render(controller, A, 0.4)).allowed).toBe(true)
    clock.set(Date.UTC(2026, 9, 13, 12, 0, 0))
  })

  it('counts a customer’s renders still with a provider, so many at once cannot pass a cap none of them breaches', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 8)
    await jobFor(A, 1.5)
    const refused = await render(controller, A, 0.6)
    expect(codes(refused)).toContain('spend.customer_cap')
    // B's renders are not A's, in flight or settled.
    await jobFor(B, 9)
    expect((await render(controller, A, 0.4)).allowed).toBe(true)
  })

  it('does not count the job being authorized against itself at submit time', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 9)
    // At submit the job is already `authorizing`, which is in flight.
    const jobId = await jobFor(A, 0.6, 'authorizing')
    expect(codes(await render(controller, A, 0.6))).toContain('spend.customer_cap')
    expect((await render(controller, A, 0.6, { jobId })).allowed).toBe(true)
    // Leaving itself out does not let it through if it really does not fit.
    expect(codes(await render(controller, A, 1.2, { jobId }))).toContain('spend.customer_cap')
  })

  it('does not hold sandbox renders to the cap, which cost nothing', async () => {
    const controller = new CostController(db, config({ CUSTOMER_SPEND_CAP_USD: '0' }), clock)
    const { request, quote } = quoteFor(0, true)
    const sandbox = await controller.authorize({ orgId: A.org, projectId: A.project, shotId: SHOT, request, quote, tier: 'standard' })
    expect(sandbox.allowed).toBe(true)
    // A cap of zero is a decision: no customer renders live, the house still does.
    expect(codes(await render(controller, A, 0.4))).toContain('spend.customer_cap')
    expect((await render(controller, HOUSE, 0.4)).allowed).toBe(true)
  })
})

describe('with CUSTOMER_SPEND_CAP_USD unset', () => {
  it('behaves exactly as before: the stored organization budget is the only monthly cap', async () => {
    const controller = new CostController(db, config({ CUSTOMER_SPEND_CAP_USD: '' }), clock)
    // Well past $10, spent on earlier days so the $50 daily cap is not the thing under test.
    await charge(A, 499, Date.UTC(2026, 9, 2, 12, 0, 0))
    const fine = await render(controller, A, 0.4)
    expect(fine.allowed).toBe(true)
    expect(codes(fine)).not.toContain('spend.customer_cap')
    expect(fine.remaining.customerCapMicros).toBeNull()

    await charge(A, 0.9, Date.UTC(2026, 9, 3, 12, 0, 0))
    const over = await render(controller, A, 0.4)
    expect(codes(over)).toContain('budget.org_monthly')
    expect(codes(over)).not.toContain('spend.customer_cap')
    expect(over.denials.find((d) => d.code === 'budget.org_monthly')?.message).toMatch(/^organization monthly budget exceeded/)
  })
})

describe('the customer cap and the stored organization monthly budget', () => {
  async function withStoredMonthly(controller: CostController, who: Who, usd: number | null) {
    const store = controller.budgetStore
    const budget = await store.ensureDefaults('org', who.org)
    await store.set({ ...budget, monthlyCapMicros: usd === null ? null : usdToMicros(usd) })
  }

  it('lets the smaller stored budget speak when it is the smaller one', async () => {
    const controller = new CostController(db, config(), clock)
    await withStoredMonthly(controller, A, 5)
    await charge(A, 4.8)
    const result = await render(controller, A, 0.4)
    expect(codes(result)).toEqual(['budget.org_monthly'])
  })

  it('lets the customer cap speak when it is the smaller one, equal, or the only one', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 9.8)
    for (const stored of [20, 10, null]) {
      await withStoredMonthly(controller, A, stored)
      expect(codes(await render(controller, A, 0.4)), `stored monthly ${stored}`).toEqual(['spend.customer_cap'])
    }
  })
})

describe('the whole-service ceiling counts only this month', () => {
  it('ignores earlier months, which used to stop a live service for good', async () => {
    const controller = new CostController(db, config({ LIVE_SPEND_CAP_USD: '2', CUSTOMER_SPEND_CAP_USD: '' }), clock)
    // Far more than the ceiling over the service's life, none of it this month.
    await charge(A, 1.9, Date.UTC(2026, 8, 10))
    await charge(B, 1.9, Date.UTC(2026, 7, 10))
    const ledger = new CostLedger(db, clock)
    expect(await ledger.totalLiveSpend()).toBe(usdToMicros(3.8))
    expect(await ledger.liveSpendThisMonth()).toBe(0)

    const fine = await render(controller, A, 0.4)
    expect(fine.allowed).toBe(true)
    expect(fine.remaining.liveCapMicros).toBe(usdToMicros(2))
  })

  it('counts every customer together this month, and stops at the ceiling', async () => {
    const controller = new CostController(db, config({ LIVE_SPEND_CAP_USD: '2', CUSTOMER_SPEND_CAP_USD: '' }), clock)
    await charge(A, 1)
    await charge(B, 0.9)
    expect(await new CostLedger(db, clock).liveSpendThisMonth()).toBe(usdToMicros(1.9))

    const refused = await render(controller, HOUSE, 0.4)
    expect(codes(refused)).toEqual(['spend.live_cap'])
    expect(refused.denials[0]?.message).toMatch(/this month by all customers/)
    expect(refused.denials[0]?.message).toMatch(/LIVE_SPEND_CAP_USD/)
  })

  it('starts over on the first of the month', async () => {
    const controller = new CostController(db, config({ LIVE_SPEND_CAP_USD: '2', CUSTOMER_SPEND_CAP_USD: '' }), clock)
    await charge(A, 1.9)
    expect(codes(await render(controller, B, 0.4))).toContain('spend.live_cap')
    clock.set(Date.UTC(2026, 10, 1, 0, 0, 0))
    expect((await render(controller, B, 0.4)).allowed).toBe(true)
    clock.set(Date.UTC(2026, 9, 13, 12, 0, 0))
  })

  it('still counts work in flight, whatever month it was started in', async () => {
    const controller = new CostController(db, config({ LIVE_SPEND_CAP_USD: '2', CUSTOMER_SPEND_CAP_USD: '' }), clock)
    await jobFor(A, 1.5)
    expect(codes(await render(controller, B, 0.6))).toContain('spend.live_cap')
  })

  it('keeps the customer cap and the ceiling independent, so the ceiling can still stop everyone', async () => {
    const controller = new CostController(db, config({ LIVE_SPEND_CAP_USD: '12', CUSTOMER_SPEND_CAP_USD: '10' }), clock)
    await charge(A, 6)
    await charge(B, 5.8)
    // B is under their own $10, but the service as a whole has no room left.
    const refused = await render(controller, B, 0.4)
    expect(codes(refused)).toEqual(['spend.live_cap'])
  })
})

describe('what the screens read', () => {
  it('reports a customer’s standing: the cap, whether it applies, and their own spend this month', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 3.21)
    await charge(A, 5, Date.UTC(2026, 8, 20))
    await charge(B, 1)

    expect(await controller.customerStanding(A.org)).toEqual({
      configured: true,
      capMicros: usdToMicros(10),
      applies: true,
      spentMicros: usdToMicros(3.21),
    })
    expect(await controller.customerStanding(HOUSE.org)).toMatchObject({ configured: true, applies: false })

    const unset = new CostController(db, config({ CUSTOMER_SPEND_CAP_USD: '' }), clock)
    expect(await unset.customerStanding(A.org)).toEqual({
      configured: false,
      capMicros: null,
      applies: false,
      spentMicros: usdToMicros(3.21),
    })
  })

  it('knows the house organization the way the auth service does: the oldest with no Street Banker identity', async () => {
    const controller = new CostController(db, config(), clock)
    expect(await controller.isHouseOrg(HOUSE.org)).toBe(true)
    expect(await controller.isHouseOrg(A.org)).toBe(false)
    expect(await controller.isHouseOrg('org_nobody')).toBe(false)
  })

  it('tells visual QC, which never passes through authorize(), when a customer has used the month', async () => {
    const controller = new CostController(db, config(), clock)
    await charge(A, 9.99)
    expect(await controller.customerCapReached(A.org)).toBeNull()
    await jobFor(A, 0.02)
    expect(await controller.customerCapReached(A.org)).toEqual({ capMicros: usdToMicros(10), usedMicros: usdToMicros(10.01) })
    expect(await controller.customerCapReached(B.org)).toBeNull()
    await charge(HOUSE, 500)
    expect(await controller.customerCapReached(HOUSE.org)).toBeNull()
  })
})
