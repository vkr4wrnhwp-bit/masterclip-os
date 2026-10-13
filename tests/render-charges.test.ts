import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, toNum, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { emptyShot, EnvironmentRecord } from '@masterclip/shot-schema'
import { createRuntime, RenderService, settleCancelledJob, type Runtime } from '@masterclip/runtime'

/**
 * A job is charged once per paid generation, and submitted once.
 *
 * The retry route lets a failed or cancelled job be sent again, which is a new
 * paid generation under the same job id. Charges used to be deduped on the job
 * id alone, so every generation after the first was paid for and never counted.
 * And nothing stopped two workers (a queue retry and a user's retry) both
 * reading the same job as waiting and both submitting it.
 */
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
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'charges-test-secret',
      SESSION_SECRET: 'charges-test-session-secret',
      PROVIDER_POLL_INTERVAL_MS: '0',
    },
    true,
  )
  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'charges-test-secret' }),
  })
  const { createMockProvider } = await import('@masterclip/provider-mock')
  runtime.registry.register(
    createMockProvider({
      logger: silentLogger,
      sandbox: true,
      publicBaseUrl: '',
      now: () => Date.now(),
      workDir: join(storageRoot, 'mock'),
      latencyMs: 0,
      defectRate: 0,
      failureRate: 0,
    }),
  )

  const org = await runtime.projects.createOrg('Charges Org')
  orgId = org.id
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
  await runtime.close()
  await rm(storageRoot, { recursive: true, force: true })
})

const candidate = {
  providerId: 'mock',
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

describe('one charge per paid generation', () => {
  it('counts every generation of a retried job, not just the first', async () => {
    const render = new RenderService(runtime)
    const jobId = await plannedJob(render)

    await render.submitRender(jobId)
    await untilDone(render, jobId)
    expect(await charges(jobId)).toBe(1)

    // The same generation settled again (a second poll, a cancel) is still one charge.
    await untilDone(render, jobId)
    await settleCancelledJob(runtime, jobId, { providerStopped: true })
    expect(await charges(jobId)).toBe(1)

    // A retry is a new paid generation under the same job id.
    await retry(jobId)
    await render.submitRender(jobId)
    await untilDone(render, jobId)
    expect(await attempts(jobId)).toBe(2)
    expect(await charges(jobId)).toBe(2)

    // And a cancel on a retry that has not been sent yet costs nothing more.
    await retry(jobId)
    expect(await settleCancelledJob(runtime, jobId, { providerStopped: true })).toBeNull()
    expect(await charges(jobId)).toBe(2)

    // A cancel -> retry -> cancel loop pays the provider each cycle, and is counted each cycle.
    await render.submitRender(jobId)
    await runtime.renders.updateJob(jobId, { status: 'cancelled' })
    expect(await settleCancelledJob(runtime, jobId, { providerStopped: false })).not.toBeNull()
    expect(await attempts(jobId)).toBe(3)
    expect(await charges(jobId)).toBe(3)
    const distinct = await count(`SELECT COUNT(DISTINCT attempt_id) AS n FROM cost_ledger WHERE job_id = ? AND entry_type = 'charge'`, [jobId])
    expect(distinct).toBe(3)
  })

  it('does not charge twice a job charged before charges carried an attempt', async () => {
    const render = new RenderService(runtime)
    const jobId = await plannedJob(render)
    await render.submitRender(jobId)
    // As written by the code that deduped on the job id: no attempt on the charge.
    await db.run(`UPDATE cost_ledger SET attempt_id = NULL WHERE job_id = ? AND entry_type = 'estimate'`, [jobId])
    await untilDone(render, jobId)
    await db.run(`UPDATE cost_ledger SET attempt_id = NULL WHERE job_id = ? AND entry_type = 'charge'`, [jobId])
    expect(await charges(jobId)).toBe(1)

    // The same generation settling again is covered by that older charge...
    await settleCancelledJob(runtime, jobId, { providerStopped: true })
    expect(await charges(jobId)).toBe(1)
    // ...but a retry after it is a new generation and is counted.
    await retry(jobId)
    await render.submitRender(jobId)
    await untilDone(render, jobId)
    expect(await charges(jobId)).toBe(2)
  })
})

describe('one submission per job', () => {
  it('lets only one of two workers that read the same waiting job send it', async () => {
    const render = new RenderService(runtime)
    const jobId = await plannedJob(render)
    await Promise.all([render.submitRender(jobId), render.submitRender(jobId)])
    expect(await attempts(jobId)).toBe(1)
    expect(await count(`SELECT COUNT(*) AS n FROM cost_ledger WHERE job_id = ? AND entry_type = 'estimate'`, [jobId])).toBe(1)
    expect((await runtime.renders.getJob(jobId)).status).toBe('submitted')
  })

  it('does the same for a blocked job that a queue retry and a user retry both pick up', async () => {
    const render = new RenderService(runtime)
    const jobId = await plannedJob(render)
    await runtime.renders.updateJob(jobId, { status: 'blocked' })
    await Promise.all([render.submitRender(jobId), render.submitRender(jobId), render.submitRender(jobId)])
    expect(await attempts(jobId)).toBe(1)
  })

  it('lets only one worker take over a job a stopped worker left authorizing', async () => {
    const render = new RenderService(runtime)
    const jobId = await plannedJob(render)
    await runtime.renders.updateJob(jobId, { status: 'authorizing' })
    await Promise.all([render.submitRender(jobId), render.submitRender(jobId)])
    expect(await attempts(jobId)).toBe(1)
  })
})
