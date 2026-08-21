/**
 * Typed API client.
 *
 * Errors arrive as the server's `{ error: { kind, code, message, details } }`
 * envelope and are re-thrown with the message intact, so the UI can show what
 * actually went wrong instead of "request failed".
 */
export class ApiError extends Error {
  constructor(
    readonly kind: string,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly status = 0,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * The server sets this cookie readable so we can echo it back in a header.
 * Setting a header cross-site is the thing an attacker's page cannot do, which
 * is what makes the pair meaningful rather than the cookie alone.
 */
function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)masterclip_csrf=([^;]*)/)
  return match?.[1] ? decodeURIComponent(match[1]) : ''
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const token = method === 'GET' || method === 'HEAD' ? '' : csrfToken()
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      // Outside the FormData branch on purpose: uploads need the token too, and
      // they are the one call that suppresses the content-type header.
      ...(token ? { 'x-csrf-token': token } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!response.ok) {
    const envelope = (body as { error?: { kind?: string; code?: string; message?: string; details?: Record<string, unknown> } })?.error
    throw new ApiError(
      envelope?.kind ?? 'internal',
      envelope?.code ?? String(response.status),
      envelope?.message ?? `${response.status} ${response.statusText}`,
      envelope?.details ?? {},
      response.status,
    )
  }
  return body as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const put = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) })
const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) })

export interface User {
  userId: string
  orgId: string
  email: string
  displayName: string
  orgRole: string
}

export interface Project {
  id: string
  orgId: string
  name: string
  slug: string
  brief: string
  status: string
  styleBible: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface Shot {
  id: string
  projectId: string
  sceneId: string | null
  shotKey: string
  title: string
  currentVersion: number
  ordinal: number
  spec?: Record<string, unknown>
}

export interface ModelInfo {
  providerId: string
  modelId: string
  displayName: string
  family: string
  tier: string
  modes: string[]
  resolutions: string[]
  aspectRatios: string[]
  durations: { minSeconds: number; maxSeconds: number; allowedSeconds?: number[] }
  nativeAudio: boolean
  firstFrame: boolean
  lastFrame: boolean
  videoReference: boolean
  extension: boolean
  maxReferenceImages: number
  pricing: { basis: string; rateMicros: number; dynamic: boolean; notes?: string; sourceUrl: string; retrievedAt: string } | null
  source: string
}

export interface RoutingCandidate {
  providerId: string
  modelId: string
  displayName: string
  tier: string
  estimatedUsd: string | null
  expectedApprovedUsd: string | null
  expectedApprovedPerSecondUsd: string | null
  predictedApprovalRate: number
  confidence: number
  observedApprovals: number
  observedSubmissions: number
  health: string
  score: number
  reasons: string[]
  warnings: string[]
}

export interface QueueJobView {
  id: string
  batchId: string | null
  shotId: string
  provider: string
  model: string
  status: string
  attempts: number
  estimatedUsd: string
  actualUsd: string
  sandbox: boolean
  ageSeconds: number
  error: Record<string, unknown> | null
  createdAt: string
  submittedAt: string | null
  completedAt: string | null
}

export interface OutputView {
  id: string
  jobId: string
  shotId: string
  providerId: string
  modelId: string
  durationSeconds: number | null
  width: number | null
  height: number | null
  fps: number | null
  hasAudio: boolean
  status: string
  prompt: string
  seed: string | null
  routingProfile: string
  estimatedUsd: string
  actualUsd: string
  qcDetail: Record<string, unknown> | null
  review: { decision: string; rejectionReasons: string[]; note: string } | null
  urls: { source: string | null; proxy: string | null; thumbnail: string | null; contactSheet: string | null }
}

export const api = {
  health: () => get<{ ok: boolean; mode: string; dialect: string; storage: string; agents: boolean }>('/api/health'),
  me: () => get<{ user: User }>('/api/auth/me'),
  login: (email: string, password: string) => post<{ user: User }>('/api/auth/login', { email, password }),
  signup: (input: { email: string; password: string; displayName: string; orgName: string }) => post<{ user: User }>('/api/auth/signup', input),
  logout: () => post<{ ok: boolean }>('/api/auth/logout'),

  projects: () => get<{ projects: Project[] }>('/api/projects'),
  createProject: (name: string, brief: string) => post<{ project: Project }>('/api/projects', { name, brief }),
  project: (id: string) =>
    get<{ project: Project; scenes: unknown[]; shots: Shot[]; characters: unknown[]; environments: unknown[] }>(`/api/projects/${id}`),
  updateProject: (id: string, patchBody: Record<string, unknown>) => patch<{ project: Project }>(`/api/projects/${id}`, patchBody),

  shots: (projectId: string) => get<{ shots: Shot[] }>(`/api/projects/${projectId}/shots`),
  blankShot: () => get<{ shot: Record<string, unknown> }>('/api/shots/blank'),
  validateShot: (spec: unknown) => post<{ ok: boolean; issues: Array<{ path: string; message: string; severity: string; code: string }> }>('/api/shots/validate', { spec }),
  createShot: (projectId: string, spec: unknown) => post<{ shot: Shot; warnings: unknown[] }>(`/api/projects/${projectId}/shots`, { spec }),
  shot: (shotId: string) =>
    get<{ shot: Shot; version: { id: string; spec: Record<string, unknown> }; versions: unknown[]; outputs: unknown[] }>(`/api/shots/${shotId}`),
  saveShotVersion: (shotId: string, spec: unknown, note: string) =>
    post<{ version: { id: string } }>(`/api/shots/${shotId}/versions`, { spec, note }),
  importShots: (projectId: string, format: 'csv' | 'json', content: string, dryRun: boolean) =>
    post<Record<string, unknown>>(`/api/projects/${projectId}/shots/import`, { format, content, dryRun }),

  models: (refresh = false) => get<{ models: ModelInfo[] }>(`/api/models${refresh ? '?refresh=1' : ''}`),
  providers: () =>
    get<{
      mode: string
      liveSpendCapUsd: number
      liveSpentUsd: string
      providers: Array<{ providerId: string; displayName: string; configured: boolean; keyFingerprint: string; health: Record<string, unknown> | null }>
    }>('/api/providers'),
  providerHealth: () => get<{ health: Array<{ providerId: string; status: string; latencyMs: number | null; message: string }> }>('/api/providers/health'),
  routingProfiles: () => get<{ profiles: Array<Record<string, unknown>> }>('/api/routing-profiles'),

  routing: (shotId: string) =>
    get<{
      profile: Record<string, unknown>
      chosen: RoutingCandidate | null
      candidates: RoutingCandidate[]
      rejected: Array<{ providerId: string; modelId: string; reasons: string[] }>
      lowConfidence: boolean
      explanation: string
    }>(`/api/shots/${shotId}/routing`),

  matrix: (shotId: string, body: Record<string, unknown>) =>
    post<{
      cells: Array<Record<string, unknown>>
      candidateCount: number
      estimatedTotalUsd: string | null
      unpricedCount: number
      byProvider: Array<{ providerId: string; count: number; estimatedMicros: number | null }>
      warnings: string[]
      budget: Record<string, unknown>
      mode: string
    }>(`/api/shots/${shotId}/matrix`, body),

  render: (shotId: string, body: Record<string, unknown>) =>
    post<{ jobIds: string[]; skipped: Array<{ reason: string }>; estimatedUsd: string; warnings: string[]; queued: number }>(
      `/api/shots/${shotId}/render`,
      body,
    ),

  queue: (projectId: string) => get<{ stats: Record<string, number>; jobs: QueueJobView[] }>(`/api/projects/${projectId}/queue`),
  retryJob: (jobId: string) => post<{ queueJobId: string }>(`/api/jobs/${jobId}/retry`),
  cancelJob: (jobId: string) => post<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`),

  outputs: (shotId: string) => get<{ outputs: OutputView[] }>(`/api/shots/${shotId}/outputs`),
  review: (outputId: string, body: Record<string, unknown>) => post<{ review: unknown }>(`/api/outputs/${outputId}/review`, body),
  promote: (outputId: string, name: string) => post<{ masterId: string }>(`/api/outputs/${outputId}/promote`, { name }),

  masters: (projectId: string) => get<{ masters: Array<Record<string, unknown>> }>(`/api/projects/${projectId}/masters`),
  finishMaster: (masterId: string, specs: unknown[]) => post<{ assetIds: string[] }>(`/api/masters/${masterId}/finish`, { specs }),
  packageMaster: (masterId: string) => post<{ directory: string; files: number }>(`/api/masters/${masterId}/package`),

  costs: (projectId: string) => get<Record<string, unknown>>(`/api/projects/${projectId}/costs`),
  budget: (projectId: string, body: Record<string, unknown>) => put<{ budget: unknown }>(`/api/projects/${projectId}/budget`, body),
  modelPerformance: (projectId: string) => get<{ performance: Array<Record<string, unknown>> }>(`/api/projects/${projectId}/model-performance`),
  strategy: (body: Record<string, unknown>) =>
    post<{ draftFirstUsd: string; premiumOnlyUsd: string; savingsUsd: string; savingsMicros: number; savingsPercent: number | null; assumptions: string[] }>(
      '/api/cost-lab/strategy',
      body,
    ),

  uploadAsset: (projectId: string, form: FormData) =>
    request<{ asset: Record<string, unknown>; url: string; deduplicated: boolean }>(`/api/projects/${projectId}/assets`, {
      method: 'POST',
      body: form,
    }),
  assets: (projectId: string, kind?: string) =>
    get<{ assets: Array<Record<string, unknown> & { url: string }> }>(`/api/projects/${projectId}/assets${kind ? `?kind=${kind}` : ''}`),
}
