/** Typed client for the Street Banker Audio Intelligence API. */

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const match = document.cookie.match(/(?:^|;\s*)masterclip_csrf=([^;]*)/)
  const token = method === 'GET' || method === 'HEAD' ? '' : match?.[1] ? decodeURIComponent(match[1]) : ''
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(token ? { 'x-csrf-token': token } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const envelope = (body as { error?: { message?: string } })?.error
    throw new Error(envelope?.message ?? `${response.status} ${response.statusText}`)
  }
  return body as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) })
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })
const upload = <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form })

export interface Meeting {
  id: string
  title: string
  meetingType: string
  status: string
  summary: string
  operatorLeadId: string | null
  transcriptId: string | null
  engine: string
  createdAt: string
  extraction: {
    summary: string
    purpose: string
    opportunity: string
    blockers: string[]
    risks: string[]
    openQuestions: string[]
    people: Array<{ name: string; role: string; company?: string }>
    dates: Array<{ label: string; date: string; kind: string }>
    decisions: Array<{ decision: string; status: string }>
  } | null
}

export interface TranscriptSegment {
  id: string
  speakerKey: string | null
  startMs: number
  endMs: number
  text: string
  confidence?: number
}

export interface Speaker {
  providerSpeakerKey: string
  displayName: string
  manuallyConfirmed: boolean
}

export interface ActionItem {
  id: string
  description: string
  dueAt: string | null
  confidence: number
  approvalStatus: string
  sourceStartMs: number | null
}

export interface DealVariable {
  id: string
  variableType: string
  value: string
  extractionType: string
  confidence: number
  approvalStatus: string
}

export interface Lead {
  id: string
  name: string
  contactName: string
  email: string
  artistName: string
  stage: string
  source: string
  updatedAt: string
}

export interface Brief {
  id: string
  briefType: string
  title: string
  script: string
  status: string
  audioAssetId: string | null
  engine: string
  errorMessage: string | null
  createdAt: string
  items: Array<{ statement: string; confidence: string }>
}

export interface Agent {
  id: string
  name: string
  agentType: string
  status: string
  provider: string
  providerAgentId: string | null
  knowledgeBaseVersion: number
}

export interface Conversation {
  id: string
  agentId: string
  channel: string
  status: string
  startedAt: string
  durationSeconds: number | null
  humanTransferStatus: string
  summary: string
  operatorLeadId: string | null
  transcript: Array<{ role: string; text: string }>
  guestContact: Record<string, string>
}

export interface DubbingProject {
  id: string
  name: string
  status: string
  sourceLanguage: string
  voiceStrategy: string
  targets: Array<{ language: string; status: string; assetId: string | null; error?: string }>
  transcriptId: string | null
  createdAt: string
}

export interface CampaignProject {
  id: string
  name: string
  templateType: string
  usageContext: string
  rightsBasis: string
  status: string
  createdAt: string
}

export interface RemixProject {
  id: string
  name: string
  remixLane: string
  targetUse: string
  status: string
  providerScreening: string
  finalApprovalStatus: string
  compositionPlan: unknown
  createdAt: string
}

export interface RemixVersion {
  id: string
  versionType: string
  prompt: string
  model: string
  reviewStatus: string
  url: string | null
  createdAt: string
}

export interface VoiceProfile {
  id: string
  name: string
  voiceOwnerName: string
  provider: string
  providerVoiceId: string
  status: string
  verificationStatus: string
  validUntil: string | null
  revokedAt: string | null
  permittedUses: Record<string, unknown>
}

export interface AudioPolicy {
  requireZeroRetention: boolean
  requireRecordingConsent: boolean
  allowMusicGeneration: boolean
  allowVoiceCloning: boolean
  allowDownload: boolean
  sourceAudioRetentionDays: number | null
  transcriptRetentionDays: number | null
  generatedAudioRetentionDays: number | null
  agentConversationRetentionDays: number | null
  [key: string]: unknown
}

export interface AudioUsage {
  summary: { monthSpendUsd: number; byOperation: Array<{ operation: string; provider: string; count: number; usd: number }> }
  entries: Array<{ id: string; operation: string; provider: string; model: string; unit: string; inputUnits: number; createdAt: string }>
  budgets: Array<{ scope: string; scopeId: string; monthlyCapMicros: number | null; hardStop: boolean }>
}

export interface AdminOrgBudget {
  scope: string
  scopeId: string
  monthlyCapUsd: number | null
  perJobCapUsd: number | null
  hardStop: boolean
  warnThresholdPct: number
}

export interface AdminOrg {
  id: string
  name: string
  createdAt: string
  /** The flagship holds every capability implicitly — no grant rows needed. */
  isFlagship: boolean
  entitlements: Array<{ capability: string; enabled: boolean }>
  budgets: AdminOrgBudget[]
  monthSpendUsd: number
}

export interface AdminOrgs {
  orgs: AdminOrg[]
  capabilities: Array<{ key: string; label: string; description: string; riskTier: 'standard' | 'elevated' | 'high' }>
  presets: string[]
}

export const audioApi = {
  meetings: () => get<{ meetings: Meeting[] }>('/api/audio/meetings'),
  meeting: (id: string) =>
    get<{
      meeting: Meeting
      segments: TranscriptSegment[]
      speakers: Speaker[]
      actionItems: ActionItem[]
      dealVariables: DealVariable[]
      audioUrl: string | null
    }>(`/api/audio/meetings/${id}`),
  createMeeting: (form: FormData) => upload<{ meeting: Meeting; warning: string | null }>('/api/audio/meetings', form),
  renameSpeaker: (id: string, providerSpeakerKey: string, displayName: string) =>
    patch<{ ok: boolean }>(`/api/audio/meetings/${id}/speakers`, { providerSpeakerKey, displayName }),
  correctSegment: (transcriptId: string, segmentId: string, text: string) =>
    patch<{ ok: boolean }>(`/api/audio/transcriptions/${transcriptId}/segments`, { segmentId, text }),
  syncAgent: (agentId: string) => post<{ queued: boolean }>(`/api/audio/agents/${agentId}/sync`),
  updateLead: (id: string, body: Record<string, string>) => patch<{ lead: Lead }>(`/api/audio/leads/${id}`, body),
  setTaskStatus: (id: string, status: 'open' | 'done' | 'cancelled') => post<{ ok: boolean }>(`/api/audio/tasks/${id}/status`, { status }),
  extractMeeting: (id: string) => post<{ ok: boolean }>(`/api/audio/meetings/${id}/extract`),
  approveItems: (id: string, items: Array<{ kind: 'action' | 'deal'; itemId: string; status: string; editedValue?: string }>) =>
    post<{ ok: boolean }>(`/api/audio/meetings/${id}/approve`, { items }),
  commitMeeting: (id: string) => post<{ ok: boolean; notes: number; tasks: number }>(`/api/audio/meetings/${id}/commit`),

  leads: () => get<{ leads: Lead[] }>('/api/audio/leads'),
  createLead: (body: { name: string; contactName?: string; email?: string; artistName?: string }) => post<{ lead: Lead }>('/api/audio/leads', body),
  lead: (id: string) =>
    get<{ lead: Lead; notes: Array<{ id: string; body: string; sourceType: string; createdAt: string }>; tasks: Array<{ id: string; description: string; status: string; dueAt: string | null }> }>(
      `/api/audio/leads/${id}`,
    ),

  briefs: () => get<{ briefs: Brief[] }>('/api/audio/signal-briefs'),
  brief: (id: string) => get<{ brief: Brief; audioUrl: string | null }>(`/api/audio/signal-briefs/${id}`),
  createBrief: (body: { briefType: string; title: string; items: Array<{ statement: string; confidence: string }> }) =>
    post<{ brief: Brief; warning: string | null }>('/api/audio/signal-briefs', body),
  updateBrief: (id: string, script: string, render: boolean) => patch<{ ok: boolean }>(`/api/audio/signal-briefs/${id}`, { script, render }),
  briefSchedules: () => get<{ schedules: Array<{ id: string; briefType: string; cadence: string; hourUtc: number; enabled: boolean; lastRunAt: string | null }> }>('/api/audio/signal-briefs/schedules/list'),
  createBriefSchedule: (body: { briefType: string; cadence: string; hourUtc: number; timezone: string }) =>
    post<{ schedule: unknown }>('/api/audio/signal-briefs/schedules', body),
  toggleBriefSchedule: (id: string, enabled: boolean) => patch<{ ok: boolean }>(`/api/audio/signal-briefs/schedules/${id}`, { enabled }),

  agents: () => get<{ agents: Agent[] }>('/api/audio/agents'),
  ensureAgents: () => post<{ agents: Agent[] }>('/api/audio/agents'),
  updateAgent: (id: string, body: { status?: string; name?: string }) => patch<{ agent: Agent }>(`/api/audio/agents/${id}`, body),
  startSession: (agentId: string) => post<{ conversationId: string; disclosure: string; greeting: string }>(`/api/audio/agents/${agentId}/session`),
  sendTurn: (conversationId: string, text: string) =>
    post<{ reply: string; humanTransfer: boolean; ended: boolean }>(`/api/audio/conversations/${conversationId}/turn`, { text }),
  conversations: () => get<{ conversations: Conversation[] }>('/api/audio/conversations'),
  conversation: (id: string) => get<{ conversation: Conversation }>(`/api/audio/conversations/${id}`),
  humanTransfer: (id: string) => post<{ ok: boolean }>(`/api/audio/conversations/${id}/human-transfer`),

  dubbingProjects: () => get<{ projects: DubbingProject[] }>('/api/audio/dubbing'),
  dubbingProject: (id: string) => get<{ project: DubbingProject; segments: TranscriptSegment[] }>(`/api/audio/dubbing/${id}`),
  createDubbing: (form: FormData) => upload<{ project: DubbingProject; warning: string | null }>('/api/audio/dubbing', form),
  approveDubbingTranscript: (id: string) => post<{ ok: boolean }>(`/api/audio/dubbing/${id}/approve-transcript`),
  approveDubbing: (id: string, note: string) => post<{ ok: boolean }>(`/api/audio/dubbing/${id}/approve`, { note }),
  exportDubbing: (id: string) => get<{ exports: Array<{ language: string; url: string }> }>(`/api/audio/dubbing/${id}/export`),

  campaigns: () => get<{ projects: CampaignProject[] }>('/api/audio/campaigns'),
  campaign: (id: string) =>
    get<{ project: CampaignProject; assets: Array<{ id: string; fileName: string; assetType: string; url: string; createdAt: string }>; generations: Array<{ id: string; operation: string; provider: string; model: string; prompt: string; createdAt: string }> }>(
      `/api/audio/campaigns/${id}`,
    ),
  createCampaign: (body: { name: string; templateType: string; usageContext?: string; rightsBasis?: string }) =>
    post<{ project: CampaignProject }>('/api/audio/campaigns', body),
  campaignVoiceover: (id: string, text: string, voiceProfileId?: string) =>
    post<{ jobId: string; warning: string | null }>(`/api/audio/campaigns/${id}/voiceover`, { text, ...(voiceProfileId ? { voiceProfileId } : {}) }),
  campaignSfx: (id: string, text: string, durationSeconds?: number) =>
    post<{ jobId: string; warning: string | null }>(`/api/audio/campaigns/${id}/sound-effect`, { text, ...(durationSeconds ? { durationSeconds } : {}) }),
  campaignUpload: (id: string, form: FormData) => upload<{ asset: { id: string } }>(`/api/audio/campaigns/${id}/upload`, form),
  campaignIsolate: (id: string, sourceAssetId: string) =>
    post<{ jobId: string; warning: string | null }>(`/api/audio/campaigns/${id}/isolate-voice`, { sourceAssetId }),

  remixProjects: () => get<{ projects: RemixProject[] }>('/api/audio/remix'),
  remixProject: (id: string) => get<{ project: RemixProject; versions: RemixVersion[] }>(`/api/audio/remix/${id}`),
  createRemix: (form: FormData) => upload<{ project: RemixProject }>('/api/audio/remix', form),
  remixStems: (id: string) => post<{ jobId: string }>(`/api/audio/remix/${id}/stems`),
  remixUploadScreen: (id: string) => post<{ jobId: string }>(`/api/audio/remix/${id}/upload-screen`),
  remixPlan: (id: string) => post<{ jobId: string }>(`/api/audio/remix/${id}/composition-plan`),
  remixConcept: (id: string, prompt: string) => post<{ jobId: string }>(`/api/audio/remix/${id}/concept`, { prompt }),
  remixReview: (id: string, versionId: string, status: 'producer_reviewed' | 'rejected') =>
    post<{ ok: boolean }>(`/api/audio/remix/${id}/review-version`, { versionId, status }),
  remixApprove: (id: string, status: 'producer_approved' | 'release_ready') => post<{ ok: boolean }>(`/api/audio/remix/${id}/approve`, { status }),

  voiceProfiles: () => get<{ profiles: VoiceProfile[] }>('/api/audio/voice-vault'),
  registerVoice: (body: { ownerName: string; profileName: string; providerVoiceId: string; ownerConsentConfirmed: boolean; validUntil: string | null; permittedUses: Record<string, boolean> }) =>
    post<{ profile: VoiceProfile }>('/api/audio/voice-vault', body),
  revokeVoice: (id: string) => post<{ profile: VoiceProfile }>(`/api/audio/voice-vault/${id}/revoke`),

  settings: () =>
    get<{ policy: AudioPolicy; settings: { protectedNames: string[]; featureToggles: Record<string, boolean>; whiteLabel: Record<string, string> }; entitlements: Array<{ capability: string; enabled: boolean }>; keyterms: Array<{ id: string; term: string; category: string; sensitivity: string }> }>(
      '/api/audio/settings',
    ),
  updatePolicy: (body: Record<string, unknown>) => patch<{ policy: AudioPolicy }>('/api/audio/settings/policy', body),
  updateSettings: (body: Record<string, unknown>) => patch<{ settings: unknown }>('/api/audio/settings', body),
  addKeyterm: (body: { term: string; category: string; sensitivity: string }) => post<{ id: string }>('/api/audio/settings/keyterms', body),
  removeKeyterm: (id: string) => del<{ ok: boolean }>(`/api/audio/settings/keyterms/${id}`),
  usage: () => get<AudioUsage>('/api/audio/usage'),
  jobs: () => get<{ jobs: Array<{ id: string; operation: string; provider: string; status: string; errorMessage: string | null; createdAt: string }> }>('/api/audio/jobs'),
  assetUrl: (id: string) => get<{ url: string }>(`/api/audio/assets/${id}/url`),

  adminProviders: () =>
    get<{ health: Array<{ providerId: string; status: string; latencyMs?: number; message: string }>; slots: Array<{ slot: string; providerId: string; configured: boolean; zeroRetention: boolean }>; elevenLabsEnabled: boolean }>(
      '/api/admin/audio/providers',
    ),
  adminOrgs: () => get<AdminOrgs>('/api/admin/audio/orgs'),
  adminSetEntitlements: (orgId: string, body: { preset?: string; grant?: string[]; revoke?: string[] }) =>
    post<{ ok: boolean }>(`/api/admin/audio/orgs/${orgId}/entitlements`, body),
  adminToggleEntitlement: (orgId: string, capability: string, enabled: boolean) =>
    post<{ ok: boolean }>(`/api/admin/audio/orgs/${orgId}/entitlements/toggle`, { capability, enabled }),
  adminSetBudget: (orgId: string, body: { scope: string; scopeId: string; monthlyCapUsd: number | null; perJobCapUsd: number | null; hardStop: boolean }) =>
    post<{ budget: unknown }>(`/api/admin/audio/orgs/${orgId}/budgets`, body),
  adminWebhooks: () => get<{ events: Array<{ id: string; eventType: string; status: string; signatureValid: boolean; receivedAt: string; failureReason: string | null }> }>('/api/admin/audio/webhooks'),
}
