import { insertRow, toBool, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'

/**
 * Every asynchronous unit of audio work, whoever performs it.
 *
 * The named types are a closed set on purpose. A job type that is not in this
 * union cannot be queued, which is what stops the ledger from silently becoming
 * a free-form log nobody can query.
 */
export const STUDIO_JOB_TYPES = [
  'mix_analysis',
  'reference_analysis',
  'master_render',
  'rendition_analysis',
  'waveform_peaks',
  'playback_proxy',
  'stem_separation',
  'album_assessment',
] as const

export type StudioJobType = (typeof STUDIO_JOB_TYPES)[number]

/**
 * `unsupported` is separate from `failed` deliberately: the work could not be
 * performed by this deployment (no decoder, no configured provider), which is a
 * fact about the installation. `failed` is a fact about the attempt. They read
 * differently to a user and they bill differently.
 */
export type StudioJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'unsupported' | 'cancelled'

/**
 * Where a job stands against the customer's balance.
 *
 * `reserved` is the only state a running job may hold, and it converts to
 * `consumed` in exactly one place: a job that produced a usable result. Every
 * other terminal state releases it. See `ProcessingJobRepo.settle`.
 */
export type StudioCreditState = 'not_billable' | 'reserved' | 'consumed' | 'released'

export interface ProcessingJobRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string | null
  jobType: StudioJobType
  subjectType: string
  subjectId: string
  status: StudioJobStatus
  provider: string
  adapter: string
  providerJobId: string | null
  idempotencyKey: string
  attempt: number
  maxAttempts: number
  /** Null means the provider reported no cost — which is not the same as zero. */
  costMicros: number | null
  billable: boolean
  creditUnits: number
  creditState: StudioCreditState
  errorCode: string | null
  errorMessage: string | null
  request: Record<string, unknown>
  result: Record<string, unknown>
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ProcessingJobOutcome {
  status: Extract<StudioJobStatus, 'succeeded' | 'failed' | 'unsupported' | 'cancelled'>
  /** Whether the job produced something the customer can use. Only this bills. */
  usableResult: boolean
  errorCode?: string | null
  errorMessage?: string | null
  costMicros?: number | null
  providerJobId?: string | null
  /**
   * The adapter that actually performed the work, when it differs from the one
   * requested — a renderer that fell back to passthrough is not the renderer
   * that was asked for, and the ledger should say which one ran.
   */
  adapter?: string | null
  result?: Record<string, unknown>
}

export class ProcessingJobRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Claims a job for a unit of work, or returns the one already claimed.
   *
   * The idempotency key is the whole point. A redelivered queue message, a
   * double-clicked button and a retried HTTP request all arrive with the same
   * key and resolve to the same row — so the work happens once and is charged
   * for once, rather than the ledger recording two attempts at the same thing.
   *
   * A previous attempt that *failed* is reused rather than duplicated: the same
   * row is reset to queued with its attempt count carried forward, so the
   * history of how many times this work has been tried survives the retry.
   */
  async claim(input: {
    orgId: string
    studioProjectId: string
    studioVersionId?: string | null
    jobType: StudioJobType
    subjectType: string
    subjectId: string
    provider: string
    adapter: string
    idempotencyKey: string
    maxAttempts?: number
    billable?: boolean
    creditUnits?: number
    request?: Record<string, unknown>
    createdBy: string
  }): Promise<ProcessingJobRecord> {
    const existing = await this.findByKey(input.orgId, input.idempotencyKey)
    if (existing) {
      if (existing.status === 'failed' || existing.status === 'cancelled') {
        await this.db.run(
          'UPDATE studio_processing_jobs SET status = ?, error_code = NULL, error_message = NULL, credit_state = ?, queued_at = ?, started_at = NULL, finished_at = NULL, duration_ms = NULL, updated_at = ? WHERE id = ? AND org_id = ?',
          [
            'queued',
            existing.billable ? 'reserved' : 'not_billable',
            this.clock.isoNow(),
            this.clock.isoNow(),
            existing.id,
            input.orgId,
          ],
        )
        return this.get(input.orgId, existing.id)
      }
      return existing
    }

    const now = this.clock.isoNow()
    const billable = input.billable ?? false
    const record: ProcessingJobRecord = {
      id: newId('stjob', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      jobType: input.jobType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      status: 'queued',
      provider: input.provider,
      adapter: input.adapter,
      providerJobId: null,
      idempotencyKey: input.idempotencyKey,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      costMicros: null,
      billable,
      creditUnits: input.creditUnits ?? 0,
      creditState: billable ? 'reserved' : 'not_billable',
      errorCode: null,
      errorMessage: null,
      request: input.request ?? {},
      result: {},
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_processing_jobs', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      job_type: record.jobType,
      subject_type: record.subjectType,
      subject_id: record.subjectId,
      status: record.status,
      provider: record.provider,
      adapter: record.adapter,
      provider_job_id: null,
      idempotency_key: record.idempotencyKey,
      attempt: record.attempt,
      max_attempts: record.maxAttempts,
      cost_micros: null,
      billable: billable ? 1 : 0,
      credit_units: record.creditUnits,
      credit_state: record.creditState,
      error_code: null,
      error_message: null,
      request: toJson(record.request),
      result: toJson(record.result),
      queued_at: now,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<ProcessingJobRecord> {
    const row = await this.db.get('SELECT * FROM studio_processing_jobs WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('processing job', id)
    return mapJob(row)
  }

  async findByKey(orgId: string, idempotencyKey: string): Promise<ProcessingJobRecord | null> {
    const row = await this.db.get('SELECT * FROM studio_processing_jobs WHERE org_id = ? AND idempotency_key = ?', [orgId, idempotencyKey])
    return row ? mapJob(row) : null
  }

  async forSubject(orgId: string, subjectType: string, subjectId: string): Promise<ProcessingJobRecord | null> {
    const row = await this.db.get(
      'SELECT * FROM studio_processing_jobs WHERE org_id = ? AND subject_type = ? AND subject_id = ? ORDER BY created_at DESC',
      [orgId, subjectType, subjectId],
    )
    return row ? mapJob(row) : null
  }

  async list(orgId: string, projectId: string, limit = 50): Promise<ProcessingJobRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM studio_processing_jobs WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId, projectId],
    )
    return rows.map(mapJob)
  }

  /** Jobs that have not reached a terminal state, for an "is anything running" view. */
  async active(orgId: string, projectId: string): Promise<ProcessingJobRecord[]> {
    const rows = await this.db.query(
      "SELECT * FROM studio_processing_jobs WHERE org_id = ? AND studio_project_id = ? AND status IN ('queued', 'running') ORDER BY created_at ASC",
      [orgId, projectId],
    )
    return rows.map(mapJob)
  }

  /** Marks a job running and counts the attempt. */
  async start(orgId: string, id: string): Promise<ProcessingJobRecord> {
    const now = this.clock.isoNow()
    await this.db.run(
      'UPDATE studio_processing_jobs SET status = ?, attempt = attempt + 1, started_at = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND org_id = ?',
      ['running', now, now, id, orgId],
    )
    return this.get(orgId, id)
  }

  /**
   * Settles a job, and decides the credit with it.
   *
   * The billing rule lives here rather than in a caller, because a rule that
   * every caller has to remember is a rule that will eventually be forgotten in
   * one of them: **a reservation converts to `consumed` only when the job both
   * succeeded and produced a usable result.** Everything else — failure, an
   * unsupported deployment, cancellation, or a "success" that yielded a
   * placeholder — releases it.
   *
   * That last case is the one worth spelling out. The passthrough renderer
   * settles a rendition as `unsupported` and hands back the unprocessed source.
   * It is a completed job and a useless one, and charging for it would be
   * charging for the customer's own audio handed back to them.
   */
  async settle(orgId: string, id: string, outcome: ProcessingJobOutcome): Promise<ProcessingJobRecord> {
    const job = await this.get(orgId, id)
    const now = this.clock.isoNow()
    const consumed = outcome.status === 'succeeded' && outcome.usableResult
    const creditState: StudioCreditState = !job.billable ? 'not_billable' : consumed ? 'consumed' : 'released'
    const durationMs = job.startedAt ? Math.max(0, Date.parse(now) - Date.parse(job.startedAt)) : null

    await this.db.run(
      'UPDATE studio_processing_jobs SET status = ?, adapter = ?, provider_job_id = COALESCE(?, provider_job_id), cost_micros = ?, credit_state = ?, error_code = ?, error_message = ?, result = ?, finished_at = ?, duration_ms = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      [
        outcome.status,
        outcome.adapter ?? job.adapter,
        outcome.providerJobId ?? null,
        // A cost is only ever recorded when the provider reported one. An
        // unreported cost stays null; guessing it would put an invented number
        // into an accounting table.
        outcome.costMicros ?? job.costMicros,
        creditState,
        outcome.errorCode ?? null,
        outcome.errorMessage ?? null,
        toJson(outcome.result ?? job.result),
        now,
        durationMs,
        now,
        id,
        orgId,
      ],
    )
    return this.get(orgId, id)
  }

  /** Records the provider's own id for the work, for support and reconciliation. */
  async setProviderJobId(orgId: string, id: string, providerJobId: string): Promise<void> {
    await this.db.run('UPDATE studio_processing_jobs SET provider_job_id = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      providerJobId,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }
}

function mapJob(row: Row): ProcessingJobRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    studioVersionId: toStrOrNull(row.studio_version_id),
    jobType: toStr(row.job_type) as StudioJobType,
    subjectType: toStr(row.subject_type),
    subjectId: toStr(row.subject_id),
    status: toStr(row.status) as StudioJobStatus,
    provider: toStr(row.provider),
    adapter: toStr(row.adapter),
    providerJobId: toStrOrNull(row.provider_job_id),
    idempotencyKey: toStr(row.idempotency_key),
    attempt: toNum(row.attempt),
    maxAttempts: toNum(row.max_attempts),
    costMicros: toNumOrNull(row.cost_micros),
    billable: toBool(row.billable),
    creditUnits: toNum(row.credit_units),
    creditState: toStr(row.credit_state) as StudioCreditState,
    errorCode: toStrOrNull(row.error_code),
    errorMessage: toStrOrNull(row.error_message),
    request: parseJson<Record<string, unknown>>(row.request, {}),
    result: parseJson<Record<string, unknown>>(row.result, {}),
    queuedAt: toStr(row.queued_at),
    startedAt: toStrOrNull(row.started_at),
    finishedAt: toStrOrNull(row.finished_at),
    durationMs: toNumOrNull(row.duration_ms),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
