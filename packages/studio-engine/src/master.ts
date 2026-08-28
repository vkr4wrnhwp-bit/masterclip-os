import { AppError, type Logger } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import {
  compareMasterMetrics,
  loudnessMatchGainDb,
  masterDirectionInfo,
  metricValue,
  mixMetricDefinition,
  planMaster,
  type MasterDirection,
  type MasterPriorities,
  type MasterRenderPlan,
} from '@masterclip/mix-analysis'
import type { MasterRenditionRecord, StudioAlbumRecord } from '@masterclip/studio-domain'
import { actorLabel, STUDIO_ANALYSIS_VERSION, type Actor, type StudioDeps } from './deps.js'
import { toMixMetrics } from './mix.js'
import { LOCAL_ADAPTER, LOCAL_PROVIDER, LOCAL_RENDER_ADAPTER } from './processing.js'

/**
 * Master Station.
 *
 * Three properties this service exists to guarantee:
 *
 *   1. **The source is never touched.** A rendition writes a new asset and a
 *      new version; the mix it came from is unchanged and stays playable.
 *   2. **Comparisons are loudness-matched.** Every rendition is re-analysed
 *      after rendering, and the gain that equalises it against the source is
 *      computed and stored. A UI that plays a master without applying it is
 *      showing the user that louder is better, which is not a mastering result.
 *   3. **The chain is readable.** The plan is stored as data — every stage, its
 *      parameters, and what the planner declined to do and why.
 */
export class StudioMasterService {
  constructor(private readonly deps: StudioDeps) {}

  private get logger(): Logger {
    return this.deps.logger.child({ component: 'studio-master' })
  }

  /**
   * Plans and queues a rendition.
   *
   * Planning happens here, synchronously, so the user sees what will be done
   * *before* anything renders — including the moves the planner refused to make
   * on this particular mix.
   */
  async requestRendition(input: {
    actor: Actor
    projectId: string
    versionId: string
    direction: MasterDirection
    priorities?: MasterPriorities
    slot?: 'a' | 'b' | 'c'
  }): Promise<{ rendition: MasterRenditionRecord; plan: MasterRenderPlan }> {
    const version = await this.deps.repos.versions.get(input.actor.orgId, input.versionId)
    if (version.studioProjectId !== input.projectId) {
      throw new AppError({ kind: 'validation', code: 'studio.version_mismatch', message: 'that version belongs to a different project' })
    }
    if (!version.assetId) {
      throw new AppError({ kind: 'validation', code: 'studio.no_audio', message: 'this version has no audio to master' })
    }

    const analysis = await this.deps.repos.analyses.latestForVersion(input.actor.orgId, version.id)
    if (!analysis) {
      // Mastering without measuring would mean applying a fixed amount of gain
      // to an unknown level. The refusal is the product working correctly.
      throw new AppError({
        kind: 'validation',
        code: 'studio.not_analyzed',
        message: 'this version has not been analysed yet — Master Station needs to know what it is starting from',
      })
    }
    const sourceMetrics = toMixMetrics(await this.deps.repos.analyses.metrics(input.actor.orgId, analysis.id))
    const plan = planMaster(input.direction, sourceMetrics, input.priorities ?? {})

    const slot = input.slot ?? (await this.nextSlot(input.actor.orgId, version.id))
    const rendition = await this.deps.repos.renditions.create({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      sourceVersionId: version.id,
      slot,
      direction: input.direction,
      priorities: (input.priorities ?? {}) as Record<string, number | boolean>,
      targetLufs: plan.targetLufs,
      targetTruePeak: plan.targetTruePeakDbtp,
      renderPlan: plan,
      createdBy: input.actor.userId,
    })

    const job = await this.deps.repos.processing.claim({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      studioVersionId: version.id,
      jobType: 'master_render',
      subjectType: 'master_rendition',
      subjectId: rendition.id,
      provider: LOCAL_PROVIDER,
      // The adapter recorded here is the one requested. Which one actually ran
      // is written back on settle, because the resilient renderer decides that
      // at render time and a fallback must not be invisible.
      adapter: LOCAL_RENDER_ADAPTER,
      idempotencyKey: `master_render:${rendition.id}`,
      request: { direction: input.direction, target_lufs: plan.targetLufs, target_true_peak: plan.targetTruePeakDbtp },
      createdBy: input.actor.userId,
    })

    await this.deps.queue.enqueue({
      queue: QUEUES.studio,
      type: JOB_TYPES.studioRenderMaster,
      payload: { renditionId: rendition.id, orgId: input.actor.orgId, userId: input.actor.userId, jobId: job.id },
      dedupeKey: `studio.master:${rendition.id}`,
    })

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'master.requested',
      subjectType: 'rendition',
      subjectId: rendition.id,
      detail: `${masterDirectionInfo(input.direction).label} from ${version.label}`,
    })

    return { rendition, plan }
  }

  /** Slots fill a → b → c, then cycle: three comparisons is what a person can hold. */
  private async nextSlot(orgId: string, versionId: string): Promise<'a' | 'b' | 'c'> {
    const used = new Set(await this.deps.repos.renditions.usedSlots(orgId, versionId))
    for (const slot of ['a', 'b', 'c'] as const) {
      if (!used.has(slot)) return slot
    }
    return 'a'
  }

  /**
   * Renders a queued rendition.
   *
   * Runs in the worker. Every failure path settles the row with a reason: a
   * rendition stuck at `pending` forever is a worse outcome than one that says
   * what went wrong.
   */
  async renderRendition(renditionId: string, orgId: string, userId: string): Promise<MasterRenditionRecord> {
    const rendition = await this.deps.repos.renditions.get(orgId, renditionId)
    if (rendition.status === 'ready') return rendition

    const version = await this.deps.repos.versions.get(orgId, rendition.sourceVersionId)
    if (!version.assetId) {
      await this.deps.repos.renditions.settle(orgId, renditionId, { status: 'failed', failureReason: 'the source version has no audio' })
      return this.deps.repos.renditions.get(orgId, renditionId)
    }

    let sourceAsset
    let bytes: Uint8Array
    try {
      sourceAsset = await this.deps.platform.audioAssetRepo.get(orgId, version.assetId)
      bytes = await this.deps.storage.getBuffer(sourceAsset.storageKey)
    } catch (err) {
      await this.deps.repos.renditions.settle(orgId, renditionId, {
        status: 'failed',
        failureReason: `the source audio could not be read: ${err instanceof Error ? err.message : String(err)}`,
      })
      return this.deps.repos.renditions.get(orgId, renditionId)
    }

    const plan = rendition.renderPlan as MasterRenderPlan
    let result
    try {
      result = await this.deps.providers.masterRenderer.renderMaster({
        sourceBytes: bytes,
        sourceMimeType: sourceAsset.mimeType,
        plan,
      })
    } catch (err) {
      await this.deps.repos.renditions.settle(orgId, renditionId, {
        status: 'failed',
        failureReason: err instanceof Error ? err.message : String(err),
      })
      return this.deps.repos.renditions.get(orgId, renditionId)
    }

    const project = await this.deps.repos.projects.get(orgId, rendition.studioProjectId)
    const outputAsset = await this.deps.platform.audioAssets.storeUpload({
      actor: { userId, orgId, orgRole: 'member' },
      bytes: result.bytes,
      filename: masterFileName(project.artistName, project.title, rendition.slot, rendition.direction),
      area: 'studio-master',
      projectType: 'song_lab',
      projectId: rendition.studioProjectId,
      assetType: 'studio_master',
      retentionKind: 'generated',
      rightsStatus: 'authorized_upload',
      consentRecordId: project.rightsConfirmationId,
    })

    await this.deps.repos.renditions.settle(orgId, renditionId, {
      status: result.placeholder ? 'unsupported' : 'ready',
      renderer: result.renderer,
      rendererVersion: result.rendererVersion,
      placeholder: result.placeholder,
      outputAssetId: outputAsset.id,
      failureReason: result.placeholder ? result.note : null,
    })

    // The rendition is analysed with the same analyzer set as the source, which
    // is what makes the before/after table a comparison rather than two
    // unrelated reports.
    const outputAnalysis = await this.deps.repos.analyses.create({
      orgId,
      studioProjectId: rendition.studioProjectId,
      sourceAssetId: outputAsset.id,
      sourceChecksum: outputAsset.checksum,
      inputKind: 'stereo_mix',
      analyzerSetVersion: STUDIO_ANALYSIS_VERSION,
      createdBy: userId,
    })
    const analysisJob = await this.deps.repos.processing.claim({
      orgId,
      studioProjectId: rendition.studioProjectId,
      studioVersionId: rendition.sourceVersionId,
      jobType: 'rendition_analysis',
      subjectType: 'mix_analysis',
      subjectId: outputAnalysis.id,
      provider: LOCAL_PROVIDER,
      adapter: LOCAL_ADAPTER,
      idempotencyKey: `rendition_analysis:${outputAnalysis.id}`,
      request: { rendition_id: renditionId, analyzer_set: STUDIO_ANALYSIS_VERSION },
      createdBy: userId,
    })
    await this.deps.queue.enqueue({
      queue: QUEUES.studio,
      type: JOB_TYPES.studioAnalyzeRendition,
      payload: { analysisId: outputAnalysis.id, renditionId, orgId, jobId: analysisJob.id },
      dedupeKey: `studio.master_analyze:${outputAnalysis.id}`,
    })
    await this.deps.repos.renditions.setOutputAnalysis(orgId, renditionId, outputAnalysis.id, null)

    this.logger.info('studio.master_rendered', { rendition_id: renditionId, renderer: result.renderer, placeholder: result.placeholder })
    return this.deps.repos.renditions.get(orgId, renditionId)
  }

  /**
   * Analyses a rendition's output and computes the loudness-match gain.
   *
   * The gain is stored on the rendition rather than computed in the browser so
   * every surface — the A/B player, the album assembler, the delivery check —
   * uses the same number, and so a UI cannot accidentally omit it.
   */
  async settleRenditionAnalysis(analysisId: string, renditionId: string, orgId: string): Promise<void> {
    const rendition = await this.deps.repos.renditions.get(orgId, renditionId)
    const sourceAnalysis = await this.deps.repos.analyses.latestForVersion(orgId, rendition.sourceVersionId)
    const outputAnalysis = await this.deps.repos.analyses.get(orgId, analysisId)
    if (outputAnalysis.status !== 'ready') return

    const sourceLufs = sourceAnalysis ? metricValue(toMixMetrics(await this.deps.repos.analyses.metrics(orgId, sourceAnalysis.id)), 'integrated_lufs') : null
    const outputLufs = metricValue(toMixMetrics(await this.deps.repos.analyses.metrics(orgId, analysisId)), 'integrated_lufs')

    await this.deps.repos.renditions.setOutputAnalysis(orgId, renditionId, analysisId, loudnessMatchGainDb(sourceLufs, outputLufs))
  }

  /**
   * The A/B comparison surface.
   *
   * Returns the original and every rendition with the gain that makes them
   * comparable. A rendition whose loudness could not be measured comes back
   * with `matchGainDb: null` and `loudnessMatched: false`, so the UI can say
   * the comparison is unmatched instead of quietly presenting a louder file as
   * a better one.
   */
  async comparison(actor: Actor, projectId: string, versionId: string) {
    const version = await this.deps.repos.versions.get(actor.orgId, versionId)
    const sourceAnalysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, versionId)
    const sourceMetrics = sourceAnalysis ? toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, sourceAnalysis.id)) : []

    const renditions = await this.deps.repos.renditions.listForVersion(actor.orgId, versionId)
    const labels: Record<string, string> = {}
    for (const metric of sourceMetrics) labels[metric.key] = mixMetricDefinition(metric.key)?.label ?? metric.key

    const entries = []
    for (const rendition of renditions) {
      const outputMetrics = rendition.outputAnalysisId
        ? toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, rendition.outputAnalysisId))
        : []
      entries.push({
        rendition,
        direction: masterDirectionInfo(rendition.direction as MasterDirection),
        matchGainDb: rendition.matchGainDb,
        loudnessMatched: rendition.matchGainDb !== null,
        changes: compareMasterMetrics(sourceMetrics, outputMetrics, labels),
      })
    }

    return {
      original: { version, analysis: sourceAnalysis, metrics: sourceMetrics },
      renditions: entries,
      // Repeated on the payload so a client cannot render the comparison
      // without the sentence that makes it honest.
      note: 'Every comparison is level-matched. A master that is simply louder is not a better master, and Street Banker will not present it as one.',
    }
  }

  /**
   * Chooses a rendition and promotes it to a version.
   *
   * Choosing does not approve: it creates a `master` version that then goes
   * through the same approval gate as anything else. The two are separate
   * because "this is the one I like" and "this is what ships" are different
   * statements, often made by different people.
   */
  async chooseRendition(actor: Actor, projectId: string, renditionId: string) {
    const rendition = await this.deps.repos.renditions.get(actor.orgId, renditionId)
    if (rendition.studioProjectId !== projectId) {
      throw new AppError({ kind: 'validation', code: 'studio.rendition_mismatch', message: 'that rendition belongs to a different project' })
    }
    if (rendition.status !== 'ready' || !rendition.outputAssetId) {
      throw new AppError({ kind: 'validation', code: 'studio.rendition_not_ready', message: 'this rendition has not finished rendering' })
    }
    const asset = await this.deps.platform.audioAssetRepo.get(actor.orgId, rendition.outputAssetId)
    await this.deps.repos.renditions.choose(actor.orgId, projectId, renditionId)

    const version = await this.deps.repos.versions.create({
      orgId: actor.orgId,
      studioProjectId: projectId,
      parentVersionId: rendition.sourceVersionId,
      versionType: 'master',
      assetId: asset.id,
      assetChecksum: asset.checksum,
      sourceKind: 'master_render',
      masterRenditionId: rendition.id,
      notes: `${masterDirectionInfo(rendition.direction as MasterDirection).label} master, rendered by Street Banker Studio.`,
      createdBy: actor.userId,
    })

    await this.deps.repos.activity.record({
      orgId: actor.orgId,
      studioProjectId: projectId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      action: 'master.chosen',
      subjectType: 'rendition',
      subjectId: renditionId,
      detail: `${rendition.slot.toUpperCase()} · ${rendition.direction} → ${version.label}`,
    })

    return { rendition: await this.deps.repos.renditions.get(actor.orgId, renditionId), version }
  }

  // --- album master --------------------------------------------------------

  async createAlbum(actor: Actor, input: { title: string; artistName: string; gapDefaultMs?: number }): Promise<StudioAlbumRecord> {
    return this.deps.repos.albums.create({
      orgId: actor.orgId,
      title: input.title,
      artistName: input.artistName,
      ...(input.gapDefaultMs !== undefined ? { gapDefaultMs: input.gapDefaultMs } : {}),
      createdBy: actor.userId,
    })
  }

  /**
   * Album cohesion.
   *
   * Measures track-to-track consistency across the dimensions that make a
   * sequence feel like one record. Deliberately reports *spread*, not a verdict:
   * a record that moves is not an incoherent record, and the report says which
   * tracks sit furthest from the middle so a human can decide whether that is
   * the point.
   */
  async assessAlbum(actor: Actor, albumId: string) {
    const album = await this.deps.repos.albums.get(actor.orgId, albumId)
    const tracks = await this.deps.repos.albums.tracks(actor.orgId, albumId)

    const rows: Array<{
      trackId: string
      projectId: string
      title: string
      orderIndex: number
      gapMs: number
      metrics: Record<string, number | null>
      analysed: boolean
    }> = []

    for (const track of tracks) {
      const project = await this.deps.repos.projects.get(actor.orgId, track.studioProjectId)
      const versionId = track.studioVersionId ?? project.approvedMasterVersionId ?? project.currentVersionId
      const analysis = versionId ? await this.deps.repos.analyses.latestForVersion(actor.orgId, versionId) : null
      const metrics = analysis ? toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysis.id)) : []
      rows.push({
        trackId: track.id,
        projectId: project.id,
        title: project.title,
        orderIndex: track.orderIndex,
        gapMs: track.gapMs,
        analysed: metrics.length > 0,
        metrics: {
          integrated_lufs: metricValue(metrics, 'integrated_lufs'),
          spectral_centroid_hz: metricValue(metrics, 'spectral_centroid_hz'),
          low_energy_pct: metricValue(metrics, 'low_energy_pct'),
          vocal_presence_index: metricValue(metrics, 'vocal_presence_index'),
          stereo_width: metricValue(metrics, 'stereo_width'),
          dynamic_range_db: metricValue(metrics, 'dynamic_range_db'),
        },
      })
    }

    const analysedRows = rows.filter((row) => row.analysed)
    if (analysedRows.length < 2) {
      await this.deps.repos.albums.setCohesion(
        actor.orgId,
        albumId,
        null,
        'At least two analysed tracks are needed before cohesion means anything.',
      )
      return { album: await this.deps.repos.albums.get(actor.orgId, albumId), tracks: rows, dimensions: [], outliers: [] }
    }

    // Each dimension gets a tolerance — how much variation is normal across an
    // album — and scores how far the actual spread sits inside it.
    const DIMENSIONS: Array<{ key: string; label: string; tolerance: number; unit: string }> = [
      { key: 'integrated_lufs', label: 'Perceived loudness', tolerance: 2, unit: ' LUFS' },
      { key: 'spectral_centroid_hz', label: 'Tonality', tolerance: 500, unit: ' Hz' },
      { key: 'low_energy_pct', label: 'Low end', tolerance: 6, unit: '%' },
      { key: 'vocal_presence_index', label: 'Vocal presence', tolerance: 0.2, unit: '' },
      { key: 'stereo_width', label: 'Stereo presentation', tolerance: 0.15, unit: '' },
      { key: 'dynamic_range_db', label: 'Dynamics', tolerance: 3, unit: ' dB' },
    ]

    const dimensions = DIMENSIONS.map((dimension) => {
      const values = analysedRows.map((row) => row.metrics[dimension.key]).filter((value): value is number => value !== null)
      if (values.length < 2) {
        return { ...dimension, spread: null, score: null, detail: 'Not measured on enough tracks to compare.' }
      }
      const spread = Math.max(...values) - Math.min(...values)
      const score = Math.round(Math.max(0, Math.min(100, 100 - (spread / dimension.tolerance) * 50)))
      return {
        ...dimension,
        spread: Math.round(spread * 100) / 100,
        score,
        detail: `Tracks span ${spread.toFixed(1)}${dimension.unit} across the album.`,
      }
    })

    const scored = dimensions.filter((dimension) => dimension.score !== null)
    const cohesion = scored.length > 0 ? Math.round(scored.reduce((sum, dimension) => sum + (dimension.score ?? 0), 0) / scored.length) : null

    // Named outliers, because "cohesion is 72" is not an action and "track 4 is
    // 3.1 LUFS quieter than the rest" is.
    const outliers: Array<{ trackId: string; title: string; dimension: string; detail: string }> = []
    for (const dimension of DIMENSIONS) {
      const values = analysedRows.map((row) => ({ row, value: row.metrics[dimension.key] })).filter((entry): entry is { row: (typeof analysedRows)[number]; value: number } => entry.value !== null)
      if (values.length < 3) continue
      const mean = values.reduce((sum, entry) => sum + entry.value, 0) / values.length
      for (const entry of values) {
        const distance = Math.abs(entry.value - mean)
        if (distance > dimension.tolerance) {
          outliers.push({
            trackId: entry.row.trackId,
            title: entry.row.title,
            dimension: dimension.label,
            detail: `${distance.toFixed(1)}${dimension.unit} from the album average — worth checking whether that is intended.`,
          })
        }
      }
    }

    const report = [
      `${analysedRows.length} of ${rows.length} tracks measured.`,
      ...dimensions.filter((dimension) => dimension.score !== null).map((dimension) => `${dimension.label}: ${dimension.detail}`),
    ].join(' ')
    await this.deps.repos.albums.setCohesion(actor.orgId, albumId, cohesion, report)

    return { album: await this.deps.repos.albums.get(actor.orgId, albumId), tracks: rows, dimensions, outliers }
  }
}

/**
 * A filename an engineer can read in a folder of forty.
 *
 * Sanitized here rather than in storage because the asset service sanitizes for
 * safety, not for legibility, and a master called `untitled.wav` in a delivery
 * folder is its own kind of failure.
 */
export function masterFileName(artist: string, title: string, slot: string, direction: string): string {
  const clean = (value: string) => value.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'untitled'
  return `${clean(artist)}-${clean(title)}-master_${slot.toUpperCase()}_${clean(direction)}.wav`
}
