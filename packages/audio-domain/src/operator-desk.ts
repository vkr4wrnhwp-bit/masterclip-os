import { type Db, insertRow, toBool, toStr, toStrOrNull } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'

/**
 * Operator Desk scaffold: leads, notes, tasks.
 *
 * This is the destination approved audio intelligence commits into. It is a
 * deliberate minimum — enough structure for meetings, agent conversations and
 * follow-ups to land somewhere real — designed to be replaced by (or merged
 * into) a fuller CRM without changing the audio layer, which only touches it
 * through this repository.
 */

export interface OperatorLeadRecord {
  id: string
  orgId: string
  name: string
  contactName: string
  email: string
  phone: string
  artistName: string
  stage: string
  source: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface OperatorNoteRecord {
  id: string
  leadId: string
  body: string
  sourceType: string
  sourceId: string
  pinned: boolean
  createdBy: string
  createdAt: string
}

export interface OperatorTaskRecord {
  id: string
  leadId: string
  description: string
  status: 'open' | 'done' | 'cancelled'
  dueAt: string | null
  assignedUserId: string | null
  sourceType: string
  sourceId: string
  createdBy: string
  createdAt: string
  completedAt: string | null
}

export class OperatorDeskRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async createLead(input: {
    orgId: string
    name: string
    contactName?: string
    email?: string
    phone?: string
    artistName?: string
    stage?: string
    source: string
    createdBy: string
  }): Promise<OperatorLeadRecord> {
    const now = this.clock.isoNow()
    const record: OperatorLeadRecord = {
      id: newId('lead', this.clock.now()),
      orgId: input.orgId,
      name: input.name,
      contactName: input.contactName ?? '',
      email: input.email ?? '',
      phone: input.phone ?? '',
      artistName: input.artistName ?? '',
      stage: input.stage ?? 'new',
      source: input.source,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'operator_leads', {
      id: record.id,
      org_id: record.orgId,
      name: record.name,
      contact_name: record.contactName,
      email: record.email,
      phone: record.phone,
      artist_name: record.artistName,
      stage: record.stage,
      source: record.source,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async getLead(orgId: string, id: string): Promise<OperatorLeadRecord> {
    const row = await this.db.get('SELECT * FROM operator_leads WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('operator lead', id)
    return mapLead(row)
  }

  async listLeads(orgId: string, limit = 200): Promise<OperatorLeadRecord[]> {
    const rows = await this.db.query(`SELECT * FROM operator_leads WHERE org_id = ? ORDER BY updated_at DESC LIMIT ${Math.floor(limit)}`, [
      orgId,
    ])
    return rows.map(mapLead)
  }

  async updateLeadContact(orgId: string, id: string, patch: Partial<Pick<OperatorLeadRecord, 'contactName' | 'email' | 'phone' | 'artistName' | 'stage'>>): Promise<void> {
    const lead = await this.getLead(orgId, id)
    await this.db.run(
      `UPDATE operator_leads SET contact_name = ?, email = ?, phone = ?, artist_name = ?, stage = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
      [
        patch.contactName ?? lead.contactName,
        patch.email ?? lead.email,
        patch.phone ?? lead.phone,
        patch.artistName ?? lead.artistName,
        patch.stage ?? lead.stage,
        this.clock.isoNow(),
        id,
        orgId,
      ],
    )
  }

  async addNote(input: { orgId: string; leadId: string; body: string; sourceType: string; sourceId: string; pinned?: boolean; createdBy: string }): Promise<OperatorNoteRecord> {
    // The lead lookup enforces tenancy before the write.
    await this.getLead(input.orgId, input.leadId)
    const record: OperatorNoteRecord = {
      id: newId('note', this.clock.now()),
      leadId: input.leadId,
      body: input.body,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      pinned: input.pinned ?? false,
      createdBy: input.createdBy,
      createdAt: this.clock.isoNow(),
    }
    await insertRow(this.db, 'operator_notes', {
      id: record.id,
      org_id: input.orgId,
      lead_id: record.leadId,
      body: record.body,
      source_type: record.sourceType,
      source_id: record.sourceId,
      pinned: record.pinned ? 1 : 0,
      created_by: record.createdBy,
      created_at: record.createdAt,
    })
    await this.touchLead(input.orgId, input.leadId)
    return record
  }

  async notesForLead(orgId: string, leadId: string): Promise<OperatorNoteRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM operator_notes WHERE lead_id = ? AND org_id = ? ORDER BY pinned DESC, created_at DESC',
      [leadId, orgId],
    )
    return rows.map((row) => ({
      id: toStr(row.id),
      leadId: toStr(row.lead_id),
      body: toStr(row.body),
      sourceType: toStr(row.source_type),
      sourceId: toStr(row.source_id),
      pinned: toBool(row.pinned),
      createdBy: toStr(row.created_by),
      createdAt: toStr(row.created_at),
    }))
  }

  async createTask(input: {
    orgId: string
    leadId: string
    description: string
    dueAt?: string | null
    assignedUserId?: string | null
    sourceType: string
    sourceId: string
    createdBy: string
  }): Promise<OperatorTaskRecord> {
    await this.getLead(input.orgId, input.leadId)
    const record: OperatorTaskRecord = {
      id: newId('task', this.clock.now()),
      leadId: input.leadId,
      description: input.description,
      status: 'open',
      dueAt: input.dueAt ?? null,
      assignedUserId: input.assignedUserId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdBy: input.createdBy,
      createdAt: this.clock.isoNow(),
      completedAt: null,
    }
    await insertRow(this.db, 'operator_tasks', {
      id: record.id,
      org_id: input.orgId,
      lead_id: record.leadId,
      description: record.description,
      status: record.status,
      due_at: record.dueAt,
      assigned_user_id: record.assignedUserId,
      source_type: record.sourceType,
      source_id: record.sourceId,
      created_by: record.createdBy,
      created_at: record.createdAt,
      completed_at: null,
    })
    await this.touchLead(input.orgId, input.leadId)
    return record
  }

  async tasksForLead(orgId: string, leadId: string): Promise<OperatorTaskRecord[]> {
    const rows = await this.db.query('SELECT * FROM operator_tasks WHERE lead_id = ? AND org_id = ? ORDER BY created_at DESC', [
      leadId,
      orgId,
    ])
    return rows.map(mapTask)
  }

  async setTaskStatus(orgId: string, taskId: string, status: OperatorTaskRecord['status']): Promise<void> {
    const result = await this.db.run(
      `UPDATE operator_tasks SET status = ?, completed_at = ? WHERE id = ? AND org_id = ?`,
      [status, status === 'done' ? this.clock.isoNow() : null, taskId, orgId],
    )
    if (result.changes === 0) throw notFound('operator task', taskId)
  }

  private async touchLead(orgId: string, leadId: string): Promise<void> {
    await this.db.run('UPDATE operator_leads SET updated_at = ? WHERE id = ? AND org_id = ?', [this.clock.isoNow(), leadId, orgId])
  }
}

function mapLead(row: Record<string, unknown>): OperatorLeadRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    name: toStr(row.name),
    contactName: toStr(row.contact_name),
    email: toStr(row.email),
    phone: toStr(row.phone),
    artistName: toStr(row.artist_name),
    stage: toStr(row.stage),
    source: toStr(row.source),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapTask(row: Record<string, unknown>): OperatorTaskRecord {
  return {
    id: toStr(row.id),
    leadId: toStr(row.lead_id),
    description: toStr(row.description),
    status: toStr(row.status) as OperatorTaskRecord['status'],
    dueAt: toStrOrNull(row.due_at),
    assignedUserId: toStrOrNull(row.assigned_user_id),
    sourceType: toStr(row.source_type),
    sourceId: toStr(row.source_id),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    completedAt: toStrOrNull(row.completed_at),
  }
}
