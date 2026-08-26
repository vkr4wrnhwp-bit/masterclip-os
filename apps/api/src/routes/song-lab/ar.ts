import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { AR_RATINGS, AR_RECOMMENDATIONS } from '@masterclip/song-lab-domain'
import { requireSongLab, requireSongLabFlagship } from './helpers.js'

/**
 * Internal A&R and the integration handoffs.
 *
 * Every A&R route runs `requireArView` in addition to the normal gate. An
 * artist user reaching these paths gets a 403 whether or not the capability
 * string was guessed correctly, because the check is on the capability, not on
 * the route name.
 */
export async function registerSongLabArRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const songLab = runtime.songLab

  app.get('/api/song-lab/projects/:id/ar', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    await songLab.access.requireArView(actor)
    const { id } = request.params as { id: string }
    return {
      review: await songLab.ar.latest(actor, id),
      history: await songLab.ar.history(actor, id),
      ratings: AR_RATINGS,
      recommendations: AR_RECOMMENDATIONS,
    }
  })

  /** Drafts an assessment from evidence. A draft is not a decision. */
  app.post('/api/song-lab/projects/:id/ar/draft', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    await songLab.access.requireArView(actor)
    const { id } = request.params as { id: string }
    return { review: await songLab.ar.draft({ actor, projectId: id }) }
  })

  app.patch('/api/song-lab/ar-reviews/:id', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    await songLab.access.requireArView(actor)
    const { id } = request.params as { id: string }
    const rating = z.enum(AR_RATINGS)
    const body = z
      .object({
        structureRating: rating.optional(),
        hookRating: rating.optional(),
        earlyPayoffRating: rating.optional(),
        arrangementContrastRating: rating.optional(),
        vocalMemorabilityRating: rating.optional(),
        streamingFitRating: rating.optional(),
        livePotentialRating: rating.optional(),
        syncPotentialRating: rating.optional(),
        recommendation: z.enum(AR_RECOMMENDATIONS).optional(),
        why: z.string().max(4000).optional(),
      })
      .parse(request.body ?? {})
    return { review: await songLab.ar.override(actor, id, body) }
  })

  /**
   * Human approval.
   *
   * Requires admin, and stamps the approving user. This is the only route in
   * Song Lab that can move a review out of `draft`, and it cannot be reached
   * by a job.
   */
  app.post('/api/song-lab/ar-reviews/:id/approve', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access', { minimumRole: 'admin' })
    await songLab.access.requireArView(actor)
    const { id } = request.params as { id: string }
    return { review: await songLab.ar.approve(actor, id) }
  })

  // ----- integrations -------------------------------------------------------

  app.get('/api/song-lab/projects/:id/handoffs', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    return { handoffs: await songLab.integrations.list(actor, id) }
  })

  app.post('/api/song-lab/projects/:id/send-to-remix-lab', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    // Remix Lab has its own entitlement; Song Lab cannot grant access to it.
    await runtime.audio.access.authorize({ capability: 'audio.remix_lab', actor })
    const { id } = request.params as { id: string }
    const body = z.object({ remixLane: z.string().max(40).optional(), targetUse: z.string().max(60).optional() }).parse(request.body ?? {})
    return { handoff: await songLab.integrations.sendToRemixLab(actor, id, body) }
  })

  app.post('/api/song-lab/projects/:id/send-to-live-lab', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    await runtime.entitlements.require(actor.orgId, 'live_lab.access')
    const { id } = request.params as { id: string }
    return { handoff: await songLab.integrations.sendToLiveLab(actor, id) }
  })

  app.post('/api/song-lab/projects/:id/send-to-release-command', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    return { handoff: await songLab.integrations.sendToReleaseCommand(actor, id) }
  })

  app.post('/api/song-lab/projects/:id/attach-operator-desk', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    // Operator Desk has its own entitlement, like every other handoff target.
    // Writing a note into the CRM is an Operator Desk action that happens to
    // start in Song Lab; holding Song Lab is not a licence to write there.
    await runtime.audio.access.authorize({ capability: 'audio.operator_agent', actor })
    const { id } = request.params as { id: string }
    const body = z.object({ leadId: z.string().min(1), note: z.string().max(2000).optional() }).parse(request.body)
    return { handoff: await songLab.integrations.attachToOperatorDesk(actor, id, body.leadId, body.note) }
  })

  // ----- closed loop --------------------------------------------------------

  app.get('/api/song-lab/projects/:id/outcomes', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    return { outcomes: await songLab.outcomes.listForProject(actor, id) }
  })

  app.post('/api/song-lab/outcomes/:id', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    const body = z
      .object({
        outcomeWindow: z.string().min(1).max(40),
        metrics: z.record(z.string(), z.number()),
        releaseId: z.string().max(64).optional(),
        releasedAt: z.string().max(40).optional(),
      })
      .parse(request.body)
    if (body.releaseId && body.releasedAt) await songLab.outcomes.markReleased(actor, id, body.releaseId, body.releasedAt)
    return {
      outcome: await songLab.outcomes.attachOutcome({
        actor,
        outcomeId: id,
        outcomeWindow: body.outcomeWindow,
        metrics: body.metrics,
      }),
    }
  })

  /**
   * Cross-roster recommendation analytics. Flagship only — this is Street
   * Banker's own learning about its own portfolio, not a partner's.
   */
  app.get('/api/song-lab/analytics/recommendations', async (request) => {
    const actor = await requireSongLabFlagship(runtime, request)
    return {
      summary: await songLab.outcomes.recommendationSummary(actor),
      note:
        'Counts, and medians split by whether the recommendation was implemented. A metric with a null value did not have enough released songs behind it to report. Association only — songs whose artists took a note differ from songs whose artists did not in ways this data does not measure, so a difference between the groups cannot establish that the change caused the outcome.',
    }
  })
}
