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
  health: () => get<{ ok: boolean; mode: string; dialect: string; storage: string; agents: boolean; streetBankerUrl?: string; signupOpen?: boolean }>('/api/health'),
  me: () => get<{ user: User; streetBankerUrl?: string }>('/api/auth/me'),
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
      /** False when no cap was configured and the figure above is the fallback. */
      liveSpendCapConfigured: boolean
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
  retryFinishing: (masterId: string, jobId: string) =>
    post<{jobId:string;status:'queued';deduped:boolean}>(
      `/api/masters/${encodeURIComponent(masterId)}/finishing/${encodeURIComponent(jobId)}/retry`),
  finishStatus: (masterId: string, jobId: string) => get<{ jobId:string;status:string;error:string|null }>(
    `/api/masters/${encodeURIComponent(masterId)}/finishing/${encodeURIComponent(jobId)}`),
  finishCaptionedSong: (masterId: string) => post<{jobId:string;status:'queued';deduped:boolean}>(`/api/masters/${encodeURIComponent(masterId)}/captioned-song`),

  finishSongMoment: (masterId: string) => post<{jobId:string;status:'queued';deduped:boolean}>(`/api/masters/${encodeURIComponent(masterId)}/song-moment`),

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

  creativeTreatments: (projectId: string) =>
    get<{ treatments: Array<{ id: string; name: string; look: string; aspect_ratio: string; direction: string }> }>(
      `/api/projects/${encodeURIComponent(projectId)}/creative-treatments`),
  saveCreativeTreatment: (projectId: string, treatment: { name: string; look: string; aspect_ratio: string; direction: string }) =>
    post<{ treatment: { id: string; name: string; look: string; aspect_ratio: string; direction: string } }>(
      `/api/projects/${encodeURIComponent(projectId)}/creative-treatments`, treatment),

  createVariant: (projectId: string, body: {sourceShotId:string;label:string;direction:string;look:string}) =>
    post<{shotId:string;sourceShotId:string;status:string;rendered:boolean}>(`/api/projects/${projectId}/quick-variants`, body),
  proposeMusicFirstCut: (projectId:string, body:{
    name:string;audio_asset_id:string;song_start_seconds:number;target_seconds:number;
    pacing:'measured'|'balanced'|'energetic'
  }) => post<{
    spec:{name:string;audio_asset_id:string;song_start_seconds:number;
      clips:Array<{master_id:string;source_start_seconds:number;source_end_seconds:number}>};
    durationSeconds:number;targetSeconds:number;beatAligned:boolean;
    confidence:number;warnings:string[]
  }>(`/api/projects/${encodeURIComponent(projectId)}/music-timelines/propose`,body),
  musicTimelineSources: (projectId: string) => get<{
    videos: Array<{masterId:string;name:string;durationSeconds:number;videoUrl:string}>
    audio: Array<{id:string;filename:string;durationSeconds:number;audioUrl:string}>
  }>(`/api/projects/${encodeURIComponent(projectId)}/music-timelines/sources`),
  musicTimelines: (projectId: string) => get<{timelines: Array<{
    id:string;projectId:string;name:string;version:number;spec:{
      name:string;audio_asset_id:string;song_start_seconds:number;
      clips:Array<{master_id:string;source_start_seconds:number;source_end_seconds:number}>
    }
  }> }>(`/api/projects/${encodeURIComponent(projectId)}/music-timelines`),
  createMusicTimeline: (projectId:string,spec:unknown) =>
    post<{timelineId:string;version:number;status:string;rendered:boolean}>(
      `/api/projects/${encodeURIComponent(projectId)}/music-timelines`,spec),
  updateMusicTimeline: (projectId:string,timelineId:string,version:number,spec:unknown) =>
    put<{timelineId:string;version:number;status:string;rendered:boolean}>(
      `/api/projects/${encodeURIComponent(projectId)}/music-timelines/${encodeURIComponent(timelineId)}`,
      {expectedVersion:version,spec}),
  assembleMusicTimeline: (projectId:string,timelineId:string) =>
    post<{jobId:string;version:number;status:'queued';deduped:boolean}>(
      `/api/projects/${encodeURIComponent(projectId)}/music-timelines/${encodeURIComponent(timelineId)}/assemble`),
  musicTimelineExports: (projectId:string,timelineId:string) =>
    get<{exports:Array<{id:string;assetId:string;version:number;durationSeconds:number|null;url:string|null;createdAt:string}>;latestJob:{id:string;status:string}|null}>(
      `/api/projects/${encodeURIComponent(projectId)}/music-timelines/${encodeURIComponent(timelineId)}/exports`),
  musicTimelineJob: (projectId:string,timelineId:string,jobId:string) =>
    get<{jobId:string;status:string;error:string|null}>(
      `/api/projects/${encodeURIComponent(projectId)}/music-timelines/${encodeURIComponent(timelineId)}/jobs/${encodeURIComponent(jobId)}`),
  musicTimelinePreview: (projectId:string,timelineId:string) =>
    get<{timeline:{id:string;version:number;spec:{name:string;audio_asset_id:string;song_start_seconds:number;
      clips:Array<{master_id:string;source_start_seconds:number;source_end_seconds:number}>}};
      audioUrl:string;durationSeconds:number;rendered:boolean;
      clips:Array<{master_id:string;source_start_seconds:number;source_end_seconds:number;
        masterName:string;videoUrl:string;durationSeconds:number}>}>(
      `/api/projects/${encodeURIComponent(projectId)}/music-timelines/${encodeURIComponent(timelineId)}/preview`),

  beats: (assetId: string) =>
    get<{ assetId: string; bpm: number|null; confidence: number; beats: number[];
      durationSeconds: number; source: 'decoded_pcm_onset'; analysisVersion: 1; limitation: string }>(
      `/api/assets/${encodeURIComponent(assetId)}/beats`),
  waveform: (assetId: string) => get<{ assetId: string; peaks: number[]; durationSeconds: number; source: 'decoded_pcm' }>(`/api/assets/${encodeURIComponent(assetId)}/waveform`),

  quickCreate: (projectId: string, body: {
    title: string; creativeDirection: string; audioAssetId: string;
    visualAssetId: string | null; startSeconds: number; endSeconds: number;
    aspectRatio: string; look: string; promotionalUseAttested: true; shotId?: string; captions?: { start_seconds: number; end_seconds: number; text: string }[]
  }) => post<{ shotId: string; versionId: string; status: 'draft'; audioEmbedded: false; rendered: false }>(`/api/projects/${projectId}/quick-create`, body),

  uploadAsset: (projectId: string, form: FormData) =>
    request<{ asset: Record<string, unknown>; url: string; deduplicated: boolean }>(`/api/projects/${projectId}/assets`, {
      method: 'POST',
      body: form,
    }),
  assets: (projectId: string, kind?: string) =>
    get<{ assets: Array<Record<string, unknown> & { url: string }> }>(`/api/projects/${projectId}/assets${kind ? `?kind=${kind}` : ''}`),
}
