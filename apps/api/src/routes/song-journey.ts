import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { forbidden } from '@masterclip/shared'
import { compareToReferences, type MixMetric } from '@masterclip/mix-analysis'
import { SongJourneyService, proposeLevelMatch } from '@masterclip/song-journey-engine'
import { measureSongVersion, verifiedSongAudio } from './song-journey-loudness.js'
import { SongLabProjectRepo, SongVersionRepo, SongAnalysisRepo, SongSectionRepo, SongMapCorrectionRepo } from '@masterclip/song-lab-domain'
import { applySongMapEdits, songMapEvidence, type MapEdit } from '@masterclip/song-lab-engine'
import { StudioProjectRepo, StudioVersionRepo } from '@masterclip/studio-domain'
import { requireSongLab } from './song-lab/helpers.js'
import { requireStudio } from './studio/helpers.js'
import { songMapSaveSchema } from './song-map-validation.js'

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

  // The link's Studio permission matters even inside one organization.
  // Song Lab analysis access alone cannot reveal a collaborator's Studio approval.
  const authorizeLink = async (request: Parameters<typeof requireSongLab>[1], id: string) => {
    const actor = await authorize(request)
    const link = await journey.links.get(actor.orgId, id)
    await requireStudio(runtime, request, 'studio.access', {
      project: { id: link.studioProjectId, permission: 'view' },
    })
    return actor
  }

  if (runtime.config.SONG_LAB_SUITE_FEATURE_VERSION_COMPARE) {
    const params = z.object({ id: z.string().min(1).max(128) })
    const pairQuery = z.object({
      left: z.string().min(1).max(128),
      right: z.string().min(1).max(128),
    })
    app.get('/api/song-journey/links/:id/version-pair', async (request, reply) => {
      void reply.header('cache-control', 'no-store')
      const { id } = params.parse(request.params)
      const actor = await authorizeLink(request, id)
      const { left, right } = pairQuery.parse(request.query)
      return journey.compareSongVersions(actor.orgId, id, left, right)
    })

    app.get('/api/song-journey/links/:id/version-pair-loudness', async (request, reply) => {
      void reply.header('cache-control', 'no-store')
      const { id } = params.parse(request.params)
      const actor = await authorizeLink(request, id)
      const { left, right } = pairQuery.parse(request.query)
      const pair = await journey.compareSongVersions(actor.orgId, id, left, right)
      // Do not measure two versions pointing to the same source or expose an
      // unverified signed URL. A real click is required before any work occurs.
      const a = !pair.sameAsset && pair.left.sourceAssetId
        ? await measureSongVersion(runtime, actor.orgId, pair.left.songLabProjectId, pair.left.sourceAssetId)
        : null
      const b = !pair.sameAsset && pair.right.sourceAssetId
        ? await measureSongVersion(runtime, actor.orgId, pair.right.songLabProjectId, pair.right.sourceAssetId)
        : null
      const proposal = a && b ? proposeLevelMatch(a, b)
        : { available: false as const, reason: 'Both exact song versions need accessible, verified audio files under the measurement limit.' }
      return {
        leftVersionId: pair.left.id, rightVersionId: pair.right.id,
        state: a && b && proposal.available ? 'ready' : 'unavailable',
        measurements: a && b ? {
          left: { ...a, audioUrl: `/api/song-journey/links/${encodeURIComponent(id)}/version-audio/${encodeURIComponent(pair.left.id)}` },
          right: { ...b, audioUrl: `/api/song-journey/links/${encodeURIComponent(id)}/version-audio/${encodeURIComponent(pair.right.id)}` },
          method: a.method,
        } : null,
        proposal, playbackVerified: false,
        note: proposal.available
          ? (proposal.limited
            ? 'Only part of the level difference can be matched within the safe 6 dB limit. The source files remain untouched.'
            : 'The playback controls apply measured, safe attenuation only. Device output is not a certified true-peak measurement.')
          : proposal.reason,
      }
    })

    // Same-origin, cookie-authorized original bytes for iPhone Web Audio gain.
    // Do not publish a permanent URL, change the audio, or bypass Song Lab
    // project ownership. Byte ranges keep native audio seeking available.
    app.get('/api/song-journey/links/:id/version-audio/:versionId', async (request, reply) => {
      void reply.header('cache-control', 'private, no-store')
      void reply.header('x-content-type-options', 'nosniff')
      const { id, versionId } = z.object({
        id: z.string().min(1).max(128), versionId: z.string().min(1).max(128),
      }).parse(request.params)
      const actor = await authorizeLink(request, id)
      const link = await journey.links.get(actor.orgId, id)
      const version = await songVersions.get(actor.orgId, versionId)
      if (version.songLabProjectId !== link.songLabProjectId || !version.sourceAssetId) {
        return reply.code(404).send({ error: 'Version audio not available' })
      }
      const verified = await verifiedSongAudio(runtime, actor.orgId, link.songLabProjectId, version.sourceAssetId)
      if (!verified) return reply.code(404).send({ error: 'Version audio not available' })
      const { asset, bytes } = verified
      if (!asset.mimeType.startsWith('audio/') && asset.mimeType !== 'video/mp4') {
        return reply.code(415).send({ error: 'Audio file type unavailable' })
      }
      void reply.header('content-type', asset.mimeType)
      void reply.header('accept-ranges', 'bytes')
      const raw = request.headers.range
      if (raw) {
        const match = /^bytes=(\\d+)-(\\d*)$/.exec(raw)
        const start = match ? Number(match[1]) : -1
        const end = match && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
            start < 0 || start >= bytes.length || end < start) {
          return reply.code(416).header('content-range', `bytes */${bytes.length}`).send()
        }
        void reply.header('content-range', `bytes ${start}-${end}/${bytes.length}`)
        return reply.code(206).send(Buffer.from(bytes.subarray(start, end + 1)))
      }
      return reply.send(Buffer.from(bytes))
    })

    app.get('/api/song-journey/links/:id/final-approval', async (request, reply) => {
      void reply.header('cache-control', 'no-store')
      const { id } = params.parse(request.params)
      const actor = await authorizeLink(request, id)
      return journey.finalApproval(actor.orgId, id)
    })
  }

  if (runtime.config.SONG_LAB_SUITE_FEATURE_SONG_MAP) {
    const analyses = new SongAnalysisRepo(runtime.db, runtime.clock)
    const sections = new SongSectionRepo(runtime.db, runtime.clock)
    const corrections = new SongMapCorrectionRepo(runtime.db, runtime.clock)
    const read = async (orgId: string, linkId: string) => {
      const link = await journey.links.get(orgId, linkId)
      const versionId = link.selectedSongVersionId
      if (!versionId) return null
      const analysis = await analyses.latestForVersion(orgId, versionId)
        ?? (await analyses.listForProject(orgId, link.songLabProjectId)).find(item => item.songVersionId === versionId)
      if (!analysis) return null
      const raw = await sections.list(orgId, analysis.id)
      const features = await sections.features(orgId, analysis.id)
      const original = raw.map(row => ({ id: row.id, label: row.label, startMs: row.startMs,
        endMs: row.endMs, confidence: row.confidence }))
      const latest = await corrections.latest(orgId, analysis.id)
      const edits = (latest?.edits ?? []) as MapEdit[]
      return { analysis, versionId, original, edits, raw, features }
    }
    app.get('/api/song-journey/links/:id/song-map', async (request, reply) => {
      const actor = await authorize(request)
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
      const loaded = await read(actor.orgId, id)
      if (!loaded) return { ...songMapEvidence(null, []), analysisId: null, versionId: null, edits: [] }
      const mapped = applySongMapEdits(loaded.original, loaded.edits)
      return { ...songMapEvidence({
        status: loaded.analysis.status,
        analysisVersion: loaded.analysis.analysisVersion,
        engineVersion: loaded.analysis.engineVersion,
        bpm: loaded.analysis.bpm, bpmConfidence: loaded.analysis.bpmConfidence,
        key: loaded.analysis.key, keyConfidence: loaded.analysis.keyConfidence,
      }, mapped, loaded.raw.map(section => ({
        id: section.id, label: section.label, sectionType: section.sectionType,
        energy: loaded.features.get(section.id)?.energy ?? null,
      }))), analysisId: loaded.analysis.id, versionId: loaded.versionId, edits: loaded.edits }
    })
    app.post('/api/song-journey/links/:id/song-map', async (request, reply) => {
      const actor = await authorize(request)
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
      const { edits } = songMapSaveSchema.parse(request.body)
      const loaded = await read(actor.orgId, id)
      if (!loaded || loaded.analysis.status !== 'complete') return reply.code(400).send({ error: 'Not enough information: no completed analysis to correct.' })
      const updated = applySongMapEdits(loaded.original, edits)
      if (loaded.analysis.durationMs != null && updated.some(row => row.endMs > loaded.analysis.durationMs!))
        return reply.code(400).send({ error: 'Section boundary exceeds song length.' })
      await corrections.save({orgId: actor.orgId, analysisId: loaded.analysis.id,
        versionId: loaded.versionId, edits, actorId: actor.userId})
      return { sections: updated, saved: true }
    })
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
      const currentLink = await journey.links.get(actor.orgId, id)
      const options = await journey.links.list(actor.orgId)
      const candidates = []
      for (const link of options) {
        if (link.id === id || link.songLabProjectId === currentLink.songLabProjectId || !link.selectedStudioVersionId) continue
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
      if (current.id === reference.id || current.songLabProjectId === reference.songLabProjectId || !current.selectedStudioVersionId || !reference.selectedStudioVersionId)
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
      const broadKeys = new Set(['low_energy_pct', 'low_mid_energy_pct', 'mid_energy_pct',
        'high_mid_energy_pct', 'high_energy_pct', 'integrated_lufs', 'stereo_width'])
      result.rows = result.rows.filter(row => broadKeys.has(row.metricKey))
      const mismatch = mine.analysis['analyzer_set_version'] !== theirs.analysis['analyzer_set_version']
        || mine.analysis['sample_rate'] !== theirs.analysis['sample_rate']
      return {
        state: 'ready', title: refSong.title, ...result,
        warning: mismatch ? 'These were measured differently, so small differences may not be real.' : '',
        provenance: {
          current: { analysisId: mine.analysis['id'], versionId: current.selectedStudioVersionId,
            sourceFile: mine.analysis['source_file_name'] ?? 'Filename not recorded', analyzerVersion: mine.analysis['analyzer_set_version'],
            sampleRate: mine.analysis['sample_rate'], measuredAt: mine.analysis['created_at'] },
          reference: { analysisId: theirs.analysis['id'], versionId: reference.selectedStudioVersionId,
            sourceFile: theirs.analysis['source_file_name'] ?? 'Filename not recorded', analyzerVersion: theirs.analysis['analyzer_set_version'],
            sampleRate: theirs.analysis['sample_rate'], measuredAt: theirs.analysis['created_at'] },
        },
      }
    })
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
        'INSERT INTO song_translation_notes (id, org_id, studio_version_id, device, checked, note, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, studio_version_id, device) DO UPDATE SET checked = excluded.checked, note = excluded.note, updated_at = excluded.updated_at',
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
