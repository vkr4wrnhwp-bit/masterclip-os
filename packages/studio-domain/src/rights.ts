import { insertRow, toBool, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { AppError, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import type {
  AiPermission,
  AiPermissionEventRecord,
  AiPermissionRecord,
  AiPermissionScope,
  IdentityControl,
  IdentityEventRecord,
  IdentitySubject,
  IdentityVaultRecord,
  LicenseMatch,
  LicenseRequestRecord,
  LicenseRequestStatus,
} from './types.js'

/**
 * Identity Vault.
 *
 * The default posture is refusal, and it is a structural default rather than a
 * policy one: `permissionFor()` returns `prohibited` when no row exists, so an
 * artist who has never touched this screen is protected exactly as if they had
 * set every control to prohibited.
 *
 * `control = 'permitted'` additionally requires a verified consent record. The
 * repository refuses to write a permitted row without one — a permission that
 * nobody can trace back to the artist saying yes is not a permission.
 */
export class IdentityVaultRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async set(input: {
    orgId: string
    artistKey: string
    subject: IdentitySubject
    control: IdentityControl
    approvedModelIds?: string[]
    permittedUses?: string[]
    prohibitedUses?: string[]
    territories?: string[]
    termStart?: string | null
    termEnd?: string | null
    pricing?: string
    consentRecordId?: string | null
    verified?: boolean
    actorUserId: string
  }): Promise<IdentityVaultRecord> {
    if (input.control === 'permitted' && !input.consentRecordId) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.identity_needs_consent',
        message: 'permitting a use of an artist’s identity requires a verified consent record',
      })
    }

    const existing = await this.find(input.orgId, input.artistKey, input.subject)
    const now = this.clock.isoNow()
    const record: IdentityVaultRecord = {
      id: existing?.id ?? newId('stiv', this.clock.now()),
      orgId: input.orgId,
      artistKey: input.artistKey,
      subject: input.subject,
      control: input.control,
      approvedModelIds: input.approvedModelIds ?? existing?.approvedModelIds ?? [],
      permittedUses: input.permittedUses ?? existing?.permittedUses ?? [],
      prohibitedUses: input.prohibitedUses ?? existing?.prohibitedUses ?? [],
      territories: input.territories ?? existing?.territories ?? [],
      termStart: input.termStart ?? existing?.termStart ?? null,
      termEnd: input.termEnd ?? existing?.termEnd ?? null,
      pricing: input.pricing ?? existing?.pricing ?? '',
      consentRecordId: input.consentRecordId ?? existing?.consentRecordId ?? null,
      verified: input.verified ?? existing?.verified ?? false,
      createdBy: existing?.createdBy ?? input.actorUserId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revokedAt: null,
      revokedBy: null,
    }

    if (existing) {
      await this.db.run(
        'UPDATE studio_identity_vault SET control = ?, approved_model_ids = ?, permitted_uses = ?, prohibited_uses = ?, territories = ?, term_start = ?, term_end = ?, pricing = ?, consent_record_id = ?, verified = ?, updated_at = ?, revoked_at = NULL, revoked_by = NULL WHERE id = ? AND org_id = ?',
        [
          record.control,
          toJson(record.approvedModelIds),
          toJson(record.permittedUses),
          toJson(record.prohibitedUses),
          toJson(record.territories),
          record.termStart,
          record.termEnd,
          record.pricing,
          record.consentRecordId,
          record.verified ? 1 : 0,
          now,
          record.id,
          input.orgId,
        ],
      )
    } else {
      await insertRow(this.db, 'studio_identity_vault', {
        id: record.id,
        org_id: record.orgId,
        artist_key: record.artistKey,
        subject: record.subject,
        control: record.control,
        approved_model_ids: toJson(record.approvedModelIds),
        permitted_uses: toJson(record.permittedUses),
        prohibited_uses: toJson(record.prohibitedUses),
        territories: toJson(record.territories),
        term_start: record.termStart,
        term_end: record.termEnd,
        pricing: record.pricing,
        consent_record_id: record.consentRecordId,
        verified: record.verified ? 1 : 0,
        created_by: record.createdBy,
        created_at: record.createdAt,
        updated_at: now,
        revoked_at: null,
        revoked_by: null,
      })
    }

    await this.logEvent(input.orgId, record.id, existing ? 'updated' : 'created', `control set to ${record.control}`, input.actorUserId)
    return record
  }

  async find(orgId: string, artistKey: string, subject: IdentitySubject): Promise<IdentityVaultRecord | null> {
    const row = await this.db.get('SELECT * FROM studio_identity_vault WHERE org_id = ? AND artist_key = ? AND subject = ?', [orgId, artistKey, subject])
    return row ? mapIdentity(row) : null
  }

  async get(orgId: string, id: string): Promise<IdentityVaultRecord> {
    const row = await this.db.get('SELECT * FROM studio_identity_vault WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('identity vault entry', id)
    return mapIdentity(row)
  }

  async list(orgId: string, artistKey: string): Promise<IdentityVaultRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_identity_vault WHERE org_id = ? AND artist_key = ? ORDER BY subject ASC', [orgId, artistKey])
    return rows.map(mapIdentity)
  }

  /**
   * The effective control for a use.
   *
   * Absent, revoked, expired, or unverified all resolve to the safe answer.
   * The caller gets one value it can act on and a reason it can show.
   */
  async controlFor(orgId: string, artistKey: string, subject: IdentitySubject): Promise<{ control: IdentityControl; reason: string }> {
    const record = await this.find(orgId, artistKey, subject)
    if (!record) return { control: 'prohibited', reason: 'no entry exists for this artist and subject, so the use is not permitted' }
    if (record.revokedAt) return { control: 'prohibited', reason: `this permission was revoked on ${record.revokedAt}` }
    if (record.termEnd && record.termEnd < this.clock.isoNow()) return { control: 'prohibited', reason: `this permission's term ended on ${record.termEnd}` }
    if (record.control === 'permitted' && !record.verified) {
      return { control: 'consent_required', reason: 'the consent behind this permission has not been verified' }
    }
    return { control: record.control, reason: '' }
  }

  async revoke(orgId: string, id: string, actorUserId: string, reason: string): Promise<IdentityVaultRecord> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_identity_vault SET revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      this.clock.isoNow(),
      actorUserId,
      this.clock.isoNow(),
      id,
      orgId,
    ])
    await this.logEvent(orgId, id, 'revoked', reason, actorUserId)
    return this.get(orgId, id)
  }

  async logEvent(orgId: string, identityId: string, event: string, detail: string, actorUserId: string): Promise<void> {
    await insertRow(this.db, 'studio_identity_events', {
      id: newId('stac', this.clock.now()),
      org_id: orgId,
      identity_id: identityId,
      event,
      detail,
      actor_user_id: actorUserId,
      created_at: this.clock.isoNow(),
    })
  }

  /** The licence history. Append-only; revocation is an event, not an erasure. */
  async events(orgId: string, identityId: string): Promise<IdentityEventRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_identity_events WHERE org_id = ? AND identity_id = ? ORDER BY created_at ASC', [orgId, identityId])
    return rows.map((row) => ({
      id: toStr(row.id),
      orgId: toStr(row.org_id),
      identityId: toStr(row.identity_id),
      event: toStr(row.event),
      detail: toStr(row.detail),
      actorUserId: toStr(row.actor_user_id),
      createdAt: toStr(row.created_at),
    }))
  }
}

/**
 * Rights-safe AI licensing.
 *
 * Every permission is granular (scope + permission), revocable unless a
 * contract says otherwise, and logged on every change. `no_ai_use` is not
 * merely the absence of a grant — it is a positive statement an artist can
 * make, and it overrides every other permission on the same scope.
 */
export class AiPermissionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async set(input: {
    orgId: string
    studioProjectId: string
    assetScope: AiPermissionScope
    permission: AiPermission
    granted: boolean
    revocable?: boolean
    territories?: string[]
    termEnd?: string | null
    conditions?: string
    contractReference?: string | null
    actorUserId: string
  }): Promise<AiPermissionRecord> {
    const existing = await this.find(input.orgId, input.studioProjectId, input.assetScope, input.permission)
    const now = this.clock.isoNow()
    const record: AiPermissionRecord = {
      id: existing?.id ?? newId('stperm', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      assetScope: input.assetScope,
      permission: input.permission,
      granted: input.granted,
      grantedBy: input.actorUserId,
      grantedAt: now,
      revocable: input.revocable ?? true,
      revokedAt: null,
      revokedBy: null,
      territories: input.territories ?? [],
      termEnd: input.termEnd ?? null,
      conditions: input.conditions ?? '',
      contractReference: input.contractReference ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    if (existing) {
      await this.db.run(
        'UPDATE studio_ai_permissions SET granted = ?, granted_by = ?, granted_at = ?, revocable = ?, revoked_at = NULL, revoked_by = NULL, territories = ?, term_end = ?, conditions = ?, contract_reference = ?, updated_at = ? WHERE id = ? AND org_id = ?',
        [
          record.granted ? 1 : 0,
          record.grantedBy,
          record.grantedAt,
          record.revocable ? 1 : 0,
          toJson(record.territories),
          record.termEnd,
          record.conditions,
          record.contractReference,
          now,
          record.id,
          input.orgId,
        ],
      )
    } else {
      await insertRow(this.db, 'studio_ai_permissions', {
        id: record.id,
        org_id: record.orgId,
        studio_project_id: record.studioProjectId,
        asset_scope: record.assetScope,
        permission: record.permission,
        granted: record.granted ? 1 : 0,
        granted_by: record.grantedBy,
        granted_at: record.grantedAt,
        revocable: record.revocable ? 1 : 0,
        revoked_at: null,
        revoked_by: null,
        territories: toJson(record.territories),
        term_end: record.termEnd,
        conditions: record.conditions,
        contract_reference: record.contractReference,
        created_at: record.createdAt,
        updated_at: now,
      })
    }

    await this.logEvent(input.orgId, record.id, record.granted ? 'granted' : 'withheld', `${input.permission} on ${input.assetScope}`, input.actorUserId)
    return record
  }

  async find(orgId: string, projectId: string, assetScope: AiPermissionScope, permission: AiPermission): Promise<AiPermissionRecord | null> {
    const row = await this.db.get('SELECT * FROM studio_ai_permissions WHERE org_id = ? AND studio_project_id = ? AND asset_scope = ? AND permission = ?', [
      orgId,
      projectId,
      assetScope,
      permission,
    ])
    return row ? mapPermission(row) : null
  }

  async get(orgId: string, id: string): Promise<AiPermissionRecord> {
    const row = await this.db.get('SELECT * FROM studio_ai_permissions WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('ai permission', id)
    return mapPermission(row)
  }

  async list(orgId: string, projectId: string): Promise<AiPermissionRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_ai_permissions WHERE org_id = ? AND studio_project_id = ? ORDER BY asset_scope ASC, permission ASC', [
      orgId,
      projectId,
    ])
    return rows.map(mapPermission)
  }

  /**
   * Whether a use is allowed, and why.
   *
   * Resolution order is the whole point: an explicit `no_ai_use` on the scope
   * (or on `all`) refuses even where a narrower permission was granted, and the
   * absence of any grant refuses too. There is no path through this method that
   * returns `true` without a live, unexpired, granted row.
   */
  async isAllowed(
    orgId: string,
    projectId: string,
    assetScope: AiPermissionScope,
    permission: AiPermission,
  ): Promise<{ allowed: boolean; reason: string }> {
    const now = this.clock.isoNow()
    const all = await this.list(orgId, projectId)

    const blanket = all.find((entry) => entry.permission === 'no_ai_use' && entry.granted && !entry.revokedAt && (entry.assetScope === 'all' || entry.assetScope === assetScope))
    if (blanket) return { allowed: false, reason: 'this project carries an explicit "no AI use" declaration for this material' }

    const match = all.find((entry) => entry.permission === permission && (entry.assetScope === assetScope || entry.assetScope === 'all'))
    if (!match) return { allowed: false, reason: `no permission has been granted for ${permission} on this material` }
    if (!match.granted) return { allowed: false, reason: `${permission} has been explicitly withheld for this material` }
    if (match.revokedAt) return { allowed: false, reason: `this permission was revoked on ${match.revokedAt}` }
    if (match.termEnd && match.termEnd < now) return { allowed: false, reason: `this permission's term ended on ${match.termEnd}` }
    return { allowed: true, reason: '' }
  }

  async revoke(orgId: string, id: string, actorUserId: string, reason: string): Promise<AiPermissionRecord> {
    const permission = await this.get(orgId, id)
    if (!permission.revocable) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.permission_not_revocable',
        message: 'this permission was granted under a contract that makes it irrevocable; revoking it is a contractual matter, not a settings change',
      })
    }
    await this.db.run('UPDATE studio_ai_permissions SET revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      this.clock.isoNow(),
      actorUserId,
      this.clock.isoNow(),
      id,
      orgId,
    ])
    await this.logEvent(orgId, id, 'revoked', reason, actorUserId)
    return this.get(orgId, id)
  }

  async logEvent(orgId: string, permissionId: string, event: string, detail: string, actorUserId: string): Promise<void> {
    await insertRow(this.db, 'studio_ai_permission_events', {
      id: newId('stac', this.clock.now()),
      org_id: orgId,
      permission_id: permissionId,
      event,
      detail,
      actor_user_id: actorUserId,
      created_at: this.clock.isoNow(),
    })
  }

  async events(orgId: string, permissionId: string): Promise<AiPermissionEventRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_ai_permission_events WHERE org_id = ? AND permission_id = ? ORDER BY created_at ASC', [orgId, permissionId])
    return rows.map((row) => ({
      id: toStr(row.id),
      orgId: toStr(row.org_id),
      permissionId: toStr(row.permission_id),
      event: toStr(row.event),
      detail: toStr(row.detail),
      actorUserId: toStr(row.actor_user_id),
      createdAt: toStr(row.created_at),
    }))
  }
}

/**
 * The agent-to-agent licensing boundary.
 *
 * A request comes in, rights are checked against stored permissions, matches
 * are priced indicatively — and then it stops, at `awaiting_human`. Nothing in
 * this repository can set `executed`, and there is deliberately no method that
 * would: executing a licence needs contract and payment infrastructure that
 * does not exist yet, and an autonomous system that grants rights it cannot
 * paper is a liability rather than a feature.
 */
export class LicenseRequestRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    requester: string
    requesterKind: 'human' | 'agent'
    brief: string
    budgetMicros?: number | null
    durationSeconds?: number | null
    territories?: string[]
    rightsRequested?: string[]
  }): Promise<LicenseRequestRecord> {
    const now = this.clock.isoNow()
    const record: LicenseRequestRecord = {
      id: newId('stlic', this.clock.now()),
      orgId: input.orgId,
      requester: input.requester,
      requesterKind: input.requesterKind,
      brief: input.brief,
      budgetMicros: input.budgetMicros ?? null,
      durationSeconds: input.durationSeconds ?? null,
      territories: input.territories ?? [],
      rightsRequested: input.rightsRequested ?? [],
      status: 'received',
      matches: [],
      decisionNotes: '',
      executed: false,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_license_requests', {
      id: record.id,
      org_id: record.orgId,
      requester: record.requester,
      requester_kind: record.requesterKind,
      brief: record.brief,
      budget_micros: record.budgetMicros,
      duration_seconds: record.durationSeconds,
      territories: toJson(record.territories),
      rights_requested: toJson(record.rightsRequested),
      status: record.status,
      matches: toJson(record.matches),
      decision_notes: '',
      executed: 0,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<LicenseRequestRecord> {
    const row = await this.db.get('SELECT * FROM studio_license_requests WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('license request', id)
    return mapLicenseRequest(row)
  }

  async list(orgId: string, limit = 100): Promise<LicenseRequestRecord[]> {
    const rows = await this.db.query(`SELECT * FROM studio_license_requests WHERE org_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`, [orgId])
    return rows.map(mapLicenseRequest)
  }

  async settle(orgId: string, id: string, status: LicenseRequestStatus, matches: LicenseMatch[], decisionNotes: string): Promise<LicenseRequestRecord> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_license_requests SET status = ?, matches = ?, decision_notes = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      status,
      toJson(matches),
      decisionNotes,
      this.clock.isoNow(),
      id,
      orgId,
    ])
    return this.get(orgId, id)
  }
}

function mapIdentity(row: Row): IdentityVaultRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    artistKey: toStr(row.artist_key),
    subject: toStr(row.subject) as IdentitySubject,
    control: toStr(row.control) as IdentityControl,
    approvedModelIds: parseJson<string[]>(row.approved_model_ids, []),
    permittedUses: parseJson<string[]>(row.permitted_uses, []),
    prohibitedUses: parseJson<string[]>(row.prohibited_uses, []),
    territories: parseJson<string[]>(row.territories, []),
    termStart: toStrOrNull(row.term_start),
    termEnd: toStrOrNull(row.term_end),
    pricing: toStr(row.pricing),
    consentRecordId: toStrOrNull(row.consent_record_id),
    verified: toBool(row.verified),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
    revokedAt: toStrOrNull(row.revoked_at),
    revokedBy: toStrOrNull(row.revoked_by),
  }
}

function mapPermission(row: Row): AiPermissionRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    assetScope: toStr(row.asset_scope) as AiPermissionScope,
    permission: toStr(row.permission) as AiPermission,
    granted: toBool(row.granted),
    grantedBy: toStr(row.granted_by),
    grantedAt: toStr(row.granted_at),
    revocable: toBool(row.revocable),
    revokedAt: toStrOrNull(row.revoked_at),
    revokedBy: toStrOrNull(row.revoked_by),
    territories: parseJson<string[]>(row.territories, []),
    termEnd: toStrOrNull(row.term_end),
    conditions: toStr(row.conditions),
    contractReference: toStrOrNull(row.contract_reference),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapLicenseRequest(row: Row): LicenseRequestRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    requester: toStr(row.requester),
    requesterKind: toStr(row.requester_kind) === 'agent' ? 'agent' : 'human',
    brief: toStr(row.brief),
    budgetMicros: toNumOrNull(row.budget_micros),
    durationSeconds: toNumOrNull(row.duration_seconds),
    territories: parseJson<string[]>(row.territories, []),
    rightsRequested: parseJson<string[]>(row.rights_requested, []),
    status: toStr(row.status) as LicenseRequestStatus,
    matches: parseJson<LicenseMatch[]>(row.matches, []),
    decisionNotes: toStr(row.decision_notes),
    executed: toBool(row.executed),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
