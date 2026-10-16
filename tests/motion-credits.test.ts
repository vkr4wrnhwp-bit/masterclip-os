import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueueCreditNotice, RenderCreditNotice } from '../apps/web/src/views/RenderCreditNotice.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDb, toNum, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { emptyShot, EnvironmentRecord } from '@masterclip/shot-schema'
import { createRuntime, RenderService, type Runtime } from '@masterclip/runtime'
import { createMockProvider } from '@masterclip/provider-mock'
let calls: Array<Record<string, unknown>> = []
let door: ReturnType<typeof vi.fn>, submit: ReturnType<typeof vi.spyOn>, status: ReturnType<typeof vi.spyOn>
let runtime: Runtime
let db: Db
let storageRoot: string
let projectId: string
let shotId: string
let orgId: string

beforeEach(async () => {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'masterclip-charges-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'live', LIVE_SPEND_CAP_USD: '100', CUSTOMER_SPEND_CAP_USD: '10',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'charges-test-secret',
      SESSION_SECRET: 'charges-test-session-secret',
      PROVIDER_POLL_INTERVAL_MS: '0',
    },
    true,
  )
  config.SUITE_SSO_SECRET = 'test-credit-key'
  config.STREET_BANKER_URL = 'https://banker.test'
  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'charges-test-secret' }),
  })
  const provider = createMockProvider({ logger: silentLogger, sandbox: false, publicBaseUrl: '', now: () => Date.now() })
  Object.defineProperty(provider, 'providerId', { value: 'test-video' })
  submit = vi.spyOn(provider, 'submit').mockImplementation(async request => ({
    externalJobId: 'provider-' + request.requestId, providerId: 'test-video', modelId: request.modelId,
    submittedAt: new Date().toISOString(), externalRequestId: request.requestId, raw: {},
  }))
  status = vi.spyOn(provider, 'getStatus').mockResolvedValue({ state: 'completed', externalJobId: 'provider-job',
    actualMicros: 140000, billableSeconds: 4, progress: 1, outputs: [], error: null, raw: {} })
  runtime.registry.register(provider)
  door = vi.fn(async (_url: unknown, options: RequestInit) => {
    const token = JSON.parse(String(options.body)).token as string
    const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())
    calls.push(payload)
    const credits = ({ 'motion.draft': 3, 'motion.standard': 6, 'motion.premium': 16 }[String(payload.action)] ?? 6) * Number(payload.units ?? 4)
    return new Response(JSON.stringify({ ok: true, spent: credits, refunded: payload.op === 'refund' ? 24 : 0,
      balance: { total: 76 } }), { status: 200 })
  })
  vi.stubGlobal('fetch', door)
  const org = await runtime.projects.createOrg('Charges Org')
  orgId = org.id
  await db.run("UPDATE orgs SET street_banker_identity = 'uid:1' WHERE id = ?", [orgId])
  await db.run("INSERT INTO users (id,org_id,email,display_name,password_hash,org_role,disabled,created_at) VALUES (?,?,?,?,?,?,?,?)", ['tester',orgId,'artist@example.test','Artist','','owner',0,new Date().toISOString()])
  await db.run("INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at,revoked_at,street_banker_email) VALUES (?,?,?,?,?,NULL,?)", ['signed-session','tester','hash',new Date().toISOString(),'2099-01-01','artist@example.test'])
  const project = await runtime.projects.create({ orgId, name: 'Charges Project', createdBy: 'tester' })
  projectId = project.id
  await runtime.cost.budgetStore.ensureDefaults('project', projectId)
  await runtime.bibles.createEnvironment({
    projectId,
    createdBy: 'tester',
    record: EnvironmentRecord.parse({ environment_key: 'ALLEY', name: 'Rain alley' }),
  })
  const created = await runtime.projects.createShot({
    projectId,
    createdBy: 'tester',
    spec: emptyShot({
      shot_id: 'S01',
      title: 'Nova under the sign',
      generation_mode: 'text_to_video',
      action: 'she turns toward the street',
      camera_position: 'medium, chest height',
      camera_movement: 'slow dolly in',
      duration_seconds: 4,
      target_resolution: '480p',
      aspect_ratio: '16:9',
      max_cost_usd: 2,
      environment_lock: { environment_key: 'ALLEY', environment_version: 0, strength: 'strict' },
      lighting: { dominant_source: 'magenta neon sign', source_position: 'high camera left', color_temperature: 'magenta', falloff: 'rapid', shadow_behavior: 'hard', practicals: [] },
    }),
  })
  shotId = created.shot.id
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  calls = []
  await runtime.close()
  await rm(storageRoot, { recursive: true, force: true })
})

const candidate = {
  providerId: 'test-video',
  modelId: 'mock-standard',
  seed: null,
  variationLabel: 'v0',
  variationInstruction: '',
  resolution: '480p',
  aspectRatio: '16:9',
  durationSeconds: 4,
}

async function plannedJob(render: RenderService): Promise<string> {
  const plan = await render.planBatch({ projectId, shotId, batchName: 'charges', candidates: [candidate], createdBy: 'tester', orgId })
  expect(plan.jobIds).toHaveLength(1)
  return plan.jobIds[0]!
}

async function untilDone(render: RenderService, jobId: string): Promise<void> {
  for (let i = 0; i < 20; i++) if ((await render.pollRender(jobId)).done) return
  throw new Error('render did not finish')
}

const count = async (sql: string, params: string[]) => toNum((await db.get<{ n: number }>(sql, params))?.n)
const charges = (jobId: string) => count(`SELECT COUNT(*) AS n FROM cost_ledger WHERE job_id = ? AND entry_type = 'charge'`, [jobId])
const attempts = (jobId: string) => count(`SELECT COUNT(*) AS n FROM render_attempts WHERE job_id = ?`, [jobId])

/** What the retry route does to a job that has stopped. */
const retry = (jobId: string) => runtime.renders.updateJob(jobId, { status: 'queued', error: null })


it('spends every rendered second before the provider starts', async () => {
  const render = new RenderService(runtime), id = await plannedJob(render)
  await render.submitRender(id)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ op: 'spend', email: 'artist@example.test', suite: 'motion', action: 'motion.standard', units: 4 })
  expect(door.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0]!)
  expect(submit).toHaveBeenCalledTimes(1)
})

it('spends before provider submission when a sandbox plan is submitted in live mode', async () => {
  runtime.config.isSandbox = true
  runtime.config.MASTERCLIP_MODE = 'sandbox'
  const render = new RenderService(runtime), id = await plannedJob(render)
  expect((await runtime.renders.getJob(id)).sandbox).toBe(true)
  runtime.config.isSandbox = false
  runtime.config.MASTERCLIP_MODE = 'live'
  await render.submitRender(id)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ op: 'spend', units: 4 })
  expect(door.mock.invocationCallOrder[0]).toBeLessThan(submit.mock.invocationCallOrder[0]!)
  expect(submit).toHaveBeenCalledTimes(1)
})

it.each([101, 4.5])('blocks a saved %s-second request without spending or submitting', async seconds => {
  const render = new RenderService(runtime), id = await plannedJob(render)
  const job = await runtime.renders.getJob(id)
  // Keep this fixture within its safety budget so the duration gate is the refusal under test.
  const budget = await runtime.cost.budgetStore.ensureDefaults('project', projectId)
  await runtime.cost.budgetStore.set({ ...budget, perShotCapMicros: 10_000_000 })
  await db.run('UPDATE render_jobs SET request = ? WHERE id = ?', [JSON.stringify({ ...job.request, durationSeconds: seconds, maxCostMicros: 10_000_000, approvedMicros: 10_000_000 }), id])
  const message = 'Choose a video length from 1 to 100 whole seconds.'
  await expect(render.submitRender(id)).rejects.toMatchObject({ code: 'credits.duration', message })
  expect(await runtime.renders.getJob(id)).toMatchObject({ status: 'blocked', attempts: 0, error: { code: 'credits.duration', message } })
  expect(door).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it.each([[1, 1], [1, 2], [2, 1]])('uses singular credit wording for need %s and balance %s', async (need, held) => {
  door.mockResolvedValue(new Response(JSON.stringify({ ok: false, need, balance: { total: held } }), { status: 402 }))
  const render = new RenderService(runtime), id = await plannedJob(render)
  await expect(render.submitRender(id)).rejects.toMatchObject({
    message: `This render needs ${need} ${need === 1 ? 'credit' : 'credits'}. You have ${held} ${held === 1 ? 'credit' : 'credits'}.`,
  })
  expect(submit).not.toHaveBeenCalled()
})

it.each(['draft', 'standard', 'premium'] as const)('uses the real %s model tier and normalized seconds', async tier => {
  const provider = runtime.registry.get('test-video'), models = await provider.listModels()
  vi.spyOn(provider, 'listModels').mockResolvedValue(models.map(m => ({ ...m, capabilities: { ...m.capabilities, tier } })))
  const render = new RenderService(runtime)
  const plan = await render.planBatch({ projectId, shotId, batchName: tier, candidates: [candidate], createdBy: 'tester', orgId, humanApproved: true })
  expect(plan.jobIds).toHaveLength(1)
  await render.submitRender(plan.jobIds[0]!)
  expect(calls[0]).toMatchObject({ action: `motion.${tier}`, units: 4 })
  expect(await db.get('SELECT state, credits FROM render_credit_spends')).toMatchObject({ state: 'spent', credits: { draft: 12, standard: 24, premium: 64 }[tier] })
})

it('refuses a short wallet, saves the exact need and balance, and never calls the provider', async () => {
  door.mockResolvedValue(new Response(JSON.stringify({ ok: false, need: 24, balance: { total: 7 } }), { status: 402 }))
  const render = new RenderService(runtime), id = await plannedJob(render)
  await expect(render.submitRender(id)).rejects.toMatchObject({ code: 'credits.short' })
  const job = await runtime.renders.getJob(id)
  expect(job).toMatchObject({ status: 'blocked', attempts: 0, error: {
    code: 'credits.short', message: 'This render needs 24 credits. You have 7 credits.',
    creditsNeeded: 24, creditsHeld: 7, buyUrl: 'https://banker.test/billing#credits',
  } })
  expect(submit).not.toHaveBeenCalled()
})

it.each(['network', '503', 'invalid-success', 'redirect'])('refuses a render when the door fails: %s', async failure => {
  if (failure === 'network' || failure === 'redirect') door.mockRejectedValue(new Error('network refused'))
  else door.mockResolvedValue(new Response(JSON.stringify(failure === '503' ? { ok: false } : { ok: true }), { status: failure === '503' ? 503 : 200 }))
  const render = new RenderService(runtime), id = await plannedJob(render)
  await expect(render.submitRender(id)).rejects.toMatchObject({ code: 'credits.unavailable' })
  expect((await runtime.renders.getJob(id)).status).toBe('blocked')
  expect(submit).not.toHaveBeenCalled()
})

it('uses the same ref after a lost spend reply and does not submit until confirmed', async () => {
  const ordinary = door.getMockImplementation()!
  door.mockImplementationOnce(async (...args) => { await ordinary(...args); throw new Error('lost reply') })
  const render = new RenderService(runtime), id = await plannedJob(render)
  await expect(render.submitRender(id)).rejects.toMatchObject({ code: 'credits.unavailable' })
  expect(submit).not.toHaveBeenCalled()
  await render.submitRender(id)
  expect(calls).toHaveLength(2)
  expect(calls[0]!.ref).toBe(calls[1]!.ref)
  expect(submit).toHaveBeenCalledTimes(1)
})

it('queues one refund for provider failure and a new spend for a new attempt', async () => {
  submit.mockRejectedValueOnce(new Error('provider rejected generation'))
  const render = new RenderService(runtime), id = await plannedJob(render)
  await expect(render.submitRender(id)).rejects.toThrow('provider rejected generation')
  const firstRef = String(calls[0]!.ref)
  expect(await db.get('SELECT state FROM render_credit_spends WHERE ref = ?', [firstRef])).toMatchObject({ state: 'refund_pending' })
  await runtime.credits.refund(firstRef)
  await runtime.credits.refund(firstRef)
  expect(calls.filter(c => c.op === 'refund')).toEqual([{ op: 'refund', email: 'artist@example.test', suite: 'motion', ref: firstRef }])
  await retry(id)
  await render.submitRender(id)
  expect(calls.filter(c => c.op === 'spend')).toHaveLength(2)
  expect(calls.at(-1)!.ref).not.toBe(firstRef)
})

it('refunds a provider-reported failed job once, while retaining provider costs for safety caps', async () => {
  status.mockResolvedValue({ state: 'failed', actualMicros: 140000, billableSeconds: 4, error: { message: 'Provider could not make the video' } })
  const render = new RenderService(runtime), id = await plannedJob(render)
  await render.submitRender(id)
  await render.pollRender(id)
  await render.pollRender(id)
  const ref = String(calls[0]!.ref)
  await runtime.credits.refund(ref)
  await runtime.credits.refund(ref)
  expect(calls.filter(c => c.op === 'refund')).toHaveLength(1)
  expect(await charges(id)).toBe(1)
})

it('keeps a failed refund pending and retries the same ref', async () => {
  const render = new RenderService(runtime), id = await plannedJob(render)
  await render.submitRender(id)
  await runtime.credits.requestRefund(id, 1)
  const ref = String(calls[0]!.ref)
  door.mockRejectedValueOnce(new Error('door down'))
  await expect(runtime.credits.refund(ref)).rejects.toMatchObject({ code: 'credits.unavailable' })
  expect(await db.get('SELECT state FROM render_credit_spends WHERE ref = ?', [ref])).toMatchObject({ state: 'refund_pending' })
  await runtime.credits.refund(ref)
  expect(await db.get('SELECT state FROM render_credit_spends WHERE ref = ?', [ref])).toMatchObject({ state: 'refunded' })
  expect(calls.at(-1)).toMatchObject({ op: 'refund', ref })
})

it('keeps credits spent after successful generation, before any review or acceptance', async () => {
  const render = new RenderService(runtime), id = await plannedJob(render)
  await render.submitRender(id)
  await render.pollRender(id)
  expect((await runtime.renders.getJob(id)).status).toBe('downloading')
  expect(await db.get('SELECT state FROM render_credit_spends')).toMatchObject({ state: 'spent' })
  expect(calls.filter(c => c.op === 'refund')).toHaveLength(0)
})

it.each(['customer', 'service'])('the %s safety cap stops credit spend and provider work', async which => {
  const render = new RenderService(runtime), id = await plannedJob(render)
  if (which === 'customer') runtime.config.customerSpendCapMicros = 0
  else runtime.config.liveSpendCapMicros = 0
  await expect(render.submitRender(id)).rejects.toMatchObject({ code: 'render.blocked' })
  expect(calls).toHaveLength(0)
  expect(submit).not.toHaveBeenCalled()
})

it('does not charge an unverified local account email', async () => {
  await db.run('DELETE FROM sessions')
  const render = new RenderService(runtime), id = await plannedJob(render)
  await expect(render.submitRender(id)).rejects.toMatchObject({ code: 'credits.account' })
  expect(door).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('spends once when two workers claim the same render', async () => {
  const render = new RenderService(runtime), id = await plannedJob(render)
  await Promise.all([render.submitRender(id), render.submitRender(id)])
  expect(calls).toHaveLength(1)
  expect(submit).toHaveBeenCalledTimes(1)
})


it.each([false, true])('Python accepts the signed request, with MOTION key set: %s', async ownKey => {
  runtime.config.SUITE_SSO_SECRET_MOTION = ownKey ? 'test-motion-key' : ''
  const render = new RenderService(runtime), id = await plannedJob(render)
  await render.submitRender(id)
  const options = door.mock.calls[0]![1] as RequestInit
  expect(options.redirect).toBe('error')
  expect(options.signal).toBeInstanceOf(AbortSignal)
  const token = JSON.parse(String(options.body)).token
  const decoded = JSON.parse(execFileSync('python', ['-c',
    'import json,sys; from itsdangerous import URLSafeTimedSerializer; d=json.load(sys.stdin); print(json.dumps(URLSafeTimedSerializer(d["secret"], salt="street-banker-suite-credits-v1").loads(d["token"],max_age=120)))'],
    { input: JSON.stringify({ token, secret: ownKey ? 'test-motion-key' : 'test-credit-key' }), encoding: 'utf8' }))
  expect(decoded).toMatchObject({ op: 'spend', email: 'artist@example.test', suite: 'motion', action: 'motion.standard', units: 4 })
})

it('requires a configured credit door and never follows an insecure URL', async () => {
  runtime.config.STREET_BANKER_URL = 'http://banker.test'
  const render = new RenderService(runtime), id = await plannedJob(render)
  await expect(render.submitRender(id)).rejects.toMatchObject({ code: 'credits.unavailable' })
  expect(door).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('shows a plain, new-window Buy credits link only for a short wallet', () => {
  const error = { code: 'credits.short', message: 'This render needs 24 credits. You have 7 credits.', buyUrl: 'https://banker.test/billing#credits' }
  const html = renderToStaticMarkup(React.createElement(RenderCreditNotice, { error }))
  expect(html).toContain(error.message)
  expect(html).toContain('href="https://banker.test/billing#credits" target="_blank" rel="noopener noreferrer"')
  expect(html).toContain('Buy credits')
  expect(html).not.toMatch(/<code|mono/)
  expect(renderToStaticMarkup(React.createElement(RenderCreditNotice, { error: { ...error, code: 'credits.unavailable' } }))).toBe('')
  expect(renderToStaticMarkup(React.createElement(RenderCreditNotice, { error: { ...error, buyUrl: 'javascript:alert(1)' } }))).toBe('')
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.render-buy-credits\s*\{[^}]*min-height: 44px/s)
})

it('shows one notice for the newest short-wallet refusal in a batch of four', () => {
  const jobs = [1, 4, 2, 3].map(n => ({ status: 'blocked', createdAt: `2026-10-16T01:00:0${5 - n}Z`,
    error: { code: 'credits.short', message: `Refusal ${n}`, refusedAt: `2026-10-16T02:00:0${n}Z`, buyUrl: 'https://banker.test/billing#credits' } }))
  const html = renderToStaticMarkup(React.createElement(QueueCreditNotice, { jobs }))
  expect(html.match(/Buy credits/g)).toHaveLength(1)
  expect(html).toContain('Refusal 4')
  expect(html).not.toMatch(/Refusal [123]/)
  expect(renderToStaticMarkup(React.createElement(QueueCreditNotice, { jobs: jobs.map(j => ({ ...j, status: 'completed' })) }))).toBe('')
  expect(renderToStaticMarkup(React.createElement(QueueCreditNotice, { jobs: jobs.map(j => ({ ...j, error: { code: 'credits.unavailable' } })) }))).toBe('')
})

it('the durable worker processes a queued refund once', async () => {
  const { QueueWorker, QUEUES } = await import('@masterclip/runtime')
  const { JOB_TYPES } = await import('@masterclip/queue')
  submit.mockRejectedValueOnce(new Error('provider failed'))
  const render = new RenderService(runtime), id = await plannedJob(render)
  await expect(render.submitRender(id)).rejects.toThrow('provider failed')
  const worker = new QueueWorker(runtime.queue, { queueName: QUEUES.maintenance, concurrency: 1, logger: silentLogger })
  worker.register<{ ref: string }>(JOB_TYPES.refundCredits, ({ ref }) => runtime.credits.refund(ref))
  await worker.runOnce(5)
  await worker.runOnce(5)
  expect(calls.filter(c => c.op === 'refund')).toHaveLength(1)
  expect(await db.get('SELECT state FROM render_credit_spends')).toMatchObject({ state: 'refunded' })
})
