/**
 * Street Banker Audio Intelligence — provider-independent value types.
 *
 * Nothing in this file names a vendor. Adapters translate between these shapes
 * and whatever the configured provider actually speaks, which is what keeps the
 * provider replaceable: the rest of the platform compiles against this file and
 * nothing else.
 */

export type AudioProviderId = string

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down' | 'unconfigured'

export interface ProviderHealth {
  providerId: AudioProviderId
  status: ProviderHealthStatus
  latencyMs?: number
  message: string
  checkedAt: string
}

/** Bytes handed back by a provider, plus enough metadata to store them. */
export interface ProviderAsset {
  bytes: Uint8Array
  contentType: string
  filename?: string
}

/**
 * Usage as the provider reported it, not as we priced it. Pricing belongs to
 * the ledger; adapters only relay what the provider measured.
 */
export interface ProviderUsage {
  unit: 'seconds' | 'characters' | 'requests' | 'credits'
  inputUnits: number
  outputUnits: number
  providerRequestId?: string
}

/** Media input for provider calls: local bytes, a staged file, or a signed URL. */
export interface AudioInput {
  bytes?: Uint8Array
  path?: string
  url?: string
  mimeType: string
  filename?: string
}

// ===========================================================================
// transcription
// ===========================================================================

export interface TranscriptionRequest {
  orgId: string
  audio: AudioInput
  languageCode?: string
  diarize: boolean
  numSpeakers?: number
  timestamps: 'word' | 'none'
  tagAudioEvents: boolean
  /** Sanitised, shareable keyterms only — assembly filters tenant-private terms. */
  keyterms: string[]
  entityDetection?: boolean
  /**
   * When true the adapter MUST either issue a request the provider processes
   * without retention, or throw `provider_rejected` — never downgrade silently.
   */
  zeroRetention: boolean
  webhook?: { metadata: Record<string, string> }
}

export interface TranscriptEntity {
  text: string
  entityType: string
  startChar?: number
  endChar?: number
}

export interface TranscriptSegmentData {
  speakerKey: string | null
  startMs: number
  endMs: number
  text: string
  confidence?: number
  entities?: TranscriptEntity[]
}

export interface NormalizedTranscript {
  language: string
  languageConfidence?: number
  fullText: string
  confidence?: number
  segments: TranscriptSegmentData[]
  /** Provider payload kept for audit; never rendered directly. */
  raw: unknown
}

export type TranscriptionJobState = 'queued' | 'processing' | 'complete' | 'failed'

export interface TranscriptionJobResult {
  providerJobId: string | null
  status: TranscriptionJobState
  transcript?: NormalizedTranscript
  usage?: ProviderUsage
}

export interface TranscriptionJobStatus {
  status: TranscriptionJobState
  transcript?: NormalizedTranscript
  usage?: ProviderUsage
  error?: string
}

// ===========================================================================
// speech synthesis
// ===========================================================================

export interface SpeechSynthesisRequest {
  orgId: string
  text: string
  /** Provider-side voice reference (catalog voice or verified profile). */
  voiceRef: string
  modelId?: string
  outputFormat?: string
  languageCode?: string
  zeroRetention: boolean
  settings?: Record<string, unknown>
}

export interface SpeechSynthesisResult {
  audio: ProviderAsset
  usage: ProviderUsage
}

// ===========================================================================
// conversational agents
// ===========================================================================

export interface AgentToolDefinition {
  name: string
  description: string
  /** JSON schema for parameters; validated server-side again on every call. */
  parameters: Record<string, unknown>
}

export interface AgentKnowledgeDocument {
  id: string
  name: string
  content: string
}

export interface CreateAgentRequest {
  orgId: string
  name: string
  systemPrompt: string
  firstMessage: string
  language: string
  voiceRef?: string
  knowledge: AgentKnowledgeDocument[]
  tools: AgentToolDefinition[]
  disclosureText: string
}

export interface UpdateAgentRequest extends CreateAgentRequest {
  providerAgentId: string
}

export interface ProviderAgentDefinition {
  providerAgentId: string
  raw: unknown
}

export interface CreateConversationSessionRequest {
  orgId: string
  providerAgentId: string
  channel: 'web' | 'phone'
  metadata: Record<string, string>
}

export interface ConversationSession {
  providerConversationId: string | null
  /** How the client connects: a signed URL, an ephemeral token, or a local mock loop. */
  mode: 'signed_url' | 'token' | 'mock'
  value: string
}

export interface ConversationTurn {
  role: 'agent' | 'user' | 'tool'
  text: string
  atMs?: number
  toolName?: string
}

export interface ProviderConversation {
  providerConversationId: string
  status: 'active' | 'ended' | 'failed'
  turns: ConversationTurn[]
  durationSeconds?: number
  usage?: ProviderUsage
  raw: unknown
}

// ===========================================================================
// dubbing
// ===========================================================================

export interface DubbingRequest {
  orgId: string
  source: AudioInput
  sourceLanguage: string
  targetLanguages: string[]
  numSpeakers?: number
  watermark?: boolean
  zeroRetention: boolean
}

export type DubbingJobState = 'queued' | 'dubbing' | 'complete' | 'failed'

export interface DubbingProjectResult {
  providerJobId: string
  expectedDurationSeconds?: number
}

export interface DubbingJobStatus {
  status: DubbingJobState
  /** Languages whose dubbed audio is ready for download. */
  readyLanguages: string[]
  error?: string
  usage?: ProviderUsage
}

// ===========================================================================
// music
// ===========================================================================

export interface MusicGenerationRequest {
  orgId: string
  /** Mutually exclusive with compositionPlan. */
  prompt?: string
  compositionPlan?: unknown
  musicLengthMs?: number
  instrumental?: boolean
  modelId?: string
  seed?: number
}

export interface MusicGenerationResult {
  audio: ProviderAsset
  providerSongId?: string
  compositionPlan?: unknown
  seed?: number
  usage?: ProviderUsage
}

export interface OwnedMusicUploadRequest {
  orgId: string
  audio: AudioInput
  /** Internal consent-record id proving the uploader confirmed ownership. */
  rightsConfirmationId: string
}

export interface OwnedMusicUploadResult {
  providerSongId: string | null
  /**
   * `rights_review_required` is a provider screening outcome, not a finding of
   * infringement — callers must present it exactly that way.
   */
  screening: 'accepted' | 'rights_review_required' | 'failed'
  message?: string
  usage?: ProviderUsage
}

export interface MusicInpaintingRequest {
  orgId: string
  providerSongId?: string
  sourceAudio?: AudioInput
  compositionPlan: unknown
  /** Section of the source being re-generated, for lineage records. */
  rangeMs?: { startMs: number; endMs: number }
}

export interface CompositionPlanRequest {
  orgId: string
  prompt?: string
  sourceAudio?: AudioInput
  musicLengthMs?: number
}

export interface CompositionPlanResult {
  plan: unknown
  usage?: ProviderUsage
}

// ===========================================================================
// stems, isolation, sound effects
// ===========================================================================

export interface StemSeparationRequest {
  orgId: string
  audio: AudioInput
}

export interface StemSeparationResult {
  stems: Array<{ name: string; audio: ProviderAsset }>
  usage?: ProviderUsage
}

export interface VoiceIsolationRequest {
  orgId: string
  audio: AudioInput
}

export interface VoiceIsolationResult {
  audio: ProviderAsset
  usage?: ProviderUsage
}

export interface SoundEffectRequest {
  orgId: string
  text: string
  durationSeconds?: number
  promptInfluence?: number
  loop?: boolean
}

export interface SoundEffectResult {
  audio: ProviderAsset
  usage?: ProviderUsage
}

// ===========================================================================
// voice identity
// ===========================================================================

export interface VerifiedVoiceRegistrationRequest {
  orgId: string
  /**
   * `external_reference` is the preferred model: the artist verified the voice
   * through the provider's own flow and shares the resulting reference — we
   * never possess the underlying voice model. `provider_verification` starts a
   * provider-run verification the voice owner must complete themselves.
   */
  mode: 'external_reference' | 'provider_verification'
  providerVoiceId?: string
  ownerName: string
  consentRecordId: string
}

export interface ProviderVoiceProfile {
  providerVoiceId: string
  verificationStatus: 'verified' | 'pending' | 'unverified'
  raw: unknown
}

// ===========================================================================
// structured reasoning
// ===========================================================================

export type ExtractionType = 'explicit' | 'inferred' | 'needs_verification'

export interface ExtractedDealVariable {
  variableType: string
  value: string
  extractionType: ExtractionType
  confidence: number
  sourceStartMs?: number
  sourceEndMs?: number
}

export interface ExtractedActionItem {
  description: string
  owner?: string
  dueAt?: string
  confidence: number
  sourceStartMs?: number
  sourceEndMs?: number
}

export interface ExtractedDecision {
  decision: string
  participants: string[]
  status: 'agreed' | 'tentative' | 'deferred'
  sourceStartMs?: number
}

export interface ExtractedDate {
  label: string
  date: string
  kind: string
}

export interface ExtractedPerson {
  name: string
  role: string
  company?: string
}

export interface MeetingIntelligenceExtractionRequest {
  orgId: string
  meetingType: string
  transcript: NormalizedTranscript
  speakerNames: Record<string, string>
  leadContext?: { leadId: string; name: string; notes?: string }
}

export interface MeetingIntelligenceResult {
  summary: string
  purpose: string
  situation: string
  opportunity: string
  blockers: string[]
  people: ExtractedPerson[]
  dealVariables: ExtractedDealVariable[]
  dates: ExtractedDate[]
  actionItems: ExtractedActionItem[]
  decisions: ExtractedDecision[]
  risks: string[]
  openQuestions: string[]
  /** Which engine produced this — heuristic fallback or a named model. */
  engine: string
  costMicros: number
}

export interface SignalBriefRequest {
  orgId: string
  briefType: string
  title: string
  /** Pre-approved structured facts; the script must not invent beyond them. */
  items: Array<{ statement: string; confidence: 'confirmed' | 'likely' | 'needs_verification' }>
  audience: string
}

export interface SignalBriefResult {
  script: string
  wordCount: number
  engine: string
  costMicros: number
}

export interface AgentConversationClassificationRequest {
  orgId: string
  turns: ConversationTurn[]
}

export interface AgentConversationClassification {
  intent: string
  leadQuality: 'high' | 'medium' | 'low' | 'unknown'
  humanFollowUpRecommended: boolean
  summary: string
  contact: { name?: string; email?: string; phone?: string; artistName?: string }
  engine: string
  costMicros: number
}
