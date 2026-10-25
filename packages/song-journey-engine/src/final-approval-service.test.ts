import { describe, expect, it } from 'vitest'
import type { Db } from '@masterclip/database'
import { SongJourneyService } from './service.js'

function fixture(options: {
  assetChecksum?: string | null
  storedChecksum?: string | null
  deleted?: boolean
  revoked?: boolean
  receiptChecksum?: string
  receiptVersionId?: string
} = {}) {
  const assetChecksum = options.assetChecksum === undefined ? 'hash-a' : options.assetChecksum
  const storedChecksum = options.storedChecksum === undefined ? 'hash-a' : options.storedChecksum
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const db = {
    get: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      if (sql.includes('FROM song_journey_links')) return {
        id: 'link-a', org_id: 'org-a', song_lab_project_id: 'song-a',
        studio_project_id: 'studio-a', source_kind: 'song_lab',
        selected_song_version_id: 'song-version-a', selected_studio_version_id: 'studio-version-a',
        created_by: 'owner', created_at: '2026-10-25', updated_at: '2026-10-25', unlinked_at: null,
      }
      if (sql.includes('FROM studio_versions')) return {
        id: 'studio-version-a', org_id: 'org-a', studio_project_id: 'studio-a',
        parent_version_id: null, version_type: 'master', label: 'Master',
        ordinal: 1, asset_id: 'asset-a', asset_checksum: assetChecksum,
        source_kind: 'upload', master_rendition_id: null, duration_ms: 1000,
        sample_rate: 48000, bit_depth: 24, channels: 2, approved: 1,
        approval_id: 'receipt-a', superseded_at: null, notes: '',
        created_by: 'owner', created_at: '2026-10-25',
      }
      if (sql.includes('FROM audio_assets')) return options.deleted || !storedChecksum ? undefined : { checksum: storedChecksum }
      return undefined
    },
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      if (!sql.includes('FROM studio_approvals')) return []
      return [{
        id: 'receipt-a', org_id: 'org-a', studio_project_id: 'studio-a',
        studio_version_id: options.receiptVersionId ?? 'studio-version-a',
        approval_type: 'master', approved_by: 'reviewer', approved_by_label: 'Reviewer',
        approved_at: '2026-10-25', comments: '', version_checksum: options.receiptChecksum ?? 'hash-a',
        revoked_at: options.revoked ? '2026-10-25' : null, revoked_by: null, revoked_reason: null,
      }]
    },
  } as unknown as Db
  return { service: new SongJourneyService(db), calls }
}

describe('Job 45 final Studio approval service', () => {
  it('recognizes the authorized, checksum-matched existing Studio receipt', async () => {
    const { service, calls } = fixture()
    const result = await service.finalApproval('org-a', 'link-a')
    expect(result.state).toBe('approved')
    expect(result.approval?.id).toBe('receipt-a')
    expect(result.songLabEvidenceVersionId).toBe('song-version-a')
    expect(calls.filter(call => call.sql.includes('FROM audio_assets'))[0]?.params).toEqual(['asset-a', 'org-a'])
  })

  it('fails closed on deleted/mismatched audio or revoked/wrong-version approval', async () => {
    for (const options of [
      { deleted: true }, { storedChecksum: 'tampered' }, { assetChecksum: null },
      { revoked: true }, { receiptChecksum: 'wrong' }, { receiptVersionId: 'another-version' },
    ]) {
      const result = await fixture(options).service.finalApproval('org-a', 'link-a')
      expect(result.state).toBe('not_approved')
      expect(result.approval).toBeNull()
    }
  })
})
