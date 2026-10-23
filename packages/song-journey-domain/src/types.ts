export type SongJourneySource = 'song_lab' | 'studio'

export interface SongJourneyLink {
  id: string
  orgId: string
  songLabProjectId: string
  studioProjectId: string
  sourceKind: SongJourneySource
  selectedSongVersionId: string | null
  selectedStudioVersionId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  unlinkedAt: string | null
}
