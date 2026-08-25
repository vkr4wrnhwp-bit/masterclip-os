import { insertRow, toStr, toStrOrNull, updateRow, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { SongVocalStemRecord, VocalStemStatus } from './types.js'

/**
 * Separated vocal stems.
 *
 * The row exists before the audio does: separation is a queued job, so a
 * `pending` row is written first and the asset id is filled in when the job
 * finishes. That ordering is what lets the UI say "separating" instead of
 * showing nothing, and what stops a second request queueing a duplicate job.
 *
 * Every read filters on org_id in SQL.
 */
export class SongVocalStemRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    songLabProjectId: string
    songVersionId: string
    sourceAssetId: string
    sourceChecksum: string
    provider: string
    modelVersion: string
    createdBy: string
  }): Promise<SongVocalStemRecord> {
    const now = this.clock.isoNow()
    const record: SongVocalStemRecord = {
      id: newId('vst', this.clock.now()),
      orgId: input.orgId,
      songLabProjectId: input.songLabProjectId,
      songVersionId: input.songVersionId,
      sourceAssetId: input.sourceAssetId,
      sourceChecksum: input.sourceChecksum,
      stemAssetId: null,
      status: 'pending',
      stemName: null,
      provider: input.provider,
      modelVersion: input.modelVersion,
      failureReason: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'song_vocal_stems', {
      id: record.id,
      org_id: record.orgId,
      song_lab_project_id: record.songLabProjectId,
      song_version_id: record.songVersionId,
      source_asset_id: record.sourceAssetId,
      source_checksum: record.sourceChecksum,
      stem_asset_id: null,
      status: record.status,
      stem_name: null,
      provider: record.provider,
      model_version: record.modelVersion,
      failure_reason: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<SongVocalStemRecord> {
    const row = await this.db.get('SELECT * FROM song_vocal_stems WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('vocal stem', id)
    return mapStem(row)
  }

  /** Used by the worker, which knows the id before it can prove the org. */
  async getAnyOrg(id: string): Promise<SongVocalStemRecord> {
    const row = await this.db.get('SELECT * FROM song_vocal_stems WHERE id = ?', [id])
    if (!row) throw notFound('vocal stem', id)
    return mapStem(row)
  }

  /**
   * The stem the analysis pipeline should measure from, or null.
   *
   * Only a `ready` stem whose source checksum still matches the mix qualifies.
   * A stem separated from a different recording is not a stem of this one, and
   * silently measuring it would attach an isolated-stem confidence to numbers
   * that describe some other audio.
   */
  async readyForVersion(orgId: string, versionId: string, sourceChecksum: string): Promise<SongVocalStemRecord | null> {
    const row = await this.db.get(
      `SELECT * FROM song_vocal_stems
        WHERE org_id = ? AND song_version_id = ? AND source_checksum = ? AND status = 'ready' AND stem_asset_id IS NOT NULL
        ORDER BY created_at DESC`,
      [orgId, versionId, sourceChecksum],
    )
    return row ? mapStem(row) : null
  }

  /** The most recent attempt for a version, whatever its outcome. */
  async latestForVersion(orgId: string, versionId: string): Promise<SongVocalStemRecord | null> {
    const row = await this.db.get(
      'SELECT * FROM song_vocal_stems WHERE org_id = ? AND song_version_id = ? ORDER BY created_at DESC',
      [orgId, versionId],
    )
    return row ? mapStem(row) : null
  }

  async list(orgId: string, projectId: string): Promise<SongVocalStemRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_vocal_stems WHERE org_id = ? AND song_lab_project_id = ? ORDER BY created_at DESC',
      [orgId, projectId],
    )
    return rows.map(mapStem)
  }

  async markReady(id: string, input: { stemAssetId: string; stemName: string }): Promise<void> {
    await updateRow(this.db, 'song_vocal_stems', id, {
      status: 'ready',
      stem_asset_id: input.stemAssetId,
      stem_name: input.stemName,
      failure_reason: null,
      updated_at: this.clock.isoNow(),
    })
  }

  async markFailed(id: string, status: Extract<VocalStemStatus, 'failed' | 'unsupported'>, reason: string): Promise<void> {
    await updateRow(this.db, 'song_vocal_stems', id, {
      status,
      failure_reason: reason,
      updated_at: this.clock.isoNow(),
    })
  }
}

function mapStem(row: Row): SongVocalStemRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    songVersionId: toStr(row.song_version_id),
    sourceAssetId: toStr(row.source_asset_id),
    sourceChecksum: toStr(row.source_checksum),
    stemAssetId: toStrOrNull(row.stem_asset_id),
    status: toStr(row.status) as VocalStemStatus,
    stemName: toStrOrNull(row.stem_name),
    provider: toStr(row.provider),
    modelVersion: toStr(row.model_version),
    failureReason: toStrOrNull(row.failure_reason),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
