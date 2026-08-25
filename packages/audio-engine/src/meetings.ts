import { AppError, invalid } from '@masterclip/shared'
import { QUEUES, JOB_TYPES } from '@masterclip/queue'
import { assertPolicyAllows, defaultDisclosure } from '@masterclip/audio-core'
import { MEETING_TYPES, type MeetingRecord } from '@masterclip/audio-domain'
import type { Actor, AudioEngineDeps } from './deps.js'
import type { AudioAssetService } from './assets.js'
import type { TranscriptionService } from './transcription.js'

/**
 * Operator Desk Meeting Intelligence.
 *
 * The workflow the module exists for: consented media in → transcript →
 * structured DRAFT intelligence → human review → approved records committed to
 * Operator Desk. Extraction never commits anything on its own; the
 * `commit` step is a human action and the only path that writes leads/tasks.
 */
export class MeetingService {
  constructor(
    private readonly deps: AudioEngineDeps,
    private readonly audioAssets: AudioAssetService,
    private readonly transcription: TranscriptionService,
  ) {}

  /**
   * Creates the meeting, records consent, stores the media, and queues
   * transcription — one transactional-feeling step from the caller's side.
   */
  async createWithUpload(input: {
    actor: Actor
    title: string
    meetingType: string
    operatorLeadId: string | null
    bytes: Uint8Array
    filename: string
    consent: { accepted: boolean; disclosureText?: string; policyVersion?: string }
    languageCode?: string
    numSpeakers?: number
  }): Promise<MeetingRecord> {
    if (!MEETING_TYPES.includes(input.meetingType as (typeof MEETING_TYPES)[number])) {
      throw invalid(`unknown meeting type — expected one of: ${MEETING_TYPES.join(', ')}`)
    }
    const policy = await this.deps.repos.policy.getPolicy(input.actor.orgId)
    assertPolicyAllows(policy, 'upload')
    assertPolicyAllows(policy, 'transcribe')

    if (policy.requireRecordingConsent && !input.consent.accepted) {
      throw new AppError({
        kind: 'forbidden',
        code: 'audio.consent_required',
        message: 'recording/upload authorization must be acknowledged before this meeting can be processed',
      })
    }
    if (input.operatorLeadId) {
      // Tenancy check: the lead must exist in this org before anything links to it.
      await this.deps.repos.operatorDesk.getLead(input.actor.orgId, input.operatorLeadId)
    }

    const disclosure = defaultDisclosure('upload_authorization')
    const consent = await this.deps.repos.consents.record({
      orgId: input.actor.orgId,
      subjectType: 'meeting_upload',
      subjectId: 'pending',
      consentType: 'upload_authorization',
      policyVersion: input.consent.policyVersion ?? disclosure.version,
      disclosureText: input.consent.disclosureText ?? disclosure.text,
      accepted: input.consent.accepted,
      acceptedBy: input.actor.userId,
      evidence: { filename: input.filename, bytes: input.bytes.length },
    })

    const meeting = await this.deps.repos.meetings.create({
      orgId: input.actor.orgId,
      title: input.title,
      meetingType: input.meetingType,
      operatorLeadId: input.operatorLeadId,
      audioAssetId: null,
      consentRecordId: consent.id,
      createdBy: input.actor.userId,
    })

    const asset = await this.audioAssets.storeUpload({
      actor: input.actor,
      bytes: input.bytes,
      filename: input.filename,
      area: 'source',
      projectType: 'meeting',
      projectId: meeting.id,
      assetType: 'meeting_source',
      retentionKind: 'source',
      rightsStatus: 'authorized_upload',
      consentRecordId: consent.id,
    })
    await this.deps.db.run('UPDATE meeting_intelligence SET audio_asset_id = ? WHERE id = ?', [asset.id, meeting.id])
    await this.deps.repos.meetings.setStatus(meeting.id, 'transcribing')

    await this.transcription.enqueue({
      orgId: input.actor.orgId,
      userId: input.actor.userId,
      config: {
        assetId: asset.id,
        purpose: 'meeting',
        meetingId: meeting.id,
        ...(input.languageCode ? { languageCode: input.languageCode } : {}),
        ...(input.numSpeakers !== undefined ? { numSpeakers: input.numSpeakers } : {}),
      },
    })

    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'audio.meeting_created',
      targetType: 'meeting',
      targetId: meeting.id,
      data: { meetingType: input.meetingType, consentRecordId: consent.id },
    })
    return { ...meeting, audioAssetId: asset.id, status: 'transcribing' }
  }

  /** Worker entry point: extracts structured intelligence into DRAFT rows. */
  async runExtraction(meetingId: string): Promise<void> {
    const meeting = await this.deps.repos.meetings.getAnyOrg(meetingId)
    const policy = await this.deps.repos.policy.getPolicy(meeting.orgId)
    if (!policy.allowAIExtraction) {
      await this.deps.repos.meetings.setStatus(meetingId, 'draft')
      return
    }
    if (!meeting.transcriptId) {
      throw new AppError({ kind: 'conflict', code: 'meeting.no_transcript', message: 'meeting has no transcript to extract from' })
    }
    const { transcript, speakerNames } = await this.deps.repos.transcripts.toNormalized(meeting.orgId, meeting.transcriptId)
    const lead = meeting.operatorLeadId ? await this.deps.repos.operatorDesk.getLead(meeting.orgId, meeting.operatorLeadId) : null
    const extraction = await this.deps.reasoning.extractMeetingIntelligence({
      orgId: meeting.orgId,
      meetingType: meeting.meetingType,
      transcript,
      speakerNames,
      ...(lead ? { leadContext: { leadId: lead.id, name: lead.name } } : {}),
    })
    await this.deps.repos.meetings.storeExtraction(meeting.orgId, meetingId, extraction)
    if (extraction.costMicros > 0) {
      await this.deps.repos.usage.record({
        orgId: meeting.orgId,
        userId: meeting.createdBy,
        projectType: 'meeting',
        projectId: meetingId,
        provider: this.deps.reasoning.providerId,
        operation: 'meeting_extraction',
        model: extraction.engine,
        unit: 'requests',
        inputUnits: 1,
        outputUnits: 0,
        estimatedCostMicros: 0,
        finalCostMicros: extraction.costMicros,
        currency: 'USD',
        providerRequestId: null,
        jobId: null,
      })
    }
  }

  /**
   * Human approval → Operator Desk commit. Only approved items land; drafts and
   * rejected items never touch leads or tasks. Requires a lead to commit into.
   */
  async commit(actor: Actor, meetingId: string): Promise<{ notes: number; tasks: number }> {
    const meeting = await this.deps.repos.meetings.get(actor.orgId, meetingId)
    if (!meeting.operatorLeadId) {
      throw new AppError({ kind: 'validation', code: 'meeting.no_lead', message: 'attach this meeting to an Operator Desk lead before committing' })
    }
    if (meeting.status !== 'draft') {
      throw new AppError({ kind: 'conflict', code: 'meeting.not_draft', message: `meeting is ${meeting.status}; only reviewed drafts commit` })
    }
    const actionItems = (await this.deps.repos.meetings.actionItems(actor.orgId, meetingId)).filter((i) => i.approvalStatus === 'approved')
    const dealVariables = (await this.deps.repos.meetings.dealVariables(actor.orgId, meetingId)).filter((v) => v.approvalStatus === 'approved')

    let notes = 0
    let tasks = 0
    if (meeting.extraction) {
      await this.deps.repos.operatorDesk.addNote({
        orgId: actor.orgId,
        leadId: meeting.operatorLeadId,
        body: `[${meeting.meetingType}] ${meeting.extraction.summary}`,
        sourceType: 'meeting',
        sourceId: meetingId,
        createdBy: actor.userId,
      })
      notes++
    }
    for (const variable of dealVariables) {
      await this.deps.repos.operatorDesk.addNote({
        orgId: actor.orgId,
        leadId: meeting.operatorLeadId,
        body: `Deal variable (${variable.extractionType}): ${variable.variableType} — ${variable.value}`,
        sourceType: 'meeting',
        sourceId: meetingId,
        createdBy: actor.userId,
      })
      notes++
    }
    for (const item of actionItems) {
      const task = await this.deps.repos.operatorDesk.createTask({
        orgId: actor.orgId,
        leadId: meeting.operatorLeadId,
        description: item.description,
        dueAt: item.dueAt,
        assignedUserId: item.assignedUserId,
        sourceType: 'meeting',
        sourceId: meetingId,
        createdBy: actor.userId,
      })
      await this.deps.repos.meetings.linkActionToTask(item.id, task.id)
      tasks++
    }

    await this.deps.repos.meetings.markReviewed(actor.orgId, meetingId, actor.userId)
    await this.deps.repos.meetings.markCommitted(actor.orgId, meetingId)
    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'audio.meeting_committed',
      targetType: 'meeting',
      targetId: meetingId,
      data: { notes, tasks, leadId: meeting.operatorLeadId },
    })
    return { notes, tasks }
  }
}
