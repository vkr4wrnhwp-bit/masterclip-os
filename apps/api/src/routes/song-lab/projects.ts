import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'
import { SONG_LAB_RIGHTS_STATEMENT } from '@masterclip/song-lab-engine'
import { SECTION_TYPES } from '@masterclip/song-analysis'
import { readUpload, parseBool } from '../audio/helpers.js'
import { requireSongLab } from './helpers.js'

/**
 * Which of an organization's audio Song Lab will offer for import.
 *
 * Songs, not everything the tenant owns. A meeting recording or a voice sample
 * is not a record to diagnose, and listing it here would hand a user holding
 * only `song_lab.analysis` a route to signed URLs for audio that belongs to
 * modules they may not be entitled to. Same tenant either way — this is a
 * cross-module seam, not a tenant boundary — but the narrow list is both the
 * safer and the more sensible product behaviour.
 */
const IMPORTABLE_PROJECT_TYPES = new Set(['song_lab', 'remix', 'library'])

/** Projects, audio intake, analysis, structure and versions. */
export async function registerSongLabProjectRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const songLab = runtime.songLab

  // ----- capabilities -------------------------------------------------------

  app.get('/api/song-lab/capabilities', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    return {
      capabilities: await songLab.access.capabilitiesFor(actor.orgId),
      flagship: await songLab.access.isFlagship(actor.orgId),
      rightsStatement: SONG_LAB_RIGHTS_STATEMENT,
      analysisProvider: runtime.config.SONG_LAB_ANALYSIS_PROVIDER,
    }
  })

  // ----- projects -----------------------------------------------------------

  app.get('/api/song-lab/projects', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    return { projects: await songLab.repos.projects.list(actor.orgId) }
  })

  app.post('/api/song-lab/projects', async (request) => {
    const current = await runtime.songLab.repos.projects.countForOrg((await requireSongLab(runtime, request, 'song_lab.access')).orgId)
    const actor = await requireSongLab(runtime, request, 'song_lab.access', {
      usage: { limit: 'song_lab.max_projects', current, what: 'Song Lab project' },
    })
    const body = z
      .object({
        title: z.string().min(1).max(200),
        artistName: z.string().min(1).max(200),
        artistId: z.string().max(64).optional(),
        genre: z.string().min(1).max(64),
        titlePhrase: z.string().max(200).optional(),
        notes: z.string().max(4000).optional(),
        rightsConfirmed: z.boolean(),
      })
      .parse(request.body)

    const project = await songLab.projects.create({
      actor,
      title: body.title,
      artistName: body.artistName,
      artistId: body.artistId ?? null,
      genre: body.genre,
      ...(body.titlePhrase !== undefined ? { titlePhrase: body.titlePhrase } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      rightsConfirmed: body.rightsConfirmed,
    })
    return { project }
  })

  app.get('/api/song-lab/projects/:id', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    const project = await songLab.repos.projects.get(actor.orgId, id)
    const versions = await songLab.repos.versions.list(actor.orgId, id)
    const analysis = project.currentVersionId ? await songLab.repos.analyses.latestForVersion(actor.orgId, project.currentVersionId) : null
    const sections = analysis ? await songLab.repos.sections.list(actor.orgId, analysis.id) : []
    const observations = await songLab.repos.observations.listForProject(actor.orgId, id)

    const currentVersion = versions.find((version) => version.id === project.currentVersionId)
    const audioUrl =
      currentVersion?.sourceAssetId !== undefined && currentVersion?.sourceAssetId !== null
        ? (await songLab.repos.projects.get(actor.orgId, id)) && (await signedUrlFor(runtime, actor.orgId, currentVersion.sourceAssetId))
        : null

    return {
      project,
      versions,
      analysis,
      sections,
      observations,
      audioUrl,
      timeline: songLab.views.timeline(sections),
      // Presented separately from the observation list so the overview can
      // lead with them without the UI inventing its own ranking.
      thingsWorthTesting: await songLab.benchmark.thingsWorthTesting(actor, id),
    }
  })

  app.patch('/api/song-lab/projects/:id', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        artistName: z.string().min(1).max(200).optional(),
        artistId: z.string().max(64).optional(),
        genre: z.string().min(1).max(64).optional(),
        titlePhrase: z.string().max(200).optional(),
        notes: z.string().max(4000).optional(),
      })
      .parse(request.body ?? {})
    return { project: await songLab.repos.projects.update(actor.orgId, id, body) }
  })

  app.delete('/api/song-lab/projects/:id', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    await songLab.repos.projects.delete(actor.orgId, id)
    return { ok: true }
  })

  // ----- audio intake -------------------------------------------------------

  app.post('/api/song-lab/projects/:id/upload', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const { id } = request.params as { id: string }
    const { bytes, filename, fields } = await readUpload(request)
    const result = await songLab.projects.attachUpload({
      actor,
      projectId: id,
      bytes,
      filename,
      rightsConfirmed: parseBool(fields.rightsConfirmed),
    })
    return result
  })

  /** Import an existing asset: a release, an unreleased project, a Remix Lab source. */
  app.post('/api/song-lab/projects/:id/import-release', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const { id } = request.params as { id: string }
    const body = z.object({ assetId: z.string().min(1), label: z.string().max(200).optional() }).parse(request.body)
    return songLab.projects.importAsset({ actor, projectId: id, assetId: body.assetId, ...(body.label ? { label: body.label } : {}) })
  })

  /** Audio the caller could import — their organization's, and only theirs. */
  app.get('/api/song-lab/importable', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const assets = await runtime.audio.repos.assets.list(actor.orgId, {}, 200)
    return {
      assets: assets
        .filter((asset) => IMPORTABLE_PROJECT_TYPES.has(asset.projectType))
        .filter((asset) => asset.assetType !== 'song_lab_experiment_preview')
        .map((asset) => ({
          id: asset.id,
          fileName: asset.fileName,
          projectType: asset.projectType,
          durationMs: asset.durationMs,
          createdAt: asset.createdAt,
        })),
    }
  })

  app.post('/api/song-lab/projects/:id/analyze', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const { id } = request.params as { id: string }
    return { analysisId: await songLab.projects.reanalyze(actor, id) }
  })

  /** Re-run with the current engine. The previous result is kept, not replaced. */
  app.post('/api/song-lab/projects/:id/reanalyze', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const { id } = request.params as { id: string }
    return { analysisId: await songLab.projects.reanalyze(actor, id) }
  })

  // ----- vocal stem ---------------------------------------------------------

  /**
   * Separates the lead vocal so vocal metrics measure the voice rather than a
   * spectral guess at where the voice is.
   *
   * Gated on `audio.stem_separation` as well as Song Lab: separation is an
   * Audio Intelligence capability that costs provider spend, and holding Song
   * Lab is not a licence to spend it. Starting the action here does not change
   * whose capability it is.
   */
  app.post('/api/song-lab/projects/:id/versions/:versionId/vocal-stem', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    await runtime.audio.access.authorize({ capability: 'audio.stem_separation', actor })
    const { id, versionId } = request.params as { id: string; versionId: string }
    return { vocalStem: await songLab.vocalStems.request(actor, id, versionId) }
  })

  /** Separation attempts for a project, newest first. */
  app.get('/api/song-lab/projects/:id/vocal-stems', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    return { vocalStems: await songLab.repos.vocalStems.list(actor.orgId, id) }
  })

  // ----- structure ----------------------------------------------------------

  app.get('/api/song-lab/projects/:id/structure', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.structure')
    const { id } = request.params as { id: string }
    const analysis = await currentAnalysis(runtime, actor.orgId, id)
    const result = await songLab.views.structure(actor, analysis.id)
    return { analysisId: analysis.id, ...result, timeline: songLab.views.timeline(result.sections) }
  })

  app.patch('/api/song-lab/projects/:id/structure', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.structure')
    const { id } = request.params as { id: string }
    const analysis = await currentAnalysis(runtime, actor.orgId, id)
    const body = z
      .object({
        corrections: z
          .array(
            z.object({
              id: z.string().min(1),
              sectionType: z.enum(SECTION_TYPES).optional(),
              label: z.string().min(1).max(80).optional(),
              startMs: z.number().int().min(0).optional(),
              endMs: z.number().int().min(1).optional(),
              isHook: z.boolean().optional(),
              isTitlePhrase: z.boolean().optional(),
              deleted: z.boolean().optional(),
            }),
          )
          .default([]),
        added: z
          .array(
            z.object({
              sectionType: z.enum(SECTION_TYPES),
              label: z.string().min(1).max(80),
              startMs: z.number().int().min(0),
              endMs: z.number().int().min(1),
            }),
          )
          .default([]),
      })
      .parse(request.body ?? {})

    if (body.corrections.length > 0) await songLab.repos.sections.applyCorrections(actor.orgId, analysis.id, body.corrections)
    for (const section of body.added) await songLab.repos.sections.addSection(actor.orgId, analysis.id, section)

    // A correction changes the answer to every structural question, so the
    // vector is rebuilt immediately rather than at the next analysis.
    const result = await songLab.analysis.recomputeAfterCorrection(actor, analysis.id)
    return { analysisId: analysis.id, sections: result.sections, metrics: result.metrics, timeline: songLab.views.timeline(result.sections) }
  })

  // ----- views --------------------------------------------------------------

  app.get('/api/song-lab/projects/:id/energy', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const { id } = request.params as { id: string }
    const analysis = await currentAnalysis(runtime, actor.orgId, id)
    return songLab.views.energy(actor, analysis.id)
  })

  app.get('/api/song-lab/projects/:id/arrangement', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const { id } = request.params as { id: string }
    const analysis = await currentAnalysis(runtime, actor.orgId, id)
    return songLab.views.arrangement(actor, analysis.id)
  })

  app.get('/api/song-lab/projects/:id/hook', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.hook')
    const { id } = request.params as { id: string }
    return { profile: await songLab.views.hookProfile(actor, id) }
  })

  app.get('/api/song-lab/projects/:id/tempo', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const { id } = request.params as { id: string }
    const project = await songLab.repos.projects.get(actor.orgId, id)
    const analysis = await currentAnalysis(runtime, actor.orgId, id)
    const results = project.selectedBenchmarkCohortId
      ? await songLab.repos.benchmarkResults.list(actor.orgId, analysis.id, project.selectedBenchmarkCohortId)
      : []
    const tempo = results.find((result) => result.metricKey === 'bpm') ?? null
    return {
      bpm: analysis.bpm,
      bpmConfidence: analysis.bpmConfidence,
      tempoStability: analysis.tempoStability,
      meter: analysis.meter,
      benchmark: tempo,
      // Offered as options to hear, with no claim that any of them is better.
      suggestions: analysis.bpm ? [2, 4, 6].map((delta) => ({ delta, bpm: Math.round((analysis.bpm ?? 0) + delta) })) : [],
    }
  })

  app.get('/api/song-lab/projects/:id/producer', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.producer_view')
    const { id } = request.params as { id: string }
    const analysis = await currentAnalysis(runtime, actor.orgId, id)
    return songLab.views.producerView(actor, analysis.id)
  })

  // ----- versions -----------------------------------------------------------

  app.get('/api/song-lab/projects/:id/versions', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    const versions = await songLab.repos.versions.list(actor.orgId, id)
    const withUrls = await Promise.all(
      versions.map(async (version) => ({
        ...version,
        url: version.sourceAssetId ? await signedUrlFor(runtime, actor.orgId, version.sourceAssetId) : null,
      })),
    )
    return { versions: withUrls }
  })

  /** Side-by-side comparison of any two versions in the same project. */
  app.get('/api/song-lab/projects/:id/versions/compare', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    const query = z.object({ a: z.string().min(1), b: z.string().min(1) }).parse(request.query)

    const load = async (versionId: string) => {
      const version = await songLab.repos.versions.get(actor.orgId, versionId)
      if (version.songLabProjectId !== id) {
        throw new AppError({ kind: 'validation', code: 'song_lab.version_mismatch', message: 'that version belongs to a different project' })
      }
      const analysis = await songLab.repos.analyses.latestForVersion(actor.orgId, version.id)
      const sections = analysis ? await songLab.repos.sections.list(actor.orgId, analysis.id) : []
      return {
        version,
        analysis,
        sections,
        url: version.sourceAssetId ? await signedUrlFor(runtime, actor.orgId, version.sourceAssetId) : null,
        lineage: await songLab.repos.versions.lineage(actor.orgId, version.id),
      }
    }

    return { a: await load(query.a), b: await load(query.b) }
  })

  app.post('/api/song-lab/projects/:id/review-complete', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    await songLab.repos.projects.markReviewComplete(actor.orgId, id)
    return { project: await songLab.repos.projects.get(actor.orgId, id) }
  })
}

/** The analysis for the project's current version, or a clear refusal. */
export async function currentAnalysis(runtime: Runtime, orgId: string, projectId: string) {
  const project = await runtime.songLab.repos.projects.get(orgId, projectId)
  if (!project.currentVersionId) {
    throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'this project has no audio yet' })
  }
  const analysis = await runtime.songLab.repos.analyses.latestForVersion(orgId, project.currentVersionId)
  if (!analysis) {
    throw new AppError({ kind: 'validation', code: 'song_lab.not_analyzed', message: 'this song has not finished analysis yet' })
  }
  return analysis
}

/** Signed, expiring URL. Audio is never served from a permanent path. */
export async function signedUrlFor(runtime: Runtime, orgId: string, assetId: string): Promise<string | null> {
  try {
    const { url } = await runtime.audio.assets.signedUrl(orgId, assetId)
    return url
  } catch {
    // A retention sweep may have removed a preview. A missing URL is not an
    // error for the page around it.
    return null
  }
}
