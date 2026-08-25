import { type Db, insertRow, parseJsonColumn, toNum, toNumOrNull, toStr, toStrOrNull } from '@masterclip/database'
import { AppError, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { MeetingIntelligenceResult } from '@masterclip/audio-core'

export const MEETING_TYPES = [
  'A&R Call',
  'Artist Onboarding',
  'Manager Meeting',
  'Distribution Discussion',
  'Deal Discussion',
  'Catalog Review',
  'Royalty Review',
  'Release Strategy',
  'Show Debrief',
  'Partner Meeting',
  'Internal Team Meeting',
  'Voice Note',
  'Other',
] as const

export type MeetingStatus = 'uploaded' | 'transcribing' | 'extracting' | 'draft' | 'committed' | 'rejected' | 'failed'
export type ApprovalStatus = 'draft' | 'approved' | 'rejected'

export interface MeetingRecord {
  id: string
  orgId: string
  transcriptId: string | null
  audioAssetId: string | null
  operatorLeadId: string | null
  meetingType: string
  title: string
  status: MeetingStatus
  summary: string
  extraction: MeetingIntelligenceResult | null
  engine: string
  consentRecordId: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  committedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface MeetingActionItemRecord {
  id: string
  meetingId: string
  description: string
  assignedUserId: string | null
  dueAt: string | null
  sourceStartMs: number | null
  sourceEndMs: number | null
  confidence: number
  approvalStatus: ApprovalStatus
  operatorTaskId: string | null
}

export interface MeetingDealVariableRecord {
  id: string
  meetingId: string
  variableType: string
  value: string
  extractionType: string
  sourceStartMs: number | null
  sourceEndMs: number | null
  confidence: number
  approvalStatus: ApprovalStatus
}

export class MeetingRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    title: string
    meetingType: string
    operatorLeadId: string | null
    audioAssetId: string | null
    consentRecordId: string | null
    createdBy: string
  }): Promise<MeetingRecord> {
    const now = this.clock.isoNow()
    const record: MeetingRecord = {
      id: newId('meet', this.clock.now()),
      orgId: input.orgId,
      transcriptId: null,
      audioAssetId: input.audioAssetId,
      operatorLeadId: input.operatorLeadId,
      meetingType: input.meetingType,
      title: input.title,
      status: 'uploaded',
      summary: '',
      extraction: null,
      engine: '',
      consentRecordId: input.consentRecordId,
      reviewedBy: null,
      reviewedAt: null,
      committedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'meeting_intelligence', {
      id: record.id,
      org_id: record.orgId,
      transcript_id: null,
      audio_asset_id: record.audioAssetId,
      operator_lead_id: record.operatorLeadId,
      meeting_type: record.meetingType,
      title: record.title,
      status: record.status,
      summary: '',
      extraction: 'null',
      engine: '',
      consent_record_id: record.consentRecordId,
      reviewed_by: null,
      reviewed_at: null,
      committed_at: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<MeetingRecord> {
    const row = await this.db.get('SELECT * FROM meeting_intelligence WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('meeting', id)
    return mapMeeting(row)
  }

  async getAnyOrg(id: string): Promise<MeetingRecord> {
    const row = await this.db.get('SELECT * FROM meeting_intelligence WHERE id = ?', [id])
    if (!row) throw notFound('meeting', id)
    return mapMeeting(row)
  }

  async list(orgId: string, limit = 100): Promise<MeetingRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM meeting_intelligence WHERE org_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId],
    )
    return rows.map(mapMeeting)
  }

  async setStatus(id: string, status: MeetingStatus): Promise<void> {
    await this.db.run('UPDATE meeting_intelligence SET status = ?, updated_at = ? WHERE id = ?', [status, this.clock.isoNow(), id])
  }

  async attachTranscript(id: string, transcriptId: string): Promise<void> {
    await this.db.run('UPDATE meeting_intelligence SET transcript_id = ?, updated_at = ? WHERE id = ?', [
      transcriptId,
      this.clock.isoNow(),
      id,
    ])
  }

  /** Stores the extraction and materialises action items and deal variables as draft rows. */
  async storeExtraction(orgId: string, id: string, extraction: MeetingIntelligenceResult): Promise<void> {
    const now = this.clock.isoNow()
    await this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE meeting_intelligence SET extraction = ?, summary = ?, engine = ?, status = 'draft', updated_at = ? WHERE id = ? AND org_id = ?`,
        [JSON.stringify(extraction), extraction.summary, extraction.engine, now, id, orgId],
      )
      await tx.run('DELETE FROM meeting_action_items WHERE meeting_id = ? AND approval_status = ?', [id, 'draft'])
      await tx.run('DELETE FROM meeting_deal_variables WHERE meeting_id = ? AND approval_status = ?', [id, 'draft'])
      for (const item of extraction.actionItems) {
        await insertRow(tx, 'meeting_action_items', {
          id: newId('mai', this.clock.now()),
          org_id: orgId,
          meeting_id: id,
          description: item.description,
          assigned_user_id: null,
          due_at: item.dueAt ?? null,
          source_start_ms: item.sourceStartMs ?? null,
          source_end_ms: item.sourceEndMs ?? null,
          confidence: item.confidence,
          approval_status: 'draft',
          operator_task_id: null,
          created_at: now,
        })
      }
      for (const variable of extraction.dealVariables) {
        await insertRow(tx, 'meeting_deal_variables', {
          id: newId('mdv', this.clock.now()),
          org_id: orgId,
          meeting_id: id,
          variable_type: variable.variableType,
          value: variable.value,
          extraction_type: variable.extractionType,
          source_start_ms: variable.sourceStartMs ?? null,
          source_end_ms: variable.sourceEndMs ?? null,
          confidence: variable.confidence,
          approval_status: 'draft',
          created_at: now,
        })
      }
    })
  }

  async actionItems(orgId: string, meetingId: string): Promise<MeetingActionItemRecord[]> {
    const rows = await this.db.query('SELECT * FROM meeting_action_items WHERE meeting_id = ? AND org_id = ? ORDER BY created_at', [
      meetingId,
      orgId,
    ])
    return rows.map((row) => ({
      id: toStr(row.id),
      meetingId: toStr(row.meeting_id),
      description: toStr(row.description),
      assignedUserId: toStrOrNull(row.assigned_user_id),
      dueAt: toStrOrNull(row.due_at),
      sourceStartMs: toNumOrNull(row.source_start_ms),
      sourceEndMs: toNumOrNull(row.source_end_ms),
      confidence: toNum(row.confidence),
      approvalStatus: toStr(row.approval_status) as ApprovalStatus,
      operatorTaskId: toStrOrNull(row.operator_task_id),
    }))
  }

  async dealVariables(orgId: string, meetingId: string): Promise<MeetingDealVariableRecord[]> {
    const rows = await this.db.query('SELECT * FROM meeting_deal_variables WHERE meeting_id = ? AND org_id = ? ORDER BY created_at', [
      meetingId,
      orgId,
    ])
    return rows.map((row) => ({
      id: toStr(row.id),
      meetingId: toStr(row.meeting_id),
      variableType: toStr(row.variable_type),
      value: toStr(row.value),
      extractionType: toStr(row.extraction_type),
      sourceStartMs: toNumOrNull(row.source_start_ms),
      sourceEndMs: toNumOrNull(row.source_end_ms),
      confidence: toNum(row.confidence),
      approvalStatus: toStr(row.approval_status) as ApprovalStatus,
    }))
  }

  async setItemApproval(orgId: string, meetingId: string, kind: 'action' | 'deal', itemId: string, status: ApprovalStatus, editedValue?: string): Promise<void> {
    const table = kind === 'action' ? 'meeting_action_items' : 'meeting_deal_variables'
    const valueColumn = kind === 'action' ? 'description' : 'value'
    if (editedValue !== undefined) {
      const result = await this.db.run(
        `UPDATE ${table} SET approval_status = ?, ${valueColumn} = ? WHERE id = ? AND meeting_id = ? AND org_id = ?`,
        [status, editedValue, itemId, meetingId, orgId],
      )
      if (result.changes === 0) throw notFound('meeting item', itemId)
      return
    }
    const result = await this.db.run(`UPDATE ${table} SET approval_status = ? WHERE id = ? AND meeting_id = ? AND org_id = ?`, [
      status,
      itemId,
      meetingId,
      orgId,
    ])
    if (result.changes === 0) throw notFound('meeting item', itemId)
  }

  async linkActionToTask(itemId: string, operatorTaskId: string): Promise<void> {
    await this.db.run('UPDATE meeting_action_items SET operator_task_id = ? WHERE id = ?', [operatorTaskId, itemId])
  }

  async markReviewed(orgId: string, id: string, reviewedBy: string): Promise<void> {
    await this.db.run('UPDATE meeting_intelligence SET reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      reviewedBy,
      this.clock.isoNow(),
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async markCommitted(orgId: string, id: string): Promise<void> {
    const meeting = await this.get(orgId, id)
    if (meeting.status !== 'draft') {
      throw new AppError({ kind: 'conflict', code: 'meeting.not_draft', message: `meeting is ${meeting.status}, only drafts commit` })
    }
    await this.db.run(`UPDATE meeting_intelligence SET status = 'committed', committed_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [
      this.clock.isoNow(),
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }
}

function mapMeeting(row: Record<string, unknown>): MeetingRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    transcriptId: toStrOrNull(row.transcript_id),
    audioAssetId: toStrOrNull(row.audio_asset_id),
    operatorLeadId: toStrOrNull(row.operator_lead_id),
    meetingType: toStr(row.meeting_type),
    title: toStr(row.title),
    status: toStr(row.status) as MeetingStatus,
    summary: toStr(row.summary),
    extraction: parseJsonColumn<MeetingIntelligenceResult | null>(row.extraction, null),
    engine: toStr(row.engine),
    consentRecordId: toStrOrNull(row.consent_record_id),
    reviewedBy: toStrOrNull(row.reviewed_by),
    reviewedAt: toStrOrNull(row.reviewed_at),
    committedAt: toStrOrNull(row.committed_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
