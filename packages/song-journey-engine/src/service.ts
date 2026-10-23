import type { Db } from '@masterclip/database'
import { forbidden, AppError, systemClock, type Clock } from '@masterclip/shared'
import { SongLabProjectRepo, SongVersionRepo } from '@masterclip/song-lab-domain'
import { StudioProjectRepo, StudioVersionRepo } from '@masterclip/studio-domain'
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
