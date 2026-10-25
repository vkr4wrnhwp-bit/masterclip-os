import { describe, expect, it } from 'vitest'
import type { StudioApprovalRecord } from '@masterclip/studio-domain'
import { authoritativeStudioApproval } from './final-approval.js'

const approval = (id: string, patch: Partial<StudioApprovalRecord> = {}): StudioApprovalRecord => ({
  id, orgId: 'org-a', studioProjectId: 'studio-a', studioVersionId: 'version-a',
  approvalType: 'mix', approvedBy: 'reviewer', approvedByLabel: 'Reviewer',
  approvedAt: '2026-10-25T00:00:00Z', comments: '', versionChecksum: 'checksum-a',
  revokedAt: null, revokedBy: null, revokedReason: null, ...patch,
})

describe('Job 45 Studio final approval authority', () => {
  it('accepts only exact version and checksum and prefers master approval', () => {
    const mix = approval('mix')
    const master = approval('master', { approvalType: 'master' })
    expect(authoritativeStudioApproval('version-a', 'checksum-a', [mix, master])?.id).toBe('master')
    expect(authoritativeStudioApproval('version-a', 'checksum-a', [mix])?.id).toBe('mix')
  })

  it('refuses revoked, wrong-version, wrong-checksum and missing-checksum receipts', () => {
    const rows = [
      approval('revoked', { revokedAt: '2026-10-25T01:00:00Z' }),
      approval('other-version', { studioVersionId: 'version-b' }),
      approval('other-bytes', { versionChecksum: 'checksum-b' }),
    ]
    expect(authoritativeStudioApproval('version-a', 'checksum-a', rows)).toBeNull()
    expect(authoritativeStudioApproval('version-a', null, [approval('valid')])).toBeNull()
    expect(authoritativeStudioApproval('version-a', 'checksum-a', [])).toBeNull()
  })

  it('does not mistake delivery approval for final mix/master approval', () => {
    expect(authoritativeStudioApproval('version-a', 'checksum-a', [approval('delivery', { approvalType: 'delivery' })])).toBeNull()
  })
})
