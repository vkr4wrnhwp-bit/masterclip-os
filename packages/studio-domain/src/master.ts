import { insertRow, toBool, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import type { MasterRenditionRecord, MasterRenditionStatus, StudioAlbumRecord, StudioAlbumTrackRecord } from './types.js'

/** Master renditions, and project-level (album) mastering. */
export class MasterRenditionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    sourceVersionId: string
    slot: 'a' | 'b' | 'c'
    direction: string
    priorities?: Record<string, number | boolean>
    targetLufs: number | null
    targetTruePeak: number | null
    renderPlan: unknown
    createdBy: string
  }): Promise<MasterRenditionRecord> {
    const now = this.clock.isoNow()
    const record: MasterRenditionRecord = {
      id: newId('stmr', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      sourceVersionId: input.sourceVersionId,
      slot: input.slot,
      direction: input.direction,
      priorities: input.priorities ?? {},
      targetLufs: input.targetLufs,
      targetTruePeak: input.targetTruePeak,
      status: 'pending',
      renderPlan: input.renderPlan,
      renderer: null,
      rendererVersion: null,
      placeholder: false,
      outputAssetId: null,
      outputAnalysisId: null,
      matchGainDb: null,
      failureReason: null,
      approved: false,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_master_renditions', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      source_version_id: record.sourceVersionId,
      slot: record.slot,
      direction: record.direction,
      priorities: toJson(record.priorities),
      target_lufs: record.targetLufs,
      target_true_peak: record.targetTruePeak,
      status: record.status,
      render_plan: toJson(record.renderPlan),
      renderer: null,
      renderer_version: null,
      placeholder: 0,
      output_asset_id: null,
      output_analysis_id: null,
      match_gain_db: null,
      failure_reason: null,
      approved: 0,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<MasterRenditionRecord> {
    const row = await this.db.get('SELECT * FROM studio_master_renditions WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('master rendition', id)
    return mapRendition(row)
  }

  async list(orgId: string, projectId: string): Promise<MasterRenditionRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_master_renditions WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at ASC', [orgId, projectId])
    return rows.map(mapRendition)
  }

  async listForVersion(orgId: string, versionId: string): Promise<MasterRenditionRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_master_renditions WHERE org_id = ? AND source_version_id = ? ORDER BY created_at ASC', [orgId, versionId])
    return rows.map(mapRendition)
  }

  async countForProject(orgId: string, projectId: string): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM studio_master_renditions WHERE org_id = ? AND studio_project_id = ?', [orgId, projectId])
    return toNum(row?.total)
  }

  async settle(
    orgId: string,
    id: string,
    patch: {
      status: MasterRenditionStatus
      renderer?: string | null
      rendererVersion?: string | null
      placeholder?: boolean
      outputAssetId?: string | null
      outputAnalysisId?: string | null
      matchGainDb?: number | null
      failureReason?: string | null
    },
  ): Promise<void> {
    await this.db.run(
      'UPDATE studio_master_renditions SET status = ?, renderer = ?, renderer_version = ?, placeholder = ?, output_asset_id = ?, output_analysis_id = COALESCE(?, output_analysis_id), match_gain_db = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      [
        patch.status,
        patch.renderer ?? null,
        patch.rendererVersion ?? null,
        patch.placeholder ? 1 : 0,
        patch.outputAssetId ?? null,
        patch.outputAnalysisId ?? null,
        patch.matchGainDb ?? null,
        patch.failureReason ?? null,
        this.clock.isoNow(),
        id,
        orgId,
      ],
    )
  }

  async setOutputAnalysis(orgId: string, id: string, analysisId: string, matchGainDb: number | null): Promise<void> {
    await this.db.run('UPDATE studio_master_renditions SET output_analysis_id = ?, match_gain_db = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      analysisId,
      matchGainDb,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  /**
   * Marks one rendition chosen.
   *
   * Exclusive within a project: choosing B un-chooses A. Two "approved" masters
   * is not a state a delivery pipeline can act on.
   */
  async choose(orgId: string, projectId: string, id: string): Promise<void> {
    await this.db.run('UPDATE studio_master_renditions SET approved = 0, updated_at = ? WHERE org_id = ? AND studio_project_id = ?', [
      this.clock.isoNow(),
      orgId,
      projectId,
    ])
    await this.db.run('UPDATE studio_master_renditions SET approved = 1, updated_at = ? WHERE id = ? AND org_id = ?', [this.clock.isoNow(), id, orgId])
  }

  /** Which slots this version already has, so a new rendition gets a free one. */
  async usedSlots(orgId: string, versionId: string): Promise<string[]> {
    const rows = await this.db.query('SELECT slot FROM studio_master_renditions WHERE org_id = ? AND source_version_id = ?', [orgId, versionId])
    return rows.map((row) => toStr(row.slot))
  }
}

export class StudioAlbumRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: { orgId: string; title: string; artistName: string; gapDefaultMs?: number; createdBy: string }): Promise<StudioAlbumRecord> {
    const now = this.clock.isoNow()
    const record: StudioAlbumRecord = {
      id: newId('stal', this.clock.now()),
      orgId: input.orgId,
      title: input.title,
      artistName: input.artistName,
      status: 'draft',
      cohesionScore: null,
      cohesionReport: '',
      gapDefaultMs: input.gapDefaultMs ?? 1500,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_albums', {
      id: record.id,
      org_id: record.orgId,
      title: record.title,
      artist_name: record.artistName,
      status: record.status,
      cohesion_score: null,
      cohesion_report: '',
      gap_default_ms: record.gapDefaultMs,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<StudioAlbumRecord> {
    const row = await this.db.get('SELECT * FROM studio_albums WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('album', id)
    return mapAlbum(row)
  }

  async list(orgId: string): Promise<StudioAlbumRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_albums WHERE org_id = ? ORDER BY created_at DESC', [orgId])
    return rows.map(mapAlbum)
  }

  async setCohesion(orgId: string, id: string, score: number | null, report: string): Promise<void> {
    await this.db.run('UPDATE studio_albums SET cohesion_score = ?, cohesion_report = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      score,
      report,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async addTrack(input: {
    orgId: string
    albumId: string
    studioProjectId: string
    studioVersionId?: string | null
    orderIndex?: number
    gapMs?: number
  }): Promise<StudioAlbumTrackRecord> {
    const now = this.clock.isoNow()
    const existing = await this.tracks(input.orgId, input.albumId)
    const record: StudioAlbumTrackRecord = {
      id: newId('stat', this.clock.now()),
      orgId: input.orgId,
      albumId: input.albumId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      orderIndex: input.orderIndex ?? existing.length,
      gapMs: input.gapMs ?? 1500,
      createdAt: now,
    }
    await insertRow(this.db, 'studio_album_tracks', {
      id: record.id,
      org_id: record.orgId,
      album_id: record.albumId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      order_index: record.orderIndex,
      gap_ms: record.gapMs,
      created_at: now,
    })
    return record
  }

  async tracks(orgId: string, albumId: string): Promise<StudioAlbumTrackRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_album_tracks WHERE org_id = ? AND album_id = ? ORDER BY order_index ASC', [orgId, albumId])
    return rows.map((row) => ({
      id: toStr(row.id),
      orgId: toStr(row.org_id),
      albumId: toStr(row.album_id),
      studioProjectId: toStr(row.studio_project_id),
      studioVersionId: toStrOrNull(row.studio_version_id),
      orderIndex: toNum(row.order_index),
      gapMs: toNum(row.gap_ms),
      createdAt: toStr(row.created_at),
    }))
  }

  async reorder(orgId: string, albumId: string, orderedTrackIds: string[]): Promise<void> {
    for (let index = 0; index < orderedTrackIds.length; index++) {
      await this.db.run('UPDATE studio_album_tracks SET order_index = ? WHERE id = ? AND org_id = ? AND album_id = ?', [index, orderedTrackIds[index], orgId, albumId])
    }
    await this.db.run('UPDATE studio_albums SET updated_at = ? WHERE id = ? AND org_id = ?', [this.clock.isoNow(), albumId, orgId])
  }

  async setGap(orgId: string, trackId: string, gapMs: number): Promise<void> {
    await this.db.run('UPDATE studio_album_tracks SET gap_ms = ? WHERE id = ? AND org_id = ?', [gapMs, trackId, orgId])
  }

  async removeTrack(orgId: string, trackId: string): Promise<void> {
    await this.db.run('DELETE FROM studio_album_tracks WHERE id = ? AND org_id = ?', [trackId, orgId])
  }
}

function mapRendition(row: Row): MasterRenditionRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    sourceVersionId: toStr(row.source_version_id),
    slot: toStr(row.slot) as 'a' | 'b' | 'c',
    direction: toStr(row.direction),
    priorities: parseJson<Record<string, number | boolean>>(row.priorities, {}),
    targetLufs: toNumOrNull(row.target_lufs),
    targetTruePeak: toNumOrNull(row.target_true_peak),
    status: toStr(row.status) as MasterRenditionStatus,
    renderPlan: parseJson<unknown>(row.render_plan, null),
    renderer: toStrOrNull(row.renderer),
    rendererVersion: toStrOrNull(row.renderer_version),
    placeholder: toBool(row.placeholder),
    outputAssetId: toStrOrNull(row.output_asset_id),
    outputAnalysisId: toStrOrNull(row.output_analysis_id),
    matchGainDb: toNumOrNull(row.match_gain_db),
    failureReason: toStrOrNull(row.failure_reason),
    approved: toBool(row.approved),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapAlbum(row: Row): StudioAlbumRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    title: toStr(row.title),
    artistName: toStr(row.artist_name),
    status: toStr(row.status),
    cohesionScore: toNumOrNull(row.cohesion_score),
    cohesionReport: toStr(row.cohesion_report),
    gapDefaultMs: toNum(row.gap_default_ms),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
