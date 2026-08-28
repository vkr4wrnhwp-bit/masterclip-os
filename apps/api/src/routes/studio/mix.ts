import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { MASTER_DIRECTION_INFO, MASTER_DIRECTIONS, MIX_METRICS, TRANSLATION_TARGET_INFO, TRANSLATION_TARGETS } from '@masterclip/mix-analysis'
import { STUDIO_REFERENCE_RIGHTS_STATEMENT } from '@masterclip/studio-domain'
import { readUpload, parseBool } from '../audio/helpers.js'
import { requireStudio, signedUrlFor } from './helpers.js'

/** Mix Station, Mix Doctor, Reference DNA, Translation Lab and Ask the Room. */
export async function registerStudioMixRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const studio = runtime.studio

  /** The metric catalogue, so a client can label anything it is handed. */
  app.get('/api/studio/metrics', async (request) => {
    await requireStudio(runtime, request, 'studio.mix')
    return { metrics: MIX_METRICS, directions: MASTER_DIRECTION_INFO, translationTargets: TRANSLATION_TARGET_INFO }
  })

  app.get('/api/studio/projects/:id/mix', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.mix', { project: { id, permission: 'view' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    const query = z.object({ versionId: z.string().optional() }).parse(request.query ?? {})
    const versionId = query.versionId ?? project.currentVersionId
    if (!versionId) return { analysis: null, metrics: [], curves: [], issues: [], readiness: null }
    return studio.mix.report(actor, id, versionId)
  })

  /** Act on a Mix Doctor finding: HEAR / ADD NOTE / IGNORE / MARK FIXED / SEND. */
  app.post('/api/studio/projects/:id/issues/:issueId', async (request) => {
    const { id, issueId } = request.params as { id: string; issueId: string }
    const actor = await requireStudio(runtime, request, 'studio.mix_doctor', { project: { id, permission: 'comment' } })
    const body = z
      .object({
        action: z.enum(['ignore', 'mark_fixed', 'add_note', 'send_to_engineer', 'reopen']),
        assignedTo: z.string().max(64).nullable().optional(),
        category: z.enum(['mix', 'master', 'arrangement', 'vocal', 'production', 'technical', 'other']).optional(),
      })
      .parse(request.body)
    return studio.mix.actOnIssue({
      actor,
      issueId,
      action: body.action,
      assignedTo: body.assignedTo ?? null,
      ...(body.category ? { category: body.category } : {}),
    })
  })

  // ----- references ---------------------------------------------------------

  app.get('/api/studio/projects/:id/references', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.references', { project: { id, permission: 'view' } })
    return { references: await studio.repos.references.list(actor.orgId, id), rightsStatement: STUDIO_REFERENCE_RIGHTS_STATEMENT }
  })

  app.post('/api/studio/projects/:id/references', async (request) => {
    const { id } = request.params as { id: string }
    const pre = await requireStudio(runtime, request, 'studio.references', { project: { id, permission: 'upload' } })
    const current = await studio.repos.references.countForProject(pre.orgId, id)
    const actor = await requireStudio(runtime, request, 'studio.references', {
      project: { id, permission: 'upload' },
      usage: { limit: 'studio.max_references_per_project', current, what: 'reference' },
    })
    const { bytes, filename, fields } = await readUpload(request)
    return studio.mix.addReference({
      actor,
      projectId: id,
      bytes,
      filename,
      label: fields.label ?? filename,
      artistName: fields.artistName ?? 'Unknown',
      title: fields.title ?? filename,
      rightsBasis: (fields.rightsBasis as 'owned' | 'licensed' | 'authorized_private_reference') ?? 'authorized_private_reference',
      rightsConfirmed: parseBool(fields.rightsConfirmed),
    })
  })

  app.delete('/api/studio/projects/:id/references/:referenceId', async (request) => {
    const { id, referenceId } = request.params as { id: string; referenceId: string }
    const actor = await requireStudio(runtime, request, 'studio.references', { project: { id, permission: 'upload' } })
    await studio.repos.references.delete(actor.orgId, referenceId)
    return { ok: true }
  })

  /** YOUR RECORD VS YOUR REFERENCES. */
  app.get('/api/studio/projects/:id/reference-comparison', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.references', { project: { id, permission: 'view' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    const query = z.object({ versionId: z.string().optional() }).parse(request.query ?? {})
    const versionId = query.versionId ?? project.currentVersionId
    if (!versionId) return { references: [], comparison: null }
    return studio.mix.referenceComparison(actor, id, versionId)
  })

  // ----- translation lab ----------------------------------------------------

  app.get('/api/studio/projects/:id/translation', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.translation_lab', { project: { id, permission: 'view' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    const query = z.object({ versionId: z.string().optional(), targets: z.string().optional() }).parse(request.query ?? {})
    const versionId = query.versionId ?? project.currentVersionId
    if (!versionId) return { analysisId: null, estimates: [] }
    const targets = query.targets
      ? query.targets.split(',').filter((target): target is (typeof TRANSLATION_TARGETS)[number] => (TRANSLATION_TARGETS as readonly string[]).includes(target))
      : undefined
    return studio.mix.translation(actor, versionId, targets)
  })

  // ----- ask the room -------------------------------------------------------

  app.post('/api/studio/projects/:id/ask', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.ask_the_room', { project: { id, permission: 'view' } })
    const body = z.object({ question: z.string().min(1).max(1000), versionId: z.string().optional() }).parse(request.body)
    return { exchange: await studio.room.ask({ actor, projectId: id, versionId: body.versionId ?? null, question: body.question }) }
  })

  app.get('/api/studio/projects/:id/ask', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.ask_the_room', { project: { id, permission: 'view' } })
    return { exchanges: await studio.room.history(actor, id) }
  })

  // ----- master station -----------------------------------------------------

  app.get('/api/studio/projects/:id/master', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.master', { project: { id, permission: 'view' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    const query = z.object({ versionId: z.string().optional() }).parse(request.query ?? {})
    const versionId = query.versionId ?? project.approvedMixVersionId ?? project.currentVersionId
    if (!versionId) return { comparison: null, directions: MASTER_DIRECTION_INFO }

    const comparison = await studio.master.comparison(actor, id, versionId)
    return {
      directions: MASTER_DIRECTION_INFO,
      comparison: {
        ...comparison,
        original: { ...comparison.original, url: await signedUrlFor(runtime, actor.orgId, comparison.original.version.assetId) },
        renditions: await Promise.all(
          comparison.renditions.map(async (entry) => ({ ...entry, url: await signedUrlFor(runtime, actor.orgId, entry.rendition.outputAssetId) })),
        ),
      },
    }
  })

  app.post('/api/studio/projects/:id/master', async (request) => {
    const { id } = request.params as { id: string }
    const pre = await requireStudio(runtime, request, 'studio.master', { project: { id, permission: 'upload' } })
    const current = await studio.repos.renditions.countForProject(pre.orgId, id)
    const actor = await requireStudio(runtime, request, 'studio.master', {
      project: { id, permission: 'upload' },
      usage: { limit: 'studio.max_renditions_per_project', current, what: 'master rendition' },
    })
    const body = z
      .object({
        versionId: z.string().min(1),
        direction: z.enum(MASTER_DIRECTIONS),
        slot: z.enum(['a', 'b', 'c']).optional(),
        priorities: z
          .object({
            targetLufs: z.number().min(-30).max(-3).optional(),
            targetTruePeakDbtp: z.number().min(-6).max(0).optional(),
            lowShelfDb: z.number().min(-6).max(6).optional(),
            presenceDb: z.number().min(-6).max(6).optional(),
            airDb: z.number().min(-6).max(6).optional(),
            drive: z.number().min(0).max(1).optional(),
            maxGainReductionDb: z.number().min(0).max(12).optional(),
            preserveMixCharacter: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(request.body)

    return studio.master.requestRendition({
      actor,
      projectId: id,
      versionId: body.versionId,
      direction: body.direction,
      ...(body.priorities ? { priorities: body.priorities } : {}),
      ...(body.slot ? { slot: body.slot } : {}),
    })
  })

  /** Choose a rendition. Choosing is not approving — that is a separate act. */
  app.post('/api/studio/projects/:id/master/:renditionId/choose', async (request) => {
    const { id, renditionId } = request.params as { id: string; renditionId: string }
    const actor = await requireStudio(runtime, request, 'studio.master', { project: { id, permission: 'upload' } })
    return studio.master.chooseRendition(actor, id, renditionId)
  })
}
