import { describe, expect, it } from 'vitest'
import type { SongVersionRecord } from '@masterclip/song-lab-domain'
import { selectVersionPair } from './version-compare.js'

const version = (id: string, patch: Partial<SongVersionRecord> = {}): SongVersionRecord => ({
  id, orgId: 'org-a', songLabProjectId: 'song-a', parentVersionId: null,
  versionType: 'human_revision', versionLabel: id, sourceAssetId: id + '-asset',
  experimentId: null, notes: '', createdBy: 'reviewer', createdAt: '2026-10-25T00:00:00Z',
  ...patch,
})

describe('Song Lab Job 45 version pair selection', () => {
  it('selects two original records without changing or inventing approval state', () => {
    const versions = [version('v1'), version('v2')]
    const result = selectVersionPair('org-a', 'song-a', versions, 'v1', 'v2')
    expect(result.left).toBe(versions[0])
    expect(result.right).toBe(versions[1])
    expect(result.playback.available).toBe(false)
    expect(result.approval.available).toBe(false)
  })

  it('rejects same-version and cross-tenant or cross-project pairs', () => {
    const versions = [version('v1'), version('v2', { orgId: 'org-b' }), version('v3', { songLabProjectId: 'song-b' })]
    expect(() => selectVersionPair('org-a', 'song-a', versions, 'v1', 'v1')).toThrow()
    expect(() => selectVersionPair('org-a', 'song-a', versions, 'v1', 'v2')).toThrow()
    expect(() => selectVersionPair('org-a', 'song-a', versions, 'v1', 'v3')).toThrow()
    expect(() => selectVersionPair('org-b', 'song-a', versions, 'v1', 'v2')).toThrow()
  })

  it('never interprets matching asset IDs as independent audio revisions', () => {
    const result = selectVersionPair('org-a', 'song-a', [
      version('v1', { sourceAssetId: 'asset-1' }),
      version('v2', { sourceAssetId: 'asset-1' }),
    ], 'v1', 'v2')
    expect(result.sameAsset).toBe(true)
    expect(result.playback.available).toBe(false)
  })
})
