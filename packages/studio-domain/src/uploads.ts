import { insertRow, toNum, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'

export type UploadSessionStatus = 'open' | 'completed' | 'aborted' | 'expired'

/**
 * How the bytes travelled.
 *
 * `direct` means the client PUT each part straight to object storage and the
 * API never held them. `api` means they came through this process. It is
 * recorded because "where did this customer's audio go" is a question that
 * deserves an answer from data rather than from an assumption about config.
 */
export type UploadTransport = 'api' | 'direct'

export interface UploadSessionRecord {
  id: string
  orgId: string
  studioProjectId: string
  fileName: string
  contentType: string
  totalBytes: number
  partSize: number
  partCount: number
  declaredSha256: string | null
  storagePrefix: string
  transport: UploadTransport
  versionType: string
  label: string | null
  rightsConfirmationId: string
  status: UploadSessionStatus
  studioVersionId: string | null
  audioAssetId: string | null
  failureReason: string | null
  expiresAt: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface UploadPartRecord {
  id: string
  orgId: string
  sessionId: string
  partIndex: number
  storageKey: string
  bytes: number
  sha256: string
  receivedAt: string
}

export class UploadSessionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    fileName: string
    contentType: string
    totalBytes: number
    partSize: number
    partCount: number
    declaredSha256?: string | null
    storagePrefix: string
    transport: UploadTransport
    versionType: string
    label?: string | null
    rightsConfirmationId: string
    expiresAt: string
    createdBy: string
  }): Promise<UploadSessionRecord> {
    const now = this.clock.isoNow()
    const record: UploadSessionRecord = {
      id: newId('stup', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      fileName: input.fileName,
      contentType: input.contentType,
      totalBytes: input.totalBytes,
      partSize: input.partSize,
      partCount: input.partCount,
      declaredSha256: input.declaredSha256 ?? null,
      storagePrefix: input.storagePrefix,
      transport: input.transport,
      versionType: input.versionType,
      label: input.label ?? null,
      rightsConfirmationId: input.rightsConfirmationId,
      status: 'open',
      studioVersionId: null,
      audioAssetId: null,
      failureReason: null,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_upload_sessions', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      file_name: record.fileName,
      content_type: record.contentType,
      total_bytes: record.totalBytes,
      part_size: record.partSize,
      part_count: record.partCount,
      declared_sha256: record.declaredSha256,
      storage_prefix: record.storagePrefix,
      transport: record.transport,
      version_type: record.versionType,
      label: record.label,
      rights_confirmation_id: record.rightsConfirmationId,
      status: record.status,
      studio_version_id: null,
      audio_asset_id: null,
      failure_reason: null,
      expires_at: record.expiresAt,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<UploadSessionRecord> {
    const row = await this.db.get('SELECT * FROM studio_upload_sessions WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('upload session', id)
    return mapSession(row)
  }

  async listOpen(orgId: string, projectId: string): Promise<UploadSessionRecord[]> {
    const rows = await this.db.query(
      "SELECT * FROM studio_upload_sessions WHERE org_id = ? AND studio_project_id = ? AND status = 'open' ORDER BY created_at DESC",
      [orgId, projectId],
    )
    return rows.map(mapSession)
  }

  async settle(
    orgId: string,
    id: string,
    patch: { status: UploadSessionStatus; studioVersionId?: string | null; audioAssetId?: string | null; failureReason?: string | null },
  ): Promise<UploadSessionRecord> {
    await this.db.run(
      'UPDATE studio_upload_sessions SET status = ?, studio_version_id = ?, audio_asset_id = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      [patch.status, patch.studioVersionId ?? null, patch.audioAssetId ?? null, patch.failureReason ?? null, this.clock.isoNow(), id, orgId],
    )
    return this.get(orgId, id)
  }

  /**
   * Records one stored part.
   *
   * A re-sent part replaces its predecessor rather than adding a second row:
   * a client that retried after a timeout it never saw the answer to must end
   * up with one part, not two.
   */
  async recordPart(input: { orgId: string; sessionId: string; partIndex: number; storageKey: string; bytes: number; sha256: string }): Promise<UploadPartRecord> {
    const now = this.clock.isoNow()
    await this.db.run('DELETE FROM studio_upload_parts WHERE session_id = ? AND part_index = ?', [input.sessionId, input.partIndex])
    const record: UploadPartRecord = {
      id: newId('stupp', this.clock.now()),
      orgId: input.orgId,
      sessionId: input.sessionId,
      partIndex: input.partIndex,
      storageKey: input.storageKey,
      bytes: input.bytes,
      sha256: input.sha256,
      receivedAt: now,
    }
    await insertRow(this.db, 'studio_upload_parts', {
      id: record.id,
      org_id: record.orgId,
      session_id: record.sessionId,
      part_index: record.partIndex,
      storage_key: record.storageKey,
      bytes: record.bytes,
      sha256: record.sha256,
      received_at: now,
    })
    return record
  }

  async parts(orgId: string, sessionId: string): Promise<UploadPartRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_upload_parts WHERE org_id = ? AND session_id = ? ORDER BY part_index ASC', [orgId, sessionId])
    return rows.map(mapPart)
  }

  async clearParts(orgId: string, sessionId: string): Promise<void> {
    await this.db.run('DELETE FROM studio_upload_parts WHERE org_id = ? AND session_id = ?', [orgId, sessionId])
  }

  /** Open sessions past their deadline, for the sweeper. */
  async expired(nowIso: string, limit = 100): Promise<UploadSessionRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM studio_upload_sessions WHERE status = 'open' AND expires_at < ? ORDER BY expires_at ASC LIMIT ${Math.floor(limit)}`,
      [nowIso],
    )
    return rows.map(mapSession)
  }
}

function mapSession(row: Row): UploadSessionRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    fileName: toStr(row.file_name),
    contentType: toStr(row.content_type),
    totalBytes: toNum(row.total_bytes),
    partSize: toNum(row.part_size),
    partCount: toNum(row.part_count),
    declaredSha256: toStrOrNull(row.declared_sha256),
    storagePrefix: toStr(row.storage_prefix),
    transport: toStr(row.transport) as UploadTransport,
    versionType: toStr(row.version_type),
    label: toStrOrNull(row.label),
    rightsConfirmationId: toStr(row.rights_confirmation_id),
    status: toStr(row.status) as UploadSessionStatus,
    studioVersionId: toStrOrNull(row.studio_version_id),
    audioAssetId: toStrOrNull(row.audio_asset_id),
    failureReason: toStrOrNull(row.failure_reason),
    expiresAt: toStr(row.expires_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapPart(row: Row): UploadPartRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    sessionId: toStr(row.session_id),
    partIndex: toNum(row.part_index),
    storageKey: toStr(row.storage_key),
    bytes: toNum(row.bytes),
    sha256: toStr(row.sha256),
    receivedAt: toStr(row.received_at),
  }
}
