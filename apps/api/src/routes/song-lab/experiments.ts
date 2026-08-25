import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { EXPERIMENT_EDIT_TYPES } from '@masterclip/audio-experiments'
import { requireSongLab } from './helpers.js'
import { signedUrlFor } from './projects.js'

/** Experiments, previews, A/B playback and acceptance. */
export async function registerSongLabExperimentRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const songLab = runtime.songLab

  app.get('/api/song-lab/projects/:id/experiments', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.experiments')
    const { id } = request.params as { id: string }
    const experiments = await songLab.repos.experiments.list(actor.orgId, id)
    const withUrls = await Promise.all(
      experiments.map(async (experiment) => ({
        ...experiment,
        previewUrl: experiment.previewAssetId ? await signedUrlFor(runtime, actor.orgId, experiment.previewAssetId) : null,
      })),
    )

    // The original is always offered alongside the experiments, so A/B is one
    // click and "go back" is never more than that.
    const project = await songLab.repos.projects.get(actor.orgId, id)
    const versions = await songLab.repos.versions.list(actor.orgId, id)
    const original = versions.find((version) => version.versionType === 'original_upload') ?? versions[0] ?? null
    return {
      experiments: withUrls,
      original: original
        ? { ...original, url: original.sourceAssetId ? await signedUrlFor(runtime, actor.orgId, original.sourceAssetId) : null }
        : null,
      currentVersionId: project.currentVersionId,
    }
  })

  app.post('/api/song-lab/projects/:id/experiments', async (request) => {
    const { id } = request.params as { id: string }
    const current = await runtime.songLab.repos.experiments.countForProject(
      (await requireSongLab(runtime, request, 'song_lab.experiments')).orgId,
      id,
    )
    const actor = await requireSongLab(runtime, request, 'song_lab.experiments', {
      usage: { limit: 'song_lab.max_experiments_per_project', current, what: 'experiment' },
    })

    const body = z
      .object({
        experimentType: z.enum(['earlier_chorus', 'shorter_intro', 'section_cut', 'section_duplicate', 'tempo', 'alternate_outro', 'custom']),
        name: z.string().max(120).optional(),
        /** Seconds for cut/intro experiments; target BPM for tempo. */
        amount: z.number().optional(),
        sectionOrderIndex: z.number().int().min(0).optional(),
        repeatFinalHook: z.boolean().optional(),
        recommendationId: z.string().optional(),
        intent: z.string().max(500).optional(),
        editDecisionList: z
          .array(
            z.object({
              type: z.enum(EXPERIMENT_EDIT_TYPES),
              sourceStartMs: z.number().int().min(0).optional(),
              sourceEndMs: z.number().int().min(0).optional(),
              destinationMs: z.number().int().min(0).optional(),
              value: z.number().optional(),
              stem: z.string().max(40).optional(),
              note: z.string().max(200).optional(),
            }),
          )
          .optional(),
        /** Render the preview straight away. */
        render: z.boolean().default(true),
      })
      .parse(request.body)

    const experiment = body.recommendationId
      ? await songLab.experiments.createFromRecommendation(actor, id, body.recommendationId)
      : await songLab.experiments.createExperiment({
          actor,
          projectId: id,
          experimentType: body.experimentType,
          ...(body.name ? { name: body.name } : {}),
          ...(body.amount !== undefined ? { amount: body.amount } : {}),
          ...(body.sectionOrderIndex !== undefined ? { sectionOrderIndex: body.sectionOrderIndex } : {}),
          ...(body.repeatFinalHook !== undefined ? { repeatFinalHook: body.repeatFinalHook } : {}),
          ...(body.editDecisionList ? { editDecisionList: body.editDecisionList } : {}),
          ...(body.intent ? { intent: body.intent } : {}),
        })

    if (!experiment) {
      return {
        experiment: null,
        // A writing or arrangement note is a real recommendation; it just is
        // not one this engine can render as audio, and says so.
        message: 'This recommendation is a writing or arrangement note rather than an edit, so there is no audio experiment to render.',
      }
    }
    if (body.render) await songLab.experiments.queueRender(actor, experiment.id)
    return { experiment: await songLab.repos.experiments.get(actor.orgId, experiment.id) }
  })

  app.get('/api/song-lab/experiments/:id', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.experiments')
    const { id } = request.params as { id: string }
    const experiment = await songLab.repos.experiments.get(actor.orgId, id)
    return {
      experiment,
      previewUrl: experiment.previewAssetId ? await signedUrlFor(runtime, actor.orgId, experiment.previewAssetId) : null,
      sectionMapping: await songLab.experiments.sectionMapping(actor, id),
    }
  })

  app.post('/api/song-lab/experiments/:id/render', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.experiments')
    const { id } = request.params as { id: string }
    await songLab.experiments.queueRender(actor, id)
    return { ok: true, status: 'rendering' }
  })

  /** Accepting creates a new version. The source is never replaced. */
  app.post('/api/song-lab/experiments/:id/accept', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.experiments')
    const { id } = request.params as { id: string }
    const body = z.object({ versionLabel: z.string().max(120).optional() }).parse(request.body ?? {})
    const version = await songLab.experiments.accept(actor, id, body.versionLabel)
    return { version }
  })

  app.post('/api/song-lab/experiments/:id/reject', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.experiments')
    const { id } = request.params as { id: string }
    await songLab.experiments.reject(actor, id)
    return { ok: true }
  })
}
