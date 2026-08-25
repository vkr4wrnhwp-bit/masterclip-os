import { type Db, insertRow, parseJsonColumn, toBool, toStr, toStrOrNull } from '@masterclip/database'
import { AppError, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { ConsentType } from '@masterclip/audio-core'

export interface ConsentRecordRow {
  id: string
  orgId: string
  subjectType: string
  subjectId: string
  consentType: ConsentType
  policyVersion: string
  disclosureText: string
  accepted: boolean
  acceptedBy: string
  acceptedAt: string
  revokedAt: string | null
  evidence: Record<string, unknown>
}

export class ConsentRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async record(input: Omit<ConsentRecordRow, 'id' | 'acceptedAt' | 'revokedAt'>): Promise<ConsentRecordRow> {
    const record: ConsentRecordRow = { ...input, id: newId('acon', this.clock.now()), acceptedAt: this.clock.isoNow(), revokedAt: null }
    await insertRow(this.db, 'consent_records', {
      id: record.id,
      org_id: record.orgId,
      subject_type: record.subjectType,
      subject_id: record.subjectId,
      consent_type: record.consentType,
      policy_version: record.policyVersion,
      disclosure_text: record.disclosureText,
      accepted: record.accepted ? 1 : 0,
      accepted_by: record.acceptedBy,
      accepted_at: record.acceptedAt,
      revoked_at: null,
      evidence: JSON.stringify(record.evidence),
    })
    return record
  }

  async get(orgId: string, id: string): Promise<ConsentRecordRow> {
    const row = await this.db.get('SELECT * FROM consent_records WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('consent record', id)
    return mapConsent(row)
  }

  /** Throws unless the consent exists, was accepted, and is not revoked. */
  async requireActive(orgId: string, id: string, expectedType?: ConsentType): Promise<ConsentRecordRow> {
    const record = await this.get(orgId, id)
    if (!record.accepted) {
      throw new AppError({ kind: 'forbidden', code: 'consent.not_accepted', message: 'the referenced consent record was not accepted' })
    }
    if (record.revokedAt) {
      throw new AppError({ kind: 'forbidden', code: 'consent.revoked', message: 'the referenced consent record was revoked' })
    }
    if (expectedType && record.consentType !== expectedType) {
      throw new AppError({
        kind: 'validation',
        code: 'consent.wrong_type',
        message: `consent record is ${record.consentType}, expected ${expectedType}`,
      })
    }
    return record
  }

  async revoke(orgId: string, id: string): Promise<void> {
    const result = await this.db.run('UPDATE consent_records SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL', [
      this.clock.isoNow(),
      id,
      orgId,
    ])
    if (result.changes === 0) throw notFound('consent record', id)
  }

  async listForSubject(orgId: string, subjectType: string, subjectId: string): Promise<ConsentRecordRow[]> {
    const rows = await this.db.query(
      'SELECT * FROM consent_records WHERE org_id = ? AND subject_type = ? AND subject_id = ? ORDER BY accepted_at DESC',
      [orgId, subjectType, subjectId],
    )
    return rows.map(mapConsent)
  }
}

export interface VoicePermittedUses {
  commercial: boolean
  advertising: boolean
  dubbing: boolean
  social: boolean
  internal: boolean
  sublicensing: boolean
  channels: string[]
  territories: string[]
  languages: string[]
  projects: string[]
}

export interface VoiceProfileRecord {
  id: string
  orgId: string
  voiceOwnerName: string
  voiceOwnerPersonId: string | null
  provider: string
  providerVoiceId: string
  name: string
  status: 'active' | 'revoked' | 'expired' | 'pending'
  verificationStatus: 'verified' | 'pending' | 'unverified'
  consentRecordId: string
  permittedUses: VoicePermittedUses
  validFrom: string
  validUntil: string | null
  revokedAt: string | null
  revokedBy: string | null
  createdBy: string
  createdAt: string
}

export class VoiceVaultRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: Omit<VoiceProfileRecord, 'id' | 'createdAt' | 'revokedAt' | 'revokedBy'>): Promise<VoiceProfileRecord> {
    const record: VoiceProfileRecord = { ...input, id: newId('voice', this.clock.now()), revokedAt: null, revokedBy: null, createdAt: this.clock.isoNow() }
    await insertRow(this.db, 'voice_profiles', {
      id: record.id,
      org_id: record.orgId,
      voice_owner_name: record.voiceOwnerName,
      voice_owner_person_id: record.voiceOwnerPersonId,
      provider: record.provider,
      provider_voice_id: record.providerVoiceId,
      name: record.name,
      status: record.status,
      verification_status: record.verificationStatus,
      consent_record_id: record.consentRecordId,
      permitted_uses: JSON.stringify(record.permittedUses),
      valid_from: record.validFrom,
      valid_until: record.validUntil,
      revoked_at: null,
      revoked_by: null,
      created_by: record.createdBy,
      created_at: record.createdAt,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<VoiceProfileRecord> {
    const row = await this.db.get('SELECT * FROM voice_profiles WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('voice profile', id)
    return mapVoice(row)
  }

  async list(orgId: string): Promise<VoiceProfileRecord[]> {
    const rows = await this.db.query('SELECT * FROM voice_profiles WHERE org_id = ? ORDER BY created_at DESC', [orgId])
    return rows.map(mapVoice)
  }

  /**
   * The generation gate: a voice is usable only when active, verified, inside
   * its validity window, and permitted for the requested use. Every refusal
   * names its reason — "generation failed" is not an acceptable answer for a
   * rights question.
   */
  async requireUsable(orgId: string, id: string, use: keyof Pick<VoicePermittedUses, 'commercial' | 'advertising' | 'dubbing' | 'social' | 'internal'>, nowMs: number): Promise<VoiceProfileRecord> {
    const profile = await this.get(orgId, id)
    if (profile.status === 'revoked') {
      throw new AppError({ kind: 'forbidden', code: 'voice.revoked', message: 'this voice profile has been revoked by its owner' })
    }
    if (profile.status === 'expired' || (profile.validUntil && Date.parse(profile.validUntil) < nowMs)) {
      throw new AppError({ kind: 'forbidden', code: 'voice.expired', message: 'this voice profile’s permission window has ended' })
    }
    if (Date.parse(profile.validFrom) > nowMs) {
      throw new AppError({ kind: 'forbidden', code: 'voice.not_yet_valid', message: 'this voice profile’s permission window has not started' })
    }
    if (profile.verificationStatus !== 'verified') {
      throw new AppError({ kind: 'forbidden', code: 'voice.unverified', message: 'this voice profile has not completed owner verification' })
    }
    if (!profile.permittedUses[use]) {
      throw new AppError({ kind: 'forbidden', code: 'voice.use_not_permitted', message: `the voice owner has not permitted ${use} use` })
    }
    return profile
  }

  async revoke(orgId: string, id: string, revokedBy: string): Promise<VoiceProfileRecord> {
    const profile = await this.get(orgId, id)
    await this.db.run(`UPDATE voice_profiles SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ? AND org_id = ?`, [
      this.clock.isoNow(),
      revokedBy,
      id,
      orgId,
    ])
    return { ...profile, status: 'revoked', revokedAt: this.clock.isoNow(), revokedBy }
  }

  async setVerification(orgId: string, id: string, verificationStatus: VoiceProfileRecord['verificationStatus']): Promise<void> {
    await this.db.run('UPDATE voice_profiles SET verification_status = ?, status = ? WHERE id = ? AND org_id = ?', [
      verificationStatus,
      verificationStatus === 'verified' ? 'active' : 'pending',
      id,
      orgId,
    ])
  }
}

function mapConsent(row: Record<string, unknown>): ConsentRecordRow {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    subjectType: toStr(row.subject_type),
    subjectId: toStr(row.subject_id),
    consentType: toStr(row.consent_type) as ConsentType,
    policyVersion: toStr(row.policy_version),
    disclosureText: toStr(row.disclosure_text),
    accepted: toBool(row.accepted),
    acceptedBy: toStr(row.accepted_by),
    acceptedAt: toStr(row.accepted_at),
    revokedAt: toStrOrNull(row.revoked_at),
    evidence: parseJsonColumn(row.evidence, {}),
  }
}

function mapVoice(row: Record<string, unknown>): VoiceProfileRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    voiceOwnerName: toStr(row.voice_owner_name),
    voiceOwnerPersonId: toStrOrNull(row.voice_owner_person_id),
    provider: toStr(row.provider),
    providerVoiceId: toStr(row.provider_voice_id),
    name: toStr(row.name),
    status: toStr(row.status) as VoiceProfileRecord['status'],
    verificationStatus: toStr(row.verification_status) as VoiceProfileRecord['verificationStatus'],
    consentRecordId: toStr(row.consent_record_id),
    permittedUses: parseJsonColumn(row.permitted_uses, {
      commercial: false,
      advertising: false,
      dubbing: false,
      social: false,
      internal: false,
      sublicensing: false,
      channels: [],
      territories: [],
      languages: [],
      projects: [],
    }),
    validFrom: toStr(row.valid_from),
    validUntil: toStrOrNull(row.valid_until),
    revokedAt: toStrOrNull(row.revoked_at),
    revokedBy: toStrOrNull(row.revoked_by),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}
