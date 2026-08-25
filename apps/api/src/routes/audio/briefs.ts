import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { requireAudio } from './helpers.js'

export async function registerAudioBriefRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const audio = runtime.audio

  app.get('/api/audio/signal-briefs', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.signal_briefs')
    return { briefs: await audio.repos.briefs.list(actor.orgId) }
  })

  app.post('/api/audio/signal-briefs', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.signal_briefs', { slot: 'speech' })
    const body = z
      .object({
        briefType: z.string().min(1),
        title: z.string().min(1).max(200),
        items: z
          .array(z.object({ statement: z.string().min(1).max(600), confidence: z.enum(['confirmed', 'likely', 'needs_verification']) }))
          .min(1)
          .max(20),
        voiceRef: z.string().max(200).optional(),
        render: z.boolean().optional(),
      })
      .parse(request.body)
    const brief = await audio.briefs.create({
      actor,
      briefType: body.briefType,
      title: body.title,
      items: body.items,
      ...(body.voiceRef ? { voiceRef: body.voiceRef } : {}),
    })
    if (body.render !== false) await audio.briefs.enqueueRender(actor, brief.id)
    return { brief, warning }
  })

  app.get('/api/audio/signal-briefs/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.signal_briefs')
    const { id } = request.params as { id: string }
    const brief = await audio.repos.briefs.get(actor.orgId, id)
    const audioUrl = brief.audioAssetId ? (await audio.assets.signedUrl(actor.orgId, brief.audioAssetId)).url : null
    return { brief, audioUrl }
  })

  app.patch('/api/audio/signal-briefs/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.signal_briefs')
    const { id } = request.params as { id: string }
    const body = z.object({ script: z.string().min(1).max(20_000), render: z.boolean().optional() }).parse(request.body)
    await audio.repos.briefs.updateScript(actor.orgId, id, body.script)
    if (body.render) await audio.briefs.enqueueRender(actor, id)
    return { ok: true }
  })

  app.get('/api/audio/signal-briefs/schedules/list', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.signal_brief_scheduling')
    return { schedules: await audio.repos.briefs.listSchedules(actor.orgId) }
  })

  app.post('/api/audio/signal-briefs/schedules', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.signal_brief_scheduling')
    const body = z
      .object({
        briefType: z.string().min(1),
        cadence: z.enum(['daily', 'weekdays', 'weekly', 'on_demand']),
        hourUtc: z.number().int().min(0).max(23),
        timezone: z.string().min(1).max(64).default('UTC'),
      })
      .parse(request.body)
    const schedule = await audio.repos.briefs.createSchedule({
      orgId: actor.orgId,
      briefType: body.briefType,
      cadence: body.cadence,
      hourUtc: body.hourUtc,
      timezone: body.timezone,
      subscriberUserId: actor.userId,
      enabled: true,
    })
    return { schedule }
  })

  app.patch('/api/audio/signal-briefs/schedules/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.signal_brief_scheduling')
    const { id } = request.params as { id: string }
    const body = z.object({ enabled: z.boolean() }).parse(request.body)
    await audio.repos.briefs.setScheduleEnabled(actor.orgId, id, body.enabled)
    return { ok: true }
  })
}
