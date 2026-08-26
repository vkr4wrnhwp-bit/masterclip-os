import { AppError } from '@masterclip/shared'
import type { SongLyricLineRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'
import type { SongLyricService } from './lyrics.js'

/**
 * Transcribing the lyric off the recording.
 *
 * Song Lab's lyric analysis — syllables per second, title placement, chorus
 * versus verse density — is only as good as the timings it has. A pasted sheet
 * has none, so those figures either go unmeasured or wait for someone to type
 * timecodes in by hand. A transcript arrives with timings attached, which is
 * what makes the per-section figures measurable at all.
 *
 * Two properties matter more than the convenience:
 *
 *   - **A transcript is a machine's guess at words.** It is stored as
 *     `transcribed` and never as `user_supplied`, and every line lands
 *     unconfirmed. The artist's own words outrank it, and the analysis knows
 *     which it is holding.
 *   - **It never overwrites a lyric a person wrote.** Someone who typed their
 *     own lyric and then presses transcribe should not lose it, so replacing a
 *     user-supplied lyric takes an explicit second decision.
 *
 * The heavy lifting is the audio layer's. This does not re-implement
 * transcription: it enqueues the platform's transcription job, so the org's
 * retention policy, zero-retention requirement, keyterms and usage accounting
 * all apply exactly as they do everywhere else.
 */

/** Below this the provider is guessing at noise, not hearing words. */
const MIN_SEGMENT_CONFIDENCE = 0.3

export interface LyricTranscriptionRequest {
  actor: Actor
  projectId: string
  /** Required to replace a lyric a person supplied. Ignored otherwise. */
  replaceUserSupplied?: boolean
  languageCode?: string
}

export class SongLyricTranscriptionService {
  constructor(
    private readonly deps: SongLabDeps,
    private readonly lyrics: SongLyricService,
  ) {}

  /**
   * Queues transcription of the current version's lyric.
   *
   * Prefers a separated vocal stem when one is ready for this exact recording:
   * a transcriber hearing only the voice makes far fewer mistakes than one
   * picking words out of a full mix.
   */
  async request(input: LyricTranscriptionRequest): Promise<{ jobId: string; source: 'isolated_stem' | 'full_mix' }> {
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)
    if (!project.currentVersionId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_version', message: 'attach audio before transcribing a lyric' })
    }
    const version = await this.deps.repos.versions.get(input.actor.orgId, project.currentVersionId)
    if (!version.sourceAssetId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'this version has no audio to transcribe' })
    }

    // The one destructive risk in this feature: a lyric someone typed is the
    // artist's own words, and a machine transcript is not an upgrade on it.
    const existing = await this.deps.repos.lyrics.list(input.actor.orgId, version.id)
    const userSupplied = existing.some((line) => line.userConfirmed)
    if (userSupplied && !input.replaceUserSupplied) {
      throw new AppError({
        kind: 'validation',
        code: 'song_lab.lyrics_user_supplied',
        message: 'this version already has a lyric you supplied; transcribing would replace it',
      })
    }

    const mix = await this.deps.platform.audioAssetRepo.get(input.actor.orgId, version.sourceAssetId)
    const stem = await this.deps.repos.vocalStems.readyForVersion(input.actor.orgId, version.id, mix.checksum)
    const assetId = stem?.stemAssetId ?? mix.id
    const source = stem?.stemAssetId ? 'isolated_stem' : 'full_mix'

    const job = await this.deps.platform.transcription.enqueue({
      orgId: input.actor.orgId,
      userId: input.actor.userId,
      config: {
        assetId,
        purpose: 'song_lab',
        songLabProjectId: project.id,
        songVersionId: version.id,
        ...(input.languageCode ? { languageCode: input.languageCode } : {}),
      },
    })

    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'song_lab.lyrics.transcribe_requested',
      targetType: 'song_version',
      targetId: version.id,
      data: { jobId: job.id, assetId, source, replacedUserSupplied: userSupplied },
    })

    return { jobId: job.id, source }
  }

  /**
   * Turns a finished transcript into lyric lines.
   *
   * Called by the worker once the platform's transcription job completes. The
   * org is proved from the transcript row before anything is written, the same
   * way every other Song Lab job proves it.
   */
  async ingest(input: {
    transcriptId: string
    orgId: string
    userId: string
    projectId: string
    versionId: string
  }): Promise<SongLyricLineRecord[]> {
    // Org-filtered in SQL: a transcript belonging to another tenant is not
    // found here rather than being read and then rejected.
    const { transcript } = await this.deps.platform.transcripts.toNormalized(input.orgId, input.transcriptId)

    const lines = transcript.segments
      // A segment the provider itself is unsure of is not a lyric line. Dropping
      // it leaves a gap, which is honest; keeping it invents words the record
      // does not contain and then counts their syllables.
      .filter((segment) => (segment.confidence ?? 1) >= MIN_SEGMENT_CONFIDENCE)
      .map((segment) => ({ text: segment.text.trim(), startMs: segment.startMs, endMs: segment.endMs }))
      .filter((line) => line.text.length > 0)

    if (lines.length === 0) {
      throw new AppError({
        kind: 'validation',
        code: 'song_lab.transcript_empty',
        message: 'the transcriber returned no words it was confident enough about to use as a lyric',
      })
    }

    const stored = await this.lyrics.setLyrics({
      actor: { orgId: input.orgId, userId: input.userId, orgRole: 'owner' },
      projectId: input.projectId,
      source: 'transcribed',
      lines,
    })

    this.deps.logger.info('song_lab.lyrics_transcribed', {
      project_id: input.projectId,
      version_id: input.versionId,
      transcript_id: input.transcriptId,
      lines: stored.length,
      dropped_low_confidence: transcript.segments.length - lines.length,
    })

    return stored
  }
}
