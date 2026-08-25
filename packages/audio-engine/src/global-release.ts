import { AppError } from '@masterclip/shared'
import { QUEUES, JOB_TYPES } from '@masterclip/queue'
import { assertPolicyAllows, defaultDisclosure, type DubbingProvider } from '@masterclip/audio-core'
import { VOICE_STRATEGIES, type DubbingProjectRecord, type DubbingTarget } from '@masterclip/audio-domain'
import type { Actor, AudioEngineDeps } from './deps.js'
import type { AudioAssetService } from './assets.js'
import type { TranscriptionService } from './transcription.js'
import { buildSrt, buildVtt } from './captions.js'
import { estimateMicros, parseRateCard } from './rates.js'

/**
 * Global Release Pack — localized campaign versions with a human QA gate.
 *
 * Workflow: upload → rights confirmation → transcription → transcript review →
 * dubbing (one provider project per target language) → quality review →
 * approve → export. Machine output is never marked release-ready by machines:
 * the approve step is a human with `admin` access, and export requires it.
 */
export class GlobalReleaseService {
  constructor(
    private readonly deps: AudioEngineDeps,
    private readonly audioAssets: AudioAssetService,
    private readonly transcription: TranscriptionService,
  ) {}

  async create(input: {
    actor: Actor
    name: string
    bytes: Uint8Array
    filename: string
    sourceLanguage: string
    targetLanguages: string[]
    voiceStrategy: (typeof VOICE_STRATEGIES)[number]
    rightsConfirmed: boolean
  }): Promise<DubbingProjectRecord> {
    const policy = await this.deps.repos.policy.getPolicy(input.actor.orgId)
    assertPolicyAllows(policy, 'upload')
    assertPolicyAllows(policy, 'dub')
    if (!input.rightsConfirmed) {
      throw new AppError({
        kind: 'forbidden',
        code: 'audio.rights_required',
        message: 'localization requires confirming you hold the rights to this content for the selected territories',
      })
    }
    if (input.targetLanguages.length === 0) {
      throw new AppError({ kind: 'validation', code: 'dubbing.no_targets', message: 'select at least one target language' })
    }
    if (!VOICE_STRATEGIES.includes(input.voiceStrategy)) {
      throw new AppError({ kind: 'validation', code: 'dubbing.bad_strategy', message: `voice strategy must be one of ${VOICE_STRATEGIES.join(', ')}` })
    }
    const disclosure = defaultDisclosure('dubbing_authorization')
    const consent = await this.deps.repos.consents.record({
      orgId: input.actor.orgId,
      subjectType: 'dubbing_project',
      subjectId: 'pending',
      consentType: 'dubbing_authorization',
      policyVersion: disclosure.version,
      disclosureText: disclosure.text,
      accepted: true,
      acceptedBy: input.actor.userId,
      evidence: { filename: input.filename, targetLanguages: input.targetLanguages },
    })
    const asset = await this.audioAssets.storeUpload({
      actor: input.actor,
      bytes: input.bytes,
      filename: input.filename,
      area: 'dubbing',
      projectType: 'global_release',
      projectId: null,
      assetType: 'dubbing_source',
      retentionKind: 'source',
      rightsStatus: 'rights_confirmed',
      consentRecordId: consent.id,
    })
    const project = await this.deps.repos.dubbing.create({
      orgId: input.actor.orgId,
      name: input.name,
      sourceAssetId: asset.id,
      sourceLanguage: input.sourceLanguage,
      targets: input.targetLanguages.map((language) => ({ language, providerJobId: null, status: 'pending', assetId: null, subtitleAssetId: null })),
      voiceStrategy: input.voiceStrategy,
      rightsConfirmationId: consent.id,
      humanReviewRequired: true,
      reviewNote: '',
      createdBy: input.actor.userId,
    })
    await this.deps.repos.assets.attachToProject(input.actor.orgId, asset.id, 'global_release', project.id)
    await this.deps.repos.dubbing.setStatus(project.id, 'transcribing')
    await this.transcription.enqueue({
      orgId: input.actor.orgId,
      userId: input.actor.userId,
      config: { assetId: asset.id, purpose: 'dubbing', dubbingProjectId: project.id, languageCode: input.sourceLanguage },
    })
    return project
  }

  /** Human sign-off on the corrected transcript starts the dubbing runs. */
  async approveTranscript(actor: Actor, projectId: string): Promise<void> {
    const project = await this.deps.repos.dubbing.get(actor.orgId, projectId)
    if (project.status !== 'transcript_review') {
      throw new AppError({ kind: 'conflict', code: 'dubbing.not_in_transcript_review', message: `project is ${project.status}` })
    }
    await this.deps.repos.dubbing.setStatus(projectId, 'dubbing')
    await this.deps.queue.enqueue({
      queue: QUEUES.audio,
      type: JOB_TYPES.audioDubbingSubmit,
      payload: { projectId },
      dedupeKey: `audio-dub-submit:${projectId}`,
    })
  }

  /** Worker: one provider dubbing project per pending target language. */
  async runSubmit(projectId: string): Promise<void> {
    const project = await this.deps.repos.dubbing.getAnyOrg(projectId)
    const policy = await this.deps.repos.policy.getPolicy(project.orgId)
    assertPolicyAllows(policy, 'dub')
    const settings = await this.deps.repos.policy.getSettings(project.orgId)
    const provider = this.deps.registry.resolve<DubbingProvider>('dubbing', settings.defaultProviders.dubbing)
    const { asset, bytes } = await this.audioAssets.materialize(project.orgId, project.sourceAssetId)
    const targets: DubbingTarget[] = []
    for (const target of project.targets) {
      if (target.status !== 'pending') {
        targets.push(target)
        continue
      }
      try {
        const result = await provider.createDubbingProject({
          orgId: project.orgId,
          source: { bytes, mimeType: asset.mimeType, filename: asset.fileName },
          sourceLanguage: project.sourceLanguage,
          targetLanguages: [target.language],
          zeroRetention: false,
        })
        targets.push({ ...target, providerJobId: result.providerJobId, status: 'dubbing' })
      } catch (err) {
        targets.push({ ...target, status: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }
    await this.deps.repos.dubbing.updateTargets(projectId, targets)
    const minutes = asset.durationMs ? asset.durationMs / 60_000 : 0
    await this.deps.repos.usage.record({
      orgId: project.orgId,
      userId: project.createdBy,
      projectType: 'global_release',
      projectId,
      provider: provider.providerId,
      operation: 'dubbing',
      model: 'dubbing',
      unit: 'seconds',
      inputUnits: Math.round(minutes * 60),
      outputUnits: targets.filter((t) => t.status === 'dubbing').length,
      estimatedCostMicros: estimateMicros(parseRateCard(this.deps.config), 'dubbing', { minutes, languages: targets.length }),
      finalCostMicros: 0,
      currency: 'USD',
      providerRequestId: null,
      jobId: null,
    })
    await this.deps.queue.enqueue({
      queue: QUEUES.audio,
      type: JOB_TYPES.audioDubbingPoll,
      payload: { projectId },
      dedupeKey: `audio-dub-poll:${projectId}`,
    })
  }

  /** Worker: polls targets; when a language is ready, downloads and stores it. */
  async runPoll(projectId: string): Promise<{ done: boolean }> {
    const project = await this.deps.repos.dubbing.getAnyOrg(projectId)
    const settings = await this.deps.repos.policy.getSettings(project.orgId)
    const provider = this.deps.registry.resolve<DubbingProvider>('dubbing', settings.defaultProviders.dubbing)
    const targets: DubbingTarget[] = []
    for (const target of project.targets) {
      if (target.status !== 'dubbing' || !target.providerJobId) {
        targets.push(target)
        continue
      }
      try {
        const status = await provider.getDubbingStatus(target.providerJobId)
        if (status.status === 'failed') {
          targets.push({ ...target, status: 'failed', error: status.error ?? 'provider reported failure' })
          continue
        }
        if (status.status !== 'complete') {
          targets.push(target)
          continue
        }
        const dubbed = await provider.downloadDubbingAsset(target.providerJobId, target.language)
        const dubbedAsset = await this.audioAssets.storeGenerated({
          orgId: project.orgId,
          ownerUserId: project.createdBy,
          bytes: dubbed.bytes,
          contentType: dubbed.contentType,
          filename: dubbed.filename ?? `dub-${target.language}`,
          area: 'dubbing',
          projectType: 'global_release',
          projectId,
          assetType: 'dubbed_audio',
          retentionKind: 'generated',
          rightsStatus: 'derived_from_confirmed_rights',
        })
        const subtitleAssetId = await this.storeCaptions(project, target.language)
        targets.push({ ...target, status: 'ready', assetId: dubbedAsset.id, subtitleAssetId })
      } catch (err) {
        targets.push({ ...target, status: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }
    await this.deps.repos.dubbing.updateTargets(projectId, targets)
    const pending = targets.some((t) => t.status === 'dubbing')
    if (!pending) {
      const anyReady = targets.some((t) => t.status === 'ready')
      await this.deps.repos.dubbing.setStatus(projectId, anyReady ? 'quality_review' : 'failed')
    }
    return { done: !pending }
  }

  /** Captions come from OUR reviewed transcript, not the provider's. */
  private async storeCaptions(project: DubbingProjectRecord, language: string): Promise<string | null> {
    if (!project.transcriptId) return null
    const segments = await this.deps.repos.transcripts.segments(project.orgId, project.transcriptId)
    if (segments.length === 0) return null
    const store = (content: string, extension: 'srt' | 'vtt') =>
      this.audioAssets.storeGenerated({
        orgId: project.orgId,
        ownerUserId: project.createdBy,
        bytes: new TextEncoder().encode(content),
        contentType: extension === 'srt' ? 'application/x-subrip' : 'text/vtt',
        filename: `captions-${language}.${extension}`,
        area: 'dubbing',
        projectType: 'global_release',
        projectId: project.id,
        assetType: `captions_${extension}`,
        retentionKind: 'generated',
        rightsStatus: 'derived_from_confirmed_rights',
      })
    const srtAsset = await store(buildSrt(segments), 'srt')
    await store(buildVtt(segments), 'vtt')
    return srtAsset.id
  }

  async approve(actor: Actor, projectId: string, note: string): Promise<void> {
    await this.deps.repos.dubbing.approve(actor.orgId, projectId, actor.userId)
    if (note) {
      await this.deps.db.run('UPDATE dubbing_projects SET review_note = ? WHERE id = ? AND org_id = ?', [note, projectId, actor.orgId])
    }
    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'audio.dubbing_approved',
      targetType: 'dubbing_project',
      targetId: projectId,
      data: { note },
    })
  }

  async export(actor: Actor, projectId: string): Promise<Array<{ language: string; url: string }>> {
    const project = await this.deps.repos.dubbing.get(actor.orgId, projectId)
    if (project.status !== 'approved' && project.status !== 'exported') {
      throw new AppError({
        kind: 'forbidden',
        code: 'dubbing.not_approved',
        message: 'export requires human quality approval — machine translation is not automatically release-ready',
      })
    }
    const policy = await this.deps.repos.policy.getPolicy(actor.orgId)
    assertPolicyAllows(policy, 'export')
    const out: Array<{ language: string; url: string }> = []
    for (const target of project.targets) {
      if (target.status !== 'ready' || !target.assetId) continue
      const asset = await this.deps.repos.assets.get(actor.orgId, target.assetId)
      out.push({ language: target.language, url: await this.deps.storage.signedUrl(asset.storageKey, 3600) })
    }
    await this.deps.repos.dubbing.markExported(actor.orgId, projectId)
    return out
  }
}
