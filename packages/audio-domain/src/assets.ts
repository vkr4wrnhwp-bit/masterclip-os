import { type Db, insertRow, toNumOrNull, toStr, toStrOrNull, toNum } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { RetentionKind } from '@masterclip/audio-core'

export type AudioProjectType =
  | 'meeting'
  | 'brief'
  | 'agent'
  | 'global_release'
  | 'campaign'
  | 'remix'
  | 'voice_vault'
  | 'library'
  // Song Lab sources and rendered experiment previews. Stored by the same
  // asset service as every other audio file, so tenant prefixes, retention and
  // signed-URL serving are one implementation rather than two.
  | 'song_lab'

export interface AudioAssetRecord {
  id: string
  orgId: string
  ownerUserId: string
  projectType: AudioProjectType
  projectId: string | null
  assetType: string
  storageKey: string
  fileName: string
  mimeType: string
  fileSize: number
  durationMs: number | null
  checksum: string
  rightsStatus: string
  consentRecordId: string | null
  retentionKind: RetentionKind
  retentionExpiresAt: string | null
  deletedAt: string | null
  createdAt: string
}

export interface AudioGenerationRecord {
  id: string
  orgId: string
  projectType: AudioProjectType
  projectId: string | null
  outputAssetId: string
  provider: string
  model: string
  operation: string
  voiceProfileId: string | null
  prompt: string
  configuration: Record<string, unknown>
  rightsBasis: string
  consentRecordId: string | null
  parentGenerationId: string | null
  createdBy: string
  createdAt: string
}

/**
 * Audio assets and generation lineage.
 *
 * `get` takes the org id and filters on it — a valid asset id from another
 * tenant is indistinguishable from a missing one, which is the correct
 * information leak: none.
 */
export class AudioAssetRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: Omit<AudioAssetRecord, 'id' | 'createdAt' | 'deletedAt'>): Promise<AudioAssetRecord> {
    const record: AudioAssetRecord = { ...input, id: newId('aast', this.clock.now()), deletedAt: null, createdAt: this.clock.isoNow() }
    await insertRow(this.db, 'audio_assets', {
      id: record.id,
      org_id: record.orgId,
      owner_user_id: record.ownerUserId,
      project_type: record.projectType,
      project_id: record.projectId,
      asset_type: record.assetType,
      storage_key: record.storageKey,
      file_name: record.fileName,
      mime_type: record.mimeType,
      file_size: record.fileSize,
      duration_ms: record.durationMs,
      checksum: record.checksum,
      rights_status: record.rightsStatus,
      consent_record_id: record.consentRecordId,
      retention_kind: record.retentionKind,
      retention_expires_at: record.retentionExpiresAt,
      deleted_at: null,
      delete_reason: null,
      created_at: record.createdAt,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<AudioAssetRecord> {
    const row = await this.db.get('SELECT * FROM audio_assets WHERE id = ? AND org_id = ? AND deleted_at IS NULL', [id, orgId])
    if (!row) throw notFound('audio asset', id)
    return mapAsset(row)
  }

  async findByChecksum(orgId: string, checksum: string): Promise<AudioAssetRecord | null> {
    const row = await this.db.get('SELECT * FROM audio_assets WHERE org_id = ? AND checksum = ? AND deleted_at IS NULL', [orgId, checksum])
    return row ? mapAsset(row) : null
  }

  async list(orgId: string, filter: { projectType?: AudioProjectType; projectId?: string } = {}, limit = 200): Promise<AudioAssetRecord[]> {
    const clauses = ['org_id = ?', 'deleted_at IS NULL']
    const params: (string | number)[] = [orgId]
    if (filter.projectType) {
      clauses.push('project_type = ?')
      params.push(filter.projectType)
    }
    if (filter.projectId) {
      clauses.push('project_id = ?')
      params.push(filter.projectId)
    }
    const rows = await this.db.query(
      `SELECT * FROM audio_assets WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      params,
    )
    return rows.map(mapAsset)
  }

  async attachToProject(orgId: string, id: string, projectType: AudioProjectType, projectId: string): Promise<void> {
    await this.db.run('UPDATE audio_assets SET project_type = ?, project_id = ? WHERE id = ? AND org_id = ?', [
      projectType,
      projectId,
      id,
      orgId,
    ])
  }

  /**
   * Soft delete: the row survives as audit metadata (who uploaded what, when,
   * under which rights), the bytes are removed by the caller. Retention
   * cleanup and manual deletion both land here.
   */
  async markDeleted(orgId: string, id: string, reason: string): Promise<AudioAssetRecord> {
    const asset = await this.get(orgId, id)
    await this.db.run('UPDATE audio_assets SET deleted_at = ?, delete_reason = ? WHERE id = ? AND org_id = ?', [
      this.clock.isoNow(),
      reason,
      id,
      orgId,
    ])
    return asset
  }

  /** Assets whose retention deadline has passed, across all orgs (worker sweep). */
  async listExpired(nowIso: string, limit = 100): Promise<AudioAssetRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM audio_assets
        WHERE deleted_at IS NULL AND retention_expires_at IS NOT NULL AND retention_expires_at < ?
        ORDER BY retention_expires_at ASC LIMIT ${Math.floor(limit)}`,
      [nowIso],
    )
    return rows.map(mapAsset)
  }

  async recordGeneration(input: Omit<AudioGenerationRecord, 'id' | 'createdAt'>): Promise<AudioGenerationRecord> {
    const record: AudioGenerationRecord = { ...input, id: newId('agen', this.clock.now()), createdAt: this.clock.isoNow() }
    await insertRow(this.db, 'audio_generations', {
      id: record.id,
      org_id: record.orgId,
      project_type: record.projectType,
      project_id: record.projectId,
      output_asset_id: record.outputAssetId,
      provider: record.provider,
      model: record.model,
      operation: record.operation,
      voice_profile_id: record.voiceProfileId,
      prompt: record.prompt,
      configuration: JSON.stringify(record.configuration),
      rights_basis: record.rightsBasis,
      consent_record_id: record.consentRecordId,
      parent_generation_id: record.parentGenerationId,
      created_by: record.createdBy,
      created_at: record.createdAt,
    })
    return record
  }

  async generationsForProject(orgId: string, projectType: AudioProjectType, projectId: string): Promise<AudioGenerationRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM audio_generations WHERE org_id = ? AND project_type = ? AND project_id = ? ORDER BY created_at DESC',
      [orgId, projectType, projectId],
    )
    return rows.map(mapGeneration)
  }
}

function mapAsset(row: Record<string, unknown>): AudioAssetRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    ownerUserId: toStr(row.owner_user_id),
    projectType: toStr(row.project_type) as AudioProjectType,
    projectId: toStrOrNull(row.project_id),
    assetType: toStr(row.asset_type),
    storageKey: toStr(row.storage_key),
    fileName: toStr(row.file_name),
    mimeType: toStr(row.mime_type),
    fileSize: toNum(row.file_size),
    durationMs: toNumOrNull(row.duration_ms),
    checksum: toStr(row.checksum),
    rightsStatus: toStr(row.rights_status),
    consentRecordId: toStrOrNull(row.consent_record_id),
    retentionKind: toStr(row.retention_kind) as AudioAssetRecord['retentionKind'],
    retentionExpiresAt: toStrOrNull(row.retention_expires_at),
    deletedAt: toStrOrNull(row.deleted_at),
    createdAt: toStr(row.created_at),
  }
}

function mapGeneration(row: Record<string, unknown>): AudioGenerationRecord {
  let configuration: Record<string, unknown> = {}
  try {
    configuration = JSON.parse(toStr(row.configuration) || '{}') as Record<string, unknown>
  } catch {
    configuration = {}
  }
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    projectType: toStr(row.project_type) as AudioProjectType,
    projectId: toStrOrNull(row.project_id),
    outputAssetId: toStr(row.output_asset_id),
    provider: toStr(row.provider),
    model: toStr(row.model),
    operation: toStr(row.operation),
    voiceProfileId: toStrOrNull(row.voice_profile_id),
    prompt: toStr(row.prompt),
    configuration,
    rightsBasis: toStr(row.rights_basis),
    consentRecordId: toStrOrNull(row.consent_record_id),
    parentGenerationId: toStrOrNull(row.parent_generation_id),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}
