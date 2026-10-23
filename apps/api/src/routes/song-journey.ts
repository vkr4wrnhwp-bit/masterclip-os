import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { forbidden } from '@masterclip/shared'
import { SongJourneyService } from '@masterclip/song-journey-engine'
import { SongLabProjectRepo, SongVersionRepo } from '@masterclip/song-lab-domain'
import { StudioProjectRepo, StudioVersionRepo } from '@masterclip/studio-domain'
import { requireSongLab } from './song-lab/helpers.js'
import { requireStudio } from './studio/helpers.js'

export async function registerSongJourneyRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const enabled = runtime.config.SONG_LAB_SUITE_ENABLED && runtime.config.SONG_LAB_SUITE_LINKED_RECORDS_ENABLED
  if (!enabled) return

  const journey = new SongJourneyService(runtime.db, runtime.clock)
  const songs = new SongLabProjectRepo(runtime.db, runtime.clock)
  const songVersions = new SongVersionRepo(runtime.db, runtime.clock)
  const studios = new StudioProjectRepo(runtime.db, runtime.clock)
  const studioVersions = new StudioVersionRepo(runtime.db, runtime.clock)
  const authorize = async (request: Parameters<typeof requireSongLab>[1]) => {
    const songActor = await requireSongLab(runtime, request, 'song_lab.access')
    const studioActor = await requireStudio(runtime, request, 'studio.access')
    if (songActor.orgId !== studioActor.orgId) throw forbidden('Both journey records must belong to the same workspace.')
    return songActor
  }

  app.get('/api/song-journey/links', async request => {
    const actor = await authorize(request)
    const links = await journey.links.list(actor.orgId)
    return {
      links: await Promise.all(links.map(async link => {
        const [song, studio, songVersionRows, studioVersionRows] = await Promise.all([
          songs.get(actor.orgId, link.songLabProjectId),
          studios.get(actor.orgId, link.studioProjectId),
          songVersions.list(actor.orgId, link.songLabProjectId),
          studioVersions.list(actor.orgId, link.studioProjectId),
        ])
        return {
          link,
          song: { id: song.id, title: song.title, artistName: song.artistName, status: song.status },
          studio: { id: studio.id, title: studio.title, artistName: studio.artistName, stage: studio.stage },
          songVersions: songVersionRows.map(version => ({ id: version.id, label: version.versionLabel, createdAt: version.createdAt })),
          studioVersions: studioVersionRows.map(version => ({ id: version.id, label: version.label, createdAt: version.createdAt })),
        }
      })),
    }
  })

  app.post('/api/song-journey/links', async request => {
    const actor = await authorize(request)
    const body = z.object({
      songLabProjectId: z.string().min(1).max(128),
      studioProjectId: z.string().min(1).max(128),
      sourceKind: z.enum(['song_lab', 'studio']),
    }).parse(request.body)
    return { link: await journey.create(actor.orgId, actor.userId, body) }
  })

  app.put('/api/song-journey/links/:id/versions', async request => {
    const actor = await authorize(request)
    const { id } = request.params as { id: string }
    const body = z.object({ songVersionId: z.string().min(1), studioVersionId: z.string().min(1) }).parse(request.body)
    return { link: await journey.selectVersions(actor.orgId, id, body.songVersionId, body.studioVersionId) }
  })

  app.delete('/api/song-journey/links/:id', async request => {
    const actor = await authorize(request)
    const { id } = request.params as { id: string }
    return { link: await journey.links.unlink(actor.orgId, id) }
  })

  app.get('/api/song-journey/links/:id/export', async (request, reply) => {
    const actor = await authorize(request)
    const { id } = request.params as { id: string }
    const data = await journey.export(actor.orgId, id)
    return reply.header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="song-journey-${id}.json"`)
      .send(data)
  })
}
