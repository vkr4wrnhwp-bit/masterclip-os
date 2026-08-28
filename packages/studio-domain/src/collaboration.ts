import { insertRow, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { AppError, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import {
  DEFAULT_ROLE_PERMISSIONS,
  type ApprovalType,
  type CollaboratorPermission,
  type CollaboratorRole,
  type StudioApprovalRecord,
  type StudioCollaboratorRecord,
  type StudioCommentRecord,
} from './types.js'

/** Collaborators, timestamped comment threads, and formal approvals. */
export class StudioCollaboratorRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async invite(input: {
    orgId: string
    studioProjectId: string
    email: string
    displayName: string
    collaboratorRole: CollaboratorRole
    permissions?: CollaboratorPermission[]
    userId?: string | null
    invitedBy: string
  }): Promise<StudioCollaboratorRecord> {
    const now = this.clock.isoNow()
    const email = input.email.trim().toLowerCase()
    const existing = await this.db.get('SELECT * FROM studio_collaborators WHERE studio_project_id = ? AND email = ?', [input.studioProjectId, email])
    if (existing) {
      // Re-inviting somebody already on the project updates their role rather
      // than failing: that is what the person clicking the button meant.
      const record = mapCollaborator(existing)
      await this.db.run(
        'UPDATE studio_collaborators SET collaborator_role = ?, permissions = ?, display_name = ?, revoked_at = NULL, revoked_by = NULL WHERE id = ?',
        [input.collaboratorRole, toJson(input.permissions ?? DEFAULT_ROLE_PERMISSIONS[input.collaboratorRole]), input.displayName, record.id],
      )
      return this.get(input.orgId, record.id)
    }

    const record: StudioCollaboratorRecord = {
      id: newId('stcb', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      userId: input.userId ?? null,
      email,
      displayName: input.displayName,
      collaboratorRole: input.collaboratorRole,
      permissions: input.permissions ?? DEFAULT_ROLE_PERMISSIONS[input.collaboratorRole],
      invitedBy: input.invitedBy,
      invitedAt: now,
      acceptedAt: null,
      revokedAt: null,
      revokedBy: null,
    }
    await insertRow(this.db, 'studio_collaborators', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      user_id: record.userId,
      email: record.email,
      display_name: record.displayName,
      collaborator_role: record.collaboratorRole,
      permissions: toJson(record.permissions),
      invited_by: record.invitedBy,
      invited_at: now,
      accepted_at: null,
      revoked_at: null,
      revoked_by: null,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<StudioCollaboratorRecord> {
    const row = await this.db.get('SELECT * FROM studio_collaborators WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('collaborator', id)
    return mapCollaborator(row)
  }

  async list(orgId: string, projectId: string, opts: { includeRevoked?: boolean } = {}): Promise<StudioCollaboratorRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM studio_collaborators WHERE org_id = ? AND studio_project_id = ?${opts.includeRevoked ? '' : ' AND revoked_at IS NULL'} ORDER BY invited_at ASC`,
      [orgId, projectId],
    )
    return rows.map(mapCollaborator)
  }

  async countActive(orgId: string, projectId: string): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM studio_collaborators WHERE org_id = ? AND studio_project_id = ? AND revoked_at IS NULL', [
      orgId,
      projectId,
    ])
    return toNum(row?.total)
  }

  async setPermissions(orgId: string, id: string, permissions: CollaboratorPermission[]): Promise<StudioCollaboratorRecord> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_collaborators SET permissions = ? WHERE id = ? AND org_id = ?', [toJson(permissions), id, orgId])
    return this.get(orgId, id)
  }

  async accept(orgId: string, id: string, userId: string): Promise<void> {
    await this.db.run('UPDATE studio_collaborators SET accepted_at = ?, user_id = ? WHERE id = ? AND org_id = ?', [this.clock.isoNow(), userId, id, orgId])
  }

  /** Revokes rather than deletes: who had access, and when, is part of the history. */
  async revoke(orgId: string, id: string, actorUserId: string): Promise<void> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_collaborators SET revoked_at = ?, revoked_by = ? WHERE id = ? AND org_id = ?', [this.clock.isoNow(), actorUserId, id, orgId])
  }

  /**
   * What this user may do on this project.
   *
   * A user who is not a listed collaborator gets an empty set here. Whether
   * that means "no access" is the caller's decision — org members legitimately
   * see their organization's projects — but a *collaborator* permission is
   * never implied by membership.
   */
  async permissionsFor(orgId: string, projectId: string, userId: string, email: string): Promise<CollaboratorPermission[]> {
    const row = await this.db.get(
      'SELECT * FROM studio_collaborators WHERE org_id = ? AND studio_project_id = ? AND (user_id = ? OR email = ?) AND revoked_at IS NULL',
      [orgId, projectId, userId, email.trim().toLowerCase()],
    )
    return row ? mapCollaborator(row).permissions : []
  }
}

export class StudioCommentRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    studioVersionId?: string | null
    parentCommentId?: string | null
    timestampMs?: number | null
    body: string
    authorUserId: string
    authorLabel: string
  }): Promise<StudioCommentRecord> {
    const now = this.clock.isoNow()
    const record: StudioCommentRecord = {
      id: newId('stcm', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      parentCommentId: input.parentCommentId ?? null,
      timestampMs: input.timestampMs ?? null,
      body: input.body,
      authorUserId: input.authorUserId,
      authorLabel: input.authorLabel,
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
    }
    await insertRow(this.db, 'studio_comments', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      parent_comment_id: record.parentCommentId,
      timestamp_ms: record.timestampMs,
      body: record.body,
      author_user_id: record.authorUserId,
      author_label: record.authorLabel,
      status: record.status,
      resolved_by: null,
      resolved_at: null,
      created_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<StudioCommentRecord> {
    const row = await this.db.get('SELECT * FROM studio_comments WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('comment', id)
    return mapComment(row)
  }

  async list(orgId: string, projectId: string): Promise<StudioCommentRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_comments WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at ASC', [orgId, projectId])
    return rows.map(mapComment)
  }

  /**
   * Resolves a thread.
   *
   * Applies to the root comment and every reply, because a thread with a
   * resolved question and unresolved answers is a state nobody can read.
   */
  async resolve(orgId: string, id: string, actorUserId: string): Promise<void> {
    const comment = await this.get(orgId, id)
    const rootId = comment.parentCommentId ?? comment.id
    const now = this.clock.isoNow()
    await this.db.run("UPDATE studio_comments SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE org_id = ? AND (id = ? OR parent_comment_id = ?)", [
      actorUserId,
      now,
      orgId,
      rootId,
      rootId,
    ])
  }

  async reopen(orgId: string, id: string): Promise<void> {
    const comment = await this.get(orgId, id)
    const rootId = comment.parentCommentId ?? comment.id
    await this.db.run("UPDATE studio_comments SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE org_id = ? AND (id = ? OR parent_comment_id = ?)", [
      orgId,
      rootId,
      rootId,
    ])
  }
}

export class StudioApprovalRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    studioVersionId: string
    approvalType: ApprovalType
    approvedBy: string
    approvedByLabel: string
    comments?: string
    versionChecksum: string
  }): Promise<StudioApprovalRecord> {
    if (!input.versionChecksum) {
      // Approving audio nobody can identify later is not an approval. The
      // refusal lives here so no caller can create one by forgetting a field.
      throw new AppError({
        kind: 'validation',
        code: 'studio.approval_needs_checksum',
        message: 'an approval must name the exact audio it approves',
      })
    }
    const now = this.clock.isoNow()
    const record: StudioApprovalRecord = {
      id: newId('stap', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId,
      approvalType: input.approvalType,
      approvedBy: input.approvedBy,
      approvedByLabel: input.approvedByLabel,
      approvedAt: now,
      comments: input.comments ?? '',
      versionChecksum: input.versionChecksum,
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    }
    await insertRow(this.db, 'studio_approvals', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      approval_type: record.approvalType,
      approved_by: record.approvedBy,
      approved_by_label: record.approvedByLabel,
      approved_at: now,
      comments: record.comments,
      version_checksum: record.versionChecksum,
      revoked_at: null,
      revoked_by: null,
      revoked_reason: null,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<StudioApprovalRecord> {
    const row = await this.db.get('SELECT * FROM studio_approvals WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('approval', id)
    return mapApproval(row)
  }

  async list(orgId: string, projectId: string): Promise<StudioApprovalRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_approvals WHERE org_id = ? AND studio_project_id = ? ORDER BY approved_at DESC', [orgId, projectId])
    return rows.map(mapApproval)
  }

  /** The live approval of a kind, if one exists and has not been revoked. */
  async current(orgId: string, projectId: string, approvalType: ApprovalType): Promise<StudioApprovalRecord | null> {
    const row = await this.db.get(
      'SELECT * FROM studio_approvals WHERE org_id = ? AND studio_project_id = ? AND approval_type = ? AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1',
      [orgId, projectId, approvalType],
    )
    return row ? mapApproval(row) : null
  }

  /**
   * Revokes an approval.
   *
   * The row stays. An approval that was given and then withdrawn is a different
   * fact from one that never existed, and both matter when somebody asks who
   * signed off on a release.
   */
  async revoke(orgId: string, id: string, actorUserId: string, reason: string): Promise<void> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_approvals SET revoked_at = ?, revoked_by = ?, revoked_reason = ? WHERE id = ? AND org_id = ?', [
      this.clock.isoNow(),
      actorUserId,
      reason,
      id,
      orgId,
    ])
  }
}

function mapCollaborator(row: Row): StudioCollaboratorRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    userId: toStrOrNull(row.user_id),
    email: toStr(row.email),
    displayName: toStr(row.display_name),
    collaboratorRole: toStr(row.collaborator_role) as CollaboratorRole,
    permissions: parseJson<CollaboratorPermission[]>(row.permissions, []),
    invitedBy: toStr(row.invited_by),
    invitedAt: toStr(row.invited_at),
    acceptedAt: toStrOrNull(row.accepted_at),
    revokedAt: toStrOrNull(row.revoked_at),
    revokedBy: toStrOrNull(row.revoked_by),
  }
}

function mapComment(row: Row): StudioCommentRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    studioVersionId: toStrOrNull(row.studio_version_id),
    parentCommentId: toStrOrNull(row.parent_comment_id),
    timestampMs: toNumOrNull(row.timestamp_ms),
    body: toStr(row.body),
    authorUserId: toStr(row.author_user_id),
    authorLabel: toStr(row.author_label),
    status: toStr(row.status) === 'resolved' ? 'resolved' : 'open',
    resolvedBy: toStrOrNull(row.resolved_by),
    resolvedAt: toStrOrNull(row.resolved_at),
    createdAt: toStr(row.created_at),
  }
}

function mapApproval(row: Row): StudioApprovalRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    studioVersionId: toStr(row.studio_version_id),
    approvalType: toStr(row.approval_type) as ApprovalType,
    approvedBy: toStr(row.approved_by),
    approvedByLabel: toStr(row.approved_by_label),
    approvedAt: toStr(row.approved_at),
    comments: toStr(row.comments),
    versionChecksum: toStr(row.version_checksum),
    revokedAt: toStrOrNull(row.revoked_at),
    revokedBy: toStrOrNull(row.revoked_by),
    revokedReason: toStrOrNull(row.revoked_reason),
  }
}
