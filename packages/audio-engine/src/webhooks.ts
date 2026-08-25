import { AppError, sha256Hex } from '@masterclip/shared'
import { QUEUES, JOB_TYPES } from '@masterclip/queue'
import { retentionExpiresAt } from '@masterclip/audio-core'
import { normalizeSttResponse, verifyElevenLabsSignature } from '@masterclip/audio-providers'
import type { AudioEngineDeps } from './deps.js'
import type { OperatorAgentService } from './operator-agent.js'
import type { TranscriptionJobConfig } from './transcription.js'

/**
 * Provider webhook intake and processing.
 *
 * Order of operations is the security property: verify the signature against
 * the RAW bytes, then store the event idempotently, then process from the
 * stored copy in the worker. Unsigned or stale deliveries are rejected before
 * anything is stored as trusted; duplicates collapse on the
 * (provider, external id) unique index.
 */
export class AudioWebhookService {
  constructor(
    private readonly deps: AudioEngineDeps,
    private readonly operatorAgent: OperatorAgentService,
  ) {}

  /** HTTP entry point. Throws 403 on any verification failure. */
  async receiveElevenLabs(rawBody: string, signatureHeader: string | null | undefined): Promise<{ eventId: string; deduped: boolean }> {
    try {
      verifyElevenLabsSignature(rawBody, signatureHeader, this.deps.config.ELEVENLABS_WEBHOOK_SECRET, this.deps.clock.now())
    } catch (err) {
      // Rejected events are recorded (without trusting their content) so an
      // attack or misconfiguration is visible in the admin view.
      const digest = sha256Hex(rawBody).slice(0, 32)
      await this.deps.repos.webhookEvents.store({
        provider: 'elevenlabs',
        externalEventId: `rejected-${digest}`,
        eventType: 'unverified',
        signatureValid: false,
        orgId: null,
        payload: { bytes: rawBody.length },
        status: 'rejected',
      })
      throw err
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      throw new AppError({ kind: 'validation', code: 'webhook.bad_json', message: 'webhook body is not valid JSON' })
    }
    const eventType = typeof payload.type === 'string' ? payload.type : 'unknown'
    const externalEventId =
      (typeof payload.event_id === 'string' && payload.event_id) ||
      (typeof payload.request_id === 'string' && payload.request_id) ||
      sha256Hex(rawBody).slice(0, 32)

    const { record, deduped } = await this.deps.repos.webhookEvents.store({
      provider: 'elevenlabs',
      externalEventId,
      eventType,
      signatureValid: true,
      orgId: this.orgFromPayload(payload),
      payload,
    })
    if (!deduped) {
      await this.deps.queue.enqueue({
        queue: QUEUES.audio,
        type: JOB_TYPES.audioWebhookProcess,
        payload: { eventId: record.id },
        dedupeKey: `audio-webhook:${record.id}`,
      })
    }
    return { eventId: record.id, deduped }
  }

  /** Our own webhook_metadata carries the org and job the event belongs to. */
  private orgFromPayload(payload: Record<string, unknown>): string | null {
    const data = payload.data as Record<string, unknown> | undefined
    const metadata = (data?.webhook_metadata ?? payload.webhook_metadata) as Record<string, unknown> | string | undefined
    if (typeof metadata === 'string') {
      try {
        return ((JSON.parse(metadata) as Record<string, unknown>).orgId as string) ?? null
      } catch {
        return null
      }
    }
    return (metadata?.orgId as string) ?? null
  }

  /** Worker entry point: routes a stored, verified event. */
  async process(eventId: string): Promise<void> {
    const event = await this.deps.repos.webhookEvents.get(eventId)
    if (!event) throw new AppError({ kind: 'not_found', message: `webhook event ${eventId} not found` })
    if (event.status === 'processed') return
    try {
      const payload = event.payload as Record<string, unknown>
      if (event.eventType === 'speech_to_text_transcription' || event.eventType === 'transcription.completed') {
        await this.completeAsyncTranscription(payload)
      } else if (event.eventType === 'post_call_transcription' || event.eventType === 'call.ended') {
        await this.routePostCall(payload)
      } else {
        this.deps.logger.info('audio.webhook_unhandled', { event_type: event.eventType })
      }
      await this.deps.repos.webhookEvents.markProcessed(eventId)
    } catch (err) {
      await this.deps.repos.webhookEvents.markFailed(eventId, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /** Completes a transcription job that was parked awaiting webhook delivery. */
  private async completeAsyncTranscription(payload: Record<string, unknown>): Promise<void> {
    const data = (payload.data ?? payload) as Record<string, unknown>
    const transcriptionId =
      (typeof data.transcription_id === 'string' && data.transcription_id) ||
      (typeof data.request_id === 'string' && data.request_id) ||
      null
    if (!transcriptionId) return
    const row = await this.deps.db.get(
      `SELECT id FROM audio_jobs WHERE provider_job_id = ? AND status = 'awaiting_provider' AND operation = 'transcription'`,
      [transcriptionId],
    )
    if (!row) {
      this.deps.logger.warn('audio.webhook_orphan_transcription', { transcription_id: transcriptionId })
      return
    }
    const job = await this.deps.repos.jobs.getAnyOrg(String(row.id))
    const config = job.configuration as unknown as TranscriptionJobConfig
    const transcriptBody = (data.transcription ?? data) as Parameters<typeof normalizeSttResponse>[0]
    const normalized = normalizeSttResponse(transcriptBody)
    const policy = await this.deps.repos.policy.getPolicy(job.orgId)
    const transcript = await this.deps.repos.transcripts.createFromNormalized({
      orgId: job.orgId,
      audioAssetId: config.assetId,
      provider: 'elevenlabs',
      transcript: normalized,
      retentionExpiresAt: retentionExpiresAt(policy, 'transcript', this.deps.clock.now()),
    })
    await this.deps.repos.jobs.markComplete(job.id, [], job.estimatedCostMicros)
    if (config.purpose === 'meeting' && config.meetingId) {
      await this.deps.repos.meetings.attachTranscript(config.meetingId, transcript.id)
      await this.deps.repos.meetings.setStatus(config.meetingId, 'extracting')
      await this.deps.queue.enqueue({
        queue: QUEUES.audio,
        type: JOB_TYPES.audioExtractMeeting,
        payload: { meetingId: config.meetingId },
        dedupeKey: `audio-extract:${config.meetingId}:${transcript.id}`,
      })
    }
    if (config.purpose === 'dubbing' && config.dubbingProjectId) {
      await this.deps.repos.dubbing.attachTranscript(config.dubbingProjectId, transcript.id)
      await this.deps.repos.dubbing.setStatus(config.dubbingProjectId, 'transcript_review')
    }
  }

  /** Post-call events map to a conversation via the provider conversation id. */
  private async routePostCall(payload: Record<string, unknown>): Promise<void> {
    const data = (payload.data ?? payload) as Record<string, unknown>
    const providerConversationId = typeof data.conversation_id === 'string' ? data.conversation_id : null
    if (!providerConversationId) return
    const conversation = await this.deps.repos.agents.findByProviderConversation(providerConversationId)
    if (!conversation) {
      this.deps.logger.warn('audio.webhook_orphan_conversation', { provider_conversation_id: providerConversationId })
      return
    }
    await this.operatorAgent.enqueuePostCall(conversation.id)
  }
}
