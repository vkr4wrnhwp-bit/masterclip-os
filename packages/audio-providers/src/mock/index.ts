import { AppError, sha256Hex } from '@masterclip/shared'
import type {
  AudioInput,
  AudioProviderSet,
  AudioTranscriptionProvider,
  CompositionPlanRequest,
  CompositionPlanResult,
  ConversationSession,
  ConversationalAgentProvider,
  CreateAgentRequest,
  CreateConversationSessionRequest,
  DubbingJobStatus,
  DubbingProjectResult,
  DubbingProvider,
  DubbingRequest,
  MusicGenerationProvider,
  MusicGenerationRequest,
  MusicGenerationResult,
  MusicInpaintingRequest,
  NormalizedTranscript,
  OwnedMusicUploadRequest,
  OwnedMusicUploadResult,
  ProviderAgentDefinition,
  ProviderAsset,
  ProviderConversation,
  ProviderHealth,
  ProviderVoiceProfile,
  SoundEffectRequest,
  SoundEffectResult,
  SoundEffectsProvider,
  SpeechSynthesisProvider,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  StemSeparationProvider,
  StemSeparationRequest,
  StemSeparationResult,
  TranscriptionJobResult,
  TranscriptionJobStatus,
  TranscriptionRequest,
  UpdateAgentRequest,
  VerifiedVoiceRegistrationRequest,
  VoiceIdentityProvider,
  VoiceIsolationProvider,
  VoiceIsolationRequest,
  VoiceIsolationResult,
} from '@masterclip/audio-core'
import { renderWav, seedFromString } from './wav.js'

export const MOCK_AUDIO_PROVIDER_ID = 'mock-audio'

export * from './wav.js'

/**
 * Mock audio providers.
 *
 * Deterministic, credential-free, and honest about being mock: every asset is
 * a real playable WAV, every transcript is plainly fictional, and behaviour is
 * a function of the input hash so tests can rely on it. Zero-retention is
 * "supported" because nothing here retains anything.
 */

function health(): ProviderHealth {
  return { providerId: MOCK_AUDIO_PROVIDER_ID, status: 'healthy', latencyMs: 1, message: 'mock provider', checkedAt: new Date().toISOString() }
}

function inputSeed(input: AudioInput): number {
  const material = input.bytes ? sha256Hex(Buffer.from(input.bytes)) : (input.path ?? input.url ?? 'mock')
  return seedFromString(material)
}

abstract class MockBase {
  readonly providerId = MOCK_AUDIO_PROVIDER_ID
  isConfigured(): boolean {
    return true
  }
  supportsZeroRetention(): boolean {
    return true
  }
  async healthCheck(): Promise<ProviderHealth> {
    return health()
  }
}

/** A plainly fictional diarized meeting — no real people, labels, or releases. */
const MOCK_MEETING_LINES: Array<{ speaker: string; text: string }> = [
  { speaker: 'speaker_0', text: 'Thanks for making time. This call is about the Nova Verge distribution setup.' },
  { speaker: 'speaker_1', text: 'Appreciate it. We self-released the last EP through Chorusline and kept about seventy percent.' },
  { speaker: 'speaker_0', text: 'Understood. For the next release we would propose a two year license, North America territory, with a fifteen percent distribution fee.' },
  { speaker: 'speaker_1', text: 'Two years could work. We would need marketing spend confirmed before the tour in March.' },
  { speaker: 'speaker_0', text: 'I will send the split sheet template and we need the ISRC list for the back catalog by Friday.' },
  { speaker: 'speaker_1', text: 'One concern: our old distributor still claims Content ID on two tracks. That needs verification.' },
  { speaker: 'speaker_0', text: 'Noted as a rights issue. Action for us: check the Content ID claims. Action for you: send the ISRC list.' },
]

export class MockTranscriptionAdapter extends MockBase implements AudioTranscriptionProvider {
  async transcribe(input: TranscriptionRequest): Promise<TranscriptionJobResult> {
    const seed = inputSeed(input.audio)
    const transcript = mockTranscript(input.diarize, seed)
    return {
      providerJobId: `mock-stt-${seed.toString(16)}`,
      status: 'complete',
      transcript,
      usage: { unit: 'seconds', inputUnits: Math.ceil(transcript.segments[transcript.segments.length - 1]!.endMs / 1000), outputUnits: 0 },
    }
  }

  async getTranscriptionStatus(providerJobId: string): Promise<TranscriptionJobStatus> {
    const transcript = mockTranscript(true, seedFromString(providerJobId))
    return { status: 'complete', transcript }
  }
}

export function mockTranscript(diarize: boolean, seed: number): NormalizedTranscript {
  let cursor = 500 + (seed % 400)
  const segments = MOCK_MEETING_LINES.map((line) => {
    const durationMs = 2600 + (line.text.length % 7) * 350
    const segment = {
      speakerKey: diarize ? line.speaker : null,
      startMs: cursor,
      endMs: cursor + durationMs,
      text: line.text,
      confidence: 0.94,
    }
    cursor += durationMs + 350
    return segment
  })
  return {
    language: 'en',
    languageConfidence: 0.98,
    fullText: MOCK_MEETING_LINES.map((l) => l.text).join(' '),
    confidence: 0.94,
    segments,
    raw: { mock: true, seed },
  }
}

export class MockSpeechSynthesisAdapter extends MockBase implements SpeechSynthesisProvider {
  async synthesize(input: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    const durationSeconds = Math.min(90, Math.max(2, input.text.split(/\s+/).length * 0.38))
    const bytes = renderWav({ frequency: 196, durationSeconds, seed: seedFromString(input.text + input.voiceRef) })
    return {
      audio: { bytes, contentType: 'audio/wav', filename: 'speech.wav' },
      usage: { unit: 'characters', inputUnits: input.text.length, outputUnits: 0 },
    }
  }
}

export class MockAgentAdapter extends MockBase implements ConversationalAgentProvider {
  async createAgent(input: CreateAgentRequest): Promise<ProviderAgentDefinition> {
    return { providerAgentId: `mock-agent-${seedFromString(input.orgId + input.name).toString(16)}`, raw: { mock: true } }
  }

  async updateAgent(input: UpdateAgentRequest): Promise<ProviderAgentDefinition> {
    return { providerAgentId: input.providerAgentId, raw: { mock: true } }
  }

  async createConversationSession(input: CreateConversationSessionRequest): Promise<ConversationSession> {
    return {
      providerConversationId: `mock-conv-${seedFromString(JSON.stringify(input.metadata)).toString(16)}`,
      mode: 'mock',
      value: 'mock-session',
    }
  }

  async getConversation(providerConversationId: string): Promise<ProviderConversation> {
    return {
      providerConversationId,
      status: 'ended',
      turns: [
        { role: 'agent', text: 'You are speaking with an AI-powered Street Banker assistant. How can I help today?', atMs: 0 },
        { role: 'user', text: 'I want to know about distribution for my next single.', atMs: 4000 },
        { role: 'agent', text: 'I can collect the details and set up a call with a Street Banker operator.', atMs: 9000 },
      ],
      durationSeconds: 42,
      raw: { mock: true },
    }
  }
}

export class MockDubbingAdapter extends MockBase implements DubbingProvider {
  async createDubbingProject(input: DubbingRequest): Promise<DubbingProjectResult> {
    const target = input.targetLanguages[0] ?? 'es'
    return { providerJobId: `mock-dub-${target}-${inputSeed(input.source).toString(16)}`, expectedDurationSeconds: 1 }
  }

  async getDubbingStatus(providerJobId: string): Promise<DubbingJobStatus> {
    const language = providerJobId.split('-')[2] ?? 'es'
    return { status: 'complete', readyLanguages: [language] }
  }

  async downloadDubbingAsset(providerJobId: string, languageCode: string): Promise<ProviderAsset> {
    const bytes = renderWav({ frequency: 175, durationSeconds: 6, seed: seedFromString(providerJobId + languageCode) })
    return { bytes, contentType: 'audio/wav', filename: `dub-${languageCode}.wav` }
  }
}

export class MockMusicAdapter extends MockBase implements MusicGenerationProvider {
  async generateMusic(input: MusicGenerationRequest): Promise<MusicGenerationResult> {
    const seed = input.seed ?? seedFromString(input.prompt ?? JSON.stringify(input.compositionPlan ?? {}))
    const durationSeconds = Math.min(30, Math.max(3, (input.musicLengthMs ?? 8000) / 1000))
    const bytes = renderWav({ frequency: 110, durationSeconds, seed })
    return {
      audio: { bytes, contentType: 'audio/wav', filename: 'composition.wav' },
      providerSongId: `mock-song-${seed.toString(16)}`,
      seed,
      usage: { unit: 'requests', inputUnits: 1, outputUnits: Math.round(durationSeconds) },
    }
  }

  async uploadOwnedMusic(input: OwnedMusicUploadRequest): Promise<OwnedMusicUploadResult> {
    // Deterministic screening hook for tests: a filename containing
    // "screenme" simulates the provider asking for rights review.
    const name = input.audio.filename ?? ''
    if (name.includes('screenme')) {
      return { providerSongId: null, screening: 'rights_review_required', message: 'mock provider requested rights review' }
    }
    return { providerSongId: `mock-song-${inputSeed(input.audio).toString(16)}`, screening: 'accepted' }
  }

  async createInpaintingVersion(input: MusicInpaintingRequest): Promise<MusicGenerationResult> {
    const seed = seedFromString(JSON.stringify(input.compositionPlan))
    const bytes = renderWav({ frequency: 130, durationSeconds: 8, seed })
    return {
      audio: { bytes, contentType: 'audio/wav', filename: 'inpainted.wav' },
      ...(input.providerSongId ? { providerSongId: input.providerSongId } : {}),
      compositionPlan: input.compositionPlan,
      seed,
    }
  }

  async extractCompositionPlan(input: CompositionPlanRequest): Promise<CompositionPlanResult> {
    return {
      plan: {
        positive_global_styles: ['mid-tempo', 'warm', 'analog texture'],
        negative_global_styles: ['harsh noise'],
        sections: [
          { section_name: 'intro', duration_ms: 4000, lines: [] },
          { section_name: 'main', duration_ms: 8000, lines: [] },
          { section_name: 'outro', duration_ms: 4000, lines: [] },
        ],
        source: input.prompt ? 'prompt' : 'uploaded-audio',
      },
    }
  }
}

export class MockStemSeparationAdapter extends MockBase implements StemSeparationProvider {
  async separateStems(input: StemSeparationRequest): Promise<StemSeparationResult> {
    const seed = inputSeed(input.audio)
    const stems = ['vocals', 'drums', 'bass', 'other'].map((name, index) => ({
      name,
      audio: {
        bytes: renderWav({ frequency: 90 + index * 60, durationSeconds: 5, seed: seed + index }),
        contentType: 'audio/wav',
        filename: `${name}.wav`,
      },
    }))
    return { stems, usage: { unit: 'requests', inputUnits: 1, outputUnits: stems.length } }
  }
}

export class MockVoiceIsolationAdapter extends MockBase implements VoiceIsolationProvider {
  async isolateVoice(input: VoiceIsolationRequest): Promise<VoiceIsolationResult> {
    const bytes = renderWav({ frequency: 220, durationSeconds: 5, seed: inputSeed(input.audio) })
    return { audio: { bytes, contentType: 'audio/wav', filename: 'isolated.wav' } }
  }
}

export class MockSoundEffectsAdapter extends MockBase implements SoundEffectsProvider {
  async generateSoundEffect(input: SoundEffectRequest): Promise<SoundEffectResult> {
    const bytes = renderWav({
      frequency: 330,
      durationSeconds: Math.min(30, Math.max(0.5, input.durationSeconds ?? 2)),
      seed: seedFromString(input.text),
    })
    return { audio: { bytes, contentType: 'audio/wav', filename: 'sound-effect.wav' } }
  }
}

export class MockVoiceIdentityAdapter extends MockBase implements VoiceIdentityProvider {
  private readonly revoked = new Set<string>()

  async registerVerifiedVoice(input: VerifiedVoiceRegistrationRequest): Promise<ProviderVoiceProfile> {
    if (input.mode !== 'external_reference') {
      throw new AppError({
        kind: 'provider_rejected',
        code: 'voice.owner_verification_required',
        message: 'the voice owner must complete provider verification themselves',
      })
    }
    const providerVoiceId = input.providerVoiceId ?? `mock-voice-${seedFromString(input.ownerName).toString(16)}`
    // Mock verification convention: ids containing "unverified" stay pending.
    const verified = !providerVoiceId.includes('unverified')
    return { providerVoiceId, verificationStatus: verified ? 'verified' : 'pending', raw: { mock: true } }
  }

  async revokeVoice(providerVoiceId: string): Promise<void> {
    this.revoked.add(providerVoiceId)
  }

  wasRevoked(providerVoiceId: string): boolean {
    return this.revoked.has(providerVoiceId)
  }
}

export function createMockAudioProviders(): AudioProviderSet {
  return {
    transcription: new MockTranscriptionAdapter(),
    speech: new MockSpeechSynthesisAdapter(),
    agent: new MockAgentAdapter(),
    dubbing: new MockDubbingAdapter(),
    music: new MockMusicAdapter(),
    stems: new MockStemSeparationAdapter(),
    isolation: new MockVoiceIsolationAdapter(),
    soundEffects: new MockSoundEffectsAdapter(),
    voiceIdentity: new MockVoiceIdentityAdapter(),
  }
}
