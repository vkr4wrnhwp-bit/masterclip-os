import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { forbidden } from '@masterclip/shared'
import { compareToReferences, type MixMetric } from '@masterclip/mix-analysis'
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

  if (runtime.config.SONG_LAB_SUITE_FEATURE_REFERENCE_COMPARE) {
    const getAnalysis = async (orgId: string, studioVersionId: string) => {
      const row = await runtime.db.get(
        "SELECT a.*, aa.file_name AS source_file_name FROM studio_mix_analyses a LEFT JOIN audio_assets aa ON aa.id = a.source_asset_id AND aa.org_id = a.org_id WHERE a.org_id = ? AND a.studio_version_id = ? AND a.status = 'ready' ORDER BY a.created_at DESC, a.id DESC LIMIT 1",
        [orgId, studioVersionId],
      )
      if (!row) return null
      const metrics = await runtime.db.query(
        'SELECT * FROM studio_mix_metrics WHERE org_id = ? AND analysis_id = ?',
        [orgId, String(row['id'])],
      )
      return { analysis: row, metrics: metrics.map(m => ({
        key: String(m['metric_key']), value: m['value'] == null ? null : Number(m['value']),
        unit: String(m['unit']), confidence: Number(m['confidence']),
        analysisMethod: String(m['analysis_method']), provider: String(m['provider']), note: String(m['note']),
      })) as MixMetric[] }
    }
    app.get('/api/song-journey/links/:id/reference-candidates', async request => {
      const actor = await authorize(request)
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
      await journey.links.get(actor.orgId, id)
      const options = await journey.links.list(actor.orgId)
      const candidates = []
      for (const link of options) {
        if (link.id === id || !link.selectedStudioVersionId) continue
        const match = await getAnalysis(actor.orgId, link.selectedStudioVersionId)
        if (!match) continue
        const song = await songs.get(actor.orgId, link.songLabProjectId)
        candidates.push({ linkId: link.id, title: song.title, studioVersionId: link.selectedStudioVersionId })
      }
      return { candidates }
    })
    app.get('/api/song-journey/links/:id/reference-compare', async (request, reply) => {
      const actor = await authorize(request)
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
      const { with: otherId } = z.object({ with: z.string().min(1).max(128) }).parse(request.query)
      const current = await journey.links.get(actor.orgId, id)
      const reference = await journey.links.get(actor.orgId, otherId)
      if (current.id === reference.id || !current.selectedStudioVersionId || !reference.selectedStudioVersionId)
        return reply.code(400).send({ error: 'Choose two different versions from your own saved songs.' })
      const [mine, theirs] = await Promise.all([
        getAnalysis(actor.orgId, current.selectedStudioVersionId),
        getAnalysis(actor.orgId, reference.selectedStudioVersionId),
      ])
      if (!mine || !theirs) return { state: 'missing', message: 'Not enough information: both songs need completed mix measurements.' }
      const refSong = await songs.get(actor.orgId, reference.songLabProjectId)
      const result = compareToReferences(mine.metrics, [{
        referenceId: reference.id, label: refSong.title, metrics: theirs.metrics,
      }])
      const mismatch = mine.analysis['analyzer_set_version'] !== theirs.analysis['analyzer_set_version']
        || mine.analysis['sample_rate'] !== theirs.analysis['sample_rate']
      return {
        state: 'ready', title: refSong.title, ...result,
        warning: mismatch ? 'These were measured differently, so small differences may not be real.' : '',
        provenance: {
          current: { analysisId: mine.analysis['id'], versionId: current.selectedStudioVersionId,
            sourceFile: mine.analysis['source_file_name'] ?? mine.analysis['source_asset_id'], analyzerVersion: mine.analysis['analyzer_set_version'],
            sampleRate: mine.analysis['sample_rate'], measuredAt: mine.analysis['created_at'] },
          reference: { analysisId: theirs.analysis['id'], versionId: reference.selectedStudioVersionId,
            sourceFile: theirs.analysis['source_file_name'] ?? theirs.analysis['source_asset_id'], analyzerVersion: theirs.analysis['analyzer_set_version'],
            sampleRate: theirs.analysis['sample_rate'], measuredAt: theirs.analysis['created_at'] },
        },
      }
    })
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
