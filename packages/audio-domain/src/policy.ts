import { type Db, parseJsonColumn, toBool, toNumOrNull, toStr, upsertRow } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import {
  defaultAudioPolicy,
  isAudioCapability,
  type AudioCapability,
  type AudioDataPolicy,
  type KeytermEntry,
} from '@masterclip/audio-core'

export interface OrgAudioSettings {
  orgId: string
  /** Per-capability-slot default provider ids, e.g. { transcription: 'elevenlabs' }. */
  defaultProviders: Record<string, string>
  /** Names prompt moderation refuses as imitation targets. */
  protectedNames: string[]
  whiteLabel: {
    agentDisplayName?: string
    accentColor?: string
    welcomeMessage?: string
    supportEmail?: string
    businessHours?: string
    languages?: string[]
  }
  /** Org-admin switches for granted features, keyed by capability. */
  featureToggles: Record<string, boolean>
  updatedAt: string
}

export interface OrgEntitlement {
  id: string
  orgId: string
  capability: AudioCapability
  enabled: boolean
  grantedBy: string
  createdAt: string
}

/**
 * Data policies, entitlements, org settings and keyterms.
 *
 * Every read is org-scoped by construction — there is no method on this class
 * that returns another organization's rows.
 */
export class AudioPolicyRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async getPolicy(orgId: string): Promise<AudioDataPolicy> {
    const row = await this.db.get('SELECT * FROM audio_data_policies WHERE org_id = ?', [orgId])
    if (!row) {
      const policy = { ...defaultAudioPolicy(orgId, this.clock.isoNow()), id: newId('apol', this.clock.now()) }
      await this.writePolicy(policy)
      return policy
    }
    return mapPolicy(row)
  }

  async updatePolicy(orgId: string, patch: Partial<AudioDataPolicy>): Promise<AudioDataPolicy> {
    const current = await this.getPolicy(orgId)
    // id/orgId are not patchable; everything else merges.
    const next: AudioDataPolicy = { ...current, ...patch, id: current.id, organizationId: orgId, updatedAt: this.clock.isoNow() }
    await this.writePolicy(next)
    return next
  }

  private async writePolicy(policy: AudioDataPolicy): Promise<void> {
    await upsertRow(
      this.db,
      'audio_data_policies',
      {
        id: policy.id,
        org_id: policy.organizationId,
        allow_audio_upload: policy.allowAudioUpload ? 1 : 0,
        allow_meeting_recording: policy.allowMeetingRecording ? 1 : 0,
        allow_call_recording: policy.allowCallRecording ? 1 : 0,
        allow_transcription: policy.allowTranscription ? 1 : 0,
        allow_voice_generation: policy.allowVoiceGeneration ? 1 : 0,
        allow_dubbing: policy.allowDubbing ? 1 : 0,
        allow_music_generation: policy.allowMusicGeneration ? 1 : 0,
        allow_voice_cloning: policy.allowVoiceCloning ? 1 : 0,
        require_zero_retention: policy.requireZeroRetention ? 1 : 0,
        allow_provider_storage: policy.allowProviderStorage ? 1 : 0,
        allow_internal_storage: policy.allowInternalStorage ? 1 : 0,
        source_audio_retention_days: policy.sourceAudioRetentionDays,
        transcript_retention_days: policy.transcriptRetentionDays,
        generated_audio_retention_days: policy.generatedAudioRetentionDays,
        agent_conversation_retention_days: policy.agentConversationRetentionDays,
        voice_sample_retention_days: policy.voiceSampleRetentionDays,
        allow_human_review: policy.allowHumanReview ? 1 : 0,
        allow_ai_extraction: policy.allowAIExtraction ? 1 : 0,
        allow_download: policy.allowDownload ? 1 : 0,
        allow_export: policy.allowExport ? 1 : 0,
        require_recording_consent: policy.requireRecordingConsent ? 1 : 0,
        require_agent_disclosure: policy.requireAgentDisclosure ? 1 : 0,
        require_rights_confirmation: policy.requireRightsConfirmation ? 1 : 0,
        created_at: policy.createdAt,
        updated_at: policy.updatedAt,
      },
      ['org_id'],
    )
  }

  async getSettings(orgId: string): Promise<OrgAudioSettings> {
    const row = await this.db.get('SELECT * FROM org_audio_settings WHERE org_id = ?', [orgId])
    if (!row) {
      return { orgId, defaultProviders: {}, protectedNames: [], whiteLabel: {}, featureToggles: {}, updatedAt: this.clock.isoNow() }
    }
    return {
      orgId,
      defaultProviders: parseJsonColumn(row.default_providers, {}),
      protectedNames: parseJsonColumn(row.protected_names, []),
      whiteLabel: parseJsonColumn(row.white_label, {}),
      featureToggles: parseJsonColumn(row.feature_toggles, {}),
      updatedAt: toStr(row.updated_at),
    }
  }

  async updateSettings(orgId: string, patch: Partial<Omit<OrgAudioSettings, 'orgId' | 'updatedAt'>>): Promise<OrgAudioSettings> {
    const current = await this.getSettings(orgId)
    const next: OrgAudioSettings = { ...current, ...patch, orgId, updatedAt: this.clock.isoNow() }
    await upsertRow(
      this.db,
      'org_audio_settings',
      {
        org_id: orgId,
        default_providers: JSON.stringify(next.defaultProviders),
        protected_names: JSON.stringify(next.protectedNames),
        white_label: JSON.stringify(next.whiteLabel),
        feature_toggles: JSON.stringify(next.featureToggles),
        updated_at: next.updatedAt,
      },
      ['org_id'],
    )
    return next
  }

  async listEntitlements(orgId: string): Promise<OrgEntitlement[]> {
    const rows = await this.db.query('SELECT * FROM org_audio_entitlements WHERE org_id = ? ORDER BY capability', [orgId])
    return rows.map(mapEntitlement)
  }

  async hasEntitlement(orgId: string, capability: AudioCapability): Promise<{ granted: boolean; enabled: boolean }> {
    const row = await this.db.get('SELECT enabled FROM org_audio_entitlements WHERE org_id = ? AND capability = ?', [orgId, capability])
    if (!row) return { granted: false, enabled: false }
    return { granted: true, enabled: toBool(row.enabled) }
  }

  async grantEntitlements(orgId: string, capabilities: AudioCapability[], grantedBy: string): Promise<void> {
    const now = this.clock.isoNow()
    for (const capability of capabilities) {
      await upsertRow(
        this.db,
        'org_audio_entitlements',
        {
          id: newId('aent', this.clock.now()),
          org_id: orgId,
          capability,
          enabled: 1,
          granted_by: grantedBy,
          created_at: now,
        },
        ['org_id', 'capability'],
      )
    }
  }

  async revokeEntitlement(orgId: string, capability: AudioCapability): Promise<void> {
    await this.db.run('DELETE FROM org_audio_entitlements WHERE org_id = ? AND capability = ?', [orgId, capability])
  }

  async setEntitlementEnabled(orgId: string, capability: AudioCapability, enabled: boolean): Promise<void> {
    const result = await this.db.run('UPDATE org_audio_entitlements SET enabled = ? WHERE org_id = ? AND capability = ?', [
      enabled ? 1 : 0,
      orgId,
      capability,
    ])
    if (result.changes === 0) throw notFound('entitlement', capability)
  }

  async listKeyterms(orgId: string): Promise<Array<KeytermEntry & { id: string }>> {
    const rows = await this.db.query('SELECT * FROM audio_keyterms WHERE org_id = ? ORDER BY category, term', [orgId])
    return rows.map((row) => ({
      id: toStr(row.id),
      term: toStr(row.term),
      category: toStr(row.category),
      sensitivity: toStr(row.sensitivity) === 'private' ? 'private' : 'shareable',
    }))
  }

  async addKeyterm(orgId: string, entry: KeytermEntry, createdBy: string): Promise<string> {
    const id = newId('akey', this.clock.now())
    await upsertRow(
      this.db,
      'audio_keyterms',
      {
        id,
        org_id: orgId,
        term: entry.term,
        category: entry.category,
        sensitivity: entry.sensitivity,
        created_by: createdBy,
        created_at: this.clock.isoNow(),
      },
      ['org_id', 'term'],
    )
    return id
  }

  async removeKeyterm(orgId: string, id: string): Promise<void> {
    await this.db.run('DELETE FROM audio_keyterms WHERE org_id = ? AND id = ?', [orgId, id])
  }
}

function mapPolicy(row: Record<string, unknown>): AudioDataPolicy {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    allowAudioUpload: toBool(row.allow_audio_upload),
    allowMeetingRecording: toBool(row.allow_meeting_recording),
    allowCallRecording: toBool(row.allow_call_recording),
    allowTranscription: toBool(row.allow_transcription),
    allowVoiceGeneration: toBool(row.allow_voice_generation),
    allowDubbing: toBool(row.allow_dubbing),
    allowMusicGeneration: toBool(row.allow_music_generation),
    allowVoiceCloning: toBool(row.allow_voice_cloning),
    requireZeroRetention: toBool(row.require_zero_retention),
    allowProviderStorage: toBool(row.allow_provider_storage),
    allowInternalStorage: toBool(row.allow_internal_storage),
    sourceAudioRetentionDays: toNumOrNull(row.source_audio_retention_days),
    transcriptRetentionDays: toNumOrNull(row.transcript_retention_days),
    generatedAudioRetentionDays: toNumOrNull(row.generated_audio_retention_days),
    agentConversationRetentionDays: toNumOrNull(row.agent_conversation_retention_days),
    voiceSampleRetentionDays: toNumOrNull(row.voice_sample_retention_days),
    allowHumanReview: toBool(row.allow_human_review),
    allowAIExtraction: toBool(row.allow_ai_extraction),
    allowDownload: toBool(row.allow_download),
    allowExport: toBool(row.allow_export),
    requireRecordingConsent: toBool(row.require_recording_consent),
    requireAgentDisclosure: toBool(row.require_agent_disclosure),
    requireRightsConfirmation: toBool(row.require_rights_confirmation),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapEntitlement(row: Record<string, unknown>): OrgEntitlement {
  const capability = toStr(row.capability)
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    capability: (isAudioCapability(capability) ? capability : 'audio.api') as AudioCapability,
    enabled: toBool(row.enabled),
    grantedBy: toStr(row.granted_by),
    createdAt: toStr(row.created_at),
  }
}
