import { AppError } from '@masterclip/shared'
import type {
  ProviderHealth,
  ProviderVoiceProfile,
  VerifiedVoiceRegistrationRequest,
  VoiceIdentityProvider,
} from '@masterclip/audio-core'
import { ELEVENLABS_PROVIDER_ID, type ElevenLabsClient } from './client.js'
import { elevenLabsHealth } from './transcription.js'

interface VoiceResponse {
  voice_id: string
  name?: string
  category?: string
  voice_verification?: { requires_verification?: boolean; is_verified?: boolean }
}

/**
 * Voice identity adapter.
 *
 * Deliberately narrow: Street Banker does not upload voice samples on anyone's
 * behalf. The supported model is `external_reference` — the artist completes
 * the provider's own verified-voice flow (PVC) themselves and shares the
 * resulting voice id; we confirm it exists, record its verification state, and
 * store only the reference. Revocation deletes the voice from the account
 * where supported.
 */
export class ElevenLabsVoiceIdentityAdapter implements VoiceIdentityProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  supportsZeroRetention(): boolean {
    return false
  }

  async registerVerifiedVoice(input: VerifiedVoiceRegistrationRequest): Promise<ProviderVoiceProfile> {
    if (input.mode !== 'external_reference') {
      throw new AppError({
        kind: 'provider_rejected',
        code: 'voice.owner_verification_required',
        message:
          'voice registration on behalf of an artist is not supported — the voice owner must complete ' +
          'the provider’s verified voice flow themselves and share the resulting voice reference',
      })
    }
    if (!input.providerVoiceId) {
      throw new AppError({ kind: 'validation', code: 'voice.missing_reference', message: 'a provider voice reference is required' })
    }
    const { body } = await this.client.json<VoiceResponse>(`v1/voices/${encodeURIComponent(input.providerVoiceId)}`)
    const verified = body.voice_verification?.is_verified === true
    return {
      providerVoiceId: body.voice_id,
      verificationStatus: verified ? 'verified' : body.voice_verification?.requires_verification ? 'pending' : 'unverified',
      raw: body,
    }
  }

  async revokeVoice(providerVoiceId: string): Promise<void> {
    await this.client.json(`v1/voices/${encodeURIComponent(providerVoiceId)}`, { method: 'DELETE' })
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}
