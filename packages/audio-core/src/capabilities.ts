/**
 * Audio capability catalog.
 *
 * Capabilities are what Partner OS entitlements grant. The flagship org holds
 * all of them including provider administration; partner orgs receive only what
 * their plan includes. Every API route and job names the capability it needs.
 */

export type AudioCapability =
  | 'audio.meeting_intelligence'
  | 'audio.meeting_recording'
  | 'audio.meeting_upload'
  | 'audio.transcription'
  | 'audio.realtime_transcription'
  | 'audio.signal_briefs'
  | 'audio.signal_brief_scheduling'
  | 'audio.operator_agent'
  | 'audio.operator_phone'
  | 'audio.operator_web'
  | 'audio.operator_human_transfer'
  | 'audio.global_release_pack'
  | 'audio.dubbing'
  | 'audio.campaign_voiceover'
  | 'audio.sound_effects'
  | 'audio.voice_isolation'
  | 'audio.remix_lab'
  | 'audio.stem_separation'
  | 'audio.music_generation'
  | 'audio.music_inpainting'
  | 'audio.voice_vault'
  | 'audio.voice_vault_verified_cloning'
  | 'audio.white_label_operator'
  | 'audio.api'
  | 'audio.webhooks'
  | 'audio.zero_retention'
  | 'audio.custom_provider'

export interface CapabilityInfo {
  key: AudioCapability
  label: string
  description: string
  /** High-risk capabilities require flagship review before a partner receives them. */
  riskTier: 'standard' | 'elevated' | 'high'
}

export const AUDIO_CAPABILITIES: CapabilityInfo[] = [
  { key: 'audio.meeting_intelligence', label: 'Meeting Intelligence', description: 'Structured extraction from authorized meetings', riskTier: 'standard' },
  { key: 'audio.meeting_recording', label: 'Meeting recording', description: 'Record meetings in-app with consent capture', riskTier: 'elevated' },
  { key: 'audio.meeting_upload', label: 'Meeting upload', description: 'Upload authorized meeting media', riskTier: 'standard' },
  { key: 'audio.transcription', label: 'Transcription', description: 'Speech-to-text with diarization and timestamps', riskTier: 'standard' },
  { key: 'audio.realtime_transcription', label: 'Realtime transcription', description: 'Streaming transcription (future phase)', riskTier: 'elevated' },
  { key: 'audio.signal_briefs', label: 'Signal Audio Briefs', description: 'Spoken briefings from Signal intelligence', riskTier: 'standard' },
  { key: 'audio.signal_brief_scheduling', label: 'Brief scheduling', description: 'Recurring brief generation', riskTier: 'standard' },
  { key: 'audio.operator_agent', label: 'Operator voice agent', description: 'AI intake agent backed by human operators', riskTier: 'elevated' },
  { key: 'audio.operator_phone', label: 'Operator phone channel', description: 'Telephony channel for the operator agent', riskTier: 'high' },
  { key: 'audio.operator_web', label: 'Operator web channel', description: 'Web widget channel for the operator agent', riskTier: 'standard' },
  { key: 'audio.operator_human_transfer', label: 'Human transfer', description: 'Live transfer to a human operator', riskTier: 'standard' },
  { key: 'audio.global_release_pack', label: 'Global Release Pack', description: 'Localized campaign versions with human QA', riskTier: 'elevated' },
  { key: 'audio.dubbing', label: 'Dubbing', description: 'Multi-language dubbing of authorized media', riskTier: 'elevated' },
  { key: 'audio.campaign_voiceover', label: 'Campaign voiceover', description: 'Voiceover generation from approved voices', riskTier: 'elevated' },
  { key: 'audio.sound_effects', label: 'Sound effects', description: 'Generated foley, impacts, transitions', riskTier: 'standard' },
  { key: 'audio.voice_isolation', label: 'Voice isolation', description: 'Dialogue cleanup and isolation', riskTier: 'standard' },
  { key: 'audio.remix_lab', label: 'Remix Lab audio engine', description: 'Owned-audio stems, concepts, and versions', riskTier: 'elevated' },
  { key: 'audio.stem_separation', label: 'Stem separation', description: 'Split owned audio into stems', riskTier: 'standard' },
  { key: 'audio.music_generation', label: 'Music generation', description: 'Generate concept audio from neutral descriptors', riskTier: 'high' },
  { key: 'audio.music_inpainting', label: 'Music inpainting', description: 'Regenerate sections of owned uploads', riskTier: 'high' },
  { key: 'audio.voice_vault', label: 'Artist Voice Vault', description: 'Governed storage of verified voice permissions', riskTier: 'high' },
  { key: 'audio.voice_vault_verified_cloning', label: 'Verified cloning', description: 'Provider-verified voice registration', riskTier: 'high' },
  { key: 'audio.white_label_operator', label: 'White-label operator', description: 'Partner-branded operator agent', riskTier: 'elevated' },
  { key: 'audio.api', label: 'Audio API', description: 'Programmatic access to audio services', riskTier: 'elevated' },
  { key: 'audio.webhooks', label: 'Audio webhooks', description: 'Outbound event delivery', riskTier: 'standard' },
  { key: 'audio.zero_retention', label: 'Zero retention', description: 'Provider-side zero-retention processing', riskTier: 'elevated' },
  { key: 'audio.custom_provider', label: 'Custom provider', description: 'Bring-your-own audio provider account', riskTier: 'high' },
]

export const ALL_AUDIO_CAPABILITIES: AudioCapability[] = AUDIO_CAPABILITIES.map((c) => c.key)

export function isAudioCapability(value: string): value is AudioCapability {
  return ALL_AUDIO_CAPABILITIES.includes(value as AudioCapability)
}

/**
 * Plan presets. The flagship org gets everything; these are starting points for
 * partner entitlements, adjustable per org by a flagship admin.
 */
export const AUDIO_PLAN_PRESETS: Record<string, AudioCapability[]> = {
  flagship: ALL_AUDIO_CAPABILITIES,
  partner_core: [
    'audio.meeting_intelligence',
    'audio.meeting_upload',
    'audio.transcription',
    'audio.signal_briefs',
    'audio.operator_agent',
    'audio.operator_web',
    'audio.operator_human_transfer',
  ],
  partner_full: [
    'audio.meeting_intelligence',
    'audio.meeting_recording',
    'audio.meeting_upload',
    'audio.transcription',
    'audio.signal_briefs',
    'audio.signal_brief_scheduling',
    'audio.operator_agent',
    'audio.operator_web',
    'audio.operator_human_transfer',
    'audio.global_release_pack',
    'audio.dubbing',
    'audio.campaign_voiceover',
    'audio.sound_effects',
    'audio.voice_isolation',
    'audio.remix_lab',
    'audio.stem_separation',
    'audio.white_label_operator',
    'audio.webhooks',
  ],
}
