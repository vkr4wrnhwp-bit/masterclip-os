import { insertRow, toBool, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { AppError, hashObject, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import { PASSPORT_SCHEMA_VERSION, type ContributionRecord, type ContributionType, type RecordPassportDocument, type RecordPassportRecord } from './types.js'

/**
 * The Record Passport and the Human Creation Ledger.
 *
 * The passport is a machine-readable provenance record for one recording. Its
 * hash is taken over a *canonical* serialization — keys sorted at every depth —
 * so the same document always hashes to the same value regardless of which
 * build wrote it. An integrity check that fails because of key ordering is
 * worse than no integrity check at all.
 *
 * Two things this deliberately is not:
 *
 *   - It is not a legal conclusion. It records what was declared, by whom and
 *     when. `cleared: null` on a sample means nobody has said, which is
 *     different from "not cleared".
 *   - It is not DDEX or RIN. Those are export targets, and the document is
 *     shaped so an exporter can be written against it without this application
 *     taking a dependency on any one standard's library or version.
 */
export class RecordPassportRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    recordingId?: string
    document: RecordPassportDocument
    externalProfile?: string | null
    createdBy: string
  }): Promise<RecordPassportRecord> {
    const now = this.clock.isoNow()
    const recordingId = input.recordingId ?? `${input.studioProjectId}:recording`
    const document = { ...input.document, schemaVersion: PASSPORT_SCHEMA_VERSION }
    const record: RecordPassportRecord = {
      id: newId('stpp', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      recordingId,
      schemaVersion: PASSPORT_SCHEMA_VERSION,
      document,
      documentHash: hashDocument(document),
      finalizedVersionId: null,
      finalizedAssetChecksum: null,
      externalProfile: input.externalProfile ?? null,
      status: 'draft',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_record_passports', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      recording_id: record.recordingId,
      schema_version: record.schemaVersion,
      document: toJson(record.document),
      document_hash: record.documentHash,
      finalized_version_id: null,
      finalized_asset_checksum: null,
      external_profile: record.externalProfile,
      status: record.status,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<RecordPassportRecord> {
    const row = await this.db.get('SELECT * FROM studio_record_passports WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('record passport', id)
    return mapPassport(row)
  }

  async latestForProject(orgId: string, projectId: string): Promise<RecordPassportRecord | null> {
    const row = await this.db.get('SELECT * FROM studio_record_passports WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at DESC LIMIT 1', [
      orgId,
      projectId,
    ])
    return row ? mapPassport(row) : null
  }

  async list(orgId: string, projectId: string): Promise<RecordPassportRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_record_passports WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at DESC', [orgId, projectId])
    return rows.map(mapPassport)
  }

  /**
   * Updates a draft.
   *
   * A finalized passport is never rewritten: finalizing is the act of saying
   * "this describes those exact bytes", and editing it afterwards would make
   * the statement meaningless. A changed record gets a new passport.
   */
  async updateDraft(orgId: string, id: string, document: RecordPassportDocument): Promise<RecordPassportRecord> {
    const existing = await this.get(orgId, id)
    if (existing.status === 'finalized') {
      throw new AppError({
        kind: 'validation',
        code: 'studio.passport_finalized',
        message: 'a finalized passport cannot be edited — create a new one for the new state of the record',
      })
    }
    const next = { ...document, schemaVersion: PASSPORT_SCHEMA_VERSION }
    await this.db.run('UPDATE studio_record_passports SET document = ?, document_hash = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      toJson(next),
      hashDocument(next),
      this.clock.isoNow(),
      id,
      orgId,
    ])
    return this.get(orgId, id)
  }

  /** Binds the passport to a version's exact bytes and closes it to editing. */
  async finalize(orgId: string, id: string, versionId: string, assetChecksum: string): Promise<RecordPassportRecord> {
    await this.get(orgId, id)
    await this.db.run(
      "UPDATE studio_record_passports SET status = 'finalized', finalized_version_id = ?, finalized_asset_checksum = ?, updated_at = ? WHERE id = ? AND org_id = ?",
      [versionId, assetChecksum, this.clock.isoNow(), id, orgId],
    )
    return this.get(orgId, id)
  }

  /**
   * Re-derives the hash and compares it with the stored one.
   *
   * The point of storing a hash is that somebody can check it. Without this
   * method the column is decoration.
   */
  async verify(orgId: string, id: string): Promise<{ valid: boolean; storedHash: string; computedHash: string }> {
    const passport = await this.get(orgId, id)
    const computedHash = hashDocument(passport.document)
    return { valid: computedHash === passport.documentHash, storedHash: passport.documentHash, computedHash }
  }
}

/**
 * The passport's content hash.
 *
 * `hashObject` canonicalizes first — keys sorted at every depth — which is the
 * property that makes this checkable: two builds that serialize the same
 * document with different key order must produce the same hash, or an
 * integrity check fails for a reason that has nothing to do with integrity.
 */
export function hashDocument(document: RecordPassportDocument): string {
  return hashObject(document)
}

export class ContributionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    studioVersionId?: string | null
    contributionType: ContributionType
    performedBy: string
    performerUserId?: string | null
    instrument?: string | null
    detail?: string
    human: boolean
    aiTool?: string | null
    aiRole?: string | null
    declaredBy: string
  }): Promise<ContributionRecord> {
    const now = this.clock.isoNow()
    const record: ContributionRecord = {
      id: newId('stcl', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      contributionType: input.contributionType,
      performedBy: input.performedBy,
      performerUserId: input.performerUserId ?? null,
      instrument: input.instrument ?? null,
      detail: input.detail ?? '',
      human: input.human,
      // An AI-assisted contribution records what the tool did, separately from
      // the human work. The two are never merged into one claim.
      aiTool: input.human ? (input.aiTool ?? null) : (input.aiTool ?? 'unspecified'),
      aiRole: input.aiRole ?? null,
      declaredBy: input.declaredBy,
      declaredAt: now,
      createdAt: now,
    }
    await insertRow(this.db, 'studio_contributions', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      contribution_type: record.contributionType,
      performed_by: record.performedBy,
      performer_user_id: record.performerUserId,
      instrument: record.instrument,
      detail: record.detail,
      human: record.human ? 1 : 0,
      ai_tool: record.aiTool,
      ai_role: record.aiRole,
      declared_by: record.declaredBy,
      declared_at: now,
      created_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<ContributionRecord> {
    const row = await this.db.get('SELECT * FROM studio_contributions WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('contribution', id)
    return mapContribution(row)
  }

  async list(orgId: string, projectId: string): Promise<ContributionRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_contributions WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at ASC', [orgId, projectId])
    return rows.map(mapContribution)
  }

  async delete(orgId: string, id: string): Promise<void> {
    await this.get(orgId, id)
    await this.db.run('DELETE FROM studio_contributions WHERE id = ? AND org_id = ?', [id, orgId])
  }
}

function mapPassport(row: Row): RecordPassportRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    recordingId: toStr(row.recording_id),
    schemaVersion: toStr(row.schema_version),
    document: parseJson<RecordPassportDocument>(row.document, emptyDocument()),
    documentHash: toStr(row.document_hash),
    finalizedVersionId: toStrOrNull(row.finalized_version_id),
    finalizedAssetChecksum: toStrOrNull(row.finalized_asset_checksum),
    externalProfile: toStrOrNull(row.external_profile),
    status: toStr(row.status) === 'finalized' ? 'finalized' : 'draft',
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function emptyDocument(): RecordPassportDocument {
  return {
    schemaVersion: PASSPORT_SCHEMA_VERSION,
    projectId: '',
    recordingId: '',
    title: '',
    artist: '',
    generatedAt: '',
    contributors: [],
    versions: [],
    approvals: [],
    ownership: { declarations: [], splits: [] },
    aiDisclosure: { toolsUsed: [], generativeUse: [], voiceModelUse: [], declaredBy: null, declaredAt: null },
    samples: [],
    licenses: [],
    deliveryHistory: [],
  }
}

function mapContribution(row: Row): ContributionRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    studioVersionId: toStrOrNull(row.studio_version_id),
    contributionType: toStr(row.contribution_type) as ContributionType,
    performedBy: toStr(row.performed_by),
    performerUserId: toStrOrNull(row.performer_user_id),
    instrument: toStrOrNull(row.instrument),
    detail: toStr(row.detail),
    human: toBool(row.human),
    aiTool: toStrOrNull(row.ai_tool),
    aiRole: toStrOrNull(row.ai_role),
    declaredBy: toStr(row.declared_by),
    declaredAt: toStr(row.declared_at),
    createdAt: toStr(row.created_at),
  }
}
