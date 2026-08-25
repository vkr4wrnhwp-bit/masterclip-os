import type {
  LiveAiJob,
  LiveClip,
  LiveOutput,
  LiveProject,
  LiveScene,
  LiveSetItem,
  LiveStem,
  MidiMapping,
  PadAssignment,
  PerformanceManifest,
  StageControlHandoff,
} from '@masterclip/performance-project'
import { del, get, patch, post, request } from '../api.js'

/** Typed client for the Live Lab API. Types come from the shared package. */

export interface LiveAssetView {
  id: string
  organizationId: string
  liveProjectId: string
  kind: string
  filename: string
  mime: string
  bytes: number
  sha256: string
  durationMs: number | null
  metadata: Record<string, unknown>
  rightsConfirmed: boolean
  lineage: Record<string, unknown> | null
  createdAt: string
}

export interface LivePackageView {
  id: string
  liveProjectId: string
  version: number
  status: string
  manifest: PerformanceManifest | null
  storageSize: number
  createdAt: string
  verifiedAt: string | null
}

export interface LiveProjectSummary extends LiveProject {
  songCount: number
  itemCount: number
  latestPackage: { id: string; version: number; status: string } | null
}

export interface LiveProjectBundle {
  project: LiveProject
  items: LiveSetItem[]
  scenes: LiveScene[]
  clips: LiveClip[]
  stems: LiveStem[]
  mappings: MidiMapping[]
  outputs: LiveOutput[]
  assets: LiveAssetView[]
  packages: LivePackageView[]
  aiJobs: LiveAiJob[]
}

export interface SetSuggestion {
  id: string
  kind: 'add_item' | 'add_click' | 'pad_map' | 'needs_bpm'
  title: string
  description: string
}

export const liveApi = {
  capabilities: () =>
    get<{ capabilities: string[]; limits: Record<string, number | null>; all: string[]; rightsStatement: string; aiProvider: string }>(
      '/api/live-lab/capabilities',
    ),

  projects: () => get<{ projects: LiveProjectSummary[] }>('/api/live-lab/projects'),
  createProject: (body: { name: string; description?: string; masterTempo?: number; timeSignature?: string; duplicateOf?: string }) =>
    post<{ project: LiveProject }>('/api/live-lab/projects', body),
  project: (id: string) => get<LiveProjectBundle>(`/api/live-lab/projects/${id}`),
  updateProject: (id: string, body: Record<string, unknown>) => patch<{ project: LiveProject }>(`/api/live-lab/projects/${id}`, body),
  deleteProject: (id: string) => del<{ ok: boolean }>(`/api/live-lab/projects/${id}`),
  updatePads: (id: string, padMap: PadAssignment[]) => patch<{ project: LiveProject }>(`/api/live-lab/projects/${id}`, { padMap }),

  importRelease: (id: string, sourceProjectId: string) =>
    post<{ imported: Array<{ itemId: string; sceneId: string; assetId: string }> }>(`/api/live-lab/projects/${id}/import-release`, {
      sourceProjectId,
    }),
  importRemix: (id: string, sourceLiveProjectId: string, assetIds: string[]) =>
    post<{ imported: string[] }>(`/api/live-lab/projects/${id}/import-remix`, { sourceLiveProjectId, assetIds }),
  upload: (id: string, form: FormData) =>
    request<{ asset: LiveAssetView }>(`/api/live-lab/projects/${id}/upload`, { method: 'POST', body: form }),
  assetUrl: (assetId: string) => get<{ url: string; asset: LiveAssetView }>(`/api/live-lab/assets/${assetId}/url`),

  buildSetPlan: (id: string) => post<{ suggestions: SetSuggestion[] }>(`/api/live-lab/projects/${id}/build-set`, {}),
  applySetPlan: (id: string, suggestionIds: string[]) =>
    post<{ applied: string[] }>(`/api/live-lab/projects/${id}/build-set`, { apply: true, suggestionIds }),

  reorder: (id: string, order: string[]) => patch<{ items: LiveSetItem[] }>(`/api/live-lab/projects/${id}/set`, { order }),
  createItem: (id: string, body: Record<string, unknown>) => post<{ item: LiveSetItem }>(`/api/live-lab/projects/${id}/set-items`, body),
  updateItem: (itemId: string, body: Record<string, unknown>) => patch<{ item: LiveSetItem }>(`/api/live-lab/set-items/${itemId}`, body),
  deleteItem: (itemId: string) => del<{ ok: boolean }>(`/api/live-lab/set-items/${itemId}`),

  createScene: (projectId: string, body: Record<string, unknown>) =>
    post<{ scene: LiveScene }>(`/api/live-lab/projects/${projectId}/scenes`, body),
  updateScene: (sceneId: string, body: Record<string, unknown>) => patch<{ scene: LiveScene }>(`/api/live-lab/scenes/${sceneId}`, body),
  deleteScene: (sceneId: string) => del<{ ok: boolean }>(`/api/live-lab/scenes/${sceneId}`),
  addClip: (sceneId: string, body: Record<string, unknown>) => post<{ clip: LiveClip }>(`/api/live-lab/scenes/${sceneId}/clips`, body),

  createStem: (projectId: string, body: Record<string, unknown>) => post<{ stem: LiveStem }>(`/api/live-lab/projects/${projectId}/stems`, body),
  updateStem: (stemId: string, body: Record<string, unknown>) => patch<{ stem: LiveStem }>(`/api/live-lab/stems/${stemId}`, body),
  deleteStem: (stemId: string) => del<{ ok: boolean }>(`/api/live-lab/stems/${stemId}`),

  mappings: (projectId: string) => get<{ mappings: MidiMapping[] }>(`/api/live-lab/projects/${projectId}/midi-mappings`),
  createMapping: (projectId: string, body: Record<string, unknown>) =>
    post<{ mapping: MidiMapping; replaced: string | null }>(`/api/live-lab/projects/${projectId}/midi-mappings`, body),
  deleteMapping: (mappingId: string) => del<{ ok: boolean }>(`/api/live-lab/midi-mappings/${mappingId}`),
  mapKeyboardZone: (projectId: string, body: Record<string, unknown>) =>
    post<{ mappings: MidiMapping[]; replaced: string[] }>(`/api/live-lab/projects/${projectId}/midi-mappings/bulk`, body),

  createAiScene: (projectId: string, body: Record<string, unknown>) => post<{ job: LiveAiJob }>(`/api/live-lab/projects/${projectId}/ai-scenes`, body),
  aiJob: (jobId: string) => get<{ job: LiveAiJob; options: Array<{ asset: LiveAssetView; url: string }> }>(`/api/live-lab/ai-jobs/${jobId}`),
  acceptAiJob: (jobId: string, body: Record<string, unknown>) => post<{ sceneId: string; job: LiveAiJob }>(`/api/live-lab/ai-jobs/${jobId}/accept`, body),
  rejectAiJob: (jobId: string) => post<{ ok: boolean }>(`/api/live-lab/ai-jobs/${jobId}/reject`),

  buildPackage: (projectId: string) =>
    post<{ package: LivePackageView; report: { status: string; issues: Array<{ path: string | null; code: string; message: string }> } }>(
      `/api/live-lab/projects/${projectId}/performance-package`,
    ),
  packageFiles: (packageId: string) =>
    get<{ package: LivePackageView; files: Array<{ path: string; assetId: string; kind: string; sha256: string; bytes: number; url: string | null }> }>(
      `/api/live-lab/performance-packages/${packageId}`,
    ),
  verifyPackage: (packageId: string, files: Array<{ path: string; sha256: string; bytes: number; decodable: boolean }>) =>
    post<{ package: LivePackageView; status: string; issues: Array<{ path: string; code: string; message: string }> }>(
      `/api/live-lab/performance-packages/${packageId}/verify`,
      { files },
    ),

  stageControl: (projectId: string) => get<{ handoff: StageControlHandoff }>(`/api/live-lab/projects/${projectId}/stage-control`),
  syncEvents: (projectId: string, events: Array<{ eventType: string; payload: Record<string, unknown>; localTimestamp: string }>) =>
    post<{ recorded: number }>(`/api/live-lab/projects/${projectId}/events`, { events }),
}
