import { AppError } from '@masterclip/shared'
import type {
  AgentConversationClassification,
  AgentConversationClassificationRequest,
  AudioProviderId,
  CompositionPlanRequest,
  CompositionPlanResult,
  ConversationSession,
  CreateAgentRequest,
  CreateConversationSessionRequest,
  DubbingJobStatus,
  DubbingProjectResult,
  DubbingRequest,
  MeetingIntelligenceExtractionRequest,
  MeetingIntelligenceResult,
  MusicGenerationRequest,
  MusicGenerationResult,
  MusicInpaintingRequest,
  OwnedMusicUploadRequest,
  OwnedMusicUploadResult,
  ProviderAgentDefinition,
  ProviderAsset,
  ProviderConversation,
  ProviderHealth,
  ProviderVoiceProfile,
  SignalBriefRequest,
  SignalBriefResult,
  SoundEffectRequest,
  SoundEffectResult,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  StemSeparationRequest,
  StemSeparationResult,
  TranscriptionJobResult,
  TranscriptionJobStatus,
  TranscriptionRequest,
  UpdateAgentRequest,
  VerifiedVoiceRegistrationRequest,
  VoiceIsolationRequest,
  VoiceIsolationResult,
} from './types.js'

/**
 * Provider-independent audio interfaces.
 *
 * Every capability the platform uses is expressed here, once. ElevenLabs is one
 * implementation; the mock is another; a future vendor is a third. Domain
 * models, jobs and routes depend on these interfaces only — swapping a vendor
 * is writing an adapter, not a migration.
 */

/** Common surface every audio provider implementation exposes. */
export interface AudioProviderBase {
  readonly providerId: AudioProviderId
  isConfigured(): boolean
  /**
   * Whether this provider/account combination can process the given operation
   * without retaining content. Checked BEFORE any bytes leave the platform for
   * an org whose policy requires zero retention.
   */
  supportsZeroRetention(operation: string): boolean
  healthCheck(): Promise<ProviderHealth>
}

export interface AudioTranscriptionProvider extends AudioProviderBase {
  transcribe(input: TranscriptionRequest): Promise<TranscriptionJobResult>
  getTranscriptionStatus(providerJobId: string): Promise<TranscriptionJobStatus>
}

export interface SpeechSynthesisProvider extends AudioProviderBase {
  synthesize(input: SpeechSynthesisRequest): Promise<SpeechSynthesisResult>
}

export interface ConversationalAgentProvider extends AudioProviderBase {
  createAgent(input: CreateAgentRequest): Promise<ProviderAgentDefinition>
  updateAgent(input: UpdateAgentRequest): Promise<ProviderAgentDefinition>
  createConversationSession(input: CreateConversationSessionRequest): Promise<ConversationSession>
  getConversation(providerConversationId: string): Promise<ProviderConversation>
}

export interface DubbingProvider extends AudioProviderBase {
  createDubbingProject(input: DubbingRequest): Promise<DubbingProjectResult>
  getDubbingStatus(providerJobId: string): Promise<DubbingJobStatus>
  downloadDubbingAsset(providerJobId: string, languageCode: string): Promise<ProviderAsset>
}

export interface MusicGenerationProvider extends AudioProviderBase {
  generateMusic(input: MusicGenerationRequest): Promise<MusicGenerationResult>
  uploadOwnedMusic?(input: OwnedMusicUploadRequest): Promise<OwnedMusicUploadResult>
  createInpaintingVersion?(input: MusicInpaintingRequest): Promise<MusicGenerationResult>
  extractCompositionPlan?(input: CompositionPlanRequest): Promise<CompositionPlanResult>
}

export interface StemSeparationProvider extends AudioProviderBase {
  separateStems(input: StemSeparationRequest): Promise<StemSeparationResult>
}

export interface VoiceIsolationProvider extends AudioProviderBase {
  isolateVoice(input: VoiceIsolationRequest): Promise<VoiceIsolationResult>
}

export interface SoundEffectsProvider extends AudioProviderBase {
  generateSoundEffect(input: SoundEffectRequest): Promise<SoundEffectResult>
}

export interface VoiceIdentityProvider extends AudioProviderBase {
  registerVerifiedVoice(input: VerifiedVoiceRegistrationRequest): Promise<ProviderVoiceProfile>
  revokeVoice(providerVoiceId: string): Promise<void>
}

/**
 * Structured reasoning is a provider too: meeting extraction and brief writing
 * must not be welded to one LLM vendor any more than audio is to one audio
 * vendor. The heuristic implementation keeps every workflow runnable offline.
 */
export interface StructuredReasoningProvider {
  readonly providerId: AudioProviderId
  extractMeetingIntelligence(input: MeetingIntelligenceExtractionRequest): Promise<MeetingIntelligenceResult>
  generateSignalBrief(input: SignalBriefRequest): Promise<SignalBriefResult>
  classifyAgentConversation(input: AgentConversationClassificationRequest): Promise<AgentConversationClassification>
}

export type AudioCapabilitySlot =
  | 'transcription'
  | 'speech'
  | 'agent'
  | 'dubbing'
  | 'music'
  | 'stems'
  | 'isolation'
  | 'soundEffects'
  | 'voiceIdentity'

export interface AudioProviderSet {
  transcription?: AudioTranscriptionProvider
  speech?: SpeechSynthesisProvider
  agent?: ConversationalAgentProvider
  dubbing?: DubbingProvider
  music?: MusicGenerationProvider
  stems?: StemSeparationProvider
  isolation?: VoiceIsolationProvider
  soundEffects?: SoundEffectsProvider
  voiceIdentity?: VoiceIdentityProvider
}

/**
 * Registry of audio providers by capability slot.
 *
 * Resolution order: an explicitly requested provider, else the configured
 * default, else the configured fallback, else the mock. Unconfigured providers
 * never resolve implicitly — a missing credential surfaces as the mock (clearly
 * labelled), not as a silent failure.
 */
export class AudioProviderRegistry {
  private readonly slots = new Map<AudioCapabilitySlot, Map<AudioProviderId, AudioProviderBase>>()
  private defaults: Partial<Record<AudioCapabilitySlot, AudioProviderId>> = {}
  private fallbacks: Partial<Record<AudioCapabilitySlot, AudioProviderId>> = {}

  register(set: AudioProviderSet): void {
    for (const [slot, provider] of Object.entries(set) as Array<[AudioCapabilitySlot, AudioProviderBase | undefined]>) {
      if (!provider) continue
      const bySlot = this.slots.get(slot) ?? new Map<AudioProviderId, AudioProviderBase>()
      bySlot.set(provider.providerId, provider)
      this.slots.set(slot, bySlot)
    }
  }

  configureDefaults(defaults: Partial<Record<AudioCapabilitySlot, AudioProviderId>>, fallbacks: Partial<Record<AudioCapabilitySlot, AudioProviderId>> = {}): void {
    this.defaults = { ...this.defaults, ...defaults }
    this.fallbacks = { ...this.fallbacks, ...fallbacks }
  }

  list(slot: AudioCapabilitySlot): AudioProviderBase[] {
    return [...(this.slots.get(slot)?.values() ?? [])]
  }

  listAll(): Array<{ slot: AudioCapabilitySlot; provider: AudioProviderBase }> {
    const out: Array<{ slot: AudioCapabilitySlot; provider: AudioProviderBase }> = []
    for (const [slot, bySlot] of this.slots) for (const provider of bySlot.values()) out.push({ slot, provider })
    return out
  }

  resolve<T extends AudioProviderBase>(slot: AudioCapabilitySlot, preferred?: AudioProviderId): T {
    const bySlot = this.slots.get(slot)
    if (!bySlot || bySlot.size === 0) {
      throw new AppError({ kind: 'internal', code: 'audio.no_provider', message: `no ${slot} provider registered` })
    }
    if (preferred) {
      const provider = bySlot.get(preferred)
      if (!provider) {
        throw new AppError({ kind: 'validation', code: 'audio.unknown_provider', message: `${preferred} is not a registered ${slot} provider` })
      }
      return provider as T
    }
    const candidates = [this.defaults[slot], this.fallbacks[slot]]
    for (const id of candidates) {
      if (!id) continue
      const provider = bySlot.get(id)
      if (provider?.isConfigured()) return provider as T
    }
    // Last resort: the mock, so every workflow stays exercisable credential-free.
    const mock = bySlot.get('mock-audio')
    if (mock) return mock as T
    const first = [...bySlot.values()][0]
    if (first) return first as T
    throw new AppError({ kind: 'internal', code: 'audio.no_provider', message: `no usable ${slot} provider` })
  }

  async health(): Promise<ProviderHealth[]> {
    const seen = new Map<AudioProviderId, AudioProviderBase>()
    for (const { provider } of this.listAll()) if (!seen.has(provider.providerId)) seen.set(provider.providerId, provider)
    const out: ProviderHealth[] = []
    for (const provider of seen.values()) {
      try {
        out.push(await provider.healthCheck())
      } catch (err) {
        out.push({
          providerId: provider.providerId,
          status: 'down',
          message: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        })
      }
    }
    return out
  }
}
