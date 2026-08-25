import { AppError } from '@masterclip/shared'
import { QUEUES, JOB_TYPES } from '@masterclip/queue'
import {
  PROVIDER_RIGHTS_REVIEW_MESSAGE,
  assertPolicyAllows,
  defaultDisclosure,
  screenRemixPrompt,
  type MusicGenerationProvider,
  type StemSeparationProvider,
} from '@masterclip/audio-core'
import { REMIX_LANES, type RemixProjectRecord, type RemixVersionRecord } from '@masterclip/audio-domain'
import type { Actor, AudioEngineDeps } from './deps.js'
import type { AudioAssetService } from './assets.js'
import { estimateMicros, parseRateCard } from './rates.js'

export interface RemixGenerateConfig {
  remixProjectId: string
  operation: 'upload_screen' | 'stems' | 'composition_plan' | 'concept' | 'inpaint'
  prompt?: string
  parentVersionId?: string
  rangeMs?: { startMs: number; endMs: number }
}

/**
 * Remix Lab Audio Engine.
 *
 * Positioning is enforced in code: owned audio in, producer-ready material out.
 * Both rights checkboxes are required to create a project; every generation
 * prompt passes imitation screening BEFORE the provider sees it; every output
 * stores full lineage; and nothing becomes "release ready" without the ordered
 * human gates (producer review → release authorization).
 */
export class RemixService {
  constructor(
    private readonly deps: AudioEngineDeps,
    private readonly audioAssets: AudioAssetService,
  ) {}

  async create(input: {
    actor: Actor
    name: string
    bytes: Uint8Array
    filename: string
    remixLane: string
    targetUse: string
    rightsConfirmed: boolean
    noImitationConfirmed: boolean
  }): Promise<RemixProjectRecord> {
    const policy = await this.deps.repos.policy.getPolicy(input.actor.orgId)
    assertPolicyAllows(policy, 'upload')
    if (!REMIX_LANES.includes(input.remixLane as (typeof REMIX_LANES)[number])) {
      throw new AppError({ kind: 'validation', code: 'remix.bad_lane', message: `remix lane must be one of ${REMIX_LANES.join(', ')}` })
    }
    // Both confirmations are load-bearing and individually required.
    if (!input.rightsConfirmed) {
      throw new AppError({
        kind: 'forbidden',
        code: 'remix.rights_required',
        message: 'you must confirm you own or control this audio, or have authorization from the rights holder',
      })
    }
    if (!input.noImitationConfirmed) {
      throw new AppError({
        kind: 'forbidden',
        code: 'remix.no_imitation_required',
        message: 'you must acknowledge that Remix Lab will not imitate another artist’s name, voice, style, lyrics, song, album, or label',
      })
    }
    const rights = defaultDisclosure('rights_confirmation')
    const rightsConsent = await this.deps.repos.consents.record({
      orgId: input.actor.orgId,
      subjectType: 'remix_project',
      subjectId: 'pending',
      consentType: 'rights_confirmation',
      policyVersion: rights.version,
      disclosureText: rights.text,
      accepted: true,
      acceptedBy: input.actor.userId,
      evidence: { filename: input.filename },
    })
    const noImitation = defaultDisclosure('remix_no_imitation')
    const noImitationConsent = await this.deps.repos.consents.record({
      orgId: input.actor.orgId,
      subjectType: 'remix_project',
      subjectId: 'pending',
      consentType: 'remix_no_imitation',
      policyVersion: noImitation.version,
      disclosureText: noImitation.text,
      accepted: true,
      acceptedBy: input.actor.userId,
      evidence: {},
    })
    const asset = await this.audioAssets.storeUpload({
      actor: input.actor,
      bytes: input.bytes,
      filename: input.filename,
      area: 'remix',
      projectType: 'remix',
      projectId: null,
      assetType: 'remix_source',
      retentionKind: 'source',
      rightsStatus: 'owner_confirmed',
      consentRecordId: rightsConsent.id,
    })
    const project = await this.deps.repos.remix.create({
      orgId: input.actor.orgId,
      name: input.name,
      sourceAudioAssetId: asset.id,
      rightsConfirmationId: rightsConsent.id,
      noImitationConfirmationId: noImitationConsent.id,
      remixLane: input.remixLane,
      targetUse: input.targetUse,
      humanReviewRequired: true,
      createdBy: input.actor.userId,
    })
    await this.deps.repos.assets.attachToProject(input.actor.orgId, asset.id, 'remix', project.id)
    return project
  }

  async enqueueOperation(actor: Actor, config: RemixGenerateConfig): Promise<string> {
    const project = await this.deps.repos.remix.get(actor.orgId, config.remixProjectId)
    const policy = await this.deps.repos.policy.getPolicy(actor.orgId)
    const settings = await this.deps.repos.policy.getSettings(actor.orgId)

    if (config.operation === 'concept' || config.operation === 'inpaint') {
      assertPolicyAllows(policy, 'generate_music')
      const prompt = config.prompt ?? ''
      const verdict = screenRemixPrompt(prompt, { protectedNames: settings.protectedNames })
      if (!verdict.allowed) {
        // The request never reaches the provider; the refusal names the policy.
        throw new AppError({
          kind: 'provider_rejected',
          code: 'remix.prompt_blocked',
          message: verdict.message ?? 'blocked prompt',
          details: { hits: verdict.hits.map((h) => h.code) },
        })
      }
    }
    if (config.operation === 'inpaint' && project.providerScreening !== 'accepted') {
      throw new AppError({
        kind: 'conflict',
        code: 'remix.upload_not_screened',
        message: 'run the owned-audio upload step before inpainting — the provider must accept the source first',
      })
    }

    const card = parseRateCard(this.deps.config)
    const estimated =
      config.operation === 'stems'
        ? estimateMicros(card, 'stems', { tracks: 1 })
        : config.operation === 'concept' || config.operation === 'inpaint'
          ? estimateMicros(card, 'music', { tracks: 1 })
          : 0
    const job = await this.deps.repos.jobs.create({
      orgId: actor.orgId,
      userId: actor.userId,
      featureKey: `audio.remix_${config.operation}`,
      provider: 'resolved-at-run',
      operation: config.operation,
      inputAssetIds: [project.sourceAudioAssetId],
      configuration: config as unknown as Record<string, unknown>,
      estimatedCostMicros: estimated,
    })
    await this.deps.queue.enqueue({
      queue: QUEUES.audio,
      type: JOB_TYPES.audioRemixGenerate,
      payload: { jobId: job.id },
      dedupeKey: `audio-remix:${job.id}`,
    })
    return job.id
  }

  /** Worker entry point for all remix operations. */
  async runOperation(jobId: string): Promise<void> {
    const job = await this.deps.repos.jobs.getAnyOrg(jobId)
    const config = job.configuration as unknown as RemixGenerateConfig
    await this.deps.repos.jobs.markRunning(jobId)
    try {
      const project = await this.deps.repos.remix.get(job.orgId, config.remixProjectId)
      const settings = await this.deps.repos.policy.getSettings(job.orgId)
      const { asset, bytes } = await this.audioAssets.materialize(job.orgId, project.sourceAudioAssetId)
      const audio = { bytes, mimeType: asset.mimeType, filename: asset.fileName }

      switch (config.operation) {
        case 'upload_screen': {
          const provider = this.deps.registry.resolve<MusicGenerationProvider>('music', settings.defaultProviders.music)
          if (!provider.uploadOwnedMusic) {
            throw new AppError({ kind: 'provider_rejected', code: 'remix.no_upload', message: `${provider.providerId} does not support owned-audio upload` })
          }
          const result = await provider.uploadOwnedMusic({ orgId: job.orgId, audio, rightsConfirmationId: project.rightsConfirmationId })
          await this.deps.repos.remix.setProviderScreening(project.id, result.screening, result.providerSongId)
          if (result.screening === 'rights_review_required') {
            // Recorded verbatim, surfaced without accusation, never auto-retried.
            await this.deps.repos.jobs.markFailed(jobId, 'remix.provider_rights_review', PROVIDER_RIGHTS_REVIEW_MESSAGE)
            return
          }
          await this.deps.repos.jobs.markComplete(jobId, [], 0)
          return
        }
        case 'stems': {
          const provider = this.deps.registry.resolve<StemSeparationProvider>('stems', settings.defaultProviders.stems)
          const result = await provider.separateStems({ orgId: job.orgId, audio })
          const assetIds: string[] = []
          for (const stem of result.stems) {
            const stored = await this.audioAssets.storeGenerated({
              orgId: job.orgId,
              ownerUserId: job.userId,
              bytes: stem.audio.bytes,
              contentType: stem.audio.contentType,
              filename: stem.audio.filename ?? `${stem.name}.wav`,
              area: 'remix',
              projectType: 'remix',
              projectId: project.id,
              assetType: 'stem',
              retentionKind: 'generated',
              rightsStatus: 'derived_from_owner_confirmed',
            })
            assetIds.push(stored.id)
            await this.addVersion(job.orgId, project, jobId, 'stem', `stem: ${stem.name}`, provider.providerId, stored.id, { stem: stem.name })
          }
          await this.recordUsage(job, provider.providerId, 'stems', result.usage?.unit ?? 'requests', result.usage?.inputUnits ?? 1, result.usage?.outputUnits ?? result.stems.length, result.usage?.providerRequestId ?? null)
          await this.deps.repos.jobs.markComplete(jobId, assetIds, job.estimatedCostMicros)
          return
        }
        case 'composition_plan': {
          const provider = this.deps.registry.resolve<MusicGenerationProvider>('music', settings.defaultProviders.music)
          if (!provider.extractCompositionPlan) {
            throw new AppError({ kind: 'provider_rejected', code: 'remix.no_plan', message: `${provider.providerId} does not support composition plans` })
          }
          const result = await provider.extractCompositionPlan({ orgId: job.orgId, sourceAudio: audio })
          await this.deps.repos.remix.setCompositionPlan(project.id, result.plan)
          await this.recordUsage(job, provider.providerId, 'composition_plan', 'requests', 1, 0, result.usage?.providerRequestId ?? null)
          await this.deps.repos.jobs.markComplete(jobId, [], job.estimatedCostMicros)
          return
        }
        case 'concept':
        case 'inpaint': {
          const provider = this.deps.registry.resolve<MusicGenerationProvider>('music', settings.defaultProviders.music)
          // Re-screen at execution time: the moderation rules that were in
          // force when the job was enqueued may have been tightened since.
          const verdict = screenRemixPrompt(config.prompt ?? '', { protectedNames: settings.protectedNames })
          if (!verdict.allowed) {
            throw new AppError({ kind: 'provider_rejected', code: 'remix.prompt_blocked', message: verdict.message ?? 'blocked prompt' })
          }
          const result =
            config.operation === 'inpaint'
              ? await (async () => {
                  if (!provider.createInpaintingVersion) {
                    throw new AppError({ kind: 'provider_rejected', code: 'remix.no_inpaint', message: `${provider.providerId} does not support inpainting` })
                  }
                  return provider.createInpaintingVersion({
                    orgId: job.orgId,
                    ...(project.providerSongId ? { providerSongId: project.providerSongId } : {}),
                    compositionPlan: project.compositionPlan ?? { prompt: config.prompt },
                    ...(config.rangeMs ? { rangeMs: config.rangeMs } : {}),
                  })
                })()
              : await provider.generateMusic({ orgId: job.orgId, prompt: config.prompt ?? '', instrumental: true })
          const stored = await this.audioAssets.storeGenerated({
            orgId: job.orgId,
            ownerUserId: job.userId,
            bytes: result.audio.bytes,
            contentType: result.audio.contentType,
            filename: result.audio.filename ?? 'concept.wav',
            area: 'remix',
            projectType: 'remix',
            projectId: project.id,
            assetType: config.operation === 'inpaint' ? 'inpainted_section' : 'concept',
            retentionKind: 'generated',
            rightsStatus: 'concept_needs_review',
          })
          await this.addVersion(job.orgId, project, jobId, config.operation, config.prompt ?? '', provider.providerId, stored.id, {
            seed: result.seed ?? null,
            rangeMs: config.rangeMs ?? null,
            compositionPlan: result.compositionPlan ?? null,
            parentVersionId: config.parentVersionId ?? null,
          })
          await this.recordUsage(job, provider.providerId, config.operation, result.usage?.unit ?? 'requests', result.usage?.inputUnits ?? 1, result.usage?.outputUnits ?? 0, result.usage?.providerRequestId ?? null)
          await this.deps.repos.jobs.markComplete(jobId, [stored.id], job.estimatedCostMicros)
          return
        }
      }
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError({ kind: 'internal', message: String(err) })
      await this.deps.repos.jobs.markFailed(jobId, appErr.code, appErr.message)
      throw err
    }
  }

  private async addVersion(orgId: string, project: RemixProjectRecord, jobId: string, versionType: string, prompt: string, provider: string, outputAssetId: string, metadata: Record<string, unknown>): Promise<RemixVersionRecord> {
    const version = await this.deps.repos.remix.addVersion(orgId, {
      remixProjectId: project.id,
      parentVersionId: (metadata.parentVersionId as string | null) ?? null,
      versionType,
      prompt,
      model: this.deps.config.ELEVENLABS_MUSIC_MODEL || provider,
      seed: metadata.seed !== null && metadata.seed !== undefined ? String(metadata.seed) : null,
      outputAssetId,
      generationMetadata: {
        ...metadata,
        provider,
        sourceAssetIds: [project.sourceAudioAssetId],
        rightsConfirmationId: project.rightsConfirmationId,
        jobId,
      },
      createdBy: 'worker',
    })
    await this.deps.repos.assets.recordGeneration({
      orgId,
      projectType: 'remix',
      projectId: project.id,
      outputAssetId,
      provider,
      model: this.deps.config.ELEVENLABS_MUSIC_MODEL || provider,
      operation: versionType,
      voiceProfileId: null,
      prompt: prompt.slice(0, 2000),
      configuration: metadata,
      rightsBasis: 'owner_confirmed_source',
      consentRecordId: project.rightsConfirmationId,
      parentGenerationId: null,
      createdBy: 'worker',
    })
    return version
  }

  private async recordUsage(job: { orgId: string; userId: string; id: string; estimatedCostMicros: number }, provider: string, operation: string, unit: string, inputUnits: number, outputUnits: number, providerRequestId: string | null): Promise<void> {
    await this.deps.repos.usage.record({
      orgId: job.orgId,
      userId: job.userId,
      projectType: 'remix',
      projectId: null,
      provider,
      operation,
      model: this.deps.config.ELEVENLABS_MUSIC_MODEL || provider,
      unit,
      inputUnits,
      outputUnits,
      estimatedCostMicros: job.estimatedCostMicros,
      finalCostMicros: 0,
      currency: 'USD',
      providerRequestId,
      jobId: job.id,
    })
  }
}
