import type { SongLabProject, SongVersion } from '../song-lab/api.js'
import type { ProjectRow } from '../studio/api.js'

export interface JourneyLink {
  id: string
  orgId: string
  songLabProjectId: string
  studioProjectId: string
  sourceKind: 'song_lab' | 'studio'
  selectedSongVersionId: string | null
  selectedStudioVersionId: string | null
  createdAt: string
  updatedAt: string
  unlinkedAt: string | null
}

export interface JourneyLinkRow {
  link: JourneyLink
  song: Pick<SongLabProject, 'id' | 'title' | 'artistName' | 'status'>
  studio: Pick<ProjectRow['project'], 'id' | 'title' | 'artistName' | 'stage'>
  songVersions: Array<Pick<SongVersion, 'id' | 'createdAt'> & { label: string }>
  studioVersions: Array<{ id: string; label: string; createdAt: string }>
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const match = document.cookie.match(/(?:^|;\s*)masterclip_csrf=([^;]*)/)
  const token = method === 'GET' || method === 'HEAD' ? '' : match?.[1] ? decodeURIComponent(match[1]) : ''
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}), ...(init.headers ?? {}) },
  })
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`)
  return body as T
}

export const songJourneyApi = {
  links: () => request<{ links: JourneyLinkRow[] }>('/api/song-journey/links'),
  create: (body: { songLabProjectId: string; studioProjectId: string; sourceKind: 'song_lab' | 'studio' }) =>
    request<{ link: JourneyLink }>('/api/song-journey/links', { method: 'POST', body: JSON.stringify(body) }),
  selectVersions: (id: string, body: { songVersionId: string; studioVersionId: string }) =>
    request<{ link: JourneyLink }>(`/api/song-journey/links/${encodeURIComponent(id)}/versions`, { method: 'PUT', body: JSON.stringify(body) }),
  unlink: (id: string) => request<{ link: JourneyLink }>(`/api/song-journey/links/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  export: (id: string) => request<Record<string, unknown>>(`/api/song-journey/links/${encodeURIComponent(id)}/export`),
}
