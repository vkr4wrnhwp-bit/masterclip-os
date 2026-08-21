import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError, formatUsd, notFound } from '@masterclip/shared'

/** Statuses where the provider is working and billing for it. */
const IN_FLIGHT_STATUSES = new Set(['authorizing', 'submitted', 'processing', 'downloading'])
import { toStr } from '@masterclip/database'
import { RejectionReason, deriveRequirements } from '@masterclip/shot-schema'
import { buildMatrix, defaultStopLoss, summarize } from '@masterclip/domain'
import { compareStrategies, routeShot } from '@masterclip/model-router'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import { MasterService, RenderService, type PlannedCandidate, type Runtime, settleCancelledJob } from '@masterclip/runtime'
import { requireProject } from '../server.js'

const CandidateSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  seed: z.string().nullable().default(null),
  variationLabel: z.string().default('base'),
  variationInstruction: z.string().default(''),
  resolution: z.string(),
  aspectRatio: z.string(),
  durationSeconds: z.number(),
})

/** Routing, batches, the queue, review, and masters. */
export async function registerRenderRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const render = new RenderService(runtime)
  const masters = new MasterService(runtime)

  // ------------------------------------------------------------- routing ----
  app.get('/api/shots/:shotId/routing', async (request) => {
    const { shotId } = request.params as { shotId: string }
    const shot = await runtime.projects.getShot(shotId)
    await requireProject(runtime, request, shot.projectId)

    const version = await runtime.projects.currentVersion(shotId)
    const [models, performance, health, budget, shotSpend] = await Promise.all([
      runtime.registry.models(),
      runtime.metrics.modelPerformance(shot.projectId),
      runtime.registry.health(),
      runtime.cost.budgetStore.ensureDefaults('project', shot.projectId),
      runtime.ledger.spend('shot', shotId, { includeSandbox: true }),
    ])

    const decision = routeShot({
      shot: version.spec,
      requirements: deriveRequirements(version.spec),
      models,
      performance,
      health,
      remainingBudgetMicros: budget.perShotCapMicros === null ? null : budget.perShotCapMicros - shotSpend,
    })

    return {
      profile: decision.profile,
      chosen: decision.chosen,
      candidates: decision.candidates.map((candidate) => ({
        ...candidate,
        estimatedUsd: candidate.estimatedMicros === null ? null : formatUsd(candidate.estimatedMicros),
        expectedApprovedUsd: candidate.expectedApprovedCostMicros === null ? null : formatUsd(candidate.expectedApprovedCostMicros),
        expectedApprovedPerSecondUsd:
          candidate.expectedApprovedCostPerSecondMicros === null ? null : formatUsd(candidate.expectedApprovedCostPerSecondMicros),
      })),
      rejected: decision.rejected,
      lowConfidence: decision.lowConfidence,
      explanation: decision.explanation,
    }
  })

  // ----------------------------------------------------------- batch plan ---
  /** Dry run: builds the matrix and prices it without submitting anything. */
  app.post('/api/shots/:shotId/matrix', async (request) => {
    const { shotId } = request.params as { shotId: string }
    const shot = await runtime.projects.getShot(shotId)
    await requireProject(runtime, request, shot.projectId)
    const version = await runtime.projects.currentVersion(shotId)

    const body = z
      .object({
        models: z.array(z.object({ providerId: z.string(), modelId: z.string() })).min(1),
        seeds: z.array(z.string().nullable()).default([null]),
        aspectRatios: z.array(z.string()).optional(),
        resolutions: z.array(z.string()).optional(),
        durations: z.array(z.number()).optional(),
      })
      .parse(request.body)

    const plan = buildMatrix(version.spec, {
      models: body.models,
      seeds: body.seeds,
      ...(body.aspectRatios ? { aspectRatios: body.aspectRatios as never } : {}),
      ...(body.resolutions ? { resolutions: body.resolutions as never } : {}),
      ...(body.durations ? { durations: body.durations } : {}),
    })

    // Price every cell before anything is queued: the operator must see the
    // real total, not a per-render figure they have to multiply themselves.
    const priced = await Promise.all(
      plan.cells.map(async (cell) => {
        try {
          const provider = runtime.registry.get(cell.providerId)
          const model = await runtime.registry.findModel(cell.providerId, cell.modelId)
          const perSecond = model.pricing?.basis === 'per_second' ? model.pricing.rateMicros : null
          void provider
          return { ...cell, estimatedMicros: perSecond === null ? null : Math.round(perSecond * cell.durationSeconds) }
        } catch {
          return { ...cell, estimatedMicros: null }
        }
      }),
    )

    const summary = summarize(priced, plan.warnings)
    const budget = await runtime.cost.budgetStore.ensureDefaults('project', shot.projectId)
    const spent = await runtime.ledger.spend('project', shot.projectId, { includeSandbox: true })

    return {
      ...summary,
      estimatedTotalUsd: summary.estimatedTotalMicros === null ? null : formatUsd(summary.estimatedTotalMicros),
      stopLossMicros: defaultStopLoss(summary),
      budget: {
        perShotCapUsd: budget.perShotCapMicros === null ? null : formatUsd(budget.perShotCapMicros),
        projectSpentUsd: formatUsd(spent),
        monthlyCapUsd: budget.monthlyCapMicros === null ? null : formatUsd(budget.monthlyCapMicros),
      },
      mode: runtime.config.MASTERCLIP_MODE,
    }
  })

  app.post('/api/shots/:shotId/render', async (request) => {
    const { shotId } = request.params as { shotId: string }
    const shot = await runtime.projects.getShot(shotId)
    // Spending money is a director-level action.
    const { auth } = await requireProject(runtime, request, shot.projectId, 'director')

    const body = z
      .object({
        batchName: z.string().default('batch'),
        candidates: z.array(CandidateSchema).min(1).max(512),
        humanApproved: z.boolean().default(false),
      })
      .parse(request.body)

    const result = await render.planBatch({
      projectId: shot.projectId,
      shotId,
      batchName: body.batchName,
      candidates: body.candidates as PlannedCandidate[],
      createdBy: auth.userId,
      orgId: auth.orgId,
      humanApproved: body.humanApproved,
    })

    return {
      ...result,
      estimatedUsd: formatUsd(result.estimatedMicros),
      queued: result.jobIds.length,
      note: 'renders run in the worker; closing this page does not stop them',
    }
  })

  // --------------------------------------------------------------- queue ----
  app.get('/api/projects/:projectId/queue', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const jobs = await runtime.renders.listJobs({ projectId, limit: 200 })
    const stats = await runtime.queue.stats()
    return {
      stats,
      jobs: jobs.map((job) => ({
        id: job.id,
        batchId: job.batchId,
        shotId: job.shotId,
        provider: job.providerId,
        model: job.modelId,
        status: job.status,
        attempts: job.attempts,
        estimatedUsd: formatUsd(job.estimatedMicros),
        actualUsd: formatUsd(job.actualMicros),
        sandbox: job.sandbox,
        ageSeconds: Math.round((runtime.clock.now() - Date.parse(job.createdAt)) / 1000),
        error: job.error,
        createdAt: job.createdAt,
        submittedAt: job.submittedAt,
        completedAt: job.completedAt,
      })),
    }
  })

  app.post('/api/jobs/:jobId/retry', async (request) => {
    const { jobId } = request.params as { jobId: string }
    const job = await runtime.renders.getJob(jobId)
    // A retry is a new billable generation, so it needs spend authority.
    await requireProject(runtime, request, job.projectId, 'director')
    if (job.status === 'completed') {
      throw new AppError({ kind: 'conflict', code: 'job.already_complete', message: 'this job already produced outputs' })
    }
    // Only a job that has stopped may be retried. Retrying one that is still
    // with the provider submits a *second* paid generation while the first is
    // still running and still billing, and the original external job is then
    // orphaned — nothing polls it, so its cost is never recorded at all. Cancel
    // it first if that is really what you want.
    if (IN_FLIGHT_STATUSES.has(job.status)) {
      throw new AppError({
        kind: 'conflict',
        code: 'job.still_running',
        message: `this job is ${job.status} at the provider and is still billing; cancel it before retrying, or a second generation will be paid for alongside the first`,
      })
    }
    await runtime.renders.updateJob(jobId, { status: 'queued', error: null })
    const { id, deduped } = await runtime.queue.enqueue({
      queue: QUEUES.render,
      type: JOB_TYPES.submitRender,
      payload: { jobId },
      dedupeKey: `submit:${jobId}:retry:${job.attempts + 1}`,
    })
    return { queueJobId: id, deduped, note: 'a retry submits a new billable generation and re-checks the budget first' }
  })

  app.post('/api/jobs/:jobId/cancel', async (request) => {
    const { jobId } = request.params as { jobId: string }
    const job = await runtime.renders.getJob(jobId)
    await requireProject(runtime, request, job.projectId, 'director')
    const provider = runtime.registry.get(job.providerId)
    // Whether the provider actually stopped decides whether we owe for this
    // generation. Swallowing the failure and marking it cancelled locally meant
    // a provider that had already billed — or that refuses to cancel past the
    // point of no return — was never charged to the ledger, because polling
    // stops the moment the status is terminal.
    let providerStopped = false
    let cancelError: string | null = null
    if (job.externalJobId && provider.cancel) {
      try {
        await provider.cancel(job.externalJobId)
        providerStopped = true
      } catch (err) {
        cancelError = err instanceof Error ? err.message : String(err)
      }
    }
    await runtime.renders.updateJob(jobId, { status: 'cancelled', cancelledAt: runtime.clock.isoNow() })
    // Settle before polling stops. A cancel we could not confirm is assumed to
    // have cost its estimate: over-counting refuses the next render too early,
    // under-counting lets the cap through work that was actually paid for.
    const settled = await settleCancelledJob(runtime, jobId, { providerStopped })
    return { ok: true, providerStopped, cancelError, chargedMicros: settled }
  })

  /**
   * Dead-lettered jobs, scoped to one project.
   *
   * This used to swallow its own authorization failure with `.catch(() =>
   * undefined)` and then return every tenant's rows regardless — the caller
   * did not even need to be signed in. A dead-letter row carries the failing
   * payload, so it leaked job ids, prompts and provider detail across orgs.
   */
  /**
   * Dead-lettered jobs, scoped to one project.
   *
   * This used to swallow its own authorization failure with `.catch(() =>
   * undefined)` and then return every tenant's rows regardless — the caller did
   * not even need to be signed in. A dead-letter row carries the failing
   * payload, so it leaked job ids and provider detail across orgs.
   *
   * The row identifies its work by a JSON payload rather than a foreign key, so
   * the scoping is done in code: parse the payload, resolve the render job, keep
   * only rows belonging to this project. Rows with no resolvable job are
   * withheld rather than shown, since they cannot be attributed to anyone.
   */
  app.get('/api/queue/dead', async (request) => {
    const projectId = String((request.query as { projectId?: string }).projectId ?? '')
    await requireProject(runtime, request, projectId, 'producer')
    const rows = await runtime.db.query<Record<string, unknown>>(
      'SELECT * FROM queue_dead WHERE replayed_at IS NULL ORDER BY failed_at DESC LIMIT 500',
    )
    const mine = []
    for (const row of rows) {
      const jobId = deadLetterJobId(row)
      if (!jobId) continue
      const job = await runtime.renders.getJob(jobId).catch(() => null)
      if (job?.projectId === projectId) mine.push(row)
      if (mine.length >= 100) break
    }
    return { dead: mine }
  })

  /**
   * Replaying a dead letter re-runs the job it describes, and for a render job
   * that means a **new billable generation**. This was completely
   * unauthenticated: anyone who could reach the API could spend another org's
   * money by guessing an id. It now resolves the job the row points at and
   * demands the same `producer` role as any other spend.
   */
  app.post('/api/queue/dead/:deadId/replay', async (request) => {
    const { deadId } = request.params as { deadId: string }
    const row = await runtime.db.get<Record<string, unknown>>('SELECT * FROM queue_dead WHERE id = ?', [deadId])
    if (!row) throw notFound('dead-letter entry', deadId)
    const jobId = deadLetterJobId(row)
    if (!jobId) {
      throw new AppError({
        kind: 'forbidden',
        code: 'queue.unattributable_replay',
        message: 'this dead letter is not tied to a render job, so it cannot be attributed to a project or replayed through the API',
      })
    }
    const job = await runtime.renders.getJob(jobId)
    await requireProject(runtime, request, job.projectId, 'producer')
    return { queueJobId: await runtime.queue.replayDead(deadId) }
  })

  // ------------------------------------------------------------- outputs ----
  app.get('/api/shots/:shotId/outputs', async (request) => {
    const { shotId } = request.params as { shotId: string }
    const shot = await runtime.projects.getShot(shotId)
    await requireProject(runtime, request, shot.projectId)

    const outputs = await runtime.renders.listOutputs({ shotId })
    const enriched = await Promise.all(
      outputs.map(async (output) => {
        const [qc, review, asset, proxy, thumb, sheet, job] = await Promise.all([
          runtime.renders.qcFor(output.id),
          runtime.renders.latestReview(output.id),
          runtime.assets.find(output.assetId),
          output.proxyAssetId ? runtime.assets.find(output.proxyAssetId) : null,
          output.thumbnailAssetId ? runtime.assets.find(output.thumbnailAssetId) : null,
          output.contactSheetAssetId ? runtime.assets.find(output.contactSheetAssetId) : null,
          runtime.renders.getJob(output.jobId),
        ])
        const url = async (key: string | undefined) => (key ? runtime.storage.signedUrl(key, 3600) : null)
        return {
          ...output,
          prompt: job.compiledPrompt,
          seed: job.seed,
          routingProfile: job.routingProfile,
          estimatedUsd: formatUsd(job.estimatedMicros),
          actualUsd: formatUsd(job.actualMicros),
          qc: qc.map((row) => ({ ...row, raw: undefined })),
          qcDetail: qc.find((row) => toStr(row.layer) === 'combined') ?? null,
          review,
          urls: {
            source: await url(asset?.storageKey),
            proxy: await url(proxy?.storageKey),
            thumbnail: await url(thumb?.storageKey),
            contactSheet: await url(sheet?.storageKey),
          },
        }
      }),
    )
    return { outputs: enriched }
  })

  app.post('/api/outputs/:outputId/review', async (request) => {
    const { outputId } = request.params as { outputId: string }
    const output = await runtime.renders.getOutput(outputId)
    const { auth } = await requireProject(runtime, request, output.projectId, 'editor')
    const body = z
      .object({
        decision: z.enum(['approve', 'reject', 'rank', 'promote', 'reset']),
        rankOrder: z.number().int().nullable().optional(),
        rejectionReasons: z.array(RejectionReason).default([]),
        note: z.string().default(''),
      })
      .parse(request.body)

    const review = await runtime.renders.addReview({
      outputId,
      projectId: output.projectId,
      shotId: output.shotId,
      userId: auth.userId,
      decision: body.decision,
      rankOrder: body.rankOrder ?? null,
      rejectionReasons: body.rejectionReasons,
      note: body.note,
    })

    if (body.decision === 'reject' && body.rejectionReasons.length > 0) {
      await runtime.metrics.recordRejectionReasons(output.projectId, output.providerId, output.modelId, body.rejectionReasons)
    }
    await runtime.audit.record({
      orgId: auth.orgId,
      projectId: output.projectId,
      actor: auth.userId,
      action: 'review.decision',
      targetType: 'output',
      targetId: outputId,
      data: { decision: body.decision, reasons: body.rejectionReasons },
    })
    // Acceptance history feeds routing; recompute so the next batch benefits.
    await runtime.queue.enqueue({
      queue: QUEUES.maintenance,
      type: JOB_TYPES.recomputeStats,
      payload: { projectId: output.projectId },
      dedupeKey: `stats:${output.projectId}:${Math.floor(runtime.clock.now() / 60_000)}`,
    })
    return { review }
  })

  // ------------------------------------------------------------- masters ----
  app.post('/api/outputs/:outputId/promote', async (request) => {
    const { outputId } = request.params as { outputId: string }
    const output = await runtime.renders.getOutput(outputId)
    const { auth } = await requireProject(runtime, request, output.projectId, 'director')
    const body = z.object({ name: z.string().min(1) }).parse(request.body)
    const masterId = await masters.promote({ outputId, name: body.name, approvedBy: auth.userId, orgId: auth.orgId })
    return { masterId, master: await runtime.renders.getMaster(masterId) }
  })

  app.get('/api/projects/:projectId/masters', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const list = await runtime.renders.listMasters(projectId)
    return {
      masters: await Promise.all(
        list.map(async (master) => ({
          ...master,
          deliverables: await runtime.renders.listDeliverables(master.id),
        })),
      ),
    }
  })

  app.post('/api/masters/:masterId/finish', async (request) => {
    const { masterId } = request.params as { masterId: string }
    const master = await runtime.renders.getMaster(masterId)
    const { auth } = await requireProject(runtime, request, master.projectId, 'director')
    const body = z
      .object({
        specs: z
          .array(
            z.object({
              format: z.enum(['review_h264', 'delivery_h264', 'delivery_h265', 'prores_422hq', 'prores_4444', 'social_h264']),
              aspectRatio: z.string().optional(),
              resolution: z.string().optional(),
              reframeMode: z.enum(['crop', 'pad']).optional(),
              label: z.string().optional(),
            }),
          )
          .min(1),
      })
      .parse(request.body)
    const assetIds = await masters.finish(masterId, body.specs as never, auth.userId)
    return { assetIds, deliverables: await runtime.renders.listDeliverables(masterId) }
  })

  app.post('/api/masters/:masterId/package', async (request) => {
    const { masterId } = request.params as { masterId: string }
    const master = await runtime.renders.getMaster(masterId)
    await requireProject(runtime, request, master.projectId, 'director')
    const built = await masters.buildPackage(masterId)
    return { directory: built.directory, files: built.files.length, manifest: built.manifestPath }
  })

  app.post('/api/projects/:projectId/sequence', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const body = z.object({ masterIds: z.array(z.string()).min(1) }).parse(request.body)
    return masters.buildSequence(projectId, body.masterIds)
  })

  // ------------------------------------------------------------ cost lab ----
  app.post('/api/cost-lab/strategy', async (request) => {
    await requireProject(runtime, request, String((request.body as { projectId?: string })?.projectId ?? ''), 'viewer').catch(() => undefined)
    const body = z
      .object({
        masters: z.number().int().min(1),
        draftsPerMaster: z.number().int().min(0),
        draftCostPerClipUsd: z.number().min(0),
        finalCostPerClipUsd: z.number().min(0),
        guidedApprovalRate: z.number().min(0.01).max(1),
        blindApprovalRate: z.number().min(0.01).max(1),
      })
      .parse(request.body)

    const comparison = compareStrategies({
      masters: body.masters,
      draftsPerMaster: body.draftsPerMaster,
      draftCostPerClipMicros: Math.round(body.draftCostPerClipUsd * 1_000_000),
      finalCostPerClipMicros: Math.round(body.finalCostPerClipUsd * 1_000_000),
      guidedApprovalRate: body.guidedApprovalRate,
      blindApprovalRate: body.blindApprovalRate,
    })
    return {
      ...comparison,
      draftFirstUsd: formatUsd(comparison.draftFirstMicros, 2),
      premiumOnlyUsd: formatUsd(comparison.premiumOnlyMicros, 2),
      savingsUsd: formatUsd(comparison.savingsMicros, 2),
    }
  })
}

/**
 * The render job a dead letter refers to, if any.
 *
 * Queue payloads are JSON text rather than foreign keys, so this is the only
 * link back to an owner. Anything unparseable or without a jobId is treated as
 * unattributable, which callers must handle by withholding the row.
 */
function deadLetterJobId(row: Record<string, unknown>): string | null {
  const raw = row.payload
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw) as { jobId?: unknown }
    return typeof parsed.jobId === 'string' && parsed.jobId.length > 0 ? parsed.jobId : null
  } catch {
    return null
  }
}
