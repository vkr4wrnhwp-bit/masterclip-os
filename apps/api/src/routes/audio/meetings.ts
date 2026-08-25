import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { requireAudio, readUpload, parseBool } from './helpers.js'

/**
 * Operator Desk Meeting Intelligence routes.
 *
 * Upload requires an explicit consent acknowledgment; extraction output stays
 * a draft until a human approves; commit is the only path into Operator Desk.
 */
export async function registerAudioMeetingRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const audio = runtime.audio

  app.get('/api/audio/meetings', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    return { meetings: await audio.repos.meetings.list(actor.orgId) }
  })

  app.post('/api/audio/meetings', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.meeting_upload', { slot: 'transcription' })
    const { bytes, filename, fields } = await readUpload(request)
    const meeting = await audio.meetings.createWithUpload({
      actor,
      title: fields.title ?? filename,
      meetingType: fields.meetingType ?? 'Other',
      operatorLeadId: fields.operatorLeadId || null,
      bytes,
      filename,
      consent: { accepted: parseBool(fields.consentAccepted) },
      ...(fields.languageCode ? { languageCode: fields.languageCode } : {}),
      ...(fields.numSpeakers ? { numSpeakers: Number(fields.numSpeakers) } : {}),
    })
    return { meeting, warning }
  })

  app.get('/api/audio/meetings/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    const meeting = await audio.repos.meetings.get(actor.orgId, id)
    const transcript = meeting.transcriptId ? await audio.repos.transcripts.get(actor.orgId, meeting.transcriptId) : null
    const segments = meeting.transcriptId ? await audio.repos.transcripts.segments(actor.orgId, meeting.transcriptId) : []
    const speakers = meeting.transcriptId ? await audio.repos.transcripts.speakers(actor.orgId, meeting.transcriptId) : []
    const actionItems = await audio.repos.meetings.actionItems(actor.orgId, id)
    const dealVariables = await audio.repos.meetings.dealVariables(actor.orgId, id)
    const audioUrl = meeting.audioAssetId ? (await audio.assets.signedUrl(actor.orgId, meeting.audioAssetId)).url : null
    return { meeting, transcript, segments, speakers, actionItems, dealVariables, audioUrl }
  })

  app.patch('/api/audio/meetings/:id/speakers', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    const body = z.object({ providerSpeakerKey: z.string().min(1), displayName: z.string().min(1).max(120) }).parse(request.body)
    const meeting = await audio.repos.meetings.get(actor.orgId, id)
    if (!meeting.transcriptId) return { ok: false }
    await audio.repos.transcripts.renameSpeaker(actor.orgId, meeting.transcriptId, body.providerSpeakerKey, body.displayName)
    return { ok: true }
  })

  // ----- Transcripts (shared by meetings and Global Release review) --------

  app.get('/api/audio/transcriptions/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.transcription')
    const { id } = request.params as { id: string }
    const transcript = await audio.repos.transcripts.get(actor.orgId, id)
    return {
      transcript,
      segments: await audio.repos.transcripts.segments(actor.orgId, id),
      speakers: await audio.repos.transcripts.speakers(actor.orgId, id),
    }
  })

  /** Human transcript correction — names, terminology, mishears. */
  app.patch('/api/audio/transcriptions/:id/segments', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.transcription')
    const { id } = request.params as { id: string }
    const body = z.object({ segmentId: z.string().min(1), text: z.string().min(1).max(5000) }).parse(request.body)
    await audio.repos.transcripts.updateSegmentText(actor.orgId, id, body.segmentId, body.text)
    return { ok: true }
  })

  app.post('/api/audio/meetings/:id/extract', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    await audio.repos.meetings.get(actor.orgId, id)
    await audio.meetings.runExtraction(id)
    return { ok: true }
  })

  app.post('/api/audio/meetings/:id/approve', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    const body = z
      .object({
        items: z.array(
          z.object({
            kind: z.enum(['action', 'deal']),
            itemId: z.string(),
            status: z.enum(['approved', 'rejected', 'draft']),
            editedValue: z.string().max(2000).optional(),
          }),
        ),
      })
      .parse(request.body)
    for (const item of body.items) {
      await audio.repos.meetings.setItemApproval(actor.orgId, id, item.kind, item.itemId, item.status, item.editedValue)
    }
    await audio.repos.meetings.markReviewed(actor.orgId, id, actor.userId)
    return { ok: true }
  })

  app.post('/api/audio/meetings/:id/commit', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    const result = await audio.meetings.commit(actor, id)
    return { ok: true, ...result }
  })

  // ----- Operator Desk (leads the meetings commit into) ---------------------

  app.get('/api/audio/leads', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    return { leads: await audio.repos.operatorDesk.listLeads(actor.orgId) }
  })

  app.post('/api/audio/leads', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const body = z
      .object({
        name: z.string().min(1).max(200),
        contactName: z.string().max(200).optional(),
        email: z.string().max(200).optional(),
        artistName: z.string().max(200).optional(),
      })
      .parse(request.body)
    const lead = await audio.repos.operatorDesk.createLead({
      orgId: actor.orgId,
      name: body.name,
      ...(body.contactName !== undefined ? { contactName: body.contactName } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.artistName !== undefined ? { artistName: body.artistName } : {}),
      source: 'manual',
      createdBy: actor.userId,
    })
    return { lead }
  })

  app.get('/api/audio/leads/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    const lead = await audio.repos.operatorDesk.getLead(actor.orgId, id)
    return {
      lead,
      notes: await audio.repos.operatorDesk.notesForLead(actor.orgId, id),
      tasks: await audio.repos.operatorDesk.tasksForLead(actor.orgId, id),
    }
  })

  app.patch('/api/audio/leads/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    const body = z
      .object({
        contactName: z.string().max(200).optional(),
        email: z.string().max(200).optional(),
        phone: z.string().max(60).optional(),
        artistName: z.string().max(200).optional(),
        stage: z.string().max(60).optional(),
      })
      .parse(request.body)
    await audio.repos.operatorDesk.updateLeadContact(actor.orgId, id, body)
    return { lead: await audio.repos.operatorDesk.getLead(actor.orgId, id) }
  })

  app.post('/api/audio/tasks/:id/status', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    const body = z.object({ status: z.enum(['open', 'done', 'cancelled']) }).parse(request.body)
    await audio.repos.operatorDesk.setTaskStatus(actor.orgId, id, body.status)
    return { ok: true }
  })
}
