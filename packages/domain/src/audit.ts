import { type Db, insertRow, parseJsonColumn, toStr } from '@masterclip/database'
import { newId, systemClock, type Clock } from '@masterclip/shared'

export interface AuditEntry {
  orgId: string
  projectId?: string | null
  actor: string
  action: string
  targetType: string
  targetId: string
  data?: Record<string, unknown>
}

/**
 * Append-only audit trail.
 *
 * Covers the two categories that need to be reconstructable after the fact:
 * money (every authorization, submission, and budget change) and approvals
 * (every review decision and master promotion). Nothing updates or deletes
 * rows here.
 */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async record(entry: AuditEntry): Promise<string> {
    const id = newId('audit', this.clock.now())
    await insertRow(this.db, 'audit_log', {
      id,
      org_id: entry.orgId,
      project_id: entry.projectId ?? null,
      actor: entry.actor,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      data: JSON.stringify(entry.data ?? {}),
      created_at: this.clock.isoNow(),
    })
    return id
  }

  async forTarget(targetType: string, targetId: string): Promise<Array<AuditEntry & { id: string; createdAt: string }>> {
    const rows = await this.db.query('SELECT * FROM audit_log WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC', [
      targetType,
      targetId,
    ])
    return rows.map(mapEntry)
  }

  async forProject(projectId: string, limit = 200): Promise<Array<AuditEntry & { id: string; createdAt: string }>> {
    const rows = await this.db.query(
      `SELECT * FROM audit_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [projectId],
    )
    return rows.map(mapEntry)
  }
}

function mapEntry(row: Record<string, unknown>): AuditEntry & { id: string; createdAt: string } {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    projectId: toStr(row.project_id) || null,
    actor: toStr(row.actor),
    action: toStr(row.action),
    targetType: toStr(row.target_type),
    targetId: toStr(row.target_id),
    data: parseJsonColumn(row.data, {}),
    createdAt: toStr(row.created_at),
  }
}

export const AUDIT_ACTIONS = {
  renderAuthorized: 'render.authorized',
  renderDenied: 'render.denied',
  renderSubmitted: 'render.submitted',
  renderCharged: 'render.charged',
  budgetChanged: 'budget.changed',
  reviewDecision: 'review.decision',
  masterPromoted: 'master.promoted',
  masterExported: 'master.exported',
  assetDeleted: 'asset.deleted',
  rightsUpdated: 'asset.rights_updated',
  credentialChanged: 'provider.credential_changed',
  liveModeChanged: 'system.live_mode_changed',
} as const
