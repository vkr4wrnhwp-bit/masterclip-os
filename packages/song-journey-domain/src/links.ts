import { insertRow, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { AppError, newId, systemClock, type Clock } from '@masterclip/shared'
import type { SongJourneyLink, SongJourneySource } from './types.js'

export class SongJourneyLinkRepo {
  constructor(private readonly db: Db, private readonly clock: Clock = systemClock) {}

  async create(input: {
    orgId: string
    songLabProjectId: string
    studioProjectId: string
    sourceKind: SongJourneySource
    createdBy: string
  }): Promise<SongJourneyLink> {
    const now = this.clock.isoNow()
    const link: SongJourneyLink = {
      id: newId('sjl', this.clock.now()),
      orgId: input.orgId,
      songLabProjectId: input.songLabProjectId,
      studioProjectId: input.studioProjectId,
      sourceKind: input.sourceKind,
      selectedSongVersionId: null,
      selectedStudioVersionId: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      unlinkedAt: null,
    }
    const existing = await this.db.get(
      'SELECT id FROM song_journey_links WHERE org_id = ? AND song_lab_project_id = ? AND studio_project_id = ? AND unlinked_at IS NULL',
      [input.orgId, input.songLabProjectId, input.studioProjectId],
    )
    if (existing) throw new AppError({ kind: 'conflict', code: 'song_journey.link_exists', message: 'These two records are already linked. Open the existing journey instead.' })
    try {
      await insertRow(this.db, 'song_journey_links', {
        id: link.id,
        org_id: link.orgId,
        song_lab_project_id: link.songLabProjectId,
        studio_project_id: link.studioProjectId,
        source_kind: link.sourceKind,
        selected_song_version_id: null,
        selected_studio_version_id: null,
        created_by: link.createdBy,
        created_at: now,
        updated_at: now,
        unlinked_at: null,
      })
    } catch (error) {
      const raced = await this.db.get(
        'SELECT id FROM song_journey_links WHERE org_id = ? AND song_lab_project_id = ? AND studio_project_id = ? AND unlinked_at IS NULL',
        [input.orgId, input.songLabProjectId, input.studioProjectId],
      )
      if (raced) throw new AppError({ kind: 'conflict', code: 'song_journey.link_exists', message: 'These two records are already linked. Open the existing journey instead.' })
      throw error
    }
    return link
  }

  async get(orgId: string, id: string, includeUnlinked = false): Promise<SongJourneyLink> {
    const row = await this.db.get(
      `SELECT * FROM song_journey_links WHERE id = ? AND org_id = ?${includeUnlinked ? '' : ' AND unlinked_at IS NULL'}`,
      [id, orgId],
    )
    if (!row) throw new AppError({ kind: 'not_found', code: 'song_journey.link', message: 'Song journey link was not found.' })
    return mapLink(row)
  }

  async list(orgId: string, includeUnlinked = false): Promise<SongJourneyLink[]> {
    const rows = await this.db.query(
      `SELECT * FROM song_journey_links WHERE org_id = ?${includeUnlinked ? '' : ' AND unlinked_at IS NULL'} ORDER BY updated_at DESC`,
      [orgId],
    )
    return rows.map(mapLink)
  }

  async selectVersions(orgId: string, id: string, songVersionId: string, studioVersionId: string): Promise<SongJourneyLink> {
    const link = await this.get(orgId, id)
    await this.db.run(
      `UPDATE song_journey_links SET selected_song_version_id = ?, selected_studio_version_id = ?, updated_at = ?
       WHERE id = ? AND org_id = ? AND unlinked_at IS NULL`,
      [songVersionId, studioVersionId, this.clock.isoNow(), id, orgId],
    )
    return this.get(orgId, link.id)
  }

  /** Unlinking is a soft state change; original source records and the link receipt remain exportable. */
  async unlink(orgId: string, id: string): Promise<SongJourneyLink> {
    const link = await this.get(orgId, id, true)
    if (!link.unlinkedAt) {
      const now = this.clock.isoNow()
      await this.db.run('UPDATE song_journey_links SET unlinked_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND unlinked_at IS NULL', [now, now, id, orgId])
    }
    return this.get(orgId, id, true)
  }
}

function mapLink(row: Row): SongJourneyLink {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    studioProjectId: toStr(row.studio_project_id),
    sourceKind: toStr(row.source_kind) as SongJourneySource,
    selectedSongVersionId: toStrOrNull(row.selected_song_version_id),
    selectedStudioVersionId: toStrOrNull(row.selected_studio_version_id),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
    unlinkedAt: toStrOrNull(row.unlinked_at),
  }
}
