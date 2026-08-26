import { AppError } from '@masterclip/shared'
import { QUEUES, JOB_TYPES } from '@masterclip/queue'
import {
  assembleKeyterms,
  assertPolicyAllows,
  assertZeroRetentionSatisfiable,
  retentionExpiresAt,
  BASE_INDUSTRY_KEYTERMS,
  type AudioTranscriptionProvider,
} from '@masterclip/audio-core'
import type { AudioJobRecord, TranscriptRecord } from '@masterclip/audio-domain'
import type { AudioEngineDeps } from './deps.js'
import type { AudioAssetService } from './assets.js'
import { estimateMicros, parseRateCard } from './rates.js'

export interface TranscriptionJobConfig {
  assetId: string
  purpose: 'meeting' | 'dubbing' | 'library' | 'song_lab'
  meetingId?: string
  dubbingProjectId?: string
  /**
   * Set when `purpose` is `song_lab`, so the worker can hand the finished
   * transcript back to the version whose lyric it is. Transcription itself
   * stays ignorant of what Song Lab does with the words.
   */
  songLabProjectId?: string
  songVersionId?: string
  languageCode?: string
  numSpeakers?: number
}

/**
 * The transcription pipeline: enqueue from a route, execute in the worker.
 * Policy (including the zero-retention gate) is re-checked at execution time —
 * a policy tightened between enqueue and run wins.
 */
export class TranscriptionService {
  constructor(
    private readonly deps: AudioEngineDeps,
    private readonly audioAssets: AudioAssetService,
  ) {}

  async enqueue(input: { orgId: string; userId: string; config: TranscriptionJobConfig }): Promise<AudioJobRecord> {
    const asset = await this.deps.repos.assets.get(input.orgId, input.config.assetId)
    const minutes = asset.durationMs ? asset.durationMs / 60_000 : 0
    const settings = await this.deps.repos.policy.getSettings(input.orgId)
    const provider = this.deps.registry.resolve<AudioTranscriptionProvider>('transcription', settings.defaultProviders.transcription)
    const job = await this.deps.repos.jobs.create({
      orgId: input.orgId,
      userId: input.userId,
      featureKey: 'audio.transcription',
      provider: provider.providerId,
      operation: 'transcription',
      inputAssetIds: [asset.id],
      configuration: input.config as unknown as Record<string, unknown>,
      estimatedCostMicros: estimateMicros(parseRateCard(this.deps.config), 'transcription', { minutes }),
    })
    await this.deps.queue.enqueue({
      queue: QUEUES.audio,
      type: JOB_TYPES.audioTranscribe,
      payload: { jobId: job.id },
      dedupeKey: `audio-transcribe:${job.id}`,
    })
    return job
  }

  /** Worker entry point. */
  async run(jobId: string): Promise<TranscriptRecord> {
    const job = await this.deps.repos.jobs.getAnyOrg(jobId)
    const config = job.configuration as unknown as TranscriptionJobConfig
    await this.deps.repos.jobs.markRunning(job.id)
    try {
      const policy = await this.deps.repos.policy.getPolicy(job.orgId)
      assertPolicyAllows(policy, 'transcribe')

      const settings = await this.deps.repos.policy.getSettings(job.orgId)
      const provider = this.deps.registry.resolve<AudioTranscriptionProvider>('transcription', settings.defaultProviders.transcription)
      const requireZero = policy.requireZeroRetention || this.deps.config.ZERO_RETENTION_REQUIRED
      assertZeroRetentionSatisfiable(
        { ...policy, requireZeroRetention: requireZero },
        provider.providerId,
        provider.supportsZeroRetention('transcription'),
      )

      const { asset, bytes } = await this.audioAssets.materialize(job.orgId, config.assetId)
      const orgKeyterms = await this.deps.repos.policy.listKeyterms(job.orgId)
      const keyterms = assembleKeyterms([...BASE_INDUSTRY_KEYTERMS, ...orgKeyterms])

      const result = await provider.transcribe({
        orgId: job.orgId,
        audio: { bytes, mimeType: asset.mimeType, filename: asset.fileName },
        diarize: true,
        timestamps: 'word',
        tagAudioEvents: true,
        keyterms,
        entityDetection: true,
        zeroRetention: requireZero,
        ...(config.languageCode ? { languageCode: config.languageCode } : {}),
        ...(config.numSpeakers !== undefined ? { numSpeakers: config.numSpeakers } : {}),
      })
      if (result.status !== 'complete' || !result.transcript) {
        // Async webhook-delivered transcripts park the job; the webhook
        // processor completes it. The mock and sync paths never land here.
        await this.deps.repos.jobs.markAwaitingProvider(job.id, result.providerJobId)
        throw new AppError({
          kind: 'provider_unavailable',
          code: 'audio.transcription_async',
          message: 'transcription is processing provider-side; awaiting webhook delivery',
        })
      }

      const transcript = await this.deps.repos.transcripts.createFromNormalized({
        orgId: job.orgId,
        audioAssetId: asset.id,
        provider: provider.providerId,
        transcript: result.transcript,
        retentionExpiresAt: retentionExpiresAt(policy, 'transcript', this.deps.clock.now()),
      })

      if (result.usage) {
        await this.deps.repos.usage.record({
          orgId: job.orgId,
          userId: job.userId,
          projectType: config.purpose,
          projectId: config.meetingId ?? config.dubbingProjectId ?? null,
          provider: provider.providerId,
          operation: 'transcription',
          model: this.deps.config.ELEVENLABS_STT_MODEL,
          unit: result.usage.unit,
          inputUnits: result.usage.inputUnits,
          outputUnits: result.usage.outputUnits,
          estimatedCostMicros: job.estimatedCostMicros,
          finalCostMicros: 0,
          currency: 'USD',
          providerRequestId: result.usage.providerRequestId ?? null,
          jobId: job.id,
        })
      }

      await this.deps.repos.jobs.markComplete(job.id, [], job.estimatedCostMicros)
      await this.routeCompletion(config, transcript)
      return transcript
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'audio.transcription_async')) {
        const appErr = err instanceof AppError ? err : new AppError({ kind: 'internal', message: String(err) })
        await this.deps.repos.jobs.markFailed(job.id, appErr.code, appErr.message)
        if (config.meetingId) await this.deps.repos.meetings.setStatus(config.meetingId, 'failed')
        if (config.dubbingProjectId) await this.deps.repos.dubbing.setStatus(config.dubbingProjectId, 'failed')
      }
      throw err
    }
  }

  private async routeCompletion(config: TranscriptionJobConfig, transcript: TranscriptRecord): Promise<void> {
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
}
