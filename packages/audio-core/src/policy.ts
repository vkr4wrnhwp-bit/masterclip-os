import { AppError } from '@masterclip/shared'

/**
 * Organization-level audio data policy.
 *
 * Every job consults this before bytes move. The rule that matters most:
 * a zero-retention requirement is a hard gate — a provider that cannot honour
 * it gets no data, and the job is rejected with the reason, never downgraded.
 */
export interface AudioDataPolicy {
  id: string
  organizationId: string
  allowAudioUpload: boolean
  allowMeetingRecording: boolean
  allowCallRecording: boolean
  allowTranscription: boolean
  allowVoiceGeneration: boolean
  allowDubbing: boolean
  allowMusicGeneration: boolean
  allowVoiceCloning: boolean
  requireZeroRetention: boolean
  allowProviderStorage: boolean
  allowInternalStorage: boolean
  sourceAudioRetentionDays: number | null
  transcriptRetentionDays: number | null
  generatedAudioRetentionDays: number | null
  agentConversationRetentionDays: number | null
  voiceSampleRetentionDays: number | null
  allowHumanReview: boolean
  allowAIExtraction: boolean
  allowDownload: boolean
  allowExport: boolean
  requireRecordingConsent: boolean
  requireAgentDisclosure: boolean
  requireRightsConfirmation: boolean
  createdAt: string
  updatedAt: string
}

export type RetentionKind = 'source' | 'transcript' | 'generated' | 'agent_conversation' | 'voice_sample'

/** Conservative defaults: consent and rights checks on, retention bounded. */
export function defaultAudioPolicy(organizationId: string, now: string): AudioDataPolicy {
  return {
    id: '',
    organizationId,
    allowAudioUpload: true,
    allowMeetingRecording: true,
    allowCallRecording: false,
    allowTranscription: true,
    allowVoiceGeneration: true,
    allowDubbing: true,
    allowMusicGeneration: false,
    allowVoiceCloning: false,
    requireZeroRetention: false,
    allowProviderStorage: true,
    allowInternalStorage: true,
    sourceAudioRetentionDays: 365,
    transcriptRetentionDays: 730,
    generatedAudioRetentionDays: 365,
    agentConversationRetentionDays: 365,
    voiceSampleRetentionDays: 180,
    allowHumanReview: true,
    allowAIExtraction: true,
    allowDownload: true,
    allowExport: true,
    requireRecordingConsent: true,
    requireAgentDisclosure: true,
    requireRightsConfirmation: true,
    createdAt: now,
    updatedAt: now,
  }
}

export type PolicyAction =
  | 'upload'
  | 'record_meeting'
  | 'record_call'
  | 'transcribe'
  | 'generate_voice'
  | 'dub'
  | 'generate_music'
  | 'clone_voice'
  | 'ai_extract'
  | 'human_review'
  | 'download'
  | 'export'

const ACTION_FIELD: Record<PolicyAction, keyof AudioDataPolicy> = {
  upload: 'allowAudioUpload',
  record_meeting: 'allowMeetingRecording',
  record_call: 'allowCallRecording',
  transcribe: 'allowTranscription',
  generate_voice: 'allowVoiceGeneration',
  dub: 'allowDubbing',
  generate_music: 'allowMusicGeneration',
  clone_voice: 'allowVoiceCloning',
  ai_extract: 'allowAIExtraction',
  human_review: 'allowHumanReview',
  download: 'allowDownload',
  export: 'allowExport',
}

export function policyAllows(policy: AudioDataPolicy, action: PolicyAction): { allowed: boolean; reason?: string } {
  if (policy[ACTION_FIELD[action]] === true) return { allowed: true }
  return { allowed: false, reason: `the organization's audio data policy does not allow ${action.replace(/_/g, ' ')}` }
}

export function assertPolicyAllows(policy: AudioDataPolicy, action: PolicyAction): void {
  const verdict = policyAllows(policy, action)
  if (!verdict.allowed) {
    throw new AppError({ kind: 'forbidden', code: 'audio.policy_denied', message: verdict.reason ?? 'denied by audio data policy' })
  }
}

/**
 * The zero-retention gate. Runs before any upload to a provider. The failure
 * message names the actual conflict so an admin knows what to change — either
 * the policy, or the provider account tier.
 */
export function assertZeroRetentionSatisfiable(policy: AudioDataPolicy, providerId: string, providerSupportsZeroRetention: boolean): void {
  if (!policy.requireZeroRetention) return
  if (providerSupportsZeroRetention) return
  throw new AppError({
    kind: 'forbidden',
    code: 'audio.zero_retention_unavailable',
    message:
      `this organization's security policy requires zero-retention processing, and provider "${providerId}" ` +
      `is not verified to support it for this operation — the job was rejected before any data was sent`,
  })
}

export function resolveRetentionDays(policy: AudioDataPolicy, kind: RetentionKind): number | null {
  switch (kind) {
    case 'source':
      return policy.sourceAudioRetentionDays
    case 'transcript':
      return policy.transcriptRetentionDays
    case 'generated':
      return policy.generatedAudioRetentionDays
    case 'agent_conversation':
      return policy.agentConversationRetentionDays
    case 'voice_sample':
      return policy.voiceSampleRetentionDays
  }
}

/** Retention expiry for a new record, or null when the policy keeps it indefinitely. */
export function retentionExpiresAt(policy: AudioDataPolicy, kind: RetentionKind, nowMs: number): string | null {
  const days = resolveRetentionDays(policy, kind)
  if (days === null || days <= 0) return null
  return new Date(nowMs + days * 24 * 3600 * 1000).toISOString()
}
