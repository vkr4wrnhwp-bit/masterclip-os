import { insertRow, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { StudioActivityRecord, StudioNoteCategory, StudioNoteOrigin, StudioNoteRecord, StudioNoteStatus } from './types.js'

/** Waveform notes and markers, and the project's immutable activity history. */
export class StudioNoteRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    studioVersionId?: string | null
    kind?: 'note' | 'marker'
    timestampMs?: number | null
    endMs?: number | null
    category: StudioNoteCategory
    body: string
    assignedTo?: string | null
    origin?: StudioNoteOrigin
    sourceIssueId?: string | null
    authorUserId: string
    authorLabel: string
  }): Promise<StudioNoteRecord> {
    const now = this.clock.isoNow()
    const record: StudioNoteRecord = {
      id: newId('stn', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      kind: input.kind ?? 'note',
      timestampMs: input.timestampMs ?? null,
      endMs: input.endMs ?? null,
      category: input.category,
      body: input.body,
      status: 'open',
      assignedTo: input.assignedTo ?? null,
      origin: input.origin ?? 'human',
      sourceIssueId: input.sourceIssueId ?? null,
      authorUserId: input.authorUserId,
      authorLabel: input.authorLabel,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_notes', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      kind: record.kind,
      timestamp_ms: record.timestampMs,
      end_ms: record.endMs,
      category: record.category,
      body: record.body,
      status: record.status,
      assigned_to: record.assignedTo,
      origin: record.origin,
      source_issue_id: record.sourceIssueId,
      author_user_id: record.authorUserId,
      author_label: record.authorLabel,
      resolved_by: null,
      resolved_at: null,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<StudioNoteRecord> {
    const row = await this.db.get('SELECT * FROM studio_notes WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('studio note', id)
    return mapNote(row)
  }

  async list(orgId: string, projectId: string, opts: { versionId?: string; status?: StudioNoteStatus } = {}): Promise<StudioNoteRecord[]> {
    const where = ['org_id = ?', 'studio_project_id = ?']
    const params: Array<string> = [orgId, projectId]
    if (opts.versionId) {
      where.push('(studio_version_id = ? OR studio_version_id IS NULL)')
      params.push(opts.versionId)
    }
    if (opts.status) {
      where.push('status = ?')
      params.push(opts.status)
    }
    // Timeline order, with project-level notes (no timestamp) first: they are
    // about the record rather than a moment in it.
    const rows = await this.db.query(
      `SELECT * FROM studio_notes WHERE ${where.join(' AND ')} ORDER BY timestamp_ms IS NULL DESC, timestamp_ms ASC, created_at ASC`,
      params,
    )
    return rows.map(mapNote)
  }

  async update(
    orgId: string,
    id: string,
    patch: Partial<Pick<StudioNoteRecord, 'body' | 'category' | 'status' | 'assignedTo' | 'timestampMs' | 'endMs'>>,
    actorUserId: string,
  ): Promise<StudioNoteRecord> {
    await this.get(orgId, id)
    const columns: Record<string, string> = {
      body: 'body',
      category: 'category',
      status: 'status',
      assignedTo: 'assigned_to',
      timestampMs: 'timestamp_ms',
      endMs: 'end_ms',
    }
    const sets: string[] = []
    const params: Array<string | number | null> = []
    for (const [key, column] of Object.entries(columns)) {
      const value = patch[key as keyof typeof patch]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      params.push(value as string | number | null)
    }
    if (patch.status === 'resolved') {
      sets.push('resolved_by = ?', 'resolved_at = ?')
      params.push(actorUserId, this.clock.isoNow())
    } else if (patch.status !== undefined) {
      // Reopening clears the resolution rather than leaving a stale signature
      // attached to a note that is open again.
      sets.push('resolved_by = NULL', 'resolved_at = NULL')
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?')
      params.push(this.clock.isoNow())
      await this.db.run(`UPDATE studio_notes SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, [...params, id, orgId])
    }
    return this.get(orgId, id)
  }

  async delete(orgId: string, id: string): Promise<void> {
    await this.get(orgId, id)
    await this.db.run('DELETE FROM studio_notes WHERE id = ? AND org_id = ?', [id, orgId])
  }

  async countOpen(orgId: string, projectId: string): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM studio_notes WHERE org_id = ? AND studio_project_id = ? AND status IN (?, ?)', [
      orgId,
      projectId,
      'open',
      'in_progress',
    ])
    return toNum(row?.total)
  }
}

/**
 * The project's activity history.
 *
 * Append-only: this class has no update and no delete, and nothing else in the
 * codebase writes to the table. An audit trail somebody can edit is not one.
 */
export class StudioActivityRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async record(input: {
    orgId: string
    studioProjectId: string
    actorUserId: string
    actorLabel: string
    action: string
    subjectType: string
    subjectId?: string | null
    detail?: string
  }): Promise<StudioActivityRecord> {
    const now = this.clock.isoNow()
    const record: StudioActivityRecord = {
      id: newId('stac', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      actorUserId: input.actorUserId,
      actorLabel: input.actorLabel,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      detail: input.detail ?? '',
      createdAt: now,
    }
    await insertRow(this.db, 'studio_activity', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      actor_user_id: record.actorUserId,
      actor_label: record.actorLabel,
      action: record.action,
      subject_type: record.subjectType,
      subject_id: record.subjectId,
      detail: record.detail,
      created_at: now,
    })
    return record
  }

  async list(orgId: string, projectId: string, limit = 200): Promise<StudioActivityRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM studio_activity WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId, projectId],
    )
    return rows.map((row) => ({
      id: toStr(row.id),
      orgId: toStr(row.org_id),
      studioProjectId: toStr(row.studio_project_id),
      actorUserId: toStr(row.actor_user_id),
      actorLabel: toStr(row.actor_label),
      action: toStr(row.action),
      subjectType: toStr(row.subject_type),
      subjectId: toStrOrNull(row.subject_id),
      detail: toStr(row.detail),
      createdAt: toStr(row.created_at),
    }))
  }
}

function mapNote(row: Row): StudioNoteRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    studioVersionId: toStrOrNull(row.studio_version_id),
    kind: toStr(row.kind) === 'marker' ? 'marker' : 'note',
    timestampMs: toNumOrNull(row.timestamp_ms),
    endMs: toNumOrNull(row.end_ms),
    category: toStr(row.category) as StudioNoteCategory,
    body: toStr(row.body),
    status: toStr(row.status) as StudioNoteStatus,
    assignedTo: toStrOrNull(row.assigned_to),
    origin: toStr(row.origin) as StudioNoteOrigin,
    sourceIssueId: toStrOrNull(row.source_issue_id),
    authorUserId: toStr(row.author_user_id),
    authorLabel: toStr(row.author_label),
    resolvedBy: toStrOrNull(row.resolved_by),
    resolvedAt: toStrOrNull(row.resolved_at),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

export { mapNote }
