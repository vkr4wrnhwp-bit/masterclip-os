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

  if (runtime.config.SONG_LAB_SUITE_FEATURE_TRANSLATION_NOTES) {
    const paramsSchema = z.object({
      id: z.string().min(1).max(128),
      versionId: z.string().min(1).max(128),
    })
    const recordFor = async (orgId: string, id: string, versionId: string) => {
      const link = await journey.links.get(orgId, id)
      const version = await runtime.db.get(
        'SELECT id FROM studio_versions WHERE org_id = ? AND id = ? AND studio_project_id = ?',
        [orgId, versionId, link.studioProjectId],
      )
      if (!version) return null
      return version
    }
    app.get('/api/song-journey/links/:id/versions/:versionId/translation-notes', async (request, reply) => {
      const actor = await authorize(request)
      const { id, versionId } = paramsSchema.parse(request.params)
      if (!await recordFor(actor.orgId, id, versionId)) return reply.code(404).send({ error: 'Version not found' })
      const notes = await runtime.db.query(
        'SELECT device, checked, note, updated_at FROM song_translation_notes WHERE org_id = ? AND studio_version_id = ?',
        [actor.orgId, versionId],
      )
      const measures = await runtime.db.query(
        `SELECT m.metric_key, m.value, m.unit, m.confidence, a.id AS analysis_id,
                a.analyzer_set_version, a.source_asset_id, aa.file_name AS source_file_name, a.created_at
           FROM studio_mix_metrics m JOIN studio_mix_analyses a ON a.id = m.analysis_id LEFT JOIN audio_assets aa ON aa.id = a.source_asset_id AND aa.org_id = a.org_id
          WHERE a.org_id = ? AND m.org_id = ? AND a.studio_version_id = ?
            AND a.status = 'ready' AND m.metric_key IN ('true_peak_dbtp', 'phase_correlation', 'mono_fold_loss_db', 'sub_energy_pct')
            AND a.id = (SELECT id FROM studio_mix_analyses WHERE org_id = ? AND studio_version_id = ? AND status = 'ready' ORDER BY created_at DESC, id DESC LIMIT 1)`,
        [actor.orgId, actor.orgId, versionId, actor.orgId, versionId],
      )
      return { versionId, notes, measures, meaning: 'These ticks are your notes, not a device test.' }
    })
    app.put('/api/song-journey/links/:id/versions/:versionId/translation-notes', async (request, reply) => {
      const actor = await authorize(request)
      const { id, versionId } = paramsSchema.parse(request.params)
      if (!await recordFor(actor.orgId, id, versionId)) return reply.code(404).send({ error: 'Version not found' })
      const body = z.object({ device: z.enum(['phone', 'headphones', 'car', 'mono']),
        checked: z.boolean(), note: z.string().max(500) }).parse(request.body)
      const now = runtime.clock.isoNow()
      await runtime.db.run(
        'INSERT INTO song_translation_notes (id, org_id, studio_version_id, device, checked, note, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, studio_version_id, device) DO UPDATE SET checked = excluded.checked, note = excluded.note, created_by = excluded.created_by, updated_at = excluded.updated_at',
        [`stn_${actor.orgId}_${versionId}_${body.device}`, actor.orgId, versionId, body.device, body.checked ? 1 : 0, body.note, actor.userId, now],
      )
      return { ok: true, versionId }
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
