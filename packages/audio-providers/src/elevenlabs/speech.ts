import { AppError } from '@masterclip/shared'
import type {
  ProviderHealth,
  SoundEffectRequest,
  SoundEffectResult,
  SoundEffectsProvider,
  SpeechSynthesisProvider,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  VoiceIsolationProvider,
  VoiceIsolationRequest,
  VoiceIsolationResult,
} from '@masterclip/audio-core'
import { ELEVENLABS_PROVIDER_ID, usageFrom, type ElevenLabsClient } from './client.js'
import { elevenLabsHealth } from './transcription.js'

/** `POST v1/text-to-speech/{voice_id}` — binary audio out, characters billed. */
export class ElevenLabsSpeechSynthesisAdapter implements SpeechSynthesisProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured() && this.client.opts.ttsDefaultVoiceId.length > 0
  }

  supportsZeroRetention(): boolean {
    return this.client.opts.zeroRetentionCapable
  }

  async synthesize(input: SpeechSynthesisRequest): Promise<SpeechSynthesisResult> {
    const voiceId = input.voiceRef || this.client.opts.ttsDefaultVoiceId
    if (!voiceId) {
      throw new AppError({
        kind: 'validation',
        code: 'elevenlabs.no_voice',
        message: 'no voice configured — set ELEVENLABS_TTS_VOICE_ID or pass an approved voice reference',
      })
    }
    const query: Record<string, string | undefined> = {
      output_format: input.outputFormat ?? 'mp3_44100_128',
      enable_logging: input.zeroRetention ? 'false' : undefined,
    }
    const body: Record<string, unknown> = {
      text: input.text,
      model_id: input.modelId ?? this.client.opts.ttsModelId,
    }
    if (input.languageCode) body.language_code = input.languageCode
    if (input.settings) body.voice_settings = input.settings

    const { bytes, contentType, requestId } = await this.client.jsonBinary(`v1/text-to-speech/${encodeURIComponent(voiceId)}`, body, query)
    return {
      audio: { bytes, contentType, filename: 'speech.mp3' },
      usage: usageFrom('characters', input.text.length, 0, requestId),
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}

/** `POST v1/sound-generation` — text to sound effect, binary out. */
export class ElevenLabsSoundEffectsAdapter implements SoundEffectsProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  supportsZeroRetention(): boolean {
    return this.client.opts.zeroRetentionCapable
  }

  async generateSoundEffect(input: SoundEffectRequest): Promise<SoundEffectResult> {
    const body: Record<string, unknown> = { text: input.text }
    if (input.durationSeconds !== undefined) body.duration_seconds = input.durationSeconds
    if (input.promptInfluence !== undefined) body.prompt_influence = input.promptInfluence
    if (input.loop !== undefined) body.loop = input.loop
    if (this.client.opts.sfxModelId) body.model_id = this.client.opts.sfxModelId

    const { bytes, contentType, requestId } = await this.client.jsonBinary('v1/sound-generation', body)
    return {
      audio: { bytes, contentType, filename: 'sound-effect.mp3' },
      usage: usageFrom('requests', 1, Math.round(input.durationSeconds ?? 0), requestId),
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}

/** `POST v1/audio-isolation` — strips background from dialogue, binary out. */
export class ElevenLabsVoiceIsolationAdapter implements VoiceIsolationProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  supportsZeroRetention(): boolean {
    return this.client.opts.zeroRetentionCapable
  }

  async isolateVoice(input: VoiceIsolationRequest): Promise<VoiceIsolationResult> {
    const { bytes, contentType, requestId } = await this.client.multipartBinary('v1/audio-isolation', {}, [
      { field: 'audio', input: input.audio },
    ])
    return {
      audio: { bytes, contentType, filename: 'isolated.mp3' },
      usage: usageFrom('requests', 1, 0, requestId),
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}
