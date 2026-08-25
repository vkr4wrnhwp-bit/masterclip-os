import { AppError } from '@masterclip/shared'
import { QUEUES, JOB_TYPES } from '@masterclip/queue'
import {
  assertPolicyAllows,
  screenVoicePrompt,
  type SoundEffectsProvider,
  type SpeechSynthesisProvider,
  type VoiceIsolationProvider,
} from '@masterclip/audio-core'
import { CAMPAIGN_TEMPLATES, type CampaignProjectRecord } from '@masterclip/audio-domain'
import type { Actor, AudioEngineDeps } from './deps.js'
import type { AudioAssetService } from './assets.js'
import { estimateMicros, parseRateCard } from './rates.js'

export interface CampaignGenerateConfig {
  campaignId: string
  operation: 'voiceover' | 'sound_effect' | 'voice_isolation'
  text?: string
  voiceProfileId?: string
  sourceAssetId?: string
  durationSeconds?: number
}

/**
 * Campaign Audio Toolkit: voiceovers, sound design, dialogue cleanup.
 *
 * Voiceovers use catalog voices or verified Voice Vault profiles only — the
 * moderation screen refuses public-figure imitation and the vault enforces the
 * owner's permission scope before any synthesis happens.
 */
export class CampaignService {
  constructor(
    private readonly deps: AudioEngineDeps,
    private readonly audioAssets: AudioAssetService,
  ) {}

  async create(input: { actor: Actor; name: string; templateType: string; usageContext: string; rightsBasis: string }): Promise<CampaignProjectRecord> {
    if (!CAMPAIGN_TEMPLATES.includes(input.templateType as (typeof CAMPAIGN_TEMPLATES)[number])) {
      throw new AppError({ kind: 'validation', code: 'campaign.bad_template', message: `template must be one of ${CAMPAIGN_TEMPLATES.join(', ')}` })
    }
    return this.deps.repos.campaigns.create({
      orgId: input.actor.orgId,
      name: input.name,
      templateType: input.templateType,
      sourceAssetIds: [],
      voiceProfileId: null,
      usageContext: input.usageContext,
      rightsBasis: input.rightsBasis,
      rightsConfirmationId: null,
      createdBy: input.actor.userId,
    })
  }

  async enqueueGenerate(actor: Actor, config: CampaignGenerateConfig): Promise<string> {
    const campaign = await this.deps.repos.campaigns.get(actor.orgId, config.campaignId)
    const policy = await this.deps.repos.policy.getPolicy(actor.orgId)
    const settings = await this.deps.repos.policy.getSettings(actor.orgId)

    if (config.operation === 'voiceover') {
      assertPolicyAllows(policy, 'generate_voice')
      if (!config.text) throw new AppError({ kind: 'validation', code: 'campaign.no_text', message: 'voiceover requires text' })
      const verdict = screenVoicePrompt(config.text, { protectedNames: settings.protectedNames })
      if (!verdict.allowed) {
        throw new AppError({ kind: 'provider_rejected', code: 'campaign.prompt_blocked', message: verdict.message ?? 'blocked prompt' })
      }
      if (config.voiceProfileId) {
        // The vault enforces owner permission for advertising/commercial use.
        await this.deps.repos.voiceVault.requireUsable(actor.orgId, config.voiceProfileId, 'commercial', this.deps.clock.now())
      }
    }
    if (config.operation === 'voice_isolation') {
      if (!config.sourceAssetId) throw new AppError({ kind: 'validation', code: 'campaign.no_source', message: 'voice isolation requires a source asset' })
      await this.deps.repos.assets.get(actor.orgId, config.sourceAssetId)
    }
    if (config.operation === 'sound_effect' && !config.text) {
      throw new AppError({ kind: 'validation', code: 'campaign.no_text', message: 'sound effect generation requires a text description' })
    }

    const card = parseRateCard(this.deps.config)
    const estimated =
      config.operation === 'voiceover'
        ? estimateMicros(card, 'tts', { characters: config.text?.length ?? 0 })
        : config.operation === 'sound_effect'
          ? estimateMicros(card, 'sound_effect', { effects: 1 })
          : estimateMicros(card, 'voice_isolation', { minutes: 1 })

    const job = await this.deps.repos.jobs.create({
      orgId: actor.orgId,
      userId: actor.userId,
      featureKey: `audio.campaign_${config.operation}`,
      provider: 'resolved-at-run',
      operation: config.operation,
      inputAssetIds: config.sourceAssetId ? [config.sourceAssetId] : [],
      configuration: config as unknown as Record<string, unknown>,
      estimatedCostMicros: estimated,
    })
    await this.deps.queue.enqueue({
      queue: QUEUES.audio,
      type: JOB_TYPES.audioCampaignGenerate,
      payload: { jobId: job.id },
      dedupeKey: `audio-campaign:${job.id}`,
    })
    void campaign
    return job.id
  }

  /** Worker entry point for all three campaign operations. */
  async runGenerate(jobId: string): Promise<void> {
    const job = await this.deps.repos.jobs.getAnyOrg(jobId)
    const config = job.configuration as unknown as CampaignGenerateConfig
    await this.deps.repos.jobs.markRunning(jobId)
    try {
      const settings = await this.deps.repos.policy.getSettings(job.orgId)
      const campaign = await this.deps.repos.campaigns.get(job.orgId, config.campaignId)
      let bytes: Uint8Array
      let contentType: string
      let filename: string
      let providerId: string
      let model = ''
      let prompt = config.text ?? ''
      let voiceProfileId: string | null = null

      if (config.operation === 'voiceover') {
        let voiceRef = ''
        if (config.voiceProfileId) {
          const profile = await this.deps.repos.voiceVault.requireUsable(job.orgId, config.voiceProfileId, 'commercial', this.deps.clock.now())
          voiceRef = profile.providerVoiceId
          voiceProfileId = profile.id
        }
        const provider = this.deps.registry.resolve<SpeechSynthesisProvider>('speech', settings.defaultProviders.speech)
        const result = await provider.synthesize({ orgId: job.orgId, text: config.text ?? '', voiceRef, zeroRetention: false })
        bytes = result.audio.bytes
        contentType = result.audio.contentType
        filename = result.audio.filename ?? 'voiceover'
        providerId = provider.providerId
        model = this.deps.config.ELEVENLABS_TTS_MODEL
        await this.recordUsage(job.orgId, job.userId, config.campaignId, providerId, 'tts', model, result.usage.unit, result.usage.inputUnits, result.usage.outputUnits, job.estimatedCostMicros, jobId, result.usage.providerRequestId ?? null)
      } else if (config.operation === 'sound_effect') {
        const provider = this.deps.registry.resolve<SoundEffectsProvider>('soundEffects', settings.defaultProviders.soundEffects)
        const result = await provider.generateSoundEffect({
          orgId: job.orgId,
          text: config.text ?? '',
          ...(config.durationSeconds !== undefined ? { durationSeconds: config.durationSeconds } : {}),
        })
        bytes = result.audio.bytes
        contentType = result.audio.contentType
        filename = result.audio.filename ?? 'sound-effect'
        providerId = provider.providerId
        model = this.deps.config.ELEVENLABS_SFX_MODEL || 'sound-generation'
        if (result.usage) {
          await this.recordUsage(job.orgId, job.userId, config.campaignId, providerId, 'sound_effect', model, result.usage.unit, result.usage.inputUnits, result.usage.outputUnits, job.estimatedCostMicros, jobId, result.usage.providerRequestId ?? null)
        }
      } else {
        const { asset, bytes: source } = await this.audioAssets.materialize(job.orgId, config.sourceAssetId!)
        const provider = this.deps.registry.resolve<VoiceIsolationProvider>('isolation', settings.defaultProviders.isolation)
        const result = await provider.isolateVoice({ orgId: job.orgId, audio: { bytes: source, mimeType: asset.mimeType, filename: asset.fileName } })
        bytes = result.audio.bytes
        contentType = result.audio.contentType
        filename = result.audio.filename ?? 'isolated'
        providerId = provider.providerId
        model = 'audio-isolation'
        prompt = `voice isolation of ${asset.fileName}`
        if (result.usage) {
          await this.recordUsage(job.orgId, job.userId, config.campaignId, providerId, 'voice_isolation', model, result.usage.unit, result.usage.inputUnits, result.usage.outputUnits, job.estimatedCostMicros, jobId, result.usage.providerRequestId ?? null)
        }
      }

      const asset = await this.audioAssets.storeGenerated({
        orgId: job.orgId,
        ownerUserId: job.userId,
        bytes,
        contentType,
        filename,
        area: 'generated',
        projectType: 'campaign',
        projectId: config.campaignId,
        assetType: `campaign_${config.operation}`,
        retentionKind: 'generated',
        rightsStatus: campaign.rightsBasis || 'campaign_generated',
      })
      await this.deps.repos.assets.recordGeneration({
        orgId: job.orgId,
        projectType: 'campaign',
        projectId: config.campaignId,
        outputAssetId: asset.id,
        provider: providerId,
        model,
        operation: config.operation,
        voiceProfileId,
        prompt: prompt.slice(0, 2000),
        configuration: { templateType: campaign.templateType, usageContext: campaign.usageContext },
        rightsBasis: campaign.rightsBasis,
        consentRecordId: campaign.rightsConfirmationId,
        parentGenerationId: null,
        createdBy: job.userId,
      })
      await this.deps.repos.jobs.markComplete(jobId, [asset.id], job.estimatedCostMicros)
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError({ kind: 'internal', message: String(err) })
      await this.deps.repos.jobs.markFailed(jobId, appErr.code, appErr.message)
      throw err
    }
  }

  private async recordUsage(orgId: string, userId: string, projectId: string, provider: string, operation: string, model: string, unit: string, inputUnits: number, outputUnits: number, estimatedCostMicros: number, jobId: string, providerRequestId: string | null): Promise<void> {
    await this.deps.repos.usage.record({
      orgId,
      userId,
      projectType: 'campaign',
      projectId,
      provider,
      operation,
      model,
      unit,
      inputUnits,
      outputUnits,
      estimatedCostMicros,
      finalCostMicros: 0,
      currency: 'USD',
      providerRequestId,
      jobId,
    })
  }
}
