/** Typed client for the Street Banker Studio API. */

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
const put = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) })
const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) })
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })
const upload = <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form })

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

export interface StudioProject {
  id: string
  artistName: string
  artistId: string | null
  title: string
  genre: string
  stage: string
  artworkAssetId: string | null
  currentVersionId: string | null
  approvedMixVersionId: string | null
  approvedMasterVersionId: string | null
  releaseDate: string | null
  songLabProjectId: string | null
  releaseId: string | null
  notes: string
  demo: boolean
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface StudioVersion {
  id: string
  parentVersionId: string | null
  versionType: string
  label: string
  ordinal: number
  assetId: string | null
  assetChecksum: string | null
  sourceKind: string
  durationMs: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  approved: boolean
  supersededAt: string | null
  notes: string
  createdAt: string
  url?: string | null
}

export interface StudioNote {
  id: string
  studioVersionId: string | null
  kind: 'note' | 'marker'
  timestampMs: number | null
  endMs: number | null
  category: string
  body: string
  status: string
  assignedTo: string | null
  origin: string
  authorLabel: string
  createdAt: string
}

export interface MixMetricRow {
  metricKey: string
  value: number | null
  unit: string
  confidence: number
  analysisMethod: string
  provider: string
  note: string
}

export interface MixCurveRow {
  curveKey: string
  stepMs: number
  points: Array<number | null>
}

export interface MixIssue {
  id: string
  issueType: string
  severity: 'low' | 'moderate' | 'high'
  confidence: number
  startMs: number
  endMs: number
  headline: string
  detail: string
  whyItMatters: string
  suggestedAction: string
  evidence: Record<string, unknown>
  status: string
}

export interface ReadinessBand {
  band: string
  label: string
  score: number | null
  detected: string
  whyItMatters: string
  recommendation: string
  confidence: number
}

export interface Readiness {
  score: number | null
  bandsScored: number
  bands: ReadinessBand[]
  caveat: string
}

export interface MetricDefinition {
  key: string
  label: string
  unit: string
  group: string
  description: string
  preference: string
}

export interface MasterDirectionInfo {
  key: string
  label: string
  summary: string
  intent: string
  targetLufs: number
  targetTruePeakDbtp: number
}

export interface MasterRendition {
  id: string
  slot: string
  direction: string
  status: string
  placeholder: boolean
  outputAssetId: string | null
  matchGainDb: number | null
  failureReason: string | null
  approved: boolean
  renderPlan: { stages?: Array<{ stage: string; description: string }>; expectation?: string; restraint?: string[] } | null
}

export interface MasterComparisonEntry {
  rendition: MasterRendition
  direction: MasterDirectionInfo
  matchGainDb: number | null
  loudnessMatched: boolean
  changes: Array<{ metricKey: string; label: string; before: number | null; after: number | null; delta: number | null; unit: string; meaningful: boolean }>
  url?: string | null
}

export interface RackModuleDefinition {
  key: string
  label: string
  stage: string
  description: string
  defaults: Record<string, number | string | boolean>
}

export interface RackModule {
  id?: string
  stage: string
  moduleType: string
  orderIndex: number
  bypassed: boolean
  params: Record<string, number | string | boolean>
}

export interface RackChain {
  id: string
  rackType: string
  name: string
  abSlot: string
  stateVersion: number
}

export interface Collaborator {
  id: string
  email: string
  displayName: string
  collaboratorRole: string
  permissions: string[]
  acceptedAt: string | null
  revokedAt: string | null
}

export interface Approval {
  id: string
  studioVersionId: string
  approvalType: string
  approvedByLabel: string
  approvedAt: string
  comments: string
  versionChecksum: string
  revokedAt: string | null
}

export interface ApprovalState {
  project: StudioProject
  approvals: Approval[]
  state: Record<string, { approval: Approval | null; supersededByDraft: boolean }>
}

export interface Deliverable {
  id: string
  assetKind: string
  fileName: string
  status: string
  sentReleaseId: string | null
  sentAt: string | null
}

export interface DeliveryCheck {
  id: string
  checkKey: string
  outcome: 'pass' | 'warn' | 'fail' | 'unknown'
  detail: string
  measured: string | null
  expected: string | null
}

export interface RoomExchange {
  id: string
  question: string
  answer: string
  responder: string
  contextUsed: string[]
  actions: Array<{ kind: string; label: string; target: Record<string, string | number> }>
  confidence: string
  createdAt: string
}

export interface ProjectRow {
  project: StudioProject
  artworkUrl: string | null
  currentVersion: StudioVersion | null
  versionCount: number
  readiness: { score: number | null; bandsScored: number } | null
  collaborators: Array<{ id: string; displayName: string; role: string }>
  approvals: string[]
  pendingActions: string[]
}

export interface SessionPayload {
  project: StudioProject
  versions: StudioVersion[]
  version: StudioVersion | null
  audioUrl: string | null
  analysis: { id: string; status: string; failureReason: string | null; durationMs: number | null; sampleRate: number | null; channels: number | null; bitDepth: number | null } | null
  metrics: MixMetricRow[]
  curves: MixCurveRow[]
  issues: MixIssue[]
  readiness: Readiness | null
  notes: StudioNote[]
  collaborators: Collaborator[]
  permissions: string[]
  approvals: ApprovalState
  activity: Array<{ id: string; actorLabel: string; action: string; detail: string; createdAt: string }>
  processing: ProcessingJob[]
}

export interface ProcessingJob {
  id: string
  jobType: string
  status: string
  provider: string
  adapter: string
  attempt: number
  maxAttempts: number
  creditState: string
  errorMessage: string | null
  durationMs: number | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export const studioApi = {
  capabilities: () =>
    get<{ capabilities: string[]; catalogue: Array<{ key: string; label: string; description: string; preview: boolean }>; rightsStatement: string; stages: string[]; versionTypes: string[]; deliverableKinds: Record<string, string>; collaboratorRoles: string[]; collaboratorPermissions: string[] }>(
      '/api/studio/capabilities',
    ),
  metricCatalogue: () => get<{ metrics: MetricDefinition[]; directions: MasterDirectionInfo[]; translationTargets: Array<{ key: string; label: string; description: string; modelled: boolean }> }>('/api/studio/metrics'),

  projects: (includeArchived = false) => get<{ projects: ProjectRow[] }>(`/api/studio/projects${includeArchived ? '?includeArchived=true' : ''}`),
  createProject: (body: { title: string; artistName: string; genre: string; notes?: string; releaseDate?: string; rightsConfirmed: boolean }) =>
    post<{ project: StudioProject }>('/api/studio/projects', body),
  session: (id: string, versionId?: string) => get<SessionPayload>(`/api/studio/projects/${id}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`),
  setStage: (id: string, stage: string) => post<{ project: StudioProject }>(`/api/studio/projects/${id}/stage`, { stage }),
  setCurrentVersion: (id: string, versionId: string) => post<{ project: StudioProject }>(`/api/studio/projects/${id}/current-version`, { versionId }),
  uploadVersion: (id: string, form: FormData) => upload<{ version: StudioVersion; analysisId: string | null }>(`/api/studio/projects/${id}/upload`, form),
  importAsset: (id: string, body: { assetId: string; versionType?: string; label?: string }) =>
    post<{ version: StudioVersion }>(`/api/studio/projects/${id}/import`, body),
  importable: () => get<{ assets: Array<{ id: string; fileName: string; projectType: string; durationMs: number | null }> }>('/api/studio/importable'),
  reanalyze: (id: string, versionId?: string) => post<{ analysisId: string }>(`/api/studio/projects/${id}/analyze`, versionId ? { versionId } : {}),
  jobs: (id: string, limit?: number) => get<{ jobs: ProcessingJob[] }>(`/api/studio/projects/${id}/jobs${limit ? `?limit=${limit}` : ''}`),

  notes: (id: string) => get<{ notes: StudioNote[] }>(`/api/studio/projects/${id}/notes`),
  addNote: (id: string, body: { kind?: string; timestampMs?: number | null; category: string; body: string; studioVersionId?: string }) =>
    post<{ note: StudioNote }>(`/api/studio/projects/${id}/notes`, body),
  updateNote: (id: string, noteId: string, body: { status?: string; body?: string; category?: string }) =>
    patch<{ note: StudioNote }>(`/api/studio/projects/${id}/notes/${noteId}`, body),
  deleteNote: (id: string, noteId: string) => del<{ ok: true }>(`/api/studio/projects/${id}/notes/${noteId}`),

  mix: (id: string, versionId?: string) =>
    get<{ analysis: SessionPayload['analysis']; metrics: MixMetricRow[]; curves: MixCurveRow[]; issues: MixIssue[]; readiness: Readiness | null }>(
      `/api/studio/projects/${id}/mix${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`,
    ),
  actOnIssue: (id: string, issueId: string, action: string) => post<{ issue: MixIssue; noteId: string | null }>(`/api/studio/projects/${id}/issues/${issueId}`, { action }),

  references: (id: string) =>
    get<{ references: Array<{ id: string; label: string; artistName: string; title: string; rightsBasis: string; derivedOnly: boolean; audioDiscardedAt: string | null }>; rightsStatement: string }>(
      `/api/studio/projects/${id}/references`,
    ),
  addReference: (id: string, form: FormData) => upload<{ reference: { id: string } }>(`/api/studio/projects/${id}/references`, form),
  deleteReference: (id: string, referenceId: string) => del<{ ok: true }>(`/api/studio/projects/${id}/references/${referenceId}`),
  referenceComparison: (id: string, versionId?: string) =>
    get<{
      references: Array<{ id: string; label: string }>
      comparison: { cohortSize: number; headlines: string[]; caveat: string; rows: Array<{ metricKey: string; label: string; unit: string; yours: number | null; referenceMedian: number | null; delta: number | null; cohortSize: number; observation: string }> } | null
    }>(`/api/studio/projects/${id}/reference-comparison${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`),

  translation: (id: string, versionId?: string) =>
    get<{ estimates: Array<{ target: string; label: string; survival: number | null; energyInBandPct: number | null; observations: string[]; basis: string; modelled: boolean }> }>(
      `/api/studio/projects/${id}/translation${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`,
    ),

  ask: (id: string, question: string, versionId?: string) => post<{ exchange: RoomExchange }>(`/api/studio/projects/${id}/ask`, { question, versionId }),
  askHistory: (id: string) => get<{ exchanges: RoomExchange[] }>(`/api/studio/projects/${id}/ask`),

  master: (id: string, versionId?: string) =>
    get<{
      directions: MasterDirectionInfo[]
      comparison: { original: { version: StudioVersion; url: string | null }; renditions: MasterComparisonEntry[]; note: string } | null
    }>(`/api/studio/projects/${id}/master${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ''}`),
  requestMaster: (id: string, body: { versionId: string; direction: string }) =>
    post<{ rendition: MasterRendition; plan: { stages: Array<{ stage: string; description: string }>; expectation: string; restraint: string[] } }>(
      `/api/studio/projects/${id}/master`,
      body,
    ),
  chooseMaster: (id: string, renditionId: string) => post<{ version: StudioVersion }>(`/api/studio/projects/${id}/master/${renditionId}/choose`),

  rackCatalogue: () => get<{ stages: Array<{ key: string; label: string; description: string }>; modules: RackModuleDefinition[]; rackTypes: string[] }>('/api/studio/rack-modules'),
  racks: (id: string) => get<{ racks: Array<{ chain: RackChain; modules: RackModule[] }>; presets: Array<{ id: string; name: string; rackType: string }> }>(`/api/studio/projects/${id}/racks`),
  createRack: (id: string, body: { rackType: string; name?: string; versionId?: string }) =>
    post<{ chain: RackChain; modules: RackModule[] }>(`/api/studio/projects/${id}/racks`, body),
  setRackModules: (id: string, rackId: string, modules: RackModule[], action?: string) =>
    put<{ modules: RackModule[] }>(`/api/studio/projects/${id}/racks/${rackId}/modules`, { modules, action }),
  rackStep: (id: string, rackId: string, direction: 'undo' | 'redo') =>
    post<{ chain: RackChain; modules: RackModule[] }>(`/api/studio/projects/${id}/racks/${rackId}/${direction}`),
  rackAlternative: (id: string, rackId: string) => post<{ chain: RackChain; modules: RackModule[] }>(`/api/studio/projects/${id}/racks/${rackId}/alternative`),
  saveRackPreset: (id: string, rackId: string, name: string, scope: string) => post<{ preset: { id: string } }>(`/api/studio/projects/${id}/racks/${rackId}/preset`, { name, scope }),
  deleteRack: (id: string, rackId: string) => del<{ ok: true }>(`/api/studio/projects/${id}/racks/${rackId}`),

  versions: (id: string) => get<{ versions: StudioVersion[] }>(`/api/studio/projects/${id}/versions`),
  compareVersions: (id: string, a: string, b: string) =>
    get<{
      comparable: boolean
      incomparableReason: string | null
      a: { version: StudioVersion; url: string | null }
      b: { version: StudioVersion; url: string | null }
      differences: Array<{ metricKey: string; statement: string; before: number | null; after: number | null; delta: number; confidence: string }>
    }>(`/api/studio/projects/${id}/versions/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),

  collaborate: (id: string) =>
    get<{
      collaborators: Collaborator[]
      threads: Array<{ id: string; body: string; timestampMs: number | null; authorLabel: string; status: string; createdAt: string; replies: Array<{ id: string; body: string; authorLabel: string; createdAt: string }> }>
      approvals: ApprovalState
      activity: Array<{ id: string; actorLabel: string; action: string; detail: string; createdAt: string }>
      roles: string[]
      permissions: string[]
    }>(`/api/studio/projects/${id}/collaborate`),
  invite: (id: string, body: { email: string; displayName: string; role: string }) => post<{ collaborator: Collaborator }>(`/api/studio/projects/${id}/collaborators`, body),
  revokeCollaborator: (id: string, collaboratorId: string) => del<{ ok: true }>(`/api/studio/projects/${id}/collaborators/${collaboratorId}`),
  comment: (id: string, body: { body: string; timestampMs?: number | null; parentCommentId?: string }) => post<{ comment: unknown }>(`/api/studio/projects/${id}/comments`, body),
  resolveComment: (id: string, commentId: string) => post<{ threads: unknown }>(`/api/studio/projects/${id}/comments/${commentId}/resolve`),
  approve: (id: string, body: { versionId: string; approvalType: string; comments?: string }) => post<{ approval: Approval }>(`/api/studio/projects/${id}/approve`, body),
  revokeApproval: (id: string, approvalId: string, reason: string) => post<{ approvals: ApprovalState }>(`/api/studio/projects/${id}/approvals/${approvalId}/revoke`, { reason }),

  deliver: (id: string) =>
    get<{
      deliverables: Array<{ deliverable: Deliverable; checks: DeliveryCheck[]; url: string | null }>
      metadata: Record<string, unknown> | null
      approvals: ApprovalState
      kinds: string[]
    }>(`/api/studio/projects/${id}/deliver`),
  saveMetadata: (id: string, body: Record<string, unknown>) => put<{ metadata: unknown }>(`/api/studio/projects/${id}/release-metadata`, body),
  createDeliverable: (id: string, body: { versionId: string; assetKind: string }) => post<{ deliverable: Deliverable }>(`/api/studio/projects/${id}/deliverables`, body),
  runChecks: (id: string, deliverableId: string) =>
    post<{ deliverable: Deliverable; checks: DeliveryCheck[]; failed: number; warned: number; unknown: number }>(`/api/studio/projects/${id}/deliverables/${deliverableId}/check`),
  sendToRelease: (id: string, deliverableId: string, releaseId: string) =>
    post<{ deliverable: Deliverable }>(`/api/studio/projects/${id}/deliverables/${deliverableId}/send`, { releaseId }),

  sonicDna: (id: string) =>
    get<{ artistKey: string; entries: Array<{ id: string; attribute: string; valueText: string | null; confidence: number; sampleSize: number; source: string; status: string }>; memory: Array<{ id: string; statement: string; observations: number; confidence: number; status: string }> }>(
      `/api/studio/projects/${id}/sonic-dna`,
    ),
  resetSonicDna: (id: string) => post<{ dnaRemoved: number; memoryRemoved: number }>(`/api/studio/projects/${id}/sonic-dna/reset`),

  passport: (id: string) =>
    get<{
      passport: { id: string; documentHash: string; status: string; document: Record<string, unknown>; createdAt: string } | null
      verification: { valid: boolean; document: { valid: boolean }; asset: { checked: boolean; valid: boolean; detail: string } } | null
      contributions: Array<{ id: string; contributionType: string; performedBy: string; human: boolean; aiTool: string | null; aiRole: string | null; detail: string }>
      contributionTypes: string[]
    }>(`/api/studio/projects/${id}/passport`),
  buildPassport: (id: string) => post<{ passport: { id: string } }>(`/api/studio/projects/${id}/passport`),
  addContribution: (id: string, body: { contributionType: string; performedBy: string; human: boolean; detail?: string; aiTool?: string; aiRole?: string }) =>
    post<{ contribution: unknown }>(`/api/studio/projects/${id}/contributions`, body),

  rights: (id: string) =>
    get<{
      permissions: Array<{ permission: { id: string; assetScope: string; permission: string; granted: boolean; revokedAt: string | null; conditions: string } }>
      identity: {
        artistKey: string
        entries: Array<{ entry: { id: string; subject: string; control: string; verified: boolean; prohibitedUses: string[]; pricing: string } }>
        implicit: Array<{ subject: string; control: string; reason: string }>
      }
      catalogue: { aiPermissions: string[]; identitySubjects: string[] }
    }>(`/api/studio/projects/${id}/rights`),
  setAiPermission: (id: string, body: { assetScope: string; permission: string; granted: boolean; conditions?: string }) =>
    post<{ permission: unknown }>(`/api/studio/projects/${id}/rights/ai`, body),
  setIdentity: (id: string, body: { subject: string; control: string }) => post<{ entry: unknown }>(`/api/studio/projects/${id}/rights/identity`, body),
}
