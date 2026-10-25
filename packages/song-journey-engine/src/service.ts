import type { Db } from '@masterclip/database'
import { selectVersionPair } from './version-compare.js'
import { authoritativeStudioApproval } from './final-approval.js'
import { forbidden, AppError, systemClock, type Clock } from '@masterclip/shared'
import { SongLabProjectRepo, SongVersionRepo } from '@masterclip/song-lab-domain'
import { StudioProjectRepo, StudioVersionRepo, StudioApprovalRepo } from '@masterclip/studio-domain'
import { SongJourneyLinkRepo, type SongJourneyLink, type SongJourneySource } from '@masterclip/song-journey-domain'

export class SongJourneyService {
  readonly links: SongJourneyLinkRepo
  private readonly songs: SongLabProjectRepo
  private readonly songVersions: SongVersionRepo
  private readonly studios: StudioProjectRepo
  private readonly studioVersions: StudioVersionRepo

  constructor(private readonly db: Db, private readonly clock: Clock = systemClock) {
    this.links = new SongJourneyLinkRepo(db, clock)
    this.songs = new SongLabProjectRepo(db, clock)
    this.songVersions = new SongVersionRepo(db, clock)
    this.studios = new StudioProjectRepo(db, clock)
    this.studioVersions = new StudioVersionRepo(db, clock)
  }

  async create(orgId: string, createdBy: string, input: { songLabProjectId: string; studioProjectId: string; sourceKind: SongJourneySource }): Promise<SongJourneyLink> {
    const [song, studio] = await Promise.all([
      this.songs.get(orgId, input.songLabProjectId),
      this.studios.get(orgId, input.studioProjectId),
    ])
    if (song.orgId !== studio.orgId) throw forbidden('Both source records must belong to the same workspace.')
    if (input.sourceKind !== 'song_lab' && input.sourceKind !== 'studio') throw new AppError({ kind: 'validation', code: 'song_journey.source', message: 'Choose Song Lab or Studio as the source.' })
    return this.links.create({ orgId, createdBy, ...input })
  }

  async selectVersions(orgId: string, id: string, songVersionId: string, studioVersionId: string): Promise<SongJourneyLink> {
    const link = await this.links.get(orgId, id)
    const [songVersion, studioVersion] = await Promise.all([
      this.songVersions.get(orgId, songVersionId),
      this.studioVersions.get(orgId, studioVersionId),
    ])
    if (songVersion.songLabProjectId !== link.songLabProjectId || studioVersion.studioProjectId !== link.studioProjectId) {
      throw forbidden('Select versions that belong to the linked source records.')
    }
    return this.links.selectVersions(orgId, id, songVersionId, studioVersionId)
  }

  /** Job 45: inspect existing song history without granting playback or approval. */
  async compareSongVersions(orgId: string, linkId: string, leftId: string, rightId: string) {
    const link = await this.links.get(orgId, linkId)
    const versions = await this.songVersions.list(orgId, link.songLabProjectId)
    return selectVersionPair(orgId, link.songLabProjectId, versions, leftId, rightId)
  }

  /** Studio's exact audio version is the final authority; Song Lab remains evidence. */
  async finalApproval(orgId: string, linkId: string) {
    const link = await this.links.get(orgId, linkId)
    if (!link.selectedStudioVersionId) return {
      state: 'not_selected' as const, studioVersionId: null, approval: null,
      songLabEvidenceVersionId: link.selectedSongVersionId,
    }
    const version = await this.studioVersions.get(orgId, link.selectedStudioVersionId)
    if (version.studioProjectId !== link.studioProjectId) throw forbidden('Selected Studio version does not belong to this linked project.')
    const approvals = await new StudioApprovalRepo(this.db, this.clock).list(orgId, link.studioProjectId)
    const approval = authoritativeStudioApproval(version.id, version.assetChecksum, approvals)
    return {
      state: approval ? 'approved' as const : 'not_approved' as const,
      studioVersionId: version.id,
      studioChecksum: version.assetChecksum,
      approval: approval ? {
        id: approval.id, type: approval.approvalType, approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt, versionChecksum: approval.versionChecksum,
      } : null,
      songLabEvidenceVersionId: link.selectedSongVersionId,
    }
  }

  async export(orgId: string, id: string) {
    const link = await this.links.get(orgId, id, true)
    const [song, studio, songVersions, studioVersions] = await Promise.all([
      this.songs.get(orgId, link.songLabProjectId),
      this.studios.get(orgId, link.studioProjectId),
      this.songVersions.list(orgId, link.songLabProjectId),
      this.studioVersions.list(orgId, link.studioProjectId),
    ])
    return {
      format: 'street-banker-song-journey-link/v1',
      exportedAt: this.clock.isoNow(),
      link,
      sourceRecords: {
        songLab: { id: song.id, title: song.title, artistName: song.artistName, versionIds: songVersions.map(version => version.id) },
        studio: { id: studio.id, title: studio.title, artistName: studio.artistName, versionIds: studioVersions.map(version => version.id) },
      },
      preservation: 'This export records references only. Original projects, audio, checksums, analyses, comments and approvals remain in their owning records.',
    }
  }
}
