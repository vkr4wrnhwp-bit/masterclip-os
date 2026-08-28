import { insertRow, toBool, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { AppError, forbidden, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { StudioProjectRecord, StudioStage, StudioVersionRecord, StudioVersionSource, StudioVersionType } from './types.js'

/**
 * The canonical project, and its versions.
 *
 * Every read takes an orgId and filters on it in SQL. There is no method here
 * that fetches a project by id alone, because that is the shape of query that
 * eventually leaks one artist's unreleased record to another organization.
 */
export class StudioProjectRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    artistName: string
    artistId?: string | null
    title: string
    genre: string
    rightsConfirmationId: string
    songLabProjectId?: string | null
    liveProjectId?: string | null
    releaseId?: string | null
    releaseDate?: string | null
    notes?: string
    demo?: boolean
    createdBy: string
  }): Promise<StudioProjectRecord> {
    const now = this.clock.isoNow()
    const record: StudioProjectRecord = {
      id: newId('stp', this.clock.now()),
      orgId: input.orgId,
      artistName: input.artistName,
      artistId: input.artistId ?? null,
      title: input.title,
      genre: input.genre,
      stage: 'create',
      artworkAssetId: null,
      currentVersionId: null,
      approvedMixVersionId: null,
      approvedMasterVersionId: null,
      releaseDate: input.releaseDate ?? null,
      rightsConfirmationId: input.rightsConfirmationId,
      songLabProjectId: input.songLabProjectId ?? null,
      liveProjectId: input.liveProjectId ?? null,
      releaseId: input.releaseId ?? null,
      notes: input.notes ?? '',
      demo: input.demo ?? false,
      archivedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_projects', {
      id: record.id,
      org_id: record.orgId,
      artist_name: record.artistName,
      artist_id: record.artistId,
      title: record.title,
      genre: record.genre,
      stage: record.stage,
      artwork_asset_id: null,
      current_version_id: null,
      approved_mix_version_id: null,
      approved_master_version_id: null,
      release_date: record.releaseDate,
      rights_confirmation_id: record.rightsConfirmationId,
      song_lab_project_id: record.songLabProjectId,
      live_project_id: record.liveProjectId,
      release_id: record.releaseId,
      notes: record.notes,
      demo: record.demo ? 1 : 0,
      archived_at: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<StudioProjectRecord> {
    const row = await this.db.get('SELECT * FROM studio_projects WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('studio project', id)
    return mapProject(row)
  }

  /**
   * Loads a project without an org filter, for background jobs that only carry
   * an id. The caller passes the org the job believes it is acting for, and a
   * mismatch is refused rather than silently trusted.
   */
  async getForJob(id: string, expectedOrgId: string): Promise<StudioProjectRecord> {
    const row = await this.db.get('SELECT * FROM studio_projects WHERE id = ?', [id])
    if (!row) throw notFound('studio project', id)
    const project = mapProject(row)
    if (project.orgId !== expectedOrgId) throw forbidden('studio project belongs to another organization')
    return project
  }

  async list(orgId: string, opts: { includeArchived?: boolean; limit?: number } = {}): Promise<StudioProjectRecord[]> {
    const limit = Math.floor(opts.limit ?? 200)
    const rows = await this.db.query(
      `SELECT * FROM studio_projects WHERE org_id = ?${opts.includeArchived ? '' : ' AND archived_at IS NULL'} ORDER BY updated_at DESC LIMIT ${limit}`,
      [orgId],
    )
    return rows.map(mapProject)
  }

  async countForOrg(orgId: string): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM studio_projects WHERE org_id = ?', [orgId])
    return toNum(row?.total)
  }

  async findBySongLabProject(orgId: string, songLabProjectId: string): Promise<StudioProjectRecord | null> {
    const row = await this.db.get('SELECT * FROM studio_projects WHERE org_id = ? AND song_lab_project_id = ?', [orgId, songLabProjectId])
    return row ? mapProject(row) : null
  }

  async update(
    orgId: string,
    id: string,
    patch: Partial<
      Pick<
        StudioProjectRecord,
        'title' | 'artistName' | 'artistId' | 'genre' | 'notes' | 'releaseDate' | 'artworkAssetId' | 'songLabProjectId' | 'liveProjectId' | 'releaseId'
      >
    >,
  ): Promise<StudioProjectRecord> {
    await this.get(orgId, id)
    const columns: Record<string, string> = {
      title: 'title',
      artistName: 'artist_name',
      artistId: 'artist_id',
      genre: 'genre',
      notes: 'notes',
      releaseDate: 'release_date',
      artworkAssetId: 'artwork_asset_id',
      songLabProjectId: 'song_lab_project_id',
      liveProjectId: 'live_project_id',
      releaseId: 'release_id',
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
      await this.db.run(`UPDATE studio_projects SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, [...params, id, orgId])
    }
    return this.get(orgId, id)
  }

  async setStage(orgId: string, id: string, stage: StudioStage): Promise<void> {
    await this.db.run('UPDATE studio_projects SET stage = ?, updated_at = ? WHERE id = ? AND org_id = ?', [stage, this.clock.isoNow(), id, orgId])
  }

  async setCurrentVersion(orgId: string, id: string, versionId: string): Promise<void> {
    await this.db.run('UPDATE studio_projects SET current_version_id = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      versionId,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async setApprovedVersion(orgId: string, id: string, kind: 'mix' | 'master', versionId: string | null): Promise<void> {
    const column = kind === 'mix' ? 'approved_mix_version_id' : 'approved_master_version_id'
    await this.db.run(`UPDATE studio_projects SET ${column} = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [
      versionId,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  /**
   * Archives rather than deletes.
   *
   * A project carries approvals, a passport and a delivery history — records
   * that exist precisely so somebody can answer questions about the past.
   * Deleting the project would delete the answers.
   */
  async archive(orgId: string, id: string): Promise<void> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_projects SET archived_at = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      this.clock.isoNow(),
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async unarchive(orgId: string, id: string): Promise<void> {
    await this.db.run('UPDATE studio_projects SET archived_at = NULL, updated_at = ? WHERE id = ? AND org_id = ?', [this.clock.isoNow(), id, orgId])
  }
}

export class StudioVersionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    parentVersionId?: string | null
    versionType: StudioVersionType
    label?: string
    assetId?: string | null
    assetChecksum?: string | null
    sourceKind: StudioVersionSource
    masterRenditionId?: string | null
    durationMs?: number | null
    sampleRate?: number | null
    bitDepth?: number | null
    channels?: number | null
    notes?: string
    createdBy: string
  }): Promise<StudioVersionRecord> {
    const now = this.clock.isoNow()
    // Ordinals are per type, so the labels a user reads — Mix 01, Mix 02 — stay
    // stable and sequential even as masters and instrumentals interleave.
    const ordinal = (await this.countOfType(input.orgId, input.studioProjectId, input.versionType)) + 1
    const record: StudioVersionRecord = {
      id: newId('stv', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      parentVersionId: input.parentVersionId ?? null,
      versionType: input.versionType,
      label: input.label && input.label.length > 0 ? input.label : defaultLabel(input.versionType, ordinal),
      ordinal,
      assetId: input.assetId ?? null,
      assetChecksum: input.assetChecksum ?? null,
      sourceKind: input.sourceKind,
      masterRenditionId: input.masterRenditionId ?? null,
      durationMs: input.durationMs ?? null,
      sampleRate: input.sampleRate ?? null,
      bitDepth: input.bitDepth ?? null,
      channels: input.channels ?? null,
      approved: false,
      approvalId: null,
      supersededAt: null,
      notes: input.notes ?? '',
      createdBy: input.createdBy,
      createdAt: now,
    }
    await insertRow(this.db, 'studio_versions', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      parent_version_id: record.parentVersionId,
      version_type: record.versionType,
      label: record.label,
      ordinal: record.ordinal,
      asset_id: record.assetId,
      asset_checksum: record.assetChecksum,
      source_kind: record.sourceKind,
      master_rendition_id: record.masterRenditionId,
      duration_ms: record.durationMs,
      sample_rate: record.sampleRate,
      bit_depth: record.bitDepth,
      channels: record.channels,
      approved: 0,
      approval_id: null,
      superseded_at: null,
      notes: record.notes,
      created_by: record.createdBy,
      created_at: now,
    })

    // Previous versions of the same type are marked superseded — which records
    // that a newer one exists and nothing else. The row and its audio stay
    // exactly where they were.
    await this.db.run(
      'UPDATE studio_versions SET superseded_at = ? WHERE org_id = ? AND studio_project_id = ? AND version_type = ? AND id != ? AND superseded_at IS NULL',
      [now, input.orgId, input.studioProjectId, input.versionType, record.id],
    )
    return record
  }

  private async countOfType(orgId: string, projectId: string, versionType: StudioVersionType): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM studio_versions WHERE org_id = ? AND studio_project_id = ? AND version_type = ?', [
      orgId,
      projectId,
      versionType,
    ])
    return toNum(row?.total)
  }

  async get(orgId: string, id: string): Promise<StudioVersionRecord> {
    const row = await this.db.get('SELECT * FROM studio_versions WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('studio version', id)
    return mapVersion(row)
  }

  async list(orgId: string, projectId: string): Promise<StudioVersionRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_versions WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at ASC', [orgId, projectId])
    return rows.map(mapVersion)
  }

  async countForProject(orgId: string, projectId: string): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM studio_versions WHERE org_id = ? AND studio_project_id = ?', [orgId, projectId])
    return toNum(row?.total)
  }

  /** Walks parent pointers back to the original upload. */
  async lineage(orgId: string, versionId: string): Promise<StudioVersionRecord[]> {
    const chain: StudioVersionRecord[] = []
    let current: string | null = versionId
    // Bounded: a cycle would otherwise hang the request, and lineage that deep
    // is a bug rather than a real history.
    for (let step = 0; step < 64 && current; step++) {
      const row: Row | undefined = await this.db.get('SELECT * FROM studio_versions WHERE id = ? AND org_id = ?', [current, orgId])
      if (!row) break
      const version = mapVersion(row)
      chain.unshift(version)
      current = version.parentVersionId
    }
    return chain
  }

  async markApproved(orgId: string, id: string, approvalId: string): Promise<void> {
    await this.db.run('UPDATE studio_versions SET approved = 1, approval_id = ? WHERE id = ? AND org_id = ?', [approvalId, id, orgId])
  }

  async clearApproval(orgId: string, id: string): Promise<void> {
    await this.db.run('UPDATE studio_versions SET approved = 0, approval_id = NULL WHERE id = ? AND org_id = ?', [id, orgId])
  }

  async setLabel(orgId: string, id: string, label: string): Promise<void> {
    await this.db.run('UPDATE studio_versions SET label = ? WHERE id = ? AND org_id = ?', [label, id, orgId])
  }

  /**
   * Deleting a version.
   *
   * Refused for anything that carries audio or an approval. The spec for this
   * module is that a new version never removes an old one; the only rows this
   * will remove are empty placeholders created in error. Making that a refusal
   * in the repository rather than a rule in a service means no future caller
   * can bypass it by accident.
   */
  async deletePlaceholder(orgId: string, id: string): Promise<void> {
    const version = await this.get(orgId, id)
    if (version.assetId) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.version_not_deletable',
        message: 'a version that carries audio is never deleted — every mix stays playable',
      })
    }
    if (version.approved) {
      throw new AppError({ kind: 'validation', code: 'studio.version_approved', message: 'an approved version cannot be deleted' })
    }
    await this.db.run('DELETE FROM studio_versions WHERE id = ? AND org_id = ?', [id, orgId])
  }
}

function defaultLabel(versionType: StudioVersionType, ordinal: number): string {
  const base: Record<string, string> = {
    demo: 'Demo',
    rough: 'Rough',
    mix: 'Mix',
    approved_mix: 'Approved Mix',
    master: 'Master',
    final_master: 'Final Master',
    clean: 'Clean',
    instrumental: 'Instrumental',
    acapella: 'Acapella',
    tv_track: 'TV Track',
    performance_track: 'Performance Track',
    stems: 'Stems',
    spatial: 'Spatial',
  }
  const label = base[versionType] ?? 'Version'
  // Numbered types are the iterative ones. "Approved Mix 01" reads as a mistake.
  const numbered = ['mix', 'master', 'demo', 'rough'].includes(versionType)
  return numbered ? `${label} ${String(ordinal).padStart(2, '0')}` : ordinal > 1 ? `${label} ${ordinal}` : label
}

export function mapProject(row: Row): StudioProjectRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    artistName: toStr(row.artist_name),
    artistId: toStrOrNull(row.artist_id),
    title: toStr(row.title),
    genre: toStr(row.genre),
    stage: toStr(row.stage) as StudioStage,
    artworkAssetId: toStrOrNull(row.artwork_asset_id),
    currentVersionId: toStrOrNull(row.current_version_id),
    approvedMixVersionId: toStrOrNull(row.approved_mix_version_id),
    approvedMasterVersionId: toStrOrNull(row.approved_master_version_id),
    releaseDate: toStrOrNull(row.release_date),
    rightsConfirmationId: toStr(row.rights_confirmation_id),
    songLabProjectId: toStrOrNull(row.song_lab_project_id),
    liveProjectId: toStrOrNull(row.live_project_id),
    releaseId: toStrOrNull(row.release_id),
    notes: toStr(row.notes),
    demo: toBool(row.demo),
    archivedAt: toStrOrNull(row.archived_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

export function mapVersion(row: Row): StudioVersionRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    parentVersionId: toStrOrNull(row.parent_version_id),
    versionType: toStr(row.version_type) as StudioVersionType,
    label: toStr(row.label),
    ordinal: toNum(row.ordinal),
    assetId: toStrOrNull(row.asset_id),
    assetChecksum: toStrOrNull(row.asset_checksum),
    sourceKind: toStr(row.source_kind) as StudioVersionSource,
    masterRenditionId: toStrOrNull(row.master_rendition_id),
    durationMs: toNumOrNull(row.duration_ms),
    sampleRate: toNumOrNull(row.sample_rate),
    bitDepth: toNumOrNull(row.bit_depth),
    channels: toNumOrNull(row.channels),
    approved: toBool(row.approved),
    approvalId: toStrOrNull(row.approval_id),
    supersededAt: toStrOrNull(row.superseded_at),
    notes: toStr(row.notes),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}
