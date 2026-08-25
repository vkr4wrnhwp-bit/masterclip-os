import { type Db, insertRow, parseJsonColumn, toBool, toNum, toStr, toStrOrNull } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'

export const BRIEF_TYPES = [
  'daily_scout',
  'weekly_executive',
  'artist_opportunity',
  'release_reaction',
  'rights_health',
  'distribution_change',
  'city_ignition',
  'deal_pipeline',
  'follow_up',
] as const

export type BriefType = (typeof BRIEF_TYPES)[number]

export interface BriefItem {
  statement: string
  confidence: 'confirmed' | 'likely' | 'needs_verification'
}

export interface SignalBriefRecord {
  id: string
  orgId: string
  briefType: string
  title: string
  script: string
  items: BriefItem[]
  status: 'draft' | 'rendering' | 'ready' | 'failed'
  audioAssetId: string | null
  voiceRef: string
  engine: string
  errorMessage: string | null
  requestedBy: string
  createdAt: string
  renderedAt: string | null
}

export interface BriefScheduleRecord {
  id: string
  orgId: string
  briefType: string
  cadence: 'daily' | 'weekdays' | 'weekly' | 'on_demand'
  hourUtc: number
  timezone: string
  subscriberUserId: string
  enabled: boolean
  lastRunAt: string | null
  createdAt: string
}

export class BriefRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    briefType: string
    title: string
    script: string
    items: BriefItem[]
    voiceRef: string
    engine: string
    requestedBy: string
  }): Promise<SignalBriefRecord> {
    const record: SignalBriefRecord = {
      id: newId('brf', this.clock.now()),
      orgId: input.orgId,
      briefType: input.briefType,
      title: input.title,
      script: input.script,
      items: input.items,
      status: 'draft',
      audioAssetId: null,
      voiceRef: input.voiceRef,
      engine: input.engine,
      errorMessage: null,
      requestedBy: input.requestedBy,
      createdAt: this.clock.isoNow(),
      renderedAt: null,
    }
    await insertRow(this.db, 'signal_briefs', {
      id: record.id,
      org_id: record.orgId,
      brief_type: record.briefType,
      title: record.title,
      script: record.script,
      items: JSON.stringify(record.items),
      status: record.status,
      audio_asset_id: null,
      voice_ref: record.voiceRef,
      engine: record.engine,
      error_message: null,
      requested_by: record.requestedBy,
      created_at: record.createdAt,
      rendered_at: null,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<SignalBriefRecord> {
    const row = await this.db.get('SELECT * FROM signal_briefs WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('signal brief', id)
    return mapBrief(row)
  }

  async getAnyOrg(id: string): Promise<SignalBriefRecord> {
    const row = await this.db.get('SELECT * FROM signal_briefs WHERE id = ?', [id])
    if (!row) throw notFound('signal brief', id)
    return mapBrief(row)
  }

  async list(orgId: string, limit = 50): Promise<SignalBriefRecord[]> {
    const rows = await this.db.query(`SELECT * FROM signal_briefs WHERE org_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`, [
      orgId,
    ])
    return rows.map(mapBrief)
  }

  async updateScript(orgId: string, id: string, script: string): Promise<void> {
    const result = await this.db.run(`UPDATE signal_briefs SET script = ?, status = 'draft' WHERE id = ? AND org_id = ? AND status IN ('draft','failed','ready')`, [
      script,
      id,
      orgId,
    ])
    if (result.changes === 0) throw notFound('signal brief', id)
  }

  async markRendering(id: string): Promise<void> {
    await this.db.run(`UPDATE signal_briefs SET status = 'rendering' WHERE id = ?`, [id])
  }

  async markReady(id: string, audioAssetId: string): Promise<void> {
    await this.db.run(`UPDATE signal_briefs SET status = 'ready', audio_asset_id = ?, rendered_at = ? WHERE id = ?`, [
      audioAssetId,
      this.clock.isoNow(),
      id,
    ])
  }

  async markFailed(id: string, message: string): Promise<void> {
    await this.db.run(`UPDATE signal_briefs SET status = 'failed', error_message = ? WHERE id = ?`, [message.slice(0, 1000), id])
  }

  async createSchedule(input: Omit<BriefScheduleRecord, 'id' | 'createdAt' | 'lastRunAt'>): Promise<BriefScheduleRecord> {
    const record: BriefScheduleRecord = { ...input, id: newId('bsch', this.clock.now()), lastRunAt: null, createdAt: this.clock.isoNow() }
    await insertRow(this.db, 'signal_brief_schedules', {
      id: record.id,
      org_id: record.orgId,
      brief_type: record.briefType,
      cadence: record.cadence,
      hour_utc: record.hourUtc,
      timezone: record.timezone,
      subscriber_user_id: record.subscriberUserId,
      enabled: record.enabled ? 1 : 0,
      last_run_at: null,
      created_at: record.createdAt,
    })
    return record
  }

  async listSchedules(orgId: string): Promise<BriefScheduleRecord[]> {
    const rows = await this.db.query('SELECT * FROM signal_brief_schedules WHERE org_id = ? ORDER BY created_at DESC', [orgId])
    return rows.map(mapSchedule)
  }

  /** Schedules due at this UTC hour that have not run in the last 20 hours. */
  async listDue(nowMs: number): Promise<BriefScheduleRecord[]> {
    const now = new Date(nowMs)
    const hour = now.getUTCHours()
    const day = now.getUTCDay()
    const cutoff = new Date(nowMs - 20 * 3600 * 1000).toISOString()
    const rows = await this.db.query(
      `SELECT * FROM signal_brief_schedules
        WHERE enabled = 1 AND hour_utc = ? AND (last_run_at IS NULL OR last_run_at < ?)`,
      [hour, cutoff],
    )
    return rows.map(mapSchedule).filter((schedule) => {
      if (schedule.cadence === 'on_demand') return false
      if (schedule.cadence === 'weekdays' && (day === 0 || day === 6)) return false
      if (schedule.cadence === 'weekly' && day !== 1) return false
      return true
    })
  }

  async markScheduleRun(id: string): Promise<void> {
    await this.db.run('UPDATE signal_brief_schedules SET last_run_at = ? WHERE id = ?', [this.clock.isoNow(), id])
  }

  async setScheduleEnabled(orgId: string, id: string, enabled: boolean): Promise<void> {
    const result = await this.db.run('UPDATE signal_brief_schedules SET enabled = ? WHERE id = ? AND org_id = ?', [
      enabled ? 1 : 0,
      id,
      orgId,
    ])
    if (result.changes === 0) throw notFound('brief schedule', id)
  }
}

function mapBrief(row: Record<string, unknown>): SignalBriefRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    briefType: toStr(row.brief_type),
    title: toStr(row.title),
    script: toStr(row.script),
    items: parseJsonColumn(row.items, []),
    status: toStr(row.status) as SignalBriefRecord['status'],
    audioAssetId: toStrOrNull(row.audio_asset_id),
    voiceRef: toStr(row.voice_ref),
    engine: toStr(row.engine),
    errorMessage: toStrOrNull(row.error_message),
    requestedBy: toStr(row.requested_by),
    createdAt: toStr(row.created_at),
    renderedAt: toStrOrNull(row.rendered_at),
  }
}

function mapSchedule(row: Record<string, unknown>): BriefScheduleRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    briefType: toStr(row.brief_type),
    cadence: toStr(row.cadence) as BriefScheduleRecord['cadence'],
    hourUtc: toNum(row.hour_utc),
    timezone: toStr(row.timezone),
    subscriberUserId: toStr(row.subscriber_user_id),
    enabled: toBool(row.enabled),
    lastRunAt: toStrOrNull(row.last_run_at),
    createdAt: toStr(row.created_at),
  }
}
