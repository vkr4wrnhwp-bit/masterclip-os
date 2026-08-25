import { AppError } from '@masterclip/shared'
import { assertPolicyAllows, defaultDisclosure, type VoiceIdentityProvider } from '@masterclip/audio-core'
import type { VoicePermittedUses, VoiceProfileRecord } from '@masterclip/audio-domain'
import type { Actor, AudioEngineDeps } from './deps.js'

/**
 * Artist Voice Vault — governed storage of verified voice permissions.
 *
 * Not a cloning marketplace. The supported registration path is the voice
 * owner completing the provider's own verification and sharing the resulting
 * reference; Street Banker stores the reference and the permission record, and
 * never possesses the underlying voice model. A manager or label cannot
 * register an artist's voice on their behalf — the provider adapters refuse
 * any mode other than an owner-verified external reference.
 */
export class VoiceVaultService {
  constructor(private readonly deps: AudioEngineDeps) {}

  async register(input: {
    actor: Actor
    ownerName: string
    profileName: string
    providerVoiceId: string
    ownerConsentConfirmed: boolean
    permittedUses: Partial<VoicePermittedUses>
    validUntil: string | null
  }): Promise<VoiceProfileRecord> {
    const policy = await this.deps.repos.policy.getPolicy(input.actor.orgId)
    assertPolicyAllows(policy, 'clone_voice')
    if (!input.ownerConsentConfirmed) {
      throw new AppError({
        kind: 'forbidden',
        code: 'voice.consent_required',
        message: 'voice registration requires the voice owner’s explicit consent acknowledgment',
      })
    }
    if (!input.providerVoiceId) {
      throw new AppError({
        kind: 'validation',
        code: 'voice.reference_required',
        message:
          'the voice owner must complete the provider’s verified-voice process themselves and share the ' +
          'resulting voice reference — uploads on an artist’s behalf are not supported',
      })
    }
    const settings = await this.deps.repos.policy.getSettings(input.actor.orgId)
    const provider = this.deps.registry.resolve<VoiceIdentityProvider>('voiceIdentity', settings.defaultProviders.voiceIdentity)
    const remote = await provider.registerVerifiedVoice({
      orgId: input.actor.orgId,
      mode: 'external_reference',
      providerVoiceId: input.providerVoiceId,
      ownerName: input.ownerName,
      consentRecordId: 'pending',
    })

    const disclosure = defaultDisclosure('voice_cloning')
    const consent = await this.deps.repos.consents.record({
      orgId: input.actor.orgId,
      subjectType: 'voice_profile',
      subjectId: remote.providerVoiceId,
      consentType: 'voice_cloning',
      policyVersion: disclosure.version,
      disclosureText: disclosure.text,
      accepted: true,
      acceptedBy: input.actor.userId,
      evidence: { ownerName: input.ownerName, providerVoiceId: remote.providerVoiceId, verification: remote.verificationStatus },
    })
    const profile = await this.deps.repos.voiceVault.create({
      orgId: input.actor.orgId,
      voiceOwnerName: input.ownerName,
      voiceOwnerPersonId: null,
      provider: provider.providerId,
      providerVoiceId: remote.providerVoiceId,
      name: input.profileName,
      status: remote.verificationStatus === 'verified' ? 'active' : 'pending',
      verificationStatus: remote.verificationStatus,
      consentRecordId: consent.id,
      permittedUses: {
        commercial: false,
        advertising: false,
        dubbing: false,
        social: false,
        internal: true,
        sublicensing: false,
        channels: [],
        territories: [],
        languages: [],
        projects: [],
        ...input.permittedUses,
      },
      validFrom: this.deps.clock.isoNow(),
      validUntil: input.validUntil,
      createdBy: input.actor.userId,
    })
    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'audio.voice_registered',
      targetType: 'voice_profile',
      targetId: profile.id,
      data: { verification: remote.verificationStatus, consentRecordId: consent.id },
    })
    return profile
  }

  /**
   * Revocation: new generation stops immediately, audit records survive,
   * existing assets flip to rights-review, and the provider-side voice is
   * revoked where supported.
   */
  async revoke(actor: Actor, profileId: string): Promise<VoiceProfileRecord> {
    const profile = await this.deps.repos.voiceVault.revoke(actor.orgId, profileId, actor.userId)
    await this.deps.repos.consents.revoke(actor.orgId, profile.consentRecordId)
    // Existing generated assets that used this voice need rights review.
    await this.deps.db.run(
      `UPDATE audio_assets SET rights_status = 'rights_review_voice_revoked'
        WHERE org_id = ? AND id IN (SELECT output_asset_id FROM audio_generations WHERE org_id = ? AND voice_profile_id = ?)`,
      [actor.orgId, actor.orgId, profileId],
    )
    const settings = await this.deps.repos.policy.getSettings(actor.orgId)
    try {
      const provider = this.deps.registry.resolve<VoiceIdentityProvider>('voiceIdentity', settings.defaultProviders.voiceIdentity)
      if (provider.providerId === profile.provider) await provider.revokeVoice(profile.providerVoiceId)
    } catch (err) {
      // Provider-side revocation failing must not resurrect the voice here.
      this.deps.logger.warn('audio.voice_provider_revoke_failed', { profile_id: profileId, err })
    }
    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'audio.voice_revoked',
      targetType: 'voice_profile',
      targetId: profileId,
      data: {},
    })
    return profile
  }
}
