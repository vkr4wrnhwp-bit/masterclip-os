import type { AudioProviderSet } from '@masterclip/audio-core'
import { ElevenLabsClient, type ElevenLabsOptions } from './client.js'
import { ElevenLabsTranscriptionAdapter } from './transcription.js'
import { ElevenLabsSpeechSynthesisAdapter, ElevenLabsSoundEffectsAdapter, ElevenLabsVoiceIsolationAdapter } from './speech.js'
import { ElevenLabsAgentAdapter } from './agent.js'
import { ElevenLabsDubbingAdapter } from './dubbing.js'
import { ElevenLabsMusicAdapter, ElevenLabsStemSeparationAdapter } from './music.js'
import { ElevenLabsVoiceIdentityAdapter } from './voice-identity.js'

export * from './client.js'
export * from './transcription.js'
export * from './speech.js'
export * from './agent.js'
export * from './dubbing.js'
export * from './music.js'
export * from './voice-identity.js'
export * from './webhook.js'

export function createElevenLabsAudioProviders(opts: ElevenLabsOptions, existingClient?: ElevenLabsClient): AudioProviderSet {
  const client = existingClient ?? new ElevenLabsClient(opts)
  return {
    transcription: new ElevenLabsTranscriptionAdapter(client),
    speech: new ElevenLabsSpeechSynthesisAdapter(client),
    agent: new ElevenLabsAgentAdapter(client),
    dubbing: new ElevenLabsDubbingAdapter(client),
    music: new ElevenLabsMusicAdapter(client),
    stems: new ElevenLabsStemSeparationAdapter(client),
    isolation: new ElevenLabsVoiceIsolationAdapter(client),
    soundEffects: new ElevenLabsSoundEffectsAdapter(client),
    voiceIdentity: new ElevenLabsVoiceIdentityAdapter(client),
  }
}
