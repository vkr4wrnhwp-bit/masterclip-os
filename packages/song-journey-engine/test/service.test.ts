import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, insertRow, type Db } from '@masterclip/database'
import { SongLabProjectRepo, SongVersionRepo } from '@masterclip/song-lab-domain'
import { StudioProjectRepo, StudioVersionRepo } from '@masterclip/studio-domain'
import { SongJourneyService } from '../src/index.js'

let db: Db | undefined
afterEach(async () => { await db?.close(); db = undefined })

async function fixture() {
  db = await createTestDb()
  await insertRow(db, 'orgs', { id: 'org_journey', name: 'Journey room', created_at: '2026-10-23T00:00:00.000Z' })
  const songRepo = new SongLabProjectRepo(db)
  const song = await songRepo.create({ orgId: 'org_journey', artistId: null, artistName: 'LJ', title: 'Shared title', genre: 'r&b', rightsConfirmationId: 'rights_song', createdBy: 'artist' })
  const songVersions = new SongVersionRepo(db)
  const songV1 = await songVersions.create({ orgId: 'org_journey', songLabProjectId: song.id, parentVersionId: null, versionType: 'original_upload', versionLabel: 'Original · analysis engine 1', sourceAssetId: 'duplicate-upload-asset', createdBy: 'artist' })
  const songV2 = await songVersions.create({ orgId: 'org_journey', songLabProjectId: song.id, parentVersionId: songV1.id, versionType: 'human_revision', versionLabel: 'Revision · analysis engine 2', sourceAssetId: 'duplicate-upload-asset', createdBy: 'artist' })
  for (const [id, version, engine] of [['analysis_old', songV1.id, 'engine-1'], ['analysis_new', songV2.id, 'engine-2']] as const) {
    await insertRow(db, 'song_analyses', {
      id, org_id: 'org_journey', song_lab_project_id: song.id, song_version_id: version, analysis_version: '1', engine_version: engine,
      status: 'complete', duration_ms: 181000, bpm: 96, bpm_confidence: 0.88, tempo_stability: 0.91, song_key: 'F minor', key_confidence: 0.79,
      meter: 4, meter_confidence: 0.9, loudness: -12, dynamic_range: 8, peak_dbfs: -1.2, stereo_width: 0.31, first_vocal_ms: 1200,
      structure_confidence: 0.81, feature_vector: '{}', energy_curve: '{"values":[0.2,0.7],"stepSeconds":2}', vocal_analysis: '{}', providers: '{}',
      configuration: '{}', source_checksum: `checksum-${version}`, failure_reason: null, created_at: `2026-10-23T00:0${id === 'analysis_old' ? '1' : '2'}:00.000Z`, completed_at: '2026-10-23T00:03:00.000Z',
    })
  }

  const studioRepo = new StudioProjectRepo(db)
  const studio = await studioRepo.create({ orgId: 'org_journey', artistName: 'LJ', title: 'Other record name', genre: 'r&b', rightsConfirmationId: 'rights_studio', createdBy: 'artist' })
  const studioVersions = new StudioVersionRepo(db)
  const studioV1 = await studioVersions.create({ orgId: 'org_journey', studioProjectId: studio.id, versionType: 'mix', label: 'Mix · reference A', assetId: 'studio-asset-a', assetChecksum: 'checksum-studio-a', sourceKind: 'upload', createdBy: 'artist' })
  const studioV2 = await studioVersions.create({ orgId: 'org_journey', studioProjectId: studio.id, versionType: 'approved_mix', label: 'Approved · reference B', assetId: 'studio-asset-b', assetChecksum: 'checksum-studio-b', sourceKind: 'upload', createdBy: 'artist' })
  await insertRow(db, 'studio_comments', { id: 'comment_1', org_id: 'org_journey', studio_project_id: studio.id, studio_version_id: studioV1.id, parent_comment_id: null, timestamp_ms: 22000, body: 'Keep the breath before the hook.', author_user_id: 'artist', author_label: 'LJ', status: 'open', resolved_by: null, resolved_at: null, created_at: '2026-10-23T00:04:00.000Z' })
  await insertRow(db, 'studio_approvals', { id: 'approval_1', org_id: 'org_journey', studio_project_id: studio.id, studio_version_id: studioV1.id, approval_type: 'mix', approved_by: 'artist', approved_by_label: 'LJ', approved_at: '2026-10-23T00:05:00.000Z', comments: 'Approved for this exact checksum.', version_checksum: 'checksum-studio-a', revoked_at: null, revoked_by: null, revoked_reason: null })
  return { song, studio, songV1, songV2, studioV1, studioV2, service: new SongJourneyService(db) }
}

describe('linked song and Studio records', () => {
  it('keeps separate IDs, conflicting titles, duplicate uploads and analyzer histories intact', async () => {
    const f = await fixture()
    expect(f.song.id).not.toBe(f.studio.id)
    expect(f.song.title).not.toBe(f.studio.title)
    expect(f.songV1.id).not.toBe(f.songV2.id)
    expect(f.songV1.sourceAssetId).toBe(f.songV2.sourceAssetId) // same uploaded bytes are still two explicit versions

    const link = await f.service.create('org_journey', 'artist', { songLabProjectId: f.song.id, studioProjectId: f.studio.id, sourceKind: 'song_lab' })
    expect(link.selectedSongVersionId).toBeNull()
    expect(link.selectedStudioVersionId).toBeNull()
    await f.service.selectVersions('org_journey', link.id, f.songV2.id, f.studioV1.id)
    const exported = await f.service.export('org_journey', link.id)
    expect(exported.sourceRecords).toEqual({
      songLab: { id: f.song.id, title: 'Shared title', artistName: 'LJ', versionIds: [f.songV1.id, f.songV2.id] },
      studio: { id: f.studio.id, title: 'Other record name', artistName: 'LJ', versionIds: [f.studioV1.id, f.studioV2.id] },
    })
    expect(exported.preservation).toContain('remain in their owning records')
    expect((await db!.query('SELECT engine_version FROM song_analyses ORDER BY engine_version')).map(row => row.engine_version)).toEqual(['engine-1', 'engine-2'])
    expect(await db!.get('SELECT body FROM studio_comments WHERE id = ?', ['comment_1'])).toEqual({ body: 'Keep the breath before the hook.' })
    expect(await db!.get('SELECT version_checksum FROM studio_approvals WHERE id = ?', ['approval_1'])).toEqual({ version_checksum: 'checksum-studio-a' })
  })

  it('rejects mismatched versions, tenant reads and duplicate active links', async () => {
    const f = await fixture()
    const otherSong = await new SongLabProjectRepo(db!).create({ orgId: 'org_journey', artistId: null, artistName: 'LJ', title: 'Other', genre: 'r&b', rightsConfirmationId: 'rights', createdBy: 'artist' })
    const otherVersion = await new SongVersionRepo(db!).create({ orgId: 'org_journey', songLabProjectId: otherSong.id, parentVersionId: null, versionType: 'original_upload', versionLabel: 'Wrong record', sourceAssetId: null, createdBy: 'artist' })
    const link = await f.service.create('org_journey', 'artist', { songLabProjectId: f.song.id, studioProjectId: f.studio.id, sourceKind: 'studio' })
    await expect(f.service.selectVersions('org_journey', link.id, otherVersion.id, f.studioV1.id)).rejects.toThrow('belong to the linked source records')
    await expect(f.service.create('org_journey', 'artist', { songLabProjectId: f.song.id, studioProjectId: f.studio.id, sourceKind: 'song_lab' })).rejects.toThrow('already linked')
    await expect(f.service.links.get('another-tenant', link.id)).rejects.toThrow('not found')
  })

  it('soft-unlinks and exports the same link and exact selected versions without deleting source history', async () => {
    const f = await fixture()
    const link = await f.service.create('org_journey', 'artist', { songLabProjectId: f.song.id, studioProjectId: f.studio.id, sourceKind: 'song_lab' })
    await f.service.selectVersions('org_journey', link.id, f.songV1.id, f.studioV2.id)
    const before = await f.service.export('org_journey', link.id)
    await f.service.links.unlink('org_journey', link.id)
    const after = await f.service.export('org_journey', link.id)
    expect(after.link.unlinkedAt).toBeTruthy()
    expect(after.link.selectedSongVersionId).toBe(f.songV1.id)
    expect(after.link.selectedStudioVersionId).toBe(f.studioV2.id)
    expect(after.sourceRecords).toEqual(before.sourceRecords)
    expect(await f.service.links.list('org_journey')).toEqual([])
    expect((await new SongLabProjectRepo(db!).get('org_journey', f.song.id)).title).toBe('Shared title')
    expect((await new StudioProjectRepo(db!).get('org_journey', f.studio.id)).title).toBe('Other record name')
  })
})
