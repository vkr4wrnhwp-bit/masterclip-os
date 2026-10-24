import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { forbidden } from '@masterclip/shared'
import { SongJourneyService } from '@masterclip/song-journey-engine'
import { SongLabProjectRepo, SongVersionRepo, SongAnalysisRepo, SongSectionRepo } from '@masterclip/song-lab-domain'
import { applySongMapEdits, songMapEvidence, type MapEdit } from '@masterclip/song-lab-engine'
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

  if (runtime.config.SONG_LAB_SUITE_FEATURE_SONG_MAP) {
    const analyses = new SongAnalysisRepo(runtime.db, runtime.clock)
    const sections = new SongSectionRepo(runtime.db, runtime.clock)
    const editSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('rename'), id: z.string().min(1), label: z.string().trim().min(1).max(80) }),
      z.object({ kind: z.literal('boundary'), id: z.string().min(1), endMs: z.number().int().nonnegative() }),
      z.object({ kind: z.literal('merge'), leftId: z.string().min(1), rightId: z.string().min(1), label: z.string().trim().min(1).max(80) }),
      z.object({ kind: z.literal('split'), id: z.string().min(1), atMs: z.number().int().nonnegative(), newId: z.string().min(1), label: z.string().trim().min(1).max(80) }),
    ])
    const read = async (orgId: string, linkId: string) => {
      const link = await journey.links.get(orgId, linkId)
      const versionId = link.selectedSongVersionId
      if (!versionId) return null
      const analysis = await analyses.latestForVersion(orgId, versionId)
      if (!analysis) return null
      const raw = await sections.list(orgId, analysis.id)
      const original = raw.map(row => ({ id: row.id, label: row.label, startMs: row.startMs,
        endMs: row.endMs, confidence: row.confidence }))
      const latest = await runtime.db.get(
        'SELECT edits_json FROM song_map_corrections WHERE org_id = ? AND song_analysis_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        [orgId, analysis.id],
      )
      const edits = latest ? JSON.parse(String(latest['edits_json'])) as MapEdit[] : []
      return { analysis, versionId, original, edits }
    }
    app.get('/api/song-journey/links/:id/song-map', async (request, reply) => {
      const actor = await authorize(request)
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
      const loaded = await read(actor.orgId, id)
      if (!loaded) return reply.code(404).send({ error: 'Not enough information: no completed analysis for the selected song version.' })
      const mapped = applySongMapEdits(loaded.original, loaded.edits)
      return { ...songMapEvidence({
        status: loaded.analysis.status,
        engineVersion: loaded.analysis.engineVersion,
        bpm: loaded.analysis.bpm, bpmConfidence: loaded.analysis.bpmConfidence,
        key: loaded.analysis.key, keyConfidence: loaded.analysis.keyConfidence,
      }, mapped), analysisId: loaded.analysis.id, versionId: loaded.versionId, edits: loaded.edits }
    })
    app.post('/api/song-journey/links/:id/song-map', async (request, reply) => {
      const actor = await authorize(request)
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
      const { edits } = z.object({ edits: z.array(editSchema).max(200) }).parse(request.body)
      const loaded = await read(actor.orgId, id)
      if (!loaded) return reply.code(404).send({ error: 'Not enough information: no completed analysis.' })
      const updated = applySongMapEdits(loaded.original, edits)
      if (loaded.analysis.durationMs != null && updated.some(row => row.endMs > loaded.analysis.durationMs!))
        return reply.code(400).send({ error: 'Section boundary exceeds song length.' })
      await runtime.db.run(
        'INSERT INTO song_map_corrections (id, org_id, song_analysis_id, song_version_id, edits_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [`smc_${runtime.clock.now()}_${Math.random().toString(36).slice(2)}`, actor.orgId,
          loaded.analysis.id, loaded.versionId, JSON.stringify(edits), actor.userId, runtime.clock.isoNow()],
      )
      return { sections: updated, saved: true }
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
