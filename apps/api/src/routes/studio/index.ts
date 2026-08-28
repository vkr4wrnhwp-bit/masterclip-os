import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { requireStudio } from './helpers.js'
import { registerStudioProjectRoutes } from './projects.js'
import { registerStudioMixRoutes } from './mix.js'
import { registerStudioWorkflowRoutes } from './workflow.js'

export async function registerStudioRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  await registerStudioProjectRoutes(app, runtime)
  await registerStudioMixRoutes(app, runtime)
  await registerStudioWorkflowRoutes(app, runtime)
  await registerStudioAlbumRoutes(app, runtime)
  await registerStudioLicensingRoutes(app, runtime)
}

/** Project-level (album) mastering. */
async function registerStudioAlbumRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const studio = runtime.studio

  app.get('/api/studio/albums', async (request) => {
    const actor = await requireStudio(runtime, request, 'studio.master_album')
    return { albums: await studio.repos.albums.list(actor.orgId) }
  })

  app.post('/api/studio/albums', async (request) => {
    const actor = await requireStudio(runtime, request, 'studio.master_album')
    const body = z
      .object({ title: z.string().min(1).max(200), artistName: z.string().min(1).max(200), gapDefaultMs: z.number().int().min(0).max(30_000).optional() })
      .parse(request.body)
    return { album: await studio.master.createAlbum(actor, body) }
  })

  app.get('/api/studio/albums/:albumId', async (request) => {
    const { albumId } = request.params as { albumId: string }
    const actor = await requireStudio(runtime, request, 'studio.master_album')
    return studio.master.assessAlbum(actor, albumId)
  })

  app.post('/api/studio/albums/:albumId/tracks', async (request) => {
    const { albumId } = request.params as { albumId: string }
    const actor = await requireStudio(runtime, request, 'studio.master_album')
    const body = z.object({ studioProjectId: z.string().min(1), studioVersionId: z.string().optional(), gapMs: z.number().int().min(0).max(30_000).optional() }).parse(request.body)
    // The project is fetched through the org-scoped repo, which is what refuses
    // an album built from another tenant's records.
    await studio.repos.projects.get(actor.orgId, body.studioProjectId)
    return {
      track: await studio.repos.albums.addTrack({
        orgId: actor.orgId,
        albumId,
        studioProjectId: body.studioProjectId,
        studioVersionId: body.studioVersionId ?? null,
        ...(body.gapMs !== undefined ? { gapMs: body.gapMs } : {}),
      }),
    }
  })

  app.put('/api/studio/albums/:albumId/order', async (request) => {
    const { albumId } = request.params as { albumId: string }
    const actor = await requireStudio(runtime, request, 'studio.master_album')
    const body = z.object({ trackIds: z.array(z.string().min(1)) }).parse(request.body)
    await studio.repos.albums.reorder(actor.orgId, albumId, body.trackIds)
    return studio.master.assessAlbum(actor, albumId)
  })

  app.delete('/api/studio/albums/:albumId/tracks/:trackId', async (request) => {
    const { trackId } = request.params as { albumId: string; trackId: string }
    const actor = await requireStudio(runtime, request, 'studio.master_album')
    await studio.repos.albums.removeTrack(actor.orgId, trackId)
    return { ok: true }
  })
}

/**
 * The agent-to-agent licensing boundary.
 *
 * Org-scoped like everything else, and it stops at `awaiting_human` by
 * construction — see `StudioRightsService`. There is deliberately no route that
 * executes a licence.
 */
async function registerStudioLicensingRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const studio = runtime.studio

  app.get('/api/studio/licensing/requests', async (request) => {
    const actor = await requireStudio(runtime, request, 'studio.api')
    return { requests: await studio.rights.licenseRequests(actor) }
  })

  app.post('/api/studio/licensing/requests', async (request) => {
    const actor = await requireStudio(runtime, request, 'studio.api')
    const body = z
      .object({
        requester: z.string().min(1).max(200),
        requesterKind: z.enum(['human', 'agent']).default('agent'),
        brief: z.string().min(1).max(4000),
        budgetMicros: z.number().int().min(0).nullable().optional(),
        durationSeconds: z.number().int().min(1).max(3600).nullable().optional(),
        territories: z.array(z.string().max(8)).optional(),
        rightsRequested: z.array(z.string().max(64)).optional(),
      })
      .parse(request.body)
    const licenseRequest = await studio.rights.receiveLicenseRequest({ actor, ...body })
    return {
      request: licenseRequest,
      // Repeated on the response because an agent consuming this API needs to
      // be told, in the payload, that nothing has been granted.
      note: 'This is a rights check and an indicative match list. Street Banker does not execute licences: a person reviews, prices and papers every one.',
    }
  })
}
