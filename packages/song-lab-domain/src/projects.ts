import { insertRow, toBool, toNum, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { forbidden, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { SongLabProjectRecord, SongLabProjectStatus, SongVersionRecord, SongVersionType } from './types.js'

/**
 * Projects and version lineage.
 *
 * Every read takes an orgId and filters on it in SQL. There is no method here
 * that fetches a project by id alone, because that is the shape of query that
 * eventually leaks one tenant's music to another.
 */
export class SongLabProjectRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    artistId: string | null
    artistName: string
    title: string
    genre: string
    rightsConfirmationId: string
    titlePhrase?: string
    notes?: string
    demo?: boolean
    createdBy: string
  }): Promise<SongLabProjectRecord> {
    const now = this.clock.isoNow()
    const record: SongLabProjectRecord = {
      id: newId('slp', this.clock.now()),
      orgId: input.orgId,
      artistId: input.artistId,
      artistName: input.artistName,
      title: input.title,
      genre: input.genre,
      status: 'awaiting_audio',
      sourceAssetId: null,
      currentVersionId: null,
      selectedBenchmarkCohortId: null,
      rightsConfirmationId: input.rightsConfirmationId,
      titlePhrase: input.titlePhrase ?? '',
      notes: input.notes ?? '',
      demo: input.demo ?? false,
      reviewCompletedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'song_lab_projects', {
      id: record.id,
      org_id: record.orgId,
      artist_id: record.artistId,
      artist_name: record.artistName,
      title: record.title,
      genre: record.genre,
      status: record.status,
      source_asset_id: null,
      current_version_id: null,
      selected_benchmark_cohort_id: null,
      rights_confirmation_id: record.rightsConfirmationId,
      title_phrase: record.titlePhrase,
      notes: record.notes,
      demo: record.demo ? 1 : 0,
      review_completed_at: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<SongLabProjectRecord> {
    const row = await this.db.get('SELECT * FROM song_lab_projects WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('song lab project', id)
    return mapProject(row)
  }

  /**
   * Loads a project without an org filter, for background jobs that only carry
   * an id. The caller must pass the org the job believes it is acting for, and
   * a mismatch is refused rather than silently trusted.
   */
  async getForJob(id: string, expectedOrgId: string): Promise<SongLabProjectRecord> {
    const row = await this.db.get('SELECT * FROM song_lab_projects WHERE id = ?', [id])
    if (!row) throw notFound('song lab project', id)
    const project = mapProject(row)
    if (project.orgId !== expectedOrgId) throw forbidden('song lab project belongs to another organization')
    return project
  }

  async list(orgId: string, limit = 100): Promise<SongLabProjectRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM song_lab_projects WHERE org_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId],
    )
    return rows.map(mapProject)
  }

  async countForOrg(orgId: string): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM song_lab_projects WHERE org_id = ?', [orgId])
    return toNum(row?.total)
  }

  async update(
    orgId: string,
    id: string,
    patch: Partial<Pick<SongLabProjectRecord, 'title' | 'genre' | 'artistName' | 'artistId' | 'titlePhrase' | 'notes' | 'selectedBenchmarkCohortId'>>,
  ): Promise<SongLabProjectRecord> {
    await this.get(orgId, id)
    const columns: Record<string, string> = {
      title: 'title',
      genre: 'genre',
      artistName: 'artist_name',
      artistId: 'artist_id',
      titlePhrase: 'title_phrase',
      notes: 'notes',
      selectedBenchmarkCohortId: 'selected_benchmark_cohort_id',
    }
    const sets: string[] = []
    const params: Array<string | null> = []
    for (const [key, column] of Object.entries(columns)) {
      const value = patch[key as keyof typeof patch]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      params.push(value as string | null)
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?')
      params.push(this.clock.isoNow())
      await this.db.run(`UPDATE song_lab_projects SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, [...params, id, orgId])
    }
    return this.get(orgId, id)
  }

  async setStatus(orgId: string, id: string, status: SongLabProjectStatus): Promise<void> {
    await this.db.run('UPDATE song_lab_projects SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      status,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async setSource(orgId: string, id: string, assetId: string, versionId: string): Promise<void> {
    await this.db.run(
      'UPDATE song_lab_projects SET source_asset_id = ?, current_version_id = ?, status = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      [assetId, versionId, 'analyzing', this.clock.isoNow(), id, orgId],
    )
  }

  async setCurrentVersion(orgId: string, id: string, versionId: string): Promise<void> {
    await this.db.run('UPDATE song_lab_projects SET current_version_id = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      versionId,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async markReviewComplete(orgId: string, id: string): Promise<void> {
    const now = this.clock.isoNow()
    await this.db.run(
      'UPDATE song_lab_projects SET status = ?, review_completed_at = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      ['review_complete', now, now, id, orgId],
    )
  }

  async delete(orgId: string, id: string): Promise<void> {
    await this.get(orgId, id)
    await this.db.run('DELETE FROM song_lab_projects WHERE id = ? AND org_id = ?', [id, orgId])
  }
}

export class SongVersionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    songLabProjectId: string
    parentVersionId: string | null
    versionType: SongVersionType
    versionLabel: string
    sourceAssetId: string | null
    experimentId?: string | null
    notes?: string
    createdBy: string
  }): Promise<SongVersionRecord> {
    const now = this.clock.isoNow()
    const record: SongVersionRecord = {
      id: newId('sv', this.clock.now()),
      orgId: input.orgId,
      songLabProjectId: input.songLabProjectId,
      parentVersionId: input.parentVersionId,
      versionType: input.versionType,
      versionLabel: input.versionLabel,
      sourceAssetId: input.sourceAssetId,
      experimentId: input.experimentId ?? null,
      notes: input.notes ?? '',
      createdBy: input.createdBy,
      createdAt: now,
    }
    await insertRow(this.db, 'song_versions', {
      id: record.id,
      org_id: record.orgId,
      song_lab_project_id: record.songLabProjectId,
      parent_version_id: record.parentVersionId,
      version_type: record.versionType,
      version_label: record.versionLabel,
      source_asset_id: record.sourceAssetId,
      experiment_id: record.experimentId,
      notes: record.notes,
      created_by: record.createdBy,
      created_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<SongVersionRecord> {
    const row = await this.db.get('SELECT * FROM song_versions WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('song version', id)
    return mapVersion(row)
  }

  async list(orgId: string, projectId: string): Promise<SongVersionRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_versions WHERE org_id = ? AND song_lab_project_id = ? ORDER BY created_at ASC',
      [orgId, projectId],
    )
    return rows.map(mapVersion)
  }

  /** Walks parent pointers back to the original upload. */
  async lineage(orgId: string, versionId: string): Promise<SongVersionRecord[]> {
    const chain: SongVersionRecord[] = []
    let current: string | null = versionId
    // Bounded: a cycle would otherwise hang the request, and lineage that deep
    // is a bug rather than a real edit history.
    for (let step = 0; step < 64 && current; step++) {
      const row: Row | undefined = await this.db.get('SELECT * FROM song_versions WHERE id = ? AND org_id = ?', [current, orgId])
      if (!row) break
      const version = mapVersion(row)
      chain.unshift(version)
      current = version.parentVersionId
    }
    return chain
  }
}

function mapProject(row: Row): SongLabProjectRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    artistId: toStrOrNull(row.artist_id),
    artistName: toStr(row.artist_name),
    title: toStr(row.title),
    genre: toStr(row.genre),
    status: toStr(row.status) as SongLabProjectStatus,
    sourceAssetId: toStrOrNull(row.source_asset_id),
    currentVersionId: toStrOrNull(row.current_version_id),
    selectedBenchmarkCohortId: toStrOrNull(row.selected_benchmark_cohort_id),
    rightsConfirmationId: toStr(row.rights_confirmation_id),
    titlePhrase: toStr(row.title_phrase),
    notes: toStr(row.notes),
    demo: toBool(row.demo),
    reviewCompletedAt: toStrOrNull(row.review_completed_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapVersion(row: Row): SongVersionRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    parentVersionId: toStrOrNull(row.parent_version_id),
    versionType: toStr(row.version_type) as SongVersionType,
    versionLabel: toStr(row.version_label),
    sourceAssetId: toStrOrNull(row.source_asset_id),
    experimentId: toStrOrNull(row.experiment_id),
    notes: toStr(row.notes),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}

export { mapProject, mapVersion }
