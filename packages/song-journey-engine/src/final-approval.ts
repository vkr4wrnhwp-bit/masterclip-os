import type { StudioApprovalRecord } from '@masterclip/studio-domain'

/** An approval only counts for the exact, unrevoked Studio audio bytes. */
export function authoritativeStudioApproval(
  versionId: string,
  versionChecksum: string | null,
  approvals: readonly StudioApprovalRecord[],
): StudioApprovalRecord | null {
  if (!versionId || !versionChecksum) return null
  const eligible = approvals.filter(row =>
    row.studioVersionId === versionId &&
    row.versionChecksum === versionChecksum &&
    row.revokedAt === null &&
    (row.approvalType === 'master' || row.approvalType === 'mix'),
  )
  return eligible.find(row => row.approvalType === 'master')
    ?? eligible.find(row => row.approvalType === 'mix') ?? null
}
