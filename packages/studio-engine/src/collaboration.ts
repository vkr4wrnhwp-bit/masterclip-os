import { AppError } from '@masterclip/shared'
import type { ApprovalType, CollaboratorPermission, CollaboratorRole, StudioApprovalRecord, StudioCollaboratorRecord } from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'

/**
 * The collaborative control room, and formal approval.
 *
 * The approval rules are the load-bearing part:
 *
 *   - An approval pins the *checksum* of the audio it approved. Uploading a new
 *     file under the same version label cannot inherit it.
 *   - Approving a mix or a master moves the project's pointer to that version,
 *     so "the approved mix" is a single unambiguous thing a delivery pipeline
 *     can read.
 *   - A version that supersedes an approved one does not revoke the approval.
 *     The old approval stays true about the old audio; what changes is that the
 *     project's current version is no longer the approved one, and every
 *     surface shows both.
 */
export class StudioCollaborationService {
  constructor(private readonly deps: StudioDeps) {}

  async invite(input: {
    actor: Actor
    projectId: string
    email: string
    displayName: string
    role: CollaboratorRole
    permissions?: CollaboratorPermission[]
  }): Promise<StudioCollaboratorRecord> {
    const collaborator = await this.deps.repos.collaborators.invite({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      email: input.email,
      displayName: input.displayName,
      collaboratorRole: input.role,
      ...(input.permissions ? { permissions: input.permissions } : {}),
      invitedBy: input.actor.userId,
    })
    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'collaborator.invited',
      subjectType: 'collaborator',
      subjectId: collaborator.id,
      detail: `${input.displayName} as ${input.role}`,
    })
    return collaborator
  }

  async setPermissions(actor: Actor, projectId: string, collaboratorId: string, permissions: CollaboratorPermission[]): Promise<StudioCollaboratorRecord> {
    const collaborator = await this.deps.repos.collaborators.setPermissions(actor.orgId, collaboratorId, permissions)
    await this.deps.repos.activity.record({
      orgId: actor.orgId,
      studioProjectId: projectId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      action: 'collaborator.permissions_changed',
      subjectType: 'collaborator',
      subjectId: collaboratorId,
      detail: permissions.join(', ') || 'none',
    })
    return collaborator
  }

  async revoke(actor: Actor, projectId: string, collaboratorId: string): Promise<void> {
    const collaborator = await this.deps.repos.collaborators.get(actor.orgId, collaboratorId)
    await this.deps.repos.collaborators.revoke(actor.orgId, collaboratorId, actor.userId)
    await this.deps.repos.activity.record({
      orgId: actor.orgId,
      studioProjectId: projectId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      action: 'collaborator.revoked',
      subjectType: 'collaborator',
      subjectId: collaboratorId,
      detail: collaborator.displayName,
    })
  }

  async comment(input: {
    actor: Actor
    projectId: string
    versionId?: string | null
    parentCommentId?: string | null
    timestampMs?: number | null
    body: string
  }) {
    const comment = await this.deps.repos.comments.create({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      studioVersionId: input.versionId ?? null,
      parentCommentId: input.parentCommentId ?? null,
      timestampMs: input.timestampMs ?? null,
      body: input.body,
      authorUserId: input.actor.userId,
      authorLabel: actorLabel(input.actor),
    })
    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: input.parentCommentId ? 'comment.replied' : 'comment.added',
      subjectType: 'comment',
      subjectId: comment.id,
      detail: input.timestampMs !== null && input.timestampMs !== undefined ? clockOf(input.timestampMs) : 'project',
    })
    return comment
  }

  /**
   * Threads, assembled from the flat comment table.
   *
   * Built here rather than in the UI so every surface — the session, the
   * collaborate tab, an export — shows the same structure and the same
   * resolution state.
   */
  async threads(actor: Actor, projectId: string) {
    const comments = await this.deps.repos.comments.list(actor.orgId, projectId)
    const roots = comments.filter((comment) => !comment.parentCommentId)
    return roots
      .map((root) => ({
        ...root,
        replies: comments.filter((comment) => comment.parentCommentId === root.id),
      }))
      // Timestamped comments in timeline order, project-level ones first.
      .sort((a, b) => (a.timestampMs ?? -1) - (b.timestampMs ?? -1))
  }

  // --- approvals -----------------------------------------------------------

  /**
   * Gives formal approval.
   *
   * Refuses on a version with no audio, because approving an empty placeholder
   * is a state that would then be indistinguishable from a real sign-off. The
   * checksum is read from the version at approval time, not supplied by the
   * caller: an approval must name the bytes the system holds, not the bytes the
   * client claims.
   */
  async approve(input: { actor: Actor; projectId: string; versionId: string; approvalType: ApprovalType; comments?: string }): Promise<StudioApprovalRecord> {
    const version = await this.deps.repos.versions.get(input.actor.orgId, input.versionId)
    if (version.studioProjectId !== input.projectId) {
      throw new AppError({ kind: 'validation', code: 'studio.version_mismatch', message: 'that version belongs to a different project' })
    }
    if (!version.assetId || !version.assetChecksum) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.approval_needs_audio',
        message: 'this version carries no audio, so there is nothing to approve',
      })
    }

    const approval = await this.deps.repos.approvals.create({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      studioVersionId: version.id,
      approvalType: input.approvalType,
      approvedBy: input.actor.userId,
      approvedByLabel: actorLabel(input.actor),
      ...(input.comments ? { comments: input.comments } : {}),
      versionChecksum: version.assetChecksum,
    })

    await this.deps.repos.versions.markApproved(input.actor.orgId, version.id, approval.id)
    if (input.approvalType === 'mix') await this.deps.repos.projects.setApprovedVersion(input.actor.orgId, input.projectId, 'mix', version.id)
    if (input.approvalType === 'master') await this.deps.repos.projects.setApprovedVersion(input.actor.orgId, input.projectId, 'master', version.id)

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: `approval.${input.approvalType}`,
      subjectType: 'version',
      subjectId: version.id,
      detail: `${version.label} approved`,
    })
    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: `studio.approval.${input.approvalType}`,
      targetType: 'studio_version',
      targetId: version.id,
      data: { approvalId: approval.id, checksum: version.assetChecksum },
    })
    // The checksum goes into the chain, not just the row: an approval that
    // named specific bytes is the fact somebody will need to prove later.
    await this.deps.repos.provenance.append({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      eventType: 'approval.granted',
      subjectType: 'studio_version',
      subjectId: version.id,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      payload: { approvalType: input.approvalType, versionLabel: version.label, versionChecksum: version.assetChecksum },
    })

    return approval
  }

  async revokeApproval(actor: Actor, projectId: string, approvalId: string, reason: string): Promise<void> {
    const approval = await this.deps.repos.approvals.get(actor.orgId, approvalId)
    await this.deps.repos.approvals.revoke(actor.orgId, approvalId, actor.userId, reason)
    await this.deps.repos.versions.clearApproval(actor.orgId, approval.studioVersionId)
    if (approval.approvalType === 'mix') await this.deps.repos.projects.setApprovedVersion(actor.orgId, projectId, 'mix', null)
    if (approval.approvalType === 'master') await this.deps.repos.projects.setApprovedVersion(actor.orgId, projectId, 'master', null)

    await this.deps.repos.activity.record({
      orgId: actor.orgId,
      studioProjectId: projectId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      action: 'approval.revoked',
      subjectType: 'approval',
      subjectId: approvalId,
      detail: reason,
    })
    // Revocation is an event, never an erasure. The grant stays in the chain
    // above this one: who approved what, and who later withdrew it.
    await this.deps.repos.provenance.append({
      orgId: actor.orgId,
      studioProjectId: projectId,
      eventType: 'approval.revoked',
      subjectType: 'approval',
      subjectId: approvalId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      payload: { approvalType: approval.approvalType, reason },
    })
  }

  /**
   * The approval state of a project, including whether the approved audio is
   * still what the session is looking at.
   *
   * The `supersededByDraft` flag is what makes an approved file distinguishable
   * from later drafts everywhere it appears.
   */
  async approvalState(actor: Actor, projectId: string) {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    const approvals = await this.deps.repos.approvals.list(actor.orgId, projectId)
    const state: Record<ApprovalType, { approval: StudioApprovalRecord | null; supersededByDraft: boolean }> = {
      mix: { approval: null, supersededByDraft: false },
      master: { approval: null, supersededByDraft: false },
      delivery: { approval: null, supersededByDraft: false },
    }

    for (const type of ['mix', 'master', 'delivery'] as ApprovalType[]) {
      const current = approvals.find((approval) => approval.approvalType === type && !approval.revokedAt) ?? null
      state[type] = {
        approval: current,
        supersededByDraft: current !== null && project.currentVersionId !== null && project.currentVersionId !== current.studioVersionId,
      }
    }

    return { project, approvals, state }
  }
}

function clockOf(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
