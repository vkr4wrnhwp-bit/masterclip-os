import { AppError } from '@masterclip/shared'
import { QUEUES, JOB_TYPES } from '@masterclip/queue'
import { assertPolicyAllows, assertZeroRetentionSatisfiable, type SpeechSynthesisProvider } from '@masterclip/audio-core'
import { BRIEF_TYPES, type BriefItem, type SignalBriefRecord } from '@masterclip/audio-domain'
import type { Actor, AudioEngineDeps } from './deps.js'
import type { AudioAssetService } from './assets.js'
import { estimateMicros, parseRateCard } from './rates.js'

/**
 * Street Banker Signal Audio Briefs.
 *
 * Structured, already-authorized facts go in; a spoken script comes out with
 * confidence language intact; a speech provider renders it to org-scoped
 * audio. Brief items are supplied by the caller from data the caller may see —
 * this service never queries Signal data on its own, which is what keeps
 * unauthorized information out of unauthorized ears.
 */
export class BriefService {
  constructor(
    private readonly deps: AudioEngineDeps,
    private readonly audioAssets: AudioAssetService,
  ) {}

  async create(input: { actor: Actor; briefType: string; title: string; items: BriefItem[]; voiceRef?: string }): Promise<SignalBriefRecord> {
    if (!BRIEF_TYPES.includes(input.briefType as (typeof BRIEF_TYPES)[number])) {
      throw new AppError({ kind: 'validation', code: 'brief.unknown_type', message: `unknown brief type — expected one of: ${BRIEF_TYPES.join(', ')}` })
    }
    if (input.items.length === 0) {
      throw new AppError({ kind: 'validation', code: 'brief.empty', message: 'a brief needs at least one item' })
    }
    const policy = await this.deps.repos.policy.getPolicy(input.actor.orgId)
    assertPolicyAllows(policy, 'generate_voice')

    const script = await this.deps.reasoning.generateSignalBrief({
      orgId: input.actor.orgId,
      briefType: input.briefType,
      title: input.title,
      items: input.items,
      audience: 'executive',
    })
    const brief = await this.deps.repos.briefs.create({
      orgId: input.actor.orgId,
      briefType: input.briefType,
      title: input.title,
      script: script.script,
      items: input.items,
      voiceRef: input.voiceRef ?? '',
      engine: script.engine,
      requestedBy: input.actor.userId,
    })
    return brief
  }

  async enqueueRender(actor: Actor, briefId: string): Promise<void> {
    const brief = await this.deps.repos.briefs.get(actor.orgId, briefId)
    if (brief.status === 'rendering') return
    await this.deps.repos.briefs.markRendering(briefId)
    await this.deps.queue.enqueue({
      queue: QUEUES.audio,
      type: JOB_TYPES.audioRenderBrief,
      payload: { briefId },
      dedupeKey: `audio-brief:${briefId}:${brief.script.length}`,
    })
  }

  /** Worker entry point: text → speech → org-scoped stored asset. */
  async runRender(briefId: string): Promise<void> {
    const brief = await this.deps.repos.briefs.getAnyOrg(briefId)
    try {
      const policy = await this.deps.repos.policy.getPolicy(brief.orgId)
      assertPolicyAllows(policy, 'generate_voice')
      const settings = await this.deps.repos.policy.getSettings(brief.orgId)
      const provider = this.deps.registry.resolve<SpeechSynthesisProvider>('speech', settings.defaultProviders.speech)
      const requireZero = policy.requireZeroRetention || this.deps.config.ZERO_RETENTION_REQUIRED
      assertZeroRetentionSatisfiable({ ...policy, requireZeroRetention: requireZero }, provider.providerId, provider.supportsZeroRetention('tts'))

      const result = await provider.synthesize({
        orgId: brief.orgId,
        text: brief.script,
        voiceRef: brief.voiceRef,
        zeroRetention: requireZero,
      })
      const asset = await this.audioAssets.storeGenerated({
        orgId: brief.orgId,
        ownerUserId: brief.requestedBy,
        bytes: result.audio.bytes,
        contentType: result.audio.contentType,
        filename: result.audio.filename ?? 'brief-audio',
        area: 'generated',
        projectType: 'brief',
        projectId: brief.id,
        assetType: 'brief_audio',
        retentionKind: 'generated',
        rightsStatus: 'generated_internal',
      })
      await this.deps.repos.assets.recordGeneration({
        orgId: brief.orgId,
        projectType: 'brief',
        projectId: brief.id,
        outputAssetId: asset.id,
        provider: provider.providerId,
        model: this.deps.config.ELEVENLABS_TTS_MODEL,
        operation: 'tts',
        voiceProfileId: null,
        prompt: brief.script.slice(0, 2000),
        configuration: { briefType: brief.briefType },
        rightsBasis: 'internal_briefing',
        consentRecordId: null,
        parentGenerationId: null,
        createdBy: brief.requestedBy,
      })
      await this.deps.repos.usage.record({
        orgId: brief.orgId,
        userId: brief.requestedBy,
        projectType: 'brief',
        projectId: brief.id,
        provider: provider.providerId,
        operation: 'tts',
        model: this.deps.config.ELEVENLABS_TTS_MODEL,
        unit: result.usage.unit,
        inputUnits: result.usage.inputUnits,
        outputUnits: result.usage.outputUnits,
        estimatedCostMicros: estimateMicros(parseRateCard(this.deps.config), 'tts', { characters: brief.script.length }),
        finalCostMicros: 0,
        currency: 'USD',
        providerRequestId: result.usage.providerRequestId ?? null,
        jobId: null,
      })
      await this.deps.repos.briefs.markReady(briefId, asset.id)
    } catch (err) {
      await this.deps.repos.briefs.markFailed(briefId, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /** Maintenance tick: renders due scheduled briefs from a standing template. */
  async runScheduleTick(): Promise<number> {
    const due = await this.deps.repos.briefs.listDue(this.deps.clock.now())
    let generated = 0
    for (const schedule of due) {
      try {
        const brief = await this.deps.repos.briefs.create({
          orgId: schedule.orgId,
          briefType: schedule.briefType,
          title: `Scheduled ${schedule.briefType.replace(/_/g, ' ')} brief`,
          script: '',
          items: [
            {
              statement: 'This scheduled brief has no new confirmed items in this build; connect Signal data sources to populate it.',
              confidence: 'confirmed',
            },
          ],
          voiceRef: '',
          engine: 'scheduler',
          requestedBy: schedule.subscriberUserId,
        })
        const script = await this.deps.reasoning.generateSignalBrief({
          orgId: schedule.orgId,
          briefType: schedule.briefType,
          title: brief.title,
          items: brief.items,
          audience: 'executive',
        })
        await this.deps.repos.briefs.updateScript(schedule.orgId, brief.id, script.script)
        await this.deps.repos.briefs.markRendering(brief.id)
        await this.deps.queue.enqueue({
          queue: QUEUES.audio,
          type: JOB_TYPES.audioRenderBrief,
          payload: { briefId: brief.id },
          dedupeKey: `audio-brief:${brief.id}`,
        })
        await this.deps.repos.briefs.markScheduleRun(schedule.id)
        generated++
      } catch (err) {
        this.deps.logger.warn('audio.brief_schedule_failed', { schedule_id: schedule.id, err })
      }
    }
    return generated
  }
}
