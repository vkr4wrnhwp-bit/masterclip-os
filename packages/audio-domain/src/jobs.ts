import { type Db, insertRow, parseJsonColumn, toNum, toStr, toStrOrNull } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'

export type AudioJobStatus = 'queued' | 'running' | 'awaiting_provider' | 'complete' | 'failed' | 'cancelled'

export interface AudioJobRecord {
  id: string
  orgId: string
  userId: string
  featureKey: string
  provider: string
  operation: string
  providerJobId: string | null
  status: AudioJobStatus
  inputAssetIds: string[]
  outputAssetIds: string[]
  configuration: Record<string, unknown>
  estimatedCostMicros: number
  finalCostMicros: number
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export class AudioJobRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    userId: string
    featureKey: string
    provider: string
    operation: string
    inputAssetIds?: string[]
    configuration?: Record<string, unknown>
    estimatedCostMicros?: number
  }): Promise<AudioJobRecord> {
    const record: AudioJobRecord = {
      id: newId('ajob', this.clock.now()),
      orgId: input.orgId,
      userId: input.userId,
      featureKey: input.featureKey,
      provider: input.provider,
      operation: input.operation,
      providerJobId: null,
      status: 'queued',
      inputAssetIds: input.inputAssetIds ?? [],
      outputAssetIds: [],
      configuration: input.configuration ?? {},
      estimatedCostMicros: input.estimatedCostMicros ?? 0,
      finalCostMicros: 0,
      errorCode: null,
      errorMessage: null,
      createdAt: this.clock.isoNow(),
      startedAt: null,
      completedAt: null,
    }
    await insertRow(this.db, 'audio_jobs', {
      id: record.id,
      org_id: record.orgId,
      user_id: record.userId,
      feature_key: record.featureKey,
      provider: record.provider,
      operation: record.operation,
      provider_job_id: null,
      status: record.status,
      input_asset_ids: JSON.stringify(record.inputAssetIds),
      output_asset_ids: '[]',
      configuration: JSON.stringify(record.configuration),
      estimated_cost_micros: record.estimatedCostMicros,
      final_cost_micros: 0,
      error_code: null,
      error_message: null,
      created_at: record.createdAt,
      started_at: null,
      completed_at: null,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<AudioJobRecord> {
    const row = await this.db.get('SELECT * FROM audio_jobs WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('audio job', id)
    return mapJob(row)
  }

  /** Worker-side lookup that carries the org with it rather than trusting a caller. */
  async getAnyOrg(id: string): Promise<AudioJobRecord> {
    const row = await this.db.get('SELECT * FROM audio_jobs WHERE id = ?', [id])
    if (!row) throw notFound('audio job', id)
    return mapJob(row)
  }

  async list(orgId: string, filter: { status?: AudioJobStatus; operation?: string } = {}, limit = 100): Promise<AudioJobRecord[]> {
    const clauses = ['org_id = ?']
    const params: string[] = [orgId]
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.operation) {
      clauses.push('operation = ?')
      params.push(filter.operation)
    }
    const rows = await this.db.query(
      `SELECT * FROM audio_jobs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      params,
    )
    return rows.map(mapJob)
  }

  async markRunning(id: string): Promise<void> {
    await this.db.run(`UPDATE audio_jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`, [
      this.clock.isoNow(),
      id,
    ])
  }

  async markAwaitingProvider(id: string, providerJobId: string | null): Promise<void> {
    await this.db.run(`UPDATE audio_jobs SET status = 'awaiting_provider', provider_job_id = ? WHERE id = ?`, [providerJobId, id])
  }

  async markComplete(id: string, outputAssetIds: string[], finalCostMicros: number): Promise<void> {
    await this.db.run(
      `UPDATE audio_jobs SET status = 'complete', output_asset_ids = ?, final_cost_micros = ?, completed_at = ? WHERE id = ?`,
      [JSON.stringify(outputAssetIds), finalCostMicros, this.clock.isoNow(), id],
    )
  }

  async markFailed(id: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.db.run(`UPDATE audio_jobs SET status = 'failed', error_code = ?, error_message = ?, completed_at = ? WHERE id = ?`, [
      errorCode,
      errorMessage.slice(0, 2000),
      this.clock.isoNow(),
      id,
    ])
  }

  async cancel(orgId: string, id: string): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE audio_jobs SET status = 'cancelled', completed_at = ? WHERE id = ? AND org_id = ? AND status IN ('queued','running','awaiting_provider')`,
      [this.clock.isoNow(), id, orgId],
    )
    return result.changes > 0
  }
}

function mapJob(row: Record<string, unknown>): AudioJobRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    userId: toStr(row.user_id),
    featureKey: toStr(row.feature_key),
    provider: toStr(row.provider),
    operation: toStr(row.operation),
    providerJobId: toStrOrNull(row.provider_job_id),
    status: toStr(row.status) as AudioJobStatus,
    inputAssetIds: parseJsonColumn(row.input_asset_ids, []),
    outputAssetIds: parseJsonColumn(row.output_asset_ids, []),
    configuration: parseJsonColumn(row.configuration, {}),
    estimatedCostMicros: toNum(row.estimated_cost_micros),
    finalCostMicros: toNum(row.final_cost_micros),
    errorCode: toStrOrNull(row.error_code),
    errorMessage: toStrOrNull(row.error_message),
    createdAt: toStr(row.created_at),
    startedAt: toStrOrNull(row.started_at),
    completedAt: toStrOrNull(row.completed_at),
  }
}
