import { AppError } from '@masterclip/shared'
import type { AudioCapability } from './capabilities.js'

/**
 * Server-side feature flags and the layered access gate.
 *
 * A feature is reachable only when every layer says yes:
 *   global flag → org entitlement → org toggle → provider entitlement →
 *   user permission → usage limit → consent → rights → retention → health.
 * The gate is evaluated server-side on every request and job; the frontend
 * hiding a button is presentation, not security.
 */

export const AUDIO_FEATURE_FLAGS = [
  'AUDIO_INTELLIGENCE_ENABLED',
  'ELEVENLABS_ENABLED',
  'MEETING_INTELLIGENCE_ENABLED',
  'SIGNAL_AUDIO_BRIEFS_ENABLED',
  'AUDIO_OPERATOR_ENABLED',
  'GLOBAL_RELEASE_PACK_ENABLED',
  'CAMPAIGN_AUDIO_TOOLKIT_ENABLED',
  'REMIX_LAB_AUDIO_ENGINE_ENABLED',
  'ARTIST_VOICE_VAULT_ENABLED',
  'WHITE_LABEL_AUDIO_OPERATOR_ENABLED',
  'DUBBING_ENABLED',
  'MUSIC_GENERATION_ENABLED',
  'MUSIC_INPAINTING_ENABLED',
  'STEM_SEPARATION_ENABLED',
  'VOICE_ISOLATION_ENABLED',
  'SOUND_EFFECTS_ENABLED',
  'VOICE_CLONING_ENABLED',
  'ZERO_RETENTION_REQUIRED',
] as const

export type AudioFeatureFlag = (typeof AUDIO_FEATURE_FLAGS)[number]

export type AudioFlagState = Record<AudioFeatureFlag, boolean>

/**
 * Which global flags must be on for a capability to function. The umbrella
 * flag AUDIO_INTELLIGENCE_ENABLED is implicit for all of them.
 */
export const CAPABILITY_FLAGS: Partial<Record<AudioCapability, AudioFeatureFlag[]>> = {
  'audio.meeting_intelligence': ['MEETING_INTELLIGENCE_ENABLED'],
  'audio.meeting_recording': ['MEETING_INTELLIGENCE_ENABLED'],
  'audio.meeting_upload': ['MEETING_INTELLIGENCE_ENABLED'],
  'audio.transcription': ['MEETING_INTELLIGENCE_ENABLED'],
  'audio.signal_briefs': ['SIGNAL_AUDIO_BRIEFS_ENABLED'],
  'audio.signal_brief_scheduling': ['SIGNAL_AUDIO_BRIEFS_ENABLED'],
  'audio.operator_agent': ['AUDIO_OPERATOR_ENABLED'],
  'audio.operator_phone': ['AUDIO_OPERATOR_ENABLED'],
  'audio.operator_web': ['AUDIO_OPERATOR_ENABLED'],
  'audio.operator_human_transfer': ['AUDIO_OPERATOR_ENABLED'],
  'audio.global_release_pack': ['GLOBAL_RELEASE_PACK_ENABLED', 'DUBBING_ENABLED'],
  'audio.dubbing': ['DUBBING_ENABLED'],
  'audio.campaign_voiceover': ['CAMPAIGN_AUDIO_TOOLKIT_ENABLED'],
  'audio.sound_effects': ['CAMPAIGN_AUDIO_TOOLKIT_ENABLED', 'SOUND_EFFECTS_ENABLED'],
  'audio.voice_isolation': ['CAMPAIGN_AUDIO_TOOLKIT_ENABLED', 'VOICE_ISOLATION_ENABLED'],
  'audio.remix_lab': ['REMIX_LAB_AUDIO_ENGINE_ENABLED'],
  'audio.stem_separation': ['REMIX_LAB_AUDIO_ENGINE_ENABLED', 'STEM_SEPARATION_ENABLED'],
  'audio.music_generation': ['REMIX_LAB_AUDIO_ENGINE_ENABLED', 'MUSIC_GENERATION_ENABLED'],
  'audio.music_inpainting': ['REMIX_LAB_AUDIO_ENGINE_ENABLED', 'MUSIC_INPAINTING_ENABLED'],
  'audio.voice_vault': ['ARTIST_VOICE_VAULT_ENABLED'],
  'audio.voice_vault_verified_cloning': ['ARTIST_VOICE_VAULT_ENABLED', 'VOICE_CLONING_ENABLED'],
  'audio.white_label_operator': ['AUDIO_OPERATOR_ENABLED', 'WHITE_LABEL_AUDIO_OPERATOR_ENABLED'],
}

export type GateCheckName =
  | 'global_flag'
  | 'org_entitlement'
  | 'org_toggle'
  | 'provider_entitlement'
  | 'user_permission'
  | 'usage_limit'
  | 'consent'
  | 'rights_confirmation'
  | 'retention_configuration'
  | 'provider_health'

export interface GateCheck {
  name: GateCheckName
  pass: boolean
  message: string
}

export interface GateDecision {
  allowed: boolean
  failed?: GateCheck
  checks: GateCheck[]
}

/** Ordered evaluation; the first failing layer names itself in the refusal. */
export function evaluateGate(checks: GateCheck[]): GateDecision {
  for (const check of checks) {
    if (!check.pass) return { allowed: false, failed: check, checks }
  }
  return { allowed: true, checks }
}

export function assertGate(decision: GateDecision): void {
  if (decision.allowed) return
  const failed = decision.failed
  throw new AppError({
    kind: failed?.name === 'usage_limit' ? 'budget_exceeded' : 'forbidden',
    code: `audio.gate.${failed?.name ?? 'denied'}`,
    message: failed?.message ?? 'audio feature unavailable',
  })
}
