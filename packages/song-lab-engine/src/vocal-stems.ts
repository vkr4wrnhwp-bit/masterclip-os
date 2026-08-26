import { AppError } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import type { StemSeparationProvider } from '@masterclip/audio-core'
import type { SongVocalStemRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'
import type { SongLabProjectService } from './projects.js'

/**
 * Vocal-stem separation for measurement.
 *
 * Song Lab's vocal figures — occupancy, time to first vocal, phrase length,
 * rest ratio, held notes — are normally inferred from the full mix by a
 * spectral proxy. The proxy is capped at low confidence on purpose: it scores
 * band energy, tonality and centroid movement, so a dense guitar arrangement
 * reads as vocal and the detector has no way to know it is wrong.
 *
 * Separating the vocal replaces that inference with a measurement. This service
 * is the only path to that uplift, and it exists as an explicit action rather
 * than an automatic step for two reasons: separation costs the organization
 * provider spend, and Song Lab is the diagnostic layer — it should not spend an
 * artist's budget on its own initiative.
 *
 * What it will not do:
 *
 *   - Touch the original recording. The stem is a new, derived asset.
 *   - Guess which stem is the vocal. A provider that returns an archive or a
 *     set of unrecognised names yields `unsupported`, and the vocal figures
 *     stay on the mix-based proxy where they belong.
 *   - Reuse a stem across recordings. The source checksum is pinned, so an
 *     edited version re-separates rather than inheriting its parent's vocal.
 *
 * A ready stem changes nothing on its own. The vocal figures live on an
 * analysis row, and that row was computed before the stem existed, so
 * separation finishes by queueing a reanalysis — otherwise the organization
 * pays a provider for a measurement that is never taken. See `applyToAnalysis`
 * for the two cases where it deliberately does not.
 */

/**
 * Stem names that mean "the lead vocal", lower-cased.
 *
 * Deliberately a closed list. Matching loosely — anything containing "vo" —
 * would eventually pick up a backing-vocal or vocoder stem and measure the
 * wrong audio while claiming isolated-stem confidence.
 *
 * A bare `lead` is excluded for the same reason: it is at least as likely to be
 * a lead instrument as a lead vocal, and there is no way to tell from the name.
 * An unrecognised name costs a fallback to the mix; a wrongly recognised one
 * puts stem-level confidence on a measurement of a guitar.
 */
const VOCAL_STEM_NAMES = new Set([
  'vocal',
  'vocals',
  'voice',
  'lead_vocal',
  'lead-vocal',
  'leadvocals',
  'lead_vocals',
  'lead-vocals',
  'vocals_lead',
])

/** Normalizes `Vocals (Lead).wav` → `vocals_lead` before matching. */
export function normalizeStemName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function findVocalStem<T extends { name: string }>(stems: readonly T[]): T | null {
  for (const stem of stems) {
    if (VOCAL_STEM_NAMES.has(normalizeStemName(stem.name))) return stem
  }
  return null
}

export class SongVocalStemService {
  constructor(
    private readonly deps: SongLabDeps,
    private readonly projects: SongLabProjectService,
  ) {}

  /**
   * Queues separation for a version, or returns the attempt already covering it.
   *
   * Idempotent against the source checksum: asking twice for the same audio
   * returns the existing row rather than paying the provider twice.
   */
  async request(actor: Actor, projectId: string, versionId: string): Promise<SongVocalStemRecord> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    const version = await this.deps.repos.versions.get(actor.orgId, versionId)
    if (version.songLabProjectId !== project.id) {
      throw new AppError({ kind: 'validation', code: 'song_lab.version_mismatch', message: 'that version belongs to another project' })
    }
    if (!version.sourceAssetId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'this version has no audio to separate' })
    }
    const asset = await this.deps.platform.audioAssetRepo.get(actor.orgId, version.sourceAssetId)

    const existing = await this.deps.repos.vocalStems.latestForVersion(actor.orgId, versionId)
    // Only a still-relevant attempt short-circuits: a failure against the same
    // audio is worth retrying, but a pending or ready one is not worth paying
    // for again.
    if (existing && existing.sourceChecksum === asset.checksum && (existing.status === 'pending' || existing.status === 'ready')) {
      return existing
    }

    const provider = this.resolveProvider()
    const record = await this.deps.repos.vocalStems.create({
      orgId: actor.orgId,
      songLabProjectId: project.id,
      songVersionId: version.id,
      sourceAssetId: asset.id,
      sourceChecksum: asset.checksum,
      provider: provider.providerId,
      modelVersion: 'stem-separation',
      createdBy: actor.userId,
    })

    await this.deps.queue.enqueue({
      queue: QUEUES.songLab,
      type: JOB_TYPES.songLabSeparateVocal,
      payload: { vocalStemId: record.id, orgId: actor.orgId },
      dedupeKey: `song_lab.vocal_stem:${record.id}`,
    })

    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'song_lab.vocal_stem.requested',
      targetType: 'song_version',
      targetId: version.id,
      data: { provider: provider.providerId, sourceAssetId: asset.id, vocalStemId: record.id },
    })

    return record
  }

  /**
   * Runs a queued separation to completion.
   *
   * Called by the worker with only a row id; the org is read from the row and
   * proved against the job's claimed org, exactly as the analysis job does.
   */
  async run(vocalStemId: string, expectedOrgId: string): Promise<SongVocalStemRecord> {
    const record = await this.deps.repos.vocalStems.getAnyOrg(vocalStemId)
    if (record.orgId !== expectedOrgId) {
      throw new AppError({ kind: 'forbidden', code: 'song_lab.cross_tenant_job', message: 'vocal stem belongs to another organization' })
    }
    if (record.status !== 'pending') return record

    const asset = await this.deps.platform.audioAssetRepo.get(record.orgId, record.sourceAssetId)
    // The mix may have been replaced between queueing and running. Measuring a
    // stem of the old audio against the new would be worse than not having one.
    if (asset.checksum !== record.sourceChecksum) {
      await this.deps.repos.vocalStems.markFailed(record.id, 'failed', 'the source recording changed after separation was requested')
      return this.deps.repos.vocalStems.get(record.orgId, record.id)
    }

    const provider = this.resolveProvider()
    try {
      const bytes = await this.deps.storage.getBuffer(asset.storageKey)
      const result = await provider.separateStems({
        orgId: record.orgId,
        audio: { bytes, mimeType: asset.mimeType, filename: asset.fileName },
      })

      const vocal = findVocalStem(result.stems)
      if (!vocal) {
        const returned = result.stems.map((stem) => stem.name).join(', ') || 'nothing'
        await this.deps.repos.vocalStems.markFailed(
          record.id,
          'unsupported',
          `${provider.providerId} returned ${returned}, none of which is an isolated lead vocal`,
        )
        this.deps.logger.info('song_lab.vocal_stem_unsupported', { vocal_stem_id: record.id, provider: provider.providerId, stems: returned })
        return this.deps.repos.vocalStems.get(record.orgId, record.id)
      }

      const stored = await this.deps.platform.audioAssets.storeGenerated({
        orgId: record.orgId,
        ownerUserId: record.createdBy,
        bytes: vocal.audio.bytes,
        contentType: vocal.audio.contentType,
        filename: vocal.audio.filename ?? `${vocal.name}.wav`,
        area: 'song_lab',
        projectType: 'song_lab',
        projectId: record.songLabProjectId,
        assetType: 'stem',
        retentionKind: 'generated',
        rightsStatus: 'derived_from_owner_confirmed',
      })

      await this.deps.repos.vocalStems.markReady(record.id, { stemAssetId: stored.id, stemName: vocal.name })
      this.deps.logger.info('song_lab.vocal_stem_ready', { vocal_stem_id: record.id, asset_id: stored.id, provider: provider.providerId })
      await this.applyToAnalysis(record)
      return this.deps.repos.vocalStems.get(record.orgId, record.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.deps.repos.vocalStems.markFailed(record.id, 'failed', message)
      this.deps.logger.error('song_lab.vocal_stem_failed', { vocal_stem_id: record.id, err: message })
      throw err
    }
  }

  /**
   * Re-measures the song now that the voice can actually be heard.
   *
   * The vocal figures are stored on an analysis row, and that row was computed
   * from the mix before this stem existed. Nothing re-reads it, so without this
   * the organization pays for a separation whose result is never measured, and
   * the project keeps reporting `full_mix` at proxy confidence with no
   * indication that better numbers are available for the asking.
   *
   * Reanalysis is safe to do unprompted because it is additive: it writes a new
   * row, leaves the previous one readable, and carries forward every section a
   * person confirmed.
   *
   * Two cases where it deliberately does nothing:
   *
   *   - **The version moved on.** A new master uploaded while separation ran
   *     makes this stem a stem of the previous recording. Reanalysing the
   *     current version would spend a full analysis to discover no stem
   *     applies. The stem is kept: reverting to that version finds it again.
   *   - **Queueing fails.** The stem itself is stored and correct, so failing
   *     the job would be a lie about what happened — and retrying it would
   *     short-circuit on the now-ready row without re-attempting this. The
   *     error is logged and the UI still offers re-measuring by hand.
   */
  private async applyToAnalysis(record: SongVocalStemRecord): Promise<void> {
    try {
      const project = await this.deps.repos.projects.get(record.orgId, record.songLabProjectId)
      if (project.currentVersionId !== record.songVersionId) {
        this.deps.logger.info('song_lab.vocal_stem_superseded', {
          vocal_stem_id: record.id,
          stem_version_id: record.songVersionId,
          current_version_id: project.currentVersionId,
        })
        return
      }

      const analysisId = await this.projects.queueAnalysis(
        { orgId: record.orgId, userId: record.createdBy, orgRole: 'owner' },
        record.songLabProjectId,
        record.songVersionId,
        record.sourceChecksum,
      )
      this.deps.logger.info('song_lab.vocal_stem_remeasure_queued', { vocal_stem_id: record.id, analysis_id: analysisId })
    } catch (err) {
      this.deps.logger.error('song_lab.vocal_stem_remeasure_failed', {
        vocal_stem_id: record.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private resolveProvider(): StemSeparationProvider {
    return this.deps.platform.providerRegistry.resolve<StemSeparationProvider>('stems')
  }
}
