import { type Db, insertRow, parseJsonColumn, toBool, toNum, toNumOrNull, toStr, toStrOrNull, updateRow } from '@masterclip/database'
import { conflict, hashObject, newId, notFound, systemClock, type Clock, type MicroUsd } from '@masterclip/shared'
import type { RejectionReason } from '@masterclip/shot-schema'
import type { Master, MasterDeliverable, RenderBatch, RenderJob, RenderJobStatus, RenderOutput, Review, ReviewDecision } from './types.js'

export interface CreateJobInput {
  batchId?: string | null
  projectId: string
  sceneId?: string | null
  shotId: string
  shotVersionId: string
  providerId: string
  modelId: string
  routingProfile: string
  compiledPrompt: string
  request: Record<string, unknown>
  estimatedMicros: MicroUsd
  quoteId?: string | null
  seed?: string | null
  sandbox: boolean
  priority?: number
  createdBy: string
}

export class RenderRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  // --- batches --------------------------------------------------------------

  async createBatch(input: {
    projectId: string
    name: string
    matrix: Record<string, unknown>
    estimatedMicros: MicroUsd
    candidateCount: number
    stopLossMicros?: MicroUsd | null
    createdBy: string
  }): Promise<RenderBatch> {
    const batch: RenderBatch = {
      id: newId('batch', this.clock.now()),
      projectId: input.projectId,
      name: input.name,
      status: 'planned',
      matrix: input.matrix,
      estimatedMicros: input.estimatedMicros,
      actualMicros: 0,
      stopLossMicros: input.stopLossMicros ?? null,
      candidateCount: input.candidateCount,
      createdBy: input.createdBy,
      createdAt: this.clock.isoNow(),
      cancelledAt: null,
      completedAt: null,
    }
    await insertRow(this.db, 'render_batches', {
      id: batch.id,
      project_id: batch.projectId,
      name: batch.name,
      status: batch.status,
      matrix: JSON.stringify(batch.matrix),
      estimated_micros: batch.estimatedMicros,
      actual_micros: 0,
      stop_loss_micros: batch.stopLossMicros,
      candidate_count: batch.candidateCount,
      created_by: batch.createdBy,
      created_at: batch.createdAt,
      cancelled_at: null,
      completed_at: null,
    })
    return batch
  }

  async getBatch(id: string): Promise<RenderBatch> {
    const row = await this.db.get('SELECT * FROM render_batches WHERE id = ?', [id])
    if (!row) throw notFound('batch', id)
    return mapBatch(row)
  }

  async listBatches(projectId: string, limit = 50): Promise<RenderBatch[]> {
    const rows = await this.db.query(`SELECT * FROM render_batches WHERE project_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`, [
      projectId,
    ])
    return rows.map(mapBatch)
  }

  async setBatchStatus(id: string, status: RenderBatch['status']): Promise<void> {
    await updateRow(this.db, 'render_batches', id, {
      status,
      ...(status === 'cancelled' ? { cancelled_at: this.clock.isoNow() } : {}),
      ...(status === 'completed' ? { completed_at: this.clock.isoNow() } : {}),
    })
  }

  async batchSpend(batchId: string): Promise<MicroUsd> {
    const row = await this.db.get<{ total: number | null }>('SELECT SUM(actual_micros) AS total FROM render_jobs WHERE batch_id = ?', [batchId])
    return toNum(row?.total, 0)
  }

  // --- jobs -----------------------------------------------------------------

  /**
   * Creates a render job with an idempotency key derived from the request.
   *
   * A duplicate submission — a retried HTTP call, a double-clicked button, a
   * replayed queue message — returns the existing job instead of paying for a
   * second identical generation.
   */
  async createJob(input: CreateJobInput): Promise<{ job: RenderJob; created: boolean }> {
    const requestHash = hashObject(input.request)
    const idempotencyKey = hashObject({
      shotVersionId: input.shotVersionId,
      providerId: input.providerId,
      modelId: input.modelId,
      requestHash,
      seed: input.seed ?? null,
      batchId: input.batchId ?? null,
    })

    const existing = await this.db.get('SELECT * FROM render_jobs WHERE idempotency_key = ?', [idempotencyKey])
    if (existing) return { job: mapJob(existing), created: false }

    const now = this.clock.isoNow()
    const job: RenderJob = {
      id: newId('job', this.clock.now()),
      batchId: input.batchId ?? null,
      projectId: input.projectId,
      sceneId: input.sceneId ?? null,
      shotId: input.shotId,
      shotVersionId: input.shotVersionId,
      providerId: input.providerId,
      modelId: input.modelId,
      routingProfile: input.routingProfile,
      compiledPrompt: input.compiledPrompt,
      request: input.request,
      requestHash,
      idempotencyKey,
      status: 'queued',
      externalJobId: null,
      quoteId: input.quoteId ?? null,
      estimatedMicros: input.estimatedMicros,
      actualMicros: 0,
      attempts: 0,
      seed: input.seed ?? null,
      sandbox: input.sandbox,
      priority: input.priority ?? 0,
      error: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
    }

    try {
      await insertRow(this.db, 'render_jobs', {
        id: job.id,
        batch_id: job.batchId,
        project_id: job.projectId,
        scene_id: job.sceneId,
        shot_id: job.shotId,
        shot_version_id: job.shotVersionId,
        provider_id: job.providerId,
        model_id: job.modelId,
        routing_profile: job.routingProfile,
        compiled_prompt: job.compiledPrompt,
        request: JSON.stringify(job.request),
        request_hash: job.requestHash,
        idempotency_key: job.idempotencyKey,
        status: job.status,
        external_job_id: null,
        quote_id: job.quoteId,
        estimated_micros: job.estimatedMicros,
        actual_micros: 0,
        attempts: 0,
        seed: job.seed,
        sandbox: job.sandbox ? 1 : 0,
        priority: job.priority,
        error: null,
        created_by: job.createdBy,
        created_at: now,
        updated_at: now,
        submitted_at: null,
        completed_at: null,
        failed_at: null,
        cancelled_at: null,
      })
    } catch (err) {
      // Lost a race on the unique idempotency index.
      const raced = await this.db.get('SELECT * FROM render_jobs WHERE idempotency_key = ?', [idempotencyKey])
      if (raced) return { job: mapJob(raced), created: false }
      throw err
    }
    return { job, created: true }
  }

  async getJob(id: string): Promise<RenderJob> {
    const row = await this.db.get('SELECT * FROM render_jobs WHERE id = ?', [id])
    if (!row) throw notFound('render job', id)
    return mapJob(row)
  }

  async findJobByExternalId(providerId: string, externalJobId: string): Promise<RenderJob | null> {
    const row = await this.db.get('SELECT * FROM render_jobs WHERE provider_id = ? AND external_job_id = ?', [providerId, externalJobId])
    return row ? mapJob(row) : null
  }

  async listJobs(filter: { projectId?: string; batchId?: string; shotId?: string; statuses?: RenderJobStatus[]; limit?: number }): Promise<RenderJob[]> {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.projectId) {
      clauses.push('project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.batchId) {
      clauses.push('batch_id = ?')
      params.push(filter.batchId)
    }
    if (filter.shotId) {
      clauses.push('shot_id = ?')
      params.push(filter.shotId)
    }
    if (filter.statuses?.length) {
      clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
      params.push(...filter.statuses)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await this.db.query(
      `SELECT * FROM render_jobs ${where} ORDER BY created_at DESC LIMIT ${Math.floor(filter.limit ?? 200)}`,
      params,
    )
    return rows.map(mapJob)
  }

  async updateJob(
    id: string,
    patch: Partial<{
      status: RenderJobStatus
      externalJobId: string | null
      actualMicros: MicroUsd
      estimatedMicros: MicroUsd
      quoteId: string | null
      attempts: number
      error: Record<string, unknown> | null
      submittedAt: string | null
      completedAt: string | null
      failedAt: string | null
      cancelledAt: string | null
    }>,
  ): Promise<void> {
    const values: Record<string, string | number | null> = { updated_at: this.clock.isoNow() }
    if (patch.status !== undefined) values.status = patch.status
    if (patch.externalJobId !== undefined) values.external_job_id = patch.externalJobId
    if (patch.actualMicros !== undefined) values.actual_micros = Math.round(patch.actualMicros)
    if (patch.estimatedMicros !== undefined) values.estimated_micros = Math.round(patch.estimatedMicros)
    if (patch.quoteId !== undefined) values.quote_id = patch.quoteId
    if (patch.attempts !== undefined) values.attempts = patch.attempts
    if (patch.error !== undefined) values.error = patch.error === null ? null : JSON.stringify(patch.error)
    if (patch.submittedAt !== undefined) values.submitted_at = patch.submittedAt
    if (patch.completedAt !== undefined) values.completed_at = patch.completedAt
    if (patch.failedAt !== undefined) values.failed_at = patch.failedAt
    if (patch.cancelledAt !== undefined) values.cancelled_at = patch.cancelledAt
    await updateRow(this.db, 'render_jobs', id, values)
  }

  async recordAttempt(input: {
    jobId: string
    attempt: number
    providerId: string
    modelId: string
    status: string
    externalJobId?: string | null
    estimatedMicros: MicroUsd
    actualMicros?: MicroUsd
    billable: boolean
    latencyMs?: number | null
    error?: Record<string, unknown> | null
  }): Promise<string> {
    const id = newId('att', this.clock.now())
    await insertRow(this.db, 'render_attempts', {
      id,
      job_id: input.jobId,
      attempt: input.attempt,
      provider_id: input.providerId,
      model_id: input.modelId,
      status: input.status,
      external_job_id: input.externalJobId ?? null,
      estimated_micros: Math.round(input.estimatedMicros),
      actual_micros: Math.round(input.actualMicros ?? 0),
      billable: input.billable ? 1 : 0,
      latency_ms: input.latencyMs ?? null,
      error: input.error ? JSON.stringify(input.error) : null,
      started_at: this.clock.isoNow(),
      ended_at: null,
    })
    return id
  }

  async completeAttempt(attemptId: string, patch: { status: string; actualMicros?: MicroUsd; latencyMs?: number; error?: Record<string, unknown> | null }): Promise<void> {
    await updateRow(this.db, 'render_attempts', attemptId, {
      status: patch.status,
      ...(patch.actualMicros !== undefined ? { actual_micros: Math.round(patch.actualMicros) } : {}),
      ...(patch.latencyMs !== undefined ? { latency_ms: patch.latencyMs } : {}),
      ...(patch.error !== undefined ? { error: patch.error ? JSON.stringify(patch.error) : null } : {}),
      ended_at: this.clock.isoNow(),
    })
  }

  // --- outputs --------------------------------------------------------------

  async createOutput(input: Omit<RenderOutput, 'id' | 'createdAt'>): Promise<RenderOutput> {
    const output: RenderOutput = { ...input, id: newId('out', this.clock.now()), createdAt: this.clock.isoNow() }
    await insertRow(this.db, 'outputs', {
      id: output.id,
      job_id: output.jobId,
      attempt_id: output.attemptId,
      project_id: output.projectId,
      shot_id: output.shotId,
      asset_id: output.assetId,
      proxy_asset_id: output.proxyAssetId,
      thumbnail_asset_id: output.thumbnailAssetId,
      contact_sheet_asset_id: output.contactSheetAssetId,
      output_index: output.outputIndex,
      provider_id: output.providerId,
      model_id: output.modelId,
      duration_seconds: output.durationSeconds,
      width: output.width,
      height: output.height,
      fps: output.fps,
      has_audio: output.hasAudio ? 1 : 0,
      sha256: output.sha256,
      status: output.status,
      metadata: JSON.stringify(output.metadata),
      created_at: output.createdAt,
    })
    return output
  }

  async getOutput(id: string): Promise<RenderOutput> {
    const row = await this.db.get('SELECT * FROM outputs WHERE id = ?', [id])
    if (!row) throw notFound('output', id)
    return mapOutput(row)
  }

  async listOutputs(filter: { projectId?: string; shotId?: string; jobId?: string; batchId?: string; limit?: number }): Promise<RenderOutput[]> {
    if (filter.batchId) {
      const rows = await this.db.query(
        `SELECT o.* FROM outputs o JOIN render_jobs j ON j.id = o.job_id WHERE j.batch_id = ? ORDER BY o.created_at DESC LIMIT ${Math.floor(
          filter.limit ?? 200,
        )}`,
        [filter.batchId],
      )
      return rows.map(mapOutput)
    }
    const clauses: string[] = []
    const params: string[] = []
    if (filter.projectId) {
      clauses.push('project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.shotId) {
      clauses.push('shot_id = ?')
      params.push(filter.shotId)
    }
    if (filter.jobId) {
      clauses.push('job_id = ?')
      params.push(filter.jobId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await this.db.query(`SELECT * FROM outputs ${where} ORDER BY created_at DESC LIMIT ${Math.floor(filter.limit ?? 200)}`, params)
    return rows.map(mapOutput)
  }

  async updateOutput(id: string, patch: Partial<Pick<RenderOutput, 'status' | 'proxyAssetId' | 'thumbnailAssetId' | 'contactSheetAssetId' | 'metadata'>>): Promise<void> {
    const values: Record<string, string | null> = {}
    if (patch.status !== undefined) values.status = patch.status
    if (patch.proxyAssetId !== undefined) values.proxy_asset_id = patch.proxyAssetId
    if (patch.thumbnailAssetId !== undefined) values.thumbnail_asset_id = patch.thumbnailAssetId
    if (patch.contactSheetAssetId !== undefined) values.contact_sheet_asset_id = patch.contactSheetAssetId
    if (patch.metadata !== undefined) values.metadata = JSON.stringify(patch.metadata)
    if (Object.keys(values).length > 0) await updateRow(this.db, 'outputs', id, values)
  }

  /** Sibling hashes for duplicate detection inside a batch. */
  async siblingHashes(jobId: string): Promise<string[]> {
    const rows = await this.db.query<{ sha256: string }>(
      `SELECT o.sha256 FROM outputs o JOIN render_jobs j ON j.id = o.job_id
        WHERE j.batch_id = (SELECT batch_id FROM render_jobs WHERE id = ?) AND o.job_id <> ?`,
      [jobId, jobId],
    )
    return rows.map((r) => toStr(r.sha256))
  }

  // --- qc, reviews, masters -------------------------------------------------

  async saveQc(input: {
    outputId: string
    layer: 'technical' | 'visual' | 'combined'
    engine: string
    technicalPass: boolean
    creativeScore?: number | null
    identityScore?: number | null
    continuityScore?: number | null
    motionScore?: number | null
    realismScore?: number | null
    recommendedAction: string
    confidence: number
    hardFailures: string[]
    warnings: string[]
    raw: unknown
    costMicros: MicroUsd
  }): Promise<string> {
    const id = newId('qc', this.clock.now())
    await insertRow(this.db, 'output_qc', {
      id,
      output_id: input.outputId,
      layer: input.layer,
      engine: input.engine,
      technical_pass: input.technicalPass ? 1 : 0,
      creative_score: input.creativeScore ?? null,
      identity_score: input.identityScore ?? null,
      continuity_score: input.continuityScore ?? null,
      motion_score: input.motionScore ?? null,
      realism_score: input.realismScore ?? null,
      recommended_action: input.recommendedAction,
      confidence: input.confidence,
      hard_failures: JSON.stringify(input.hardFailures),
      warnings: JSON.stringify(input.warnings),
      raw: JSON.stringify(input.raw ?? null),
      cost_micros: Math.round(input.costMicros),
      created_at: this.clock.isoNow(),
    })
    return id
  }

  async qcFor(outputId: string): Promise<Array<Record<string, unknown>>> {
    return this.db.query('SELECT * FROM output_qc WHERE output_id = ? ORDER BY created_at DESC', [outputId])
  }

  async addReview(input: {
    outputId: string
    projectId: string
    shotId: string
    userId: string
    decision: ReviewDecision
    rankOrder?: number | null
    rejectionReasons?: RejectionReason[]
    note?: string
  }): Promise<Review> {
    const review: Review = {
      id: newId('rev', this.clock.now()),
      outputId: input.outputId,
      projectId: input.projectId,
      shotId: input.shotId,
      userId: input.userId,
      decision: input.decision,
      rankOrder: input.rankOrder ?? null,
      rejectionReasons: input.rejectionReasons ?? [],
      note: input.note ?? '',
      createdAt: this.clock.isoNow(),
    }
    await this.db.transaction(async (tx) => {
      await insertRow(tx, 'reviews', {
        id: review.id,
        output_id: review.outputId,
        project_id: review.projectId,
        shot_id: review.shotId,
        user_id: review.userId,
        decision: review.decision,
        rank_order: review.rankOrder,
        rejection_reasons: JSON.stringify(review.rejectionReasons),
        note: review.note,
        created_at: review.createdAt,
      })
      const status =
        review.decision === 'approve' ? 'approved' : review.decision === 'reject' ? 'rejected' : review.decision === 'promote' ? 'promoted' : null
      if (status) await updateRow(tx, 'outputs', review.outputId, { status })
    })
    return review
  }

  async reviewsFor(outputId: string): Promise<Review[]> {
    const rows = await this.db.query('SELECT * FROM reviews WHERE output_id = ? ORDER BY created_at DESC', [outputId])
    return rows.map(mapReview)
  }

  async latestReview(outputId: string): Promise<Review | null> {
    const row = await this.db.get('SELECT * FROM reviews WHERE output_id = ? ORDER BY created_at DESC LIMIT 1', [outputId])
    return row ? mapReview(row) : null
  }

  async promoteToMaster(input: {
    projectId: string
    sceneId?: string | null
    shotId: string
    outputId: string
    name: string
    sourceAssetId: string
    approvedBy: string
    metadata?: Record<string, unknown>
  }): Promise<Master> {
    const existing = await this.db.get('SELECT id FROM masters WHERE output_id = ?', [input.outputId])
    if (existing) throw conflict('this output has already been promoted to a master')

    const master: Master = {
      id: newId('mast', this.clock.now()),
      projectId: input.projectId,
      sceneId: input.sceneId ?? null,
      shotId: input.shotId,
      outputId: input.outputId,
      name: input.name,
      status: 'approved',
      sourceAssetId: input.sourceAssetId,
      masterAssetId: null,
      approvedBy: input.approvedBy,
      approvedAt: this.clock.isoNow(),
      metadata: input.metadata ?? {},
      createdAt: this.clock.isoNow(),
    }
    await this.db.transaction(async (tx) => {
      await insertRow(tx, 'masters', {
        id: master.id,
        project_id: master.projectId,
        scene_id: master.sceneId,
        shot_id: master.shotId,
        output_id: master.outputId,
        name: master.name,
        status: master.status,
        source_asset_id: master.sourceAssetId,
        master_asset_id: null,
        approved_by: master.approvedBy,
        approved_at: master.approvedAt,
        metadata: JSON.stringify(master.metadata),
        created_at: master.createdAt,
      })
      await updateRow(tx, 'outputs', input.outputId, { status: 'promoted' })
    })
    return master
  }

  async getMaster(id: string): Promise<Master> {
    const row = await this.db.get('SELECT * FROM masters WHERE id = ?', [id])
    if (!row) throw notFound('master', id)
    return mapMaster(row)
  }

  async listMasters(projectId: string): Promise<Master[]> {
    const rows = await this.db.query('SELECT * FROM masters WHERE project_id = ? ORDER BY created_at DESC', [projectId])
    return rows.map(mapMaster)
  }

  async setMasterAsset(masterId: string, assetId: string, status: Master['status'] = 'finished'): Promise<void> {
    await updateRow(this.db, 'masters', masterId, { master_asset_id: assetId, status })
  }

  async addDeliverable(input: { masterId: string; format: string; assetId: string; spec: Record<string, unknown> }): Promise<MasterDeliverable> {
    const deliverable: MasterDeliverable = {
      id: newId('del', this.clock.now()),
      masterId: input.masterId,
      format: input.format,
      assetId: input.assetId,
      spec: input.spec,
      createdAt: this.clock.isoNow(),
    }
    await insertRow(this.db, 'master_deliverables', {
      id: deliverable.id,
      master_id: deliverable.masterId,
      format: deliverable.format,
      asset_id: deliverable.assetId,
      spec: JSON.stringify(deliverable.spec),
      created_at: deliverable.createdAt,
    })
    return deliverable
  }

  async listDeliverables(masterId: string): Promise<MasterDeliverable[]> {
    const rows = await this.db.query('SELECT * FROM master_deliverables WHERE master_id = ? ORDER BY created_at ASC', [masterId])
    return rows.map((row) => ({
      id: toStr(row.id),
      masterId: toStr(row.master_id),
      format: toStr(row.format),
      assetId: toStr(row.asset_id),
      spec: parseJsonColumn(row.spec, {}),
      createdAt: toStr(row.created_at),
    }))
  }
}

function mapBatch(row: Record<string, unknown>): RenderBatch {
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    name: toStr(row.name),
    status: toStr(row.status) as RenderBatch['status'],
    matrix: parseJsonColumn(row.matrix, {}),
    estimatedMicros: toNum(row.estimated_micros),
    actualMicros: toNum(row.actual_micros),
    stopLossMicros: toNumOrNull(row.stop_loss_micros),
    candidateCount: toNum(row.candidate_count),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    cancelledAt: toStrOrNull(row.cancelled_at),
    completedAt: toStrOrNull(row.completed_at),
  }
}

function mapJob(row: Record<string, unknown>): RenderJob {
  return {
    id: toStr(row.id),
    batchId: toStrOrNull(row.batch_id),
    projectId: toStr(row.project_id),
    sceneId: toStrOrNull(row.scene_id),
    shotId: toStr(row.shot_id),
    shotVersionId: toStr(row.shot_version_id),
    providerId: toStr(row.provider_id),
    modelId: toStr(row.model_id),
    routingProfile: toStr(row.routing_profile),
    compiledPrompt: toStr(row.compiled_prompt),
    request: parseJsonColumn(row.request, {}),
    requestHash: toStr(row.request_hash),
    idempotencyKey: toStr(row.idempotency_key),
    status: toStr(row.status) as RenderJobStatus,
    externalJobId: toStrOrNull(row.external_job_id),
    quoteId: toStrOrNull(row.quote_id),
    estimatedMicros: toNum(row.estimated_micros),
    actualMicros: toNum(row.actual_micros),
    attempts: toNum(row.attempts),
    seed: toStrOrNull(row.seed),
    sandbox: toBool(row.sandbox),
    priority: toNum(row.priority),
    error: row.error ? parseJsonColumn(row.error, null) : null,
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
    submittedAt: toStrOrNull(row.submitted_at),
    completedAt: toStrOrNull(row.completed_at),
    failedAt: toStrOrNull(row.failed_at),
    cancelledAt: toStrOrNull(row.cancelled_at),
  }
}

function mapOutput(row: Record<string, unknown>): RenderOutput {
  return {
    id: toStr(row.id),
    jobId: toStr(row.job_id),
    attemptId: toStrOrNull(row.attempt_id),
    projectId: toStr(row.project_id),
    shotId: toStr(row.shot_id),
    assetId: toStr(row.asset_id),
    proxyAssetId: toStrOrNull(row.proxy_asset_id),
    thumbnailAssetId: toStrOrNull(row.thumbnail_asset_id),
    contactSheetAssetId: toStrOrNull(row.contact_sheet_asset_id),
    outputIndex: toNum(row.output_index),
    providerId: toStr(row.provider_id),
    modelId: toStr(row.model_id),
    durationSeconds: toNumOrNull(row.duration_seconds),
    width: toNumOrNull(row.width),
    height: toNumOrNull(row.height),
    fps: toNumOrNull(row.fps),
    hasAudio: toBool(row.has_audio),
    sha256: toStr(row.sha256),
    status: toStr(row.status) as RenderOutput['status'],
    metadata: parseJsonColumn(row.metadata, {}),
    createdAt: toStr(row.created_at),
  }
}

function mapReview(row: Record<string, unknown>): Review {
  return {
    id: toStr(row.id),
    outputId: toStr(row.output_id),
    projectId: toStr(row.project_id),
    shotId: toStr(row.shot_id),
    userId: toStr(row.user_id),
    decision: toStr(row.decision) as ReviewDecision,
    rankOrder: toNumOrNull(row.rank_order),
    rejectionReasons: parseJsonColumn(row.rejection_reasons, [] as RejectionReason[]),
    note: toStr(row.note),
    createdAt: toStr(row.created_at),
  }
}

function mapMaster(row: Record<string, unknown>): Master {
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    sceneId: toStrOrNull(row.scene_id),
    shotId: toStr(row.shot_id),
    outputId: toStr(row.output_id),
    name: toStr(row.name),
    status: toStr(row.status) as Master['status'],
    sourceAssetId: toStr(row.source_asset_id),
    masterAssetId: toStrOrNull(row.master_asset_id),
    approvedBy: toStr(row.approved_by),
    approvedAt: toStr(row.approved_at),
    metadata: parseJsonColumn(row.metadata, {}),
    createdAt: toStr(row.created_at),
  }
}
