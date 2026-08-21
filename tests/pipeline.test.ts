import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, toNum, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { formatUsd, loadConfig, silentLogger, usdToMicros } from '@masterclip/shared'
import { JOB_TYPES, QueueWorker } from '@masterclip/queue'
import { emptyShot, CharacterRecord, EnvironmentRecord } from '@masterclip/shot-schema'
import { createRuntime, MasterService, RenderService, QUEUES, type Runtime } from '@masterclip/runtime'

/**
 * End-to-end pipeline test.
 *
 * Runs the real factory against the mock provider: plan → authorize → submit →
 * poll → download → verify → technical QC → derivatives → review → promote →
 * finish → package. Everything here is genuine — real MP4s from ffmpeg, real
 * ffprobe measurements, real ledger rows — and nothing is billable.
 */
let runtime: Runtime
let db: Db
let storageRoot: string
let projectId: string
let shotId: string
let orgId: string

async function drain(render: RenderService, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    let processed = 0
    for (const queueName of [QUEUES.render, QUEUES.qc, QUEUES.media]) {
      const worker = new QueueWorker(runtime.queue, { queueName, concurrency: 1, logger: silentLogger })
      worker.register<{ jobId: string }>(JOB_TYPES.submitRender, async ({ jobId }) => void (await render.submitRender(jobId)))
      worker.register<{ jobId: string }>(JOB_TYPES.pollRender, async ({ jobId }, ctx) => {
        const result = await render.pollRender(jobId)
        if (!result.done) ctx.defer(0)
      })
      worker.register<{ jobId: string }>(JOB_TYPES.ingestOutput, async ({ jobId }) => void (await render.ingestOutputs(jobId)))
      worker.register<{ outputId: string }>(JOB_TYPES.runTechnicalQc, async ({ outputId }) => void (await render.runQc(outputId)))
      worker.register<{ outputId: string }>(JOB_TYPES.buildProxies, async ({ outputId }) => void (await render.buildDerivatives(outputId)))
      processed += await worker.runOnce(60)
    }
    if (processed === 0) break
  }
}

beforeEach(async () => {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'masterclip-pipeline-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'pipeline-test-secret',
      PROVIDER_POLL_INTERVAL_MS: '0',
    },
    true,
  )

  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'pipeline-test-secret' }),
  })

  // Default mock latency is 1.5s of simulated provider time; the drain loop
  // runs synchronously, so re-register with zero latency for tests.
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

  const org = await runtime.projects.createOrg('Test Org')
  orgId = org.id
  const project = await runtime.projects.create({ orgId, name: 'Pipeline Project', createdBy: 'tester' })
  projectId = project.id
  await runtime.cost.budgetStore.ensureDefaults('project', projectId)

  await runtime.bibles.createCharacter({
    projectId,
    createdBy: 'tester',
    record: CharacterRecord.parse({ character_key: 'NOVA', name: 'Nova', hair: 'wet dark bob', wardrobe: ['black leather jacket'] }),
  })
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
      lighting: {
        dominant_source: 'magenta neon sign',
        source_position: 'high camera left',
        color_temperature: 'magenta',
        falloff: 'rapid',
        shadow_behavior: 'hard',
        practicals: [],
      },
    }),
  })
  shotId = created.shot.id
})

afterEach(async () => {
  await runtime.close()
  await rm(storageRoot, { recursive: true, force: true })
})

function candidates(count: number, modelId = 'mock-standard') {
  return Array.from({ length: count }, (_, index) => ({
    providerId: 'mock',
    modelId,
    seed: null,
    variationLabel: `v${index}`,
    variationInstruction: index === 0 ? '' : `variation ${index}`,
    resolution: '480p',
    aspectRatio: '16:9',
    durationSeconds: 4,
  }))
}

describe('render pipeline', () => {
  it('carries a shot from plan to a packaged master', async () => {
    const render = new RenderService(runtime)

    // --- plan: quotes and authorization happen before anything is queued ----
    const plan = await render.planBatch({ projectId, shotId, batchName: 'test batch', candidates: candidates(3), createdBy: 'tester', orgId })
    expect(plan.jobIds).toHaveLength(3)
    expect(plan.estimatedMicros).toBeGreaterThan(0)

    await drain(render)

    // --- outputs exist, are real files, and have derivatives ---------------
    const outputs = await runtime.renders.listOutputs({ shotId })
    expect(outputs).toHaveLength(3)
    for (const output of outputs) {
      expect(output.sha256).toHaveLength(64)
      expect(output.proxyAssetId).toBeTruthy()
      expect(output.thumbnailAssetId).toBeTruthy()
      expect(output.contactSheetAssetId).toBeTruthy()

      const asset = await runtime.assets.get(output.assetId)
      expect(asset.bytes).toBeGreaterThan(1000)
      expect(asset.metadata.prompt).toBeTruthy()
      // Provenance: the render points back at the shot version it came from.
      expect(asset.metadata.shot_version_id).toBeTruthy()
    }

    // --- QC ran on every candidate ----------------------------------------
    for (const output of outputs) {
      const qc = await runtime.renders.qcFor(output.id)
      expect(qc.some((row) => row.layer === 'technical')).toBe(true)
      expect(qc.some((row) => row.layer === 'combined')).toBe(true)
    }

    // --- the ledger recorded both intent and charge, as sandbox ------------
    const ledger = await db.query<{ entry_type: string; sandbox: number; total: number }>(
      'SELECT entry_type, sandbox, SUM(micros) AS total FROM cost_ledger GROUP BY entry_type, sandbox',
    )
    expect(ledger.find((row) => row.entry_type === 'estimate')).toBeDefined()
    expect(ledger.find((row) => row.entry_type === 'charge')).toBeDefined()
    expect(ledger.every((row) => toNum(row.sandbox) === 1)).toBe(true)
    // Sandbox spend must never touch the live-spend allowance.
    expect(await runtime.ledger.totalLiveSpend()).toBe(0)

    // --- review and promotion ---------------------------------------------
    const passing = outputs.find((output) => output.status !== 'qc_failed') ?? outputs[0]!
    await expect(
      new MasterService(runtime).promote({ outputId: passing.id, name: 'S01 master', approvedBy: 'tester', orgId }),
    ).rejects.toThrow(/human approval/)

    await runtime.renders.addReview({
      outputId: passing.id,
      projectId,
      shotId,
      userId: 'tester',
      decision: 'approve',
      rejectionReasons: [],
      note: 'good take',
    })

    const masters = new MasterService(runtime)
    const masterId = await masters.promote({ outputId: passing.id, name: 'S01 master', approvedBy: 'tester', orgId })
    expect(masterId).toBeTruthy()

    // --- finishing and packaging ------------------------------------------
    const deliverables = await masters.finish(masterId, [{ format: 'delivery_h264' }], 'tester')
    expect(deliverables).toHaveLength(1)

    const built = await masters.buildPackage(masterId, join(storageRoot, 'packages'))
    expect(built.files.length).toBeGreaterThan(2)
    expect(built.manifestPath).toContain('provenance.json')

    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(built.manifestPath, 'utf8'))
    expect(manifest.generation.provider).toBe('mock')
    expect(manifest.generation.compiledPrompt).toContain('ALLEY')
    expect(manifest.canonicalShot.shot_id).toBe('S01')
    expect(manifest.cost.sandbox).toBe(true)
    expect(manifest.disclaimers.join(' ')).toMatch(/No AI upscaling or frame interpolation/)

    // --- metrics reflect what actually happened ---------------------------
    const metrics = await runtime.metrics.projectMetrics(projectId)
    expect(metrics.submittedCount).toBe(3)
    expect(metrics.approvedCount).toBe(1)
    expect(metrics.costPerApprovedSecond).not.toBeNull()
  })

  it('auto-rejects a defective render without a human ever seeing it', async () => {
    // Force every candidate defective at the provider.
    const defective = await createRuntime({
      config: loadConfig(
        { NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: storageRoot, ASSET_SIGNING_SECRET: 'pipeline-test-secret', PROVIDER_POLL_INTERVAL_MS: '0' },
        true,
      ),
      db,
      logger: silentLogger,
      mockOnly: true,
      storage: new LocalStorage({ root: storageRoot, signingSecret: 'pipeline-test-secret' }),
    })
    const { createMockProvider } = await import('@masterclip/provider-mock')
    defective.registry.register(
      createMockProvider({
        logger: silentLogger,
        sandbox: true,
        publicBaseUrl: '',
        now: () => Date.now(),
        workDir: join(storageRoot, 'defective-mock'),
        latencyMs: 0,
        defectRate: 1,
        failureRate: 0,
      }),
    )

    const render = new RenderService(defective)
    await render.planBatch({ projectId, shotId, batchName: 'defective batch', candidates: candidates(4), createdBy: 'tester', orgId })
    await drain(render)

    const outputs = await defective.renders.listOutputs({ shotId })
    expect(outputs.length).toBeGreaterThan(0)

    const actions: string[] = []
    for (const output of outputs) {
      const qc = await defective.renders.qcFor(output.id)
      const combined = qc.find((row) => row.layer === 'combined')
      actions.push(String(combined?.recommended_action))
    }
    // Every defect pattern must resolve to a machine decision, never silence.
    expect(actions.every((action) => action === 'AUTO_REJECT' || action === 'REGENERATE_WITH_CORRECTION')).toBe(true)
    expect(actions.some((action) => action === 'AUTO_REJECT')).toBe(true)
    // Shares the same Db handle as `runtime`; afterEach closes it once.
  })

  it('refuses to queue a batch that would blow the per-shot budget', async () => {
    const render = new RenderService(runtime)
    await runtime.cost.budgetStore.set({
      ...(await runtime.cost.budgetStore.ensureDefaults('project', projectId)),
      perShotCapMicros: usdToMicros(0.3),
    })

    // Each candidate is $0.20; the cap is $0.30. The first fits, and the rest
    // must be refused against the batch's running commitment rather than each
    // being re-authorized against the same empty balance.
    const plan = await render.planBatch({ projectId, shotId, batchName: 'over budget', candidates: candidates(4), createdBy: 'tester', orgId })
    expect(plan.jobIds).toHaveLength(1)
    expect(plan.skipped).toHaveLength(3)
    expect(plan.skipped[0]?.reason).toMatch(/budget/i)

    const audit = await runtime.audit.forProject(projectId)
    expect(audit.some((entry) => entry.action === 'render.denied')).toBe(true)
  })

  it('collapses duplicate cells in a batch instead of paying twice', async () => {
    const render = new RenderService(runtime)
    const duplicate = { ...candidates(1)[0]!, variationLabel: 'same', variationInstruction: 'same' }
    const plan = await render.planBatch({
      projectId,
      shotId,
      batchName: 'duplicates',
      candidates: [duplicate, { ...duplicate }, { ...duplicate }],
      createdBy: 'tester',
      orgId,
    })

    // Three identical cells describe one render; the idempotency key collapses
    // them so a sloppy matrix cannot triple the bill.
    expect(new Set(plan.jobIds).size).toBe(1)
    expect(plan.skipped.filter((s) => s.reason.includes('idempotency'))).toHaveLength(2)

    await drain(render)
    expect(await runtime.renders.listOutputs({ shotId })).toHaveLength(1)
  })

  it('survives a worker dying mid-flight', async () => {
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'resilience', candidates: candidates(2), createdBy: 'tester', orgId })

    // Claim the work and then abandon it, exactly as a killed worker would.
    const claimed = await runtime.queue.claim(QUEUES.render, 2)
    expect(claimed.length).toBeGreaterThan(0)

    const recovered = await runtime.queue.recoverStalled()
    expect(recovered).toBe(0) // lease has not expired yet

    await db.run("UPDATE queue_jobs SET lease_until = '2000-01-01T00:00:00.000Z' WHERE status = 'active'")
    expect(await runtime.queue.recoverStalled()).toBeGreaterThan(0)

    await drain(render)
    expect(await runtime.renders.listOutputs({ shotId })).toHaveLength(2)
  })

  it('records provenance from the delivery back to the shot version', async () => {
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'lineage', candidates: candidates(1), createdBy: 'tester', orgId })
    await drain(render)

    const output = (await runtime.renders.listOutputs({ shotId }))[0]!
    const proxyLineage = await runtime.assets.lineage(output.proxyAssetId ?? '')
    expect(proxyLineage.parents.map((p) => p.assetId)).toContain(output.assetId)
    expect(proxyLineage.parents[0]?.relation).toBe('proxy_of')

    const job = await runtime.renders.getJob(output.jobId)
    const version = await runtime.projects.getVersion(job.shotVersionId)
    expect(version.spec.shot_id).toBe('S01')
    expect(version.specHash).toHaveLength(64)
  })

  it('reports cost per approved second only once something is approved', async () => {
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'metrics', candidates: candidates(2), createdBy: 'tester', orgId })
    await drain(render)

    const before = await runtime.metrics.projectMetrics(projectId)
    expect(before.costPerApprovedSecond).toBeNull()

    const output = (await runtime.renders.listOutputs({ shotId }))[0]!
    await runtime.renders.addReview({ outputId: output.id, projectId, shotId, userId: 'tester', decision: 'approve', rejectionReasons: [], note: '' })

    const after = await runtime.metrics.projectMetrics(projectId)
    expect(after.costPerApprovedSecond).not.toBeNull()
    expect(formatUsd(after.costPerApprovedSecond ?? 0)).toMatch(/^\$/)
  })

  it('feeds rejection reasons back into model performance', async () => {
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'learning', candidates: candidates(2), createdBy: 'tester', orgId })
    await drain(render)

    const outputs = await runtime.renders.listOutputs({ shotId })
    await runtime.renders.addReview({
      outputId: outputs[0]!.id,
      projectId,
      shotId,
      userId: 'tester',
      decision: 'reject',
      rejectionReasons: ['too_static', 'ai_appearance'],
      note: '',
    })
    await runtime.metrics.recordRejectionReasons(projectId, 'mock', 'mock-standard', ['too_static', 'ai_appearance'])
    await runtime.renders.addReview({ outputId: outputs[1]!.id, projectId, shotId, userId: 'tester', decision: 'approve', rejectionReasons: [], note: '' })

    const performance = await runtime.metrics.recomputeModelPerformance(projectId)
    const row = performance.find((p) => p.modelId === 'mock-standard')
    expect(row?.submitted).toBe(2)
    expect(row?.approved).toBe(1)
    expect(row?.rejected).toBe(1)

    const reasons = await runtime.metrics.rejectionBreakdown(projectId)
    expect(reasons.map((r) => r.reason)).toContain('too_static')
  })
})
