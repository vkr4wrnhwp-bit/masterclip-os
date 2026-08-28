import { AppError, type Logger } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import {
  analyzeMix,
  compareToReferences,
  computeReleaseReadiness,
  estimateTranslation,
  MixAnalysisUnavailableError,
  mixMetricDefinition,
  runMixDoctor,
  type MixMetric,
  type ReferenceProfile,
  type TranslationTarget,
} from '@masterclip/mix-analysis'
import {
  STUDIO_REFERENCE_RIGHTS_STATEMENT,
  type MixAnalysisRecord,
  type MixCurveRecord,
  type MixIssueRecord,
  type MixIssueStatus,
  type MixMetricRecord,
  type ReferenceRightsBasis,
  type StudioNoteCategory,
  type StudioReferenceRecord,
} from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'
import { LOCAL_ADAPTER, LOCAL_PROVIDER } from './processing.js'

/**
 * Mix Station.
 *
 * Runs the analyzer set against a version's audio, stores every metric with its
 * provenance, and turns the result into timestamped potential issues.
 *
 * The refusal that matters most here: when the audio cannot be decoded, the
 * analysis is marked `unsupported` with the reason, and **no metrics are
 * written**. A half-populated report reads as a diagnosis of the record rather
 * than a fact about the deployment, and an engineer acting on invented numbers
 * is worse off than one told the file could not be read.
 */
export class StudioMixService {
  constructor(private readonly deps: StudioDeps) {}

  private get logger(): Logger {
    return this.deps.logger.child({ component: 'studio-mix' })
  }

  /**
   * Executes one queued analysis.
   *
   * Called from the worker with nothing but an id, so it re-reads the analysis
   * row and checks the org itself rather than trusting the payload.
   */
  async runAnalysis(analysisId: string, orgId: string): Promise<MixAnalysisRecord> {
    const analysis = await this.deps.repos.analyses.get(orgId, analysisId)
    if (analysis.status === 'ready') return analysis

    let asset
    try {
      asset = await this.deps.platform.audioAssetRepo.get(orgId, analysis.sourceAssetId)
    } catch (err) {
      await this.deps.repos.analyses.settle(orgId, analysisId, {
        status: 'failed',
        failureReason: `the source audio could not be found: ${err instanceof Error ? err.message : String(err)}`,
      })
      return this.deps.repos.analyses.get(orgId, analysisId)
    }

    // The checksum recorded when the analysis was queued is checked against the
    // asset now. They differ only if the asset was replaced underneath us, in
    // which case measuring it would attach numbers to bytes nobody asked about.
    if (asset.checksum !== analysis.sourceChecksum) {
      await this.deps.repos.analyses.settle(orgId, analysisId, {
        status: 'failed',
        failureReason: 'the source audio changed after this analysis was queued; re-run it against the current file',
      })
      return this.deps.repos.analyses.get(orgId, analysisId)
    }

    let bytes: Uint8Array
    try {
      bytes = await this.deps.storage.getBuffer(asset.storageKey)
    } catch (err) {
      await this.deps.repos.analyses.settle(orgId, analysisId, {
        status: 'failed',
        failureReason: `the source audio could not be read from storage: ${err instanceof Error ? err.message : String(err)}`,
      })
      return this.deps.repos.analyses.get(orgId, analysisId)
    }

    try {
      const result = await analyzeMix({
        bytes,
        mimeType: asset.mimeType,
        maxSeconds: this.deps.config.STUDIO_MAX_ANALYSIS_SECONDS,
      })

      await this.deps.repos.analyses.writeMetrics(
        orgId,
        analysisId,
        result.metrics.map((metric) => ({
          metricKey: metric.key,
          value: metric.value,
          unit: metric.unit,
          confidence: metric.confidence,
          analysisMethod: metric.analysisMethod,
          provider: metric.provider,
          note: metric.note,
        })),
      )
      await this.deps.repos.analyses.writeCurves(
        orgId,
        analysisId,
        result.curves.map((curve) => ({ curveKey: curve.key, stepMs: curve.stepMs, points: curve.points })),
      )
      await this.deps.repos.analyses.settle(orgId, analysisId, {
        status: 'ready',
        durationMs: result.durationMs,
        sampleRate: result.sampleRate,
        channels: result.channels,
        bitDepth: result.bitDepth,
        // An analyzer that failed is reported even on a successful run: the
        // report has a hole in it and the user is told which.
        failureReason: result.failures.length > 0 ? result.failures.map((failure) => `${failure.analyzer}: ${failure.reason}`).join('; ') : null,
      })

      // Version metadata comes from the analysis rather than from the upload:
      // the container's own header is the only thing that actually knows.
      if (analysis.studioVersionId) {
        await this.deps.db.run('UPDATE studio_versions SET duration_ms = ?, sample_rate = ?, bit_depth = ?, channels = ? WHERE id = ? AND org_id = ?', [
          result.durationMs,
          result.sampleRate,
          result.bitDepth,
          result.channels,
          analysis.studioVersionId,
          orgId,
        ])
      }

      if (analysis.studioProjectId) {
        const issues = runMixDoctor({ metrics: result.metrics, curves: result.curves, durationMs: result.durationMs })
        await this.deps.repos.issues.replaceForAnalysis(orgId, analysis.studioProjectId, analysisId, issues)
        this.logger.info('studio.mix_analyzed', { analysis_id: analysisId, metrics: result.metrics.length, issues: issues.length })
      }

      return this.deps.repos.analyses.get(orgId, analysisId)
    } catch (err) {
      const unsupported = err instanceof MixAnalysisUnavailableError
      await this.deps.repos.analyses.settle(orgId, analysisId, {
        status: unsupported ? 'unsupported' : 'failed',
        failureReason: err instanceof Error ? err.message : String(err),
      })
      this.logger.warn('studio.mix_analysis_failed', { analysis_id: analysisId, reason: err instanceof Error ? err.message : String(err) })
      return this.deps.repos.analyses.get(orgId, analysisId)
    }
  }

  /** The full Mix Station view for one version. */
  async report(
    actor: Actor,
    projectId: string,
    versionId: string,
  ): Promise<{
    analysis: MixAnalysisRecord | null
    metrics: MixMetricRecord[]
    curves: MixCurveRecord[]
    issues: MixIssueRecord[]
    readiness: ReturnType<typeof computeReleaseReadiness> | null
  }> {
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, versionId)
    if (!analysis) return { analysis: null, metrics: [], curves: [], issues: [], readiness: null }
    const metrics = await this.deps.repos.analyses.metrics(actor.orgId, analysis.id)
    return {
      analysis,
      metrics,
      curves: await this.deps.repos.analyses.curves(actor.orgId, analysis.id),
      issues: await this.deps.repos.issues.list(actor.orgId, analysis.id),
      readiness: computeReleaseReadiness(toMixMetrics(metrics)),
    }
  }

  /**
   * Acts on one Mix Doctor finding.
   *
   * "Send to engineer" and "add note" both create a real note on the timeline,
   * labelled with the origin `mix_doctor` — a machine-drafted note stays
   * labelled for its whole life, so nobody later mistakes a detector's guess
   * for an engineer's instruction.
   */
  async actOnIssue(input: {
    actor: Actor
    issueId: string
    action: 'ignore' | 'mark_fixed' | 'add_note' | 'send_to_engineer' | 'reopen'
    assignedTo?: string | null
    category?: StudioNoteCategory
  }): Promise<{ issue: MixIssueRecord; noteId: string | null }> {
    const issue = await this.deps.repos.issues.get(input.actor.orgId, input.issueId)

    let noteId: string | null = issue.noteId
    if (input.action === 'add_note' || input.action === 'send_to_engineer') {
      const note = await this.deps.repos.notes.create({
        orgId: input.actor.orgId,
        studioProjectId: issue.studioProjectId,
        kind: 'note',
        timestampMs: issue.startMs,
        endMs: issue.endMs,
        category: input.category ?? categoryForIssue(issue.issueType),
        body: `${issue.headline} — ${issue.detail}`,
        assignedTo: input.assignedTo ?? null,
        origin: 'mix_doctor',
        sourceIssueId: issue.id,
        authorUserId: input.actor.userId,
        authorLabel: actorLabel(input.actor),
      })
      noteId = note.id
    }

    const status: MixIssueStatus =
      input.action === 'ignore'
        ? 'ignored'
        : input.action === 'mark_fixed'
          ? 'fixed'
          : input.action === 'send_to_engineer'
            ? 'sent_to_engineer'
            : 'open'

    const updated = await this.deps.repos.issues.setStatus(input.actor.orgId, issue.id, status, input.actor.userId, noteId)
    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: issue.studioProjectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: `mix_doctor.${input.action}`,
      subjectType: 'mix_issue',
      subjectId: issue.id,
      detail: issue.headline,
    })
    return { issue: updated, noteId }
  }

  // --- references ---------------------------------------------------------

  /**
   * Adds a reference track.
   *
   * The rights basis is recorded on the row, and unless the user owns or has
   * licensed the recording the reference is `derivedOnly` — Street Banker keeps
   * the measurements and discards the audio once it has been measured. Nothing
   * in Studio can play, export or regenerate a reference.
   */
  async addReference(input: {
    actor: Actor
    projectId: string
    bytes: Uint8Array
    filename: string
    label: string
    artistName: string
    title: string
    rightsBasis: ReferenceRightsBasis
    rightsConfirmed: boolean
  }): Promise<{ reference: StudioReferenceRecord; analysisId: string }> {
    if (!input.rightsConfirmed) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.reference_rights_not_confirmed',
        message: STUDIO_REFERENCE_RIGHTS_STATEMENT,
        details: { statement: STUDIO_REFERENCE_RIGHTS_STATEMENT },
      })
    }
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)

    const asset = await this.deps.platform.audioAssets.storeUpload({
      actor: input.actor,
      bytes: input.bytes,
      filename: input.filename,
      area: 'studio-reference',
      projectType: 'song_lab',
      projectId: project.id,
      assetType: 'studio_reference',
      // Generated retention, not source: a reference is measured and then let
      // go, and it must never inherit a source file's retention window.
      retentionKind: 'generated',
      rightsStatus: input.rightsBasis,
      consentRecordId: project.rightsConfirmationId,
    })

    const reference = await this.deps.repos.references.create({
      orgId: input.actor.orgId,
      studioProjectId: project.id,
      label: input.label,
      artistName: input.artistName,
      title: input.title,
      assetId: asset.id,
      rightsBasis: input.rightsBasis,
      rightsConfirmedBy: input.actor.userId,
      createdBy: input.actor.userId,
    })

    const analysis = await this.deps.repos.analyses.create({
      orgId: input.actor.orgId,
      referenceId: reference.id,
      sourceAssetId: asset.id,
      sourceChecksum: asset.checksum,
      inputKind: 'stereo_mix',
      analyzerSetVersion: this.deps.config.STUDIO_ANALYZER_SET ?? '1.0.0',
      createdBy: input.actor.userId,
    })
    await this.deps.repos.references.setAnalysis(input.actor.orgId, reference.id, analysis.id)

    const job = await this.deps.repos.processing.claim({
      orgId: input.actor.orgId,
      studioProjectId: project.id,
      jobType: 'reference_analysis',
      subjectType: 'mix_analysis',
      subjectId: analysis.id,
      provider: LOCAL_PROVIDER,
      adapter: LOCAL_ADAPTER,
      idempotencyKey: `reference_analysis:${analysis.id}`,
      // The reference's title and artist are deliberately absent from the
      // ledger request: it is a record of work performed, not a second copy of
      // what the customer is listening to.
      request: { analyzer_set: this.deps.config.STUDIO_ANALYZER_SET ?? '1.0.0', rights_basis: input.rightsBasis },
      createdBy: input.actor.userId,
    })

    await this.deps.queue.enqueue({
      queue: QUEUES.studio,
      type: JOB_TYPES.studioAnalyzeReference,
      payload: { analysisId: analysis.id, referenceId: reference.id, orgId: input.actor.orgId, jobId: job.id },
      dedupeKey: `studio.reference:${analysis.id}`,
    })

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: project.id,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'reference.added',
      subjectType: 'reference',
      subjectId: reference.id,
      detail: `${input.artistName} — ${input.title} (${input.rightsBasis})`,
    })

    return { reference, analysisId: analysis.id }
  }

  /**
   * Measures a reference and then, where the rights basis requires it, deletes
   * the audio and keeps only the numbers.
   *
   * This is the step that makes "we do not store your references" true rather
   * than a promise: the asset is removed from storage in the same job that
   * measured it.
   */
  async runReferenceAnalysis(analysisId: string, referenceId: string, orgId: string): Promise<void> {
    await this.runAnalysis(analysisId, orgId)
    const reference = await this.deps.repos.references.get(orgId, referenceId)
    if (!reference.derivedOnly || !reference.assetId) return

    try {
      const asset = await this.deps.platform.audioAssetRepo.get(orgId, reference.assetId)
      await this.deps.storage.delete(asset.storageKey)
    } catch (err) {
      // Losing the delete is not a reason to lose the measurements. It is worth
      // knowing about, so it is logged rather than swallowed.
      this.logger.warn('studio.reference_audio_not_discarded', { reference_id: referenceId, reason: err instanceof Error ? err.message : String(err) })
      return
    }
    await this.deps.repos.references.markAudioDiscarded(orgId, referenceId)
    this.logger.info('studio.reference_audio_discarded', { reference_id: referenceId })
  }

  /** Your record against your references. */
  async referenceComparison(actor: Actor, projectId: string, versionId: string) {
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, versionId)
    if (!analysis) {
      throw new AppError({ kind: 'validation', code: 'studio.not_analyzed', message: 'this version has not finished analysis yet' })
    }
    const mine = toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysis.id))

    const references = await this.deps.repos.references.list(actor.orgId, projectId)
    const profiles: ReferenceProfile[] = []
    for (const reference of references) {
      const referenceAnalysis = reference.analysisId ? await this.deps.repos.analyses.get(actor.orgId, reference.analysisId).catch(() => null) : null
      if (!referenceAnalysis || referenceAnalysis.status !== 'ready') {
        profiles.push({ referenceId: reference.id, label: reference.label, metrics: [] })
        continue
      }
      profiles.push({
        referenceId: reference.id,
        label: reference.label,
        metrics: toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, referenceAnalysis.id)),
      })
    }

    return { references, comparison: compareToReferences(mine, profiles) }
  }

  /** Translation Lab estimates for a version. */
  async translation(actor: Actor, versionId: string, targets?: TranslationTarget[]) {
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, versionId)
    if (!analysis) {
      throw new AppError({ kind: 'validation', code: 'studio.not_analyzed', message: 'this version has not finished analysis yet' })
    }
    const metrics = toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysis.id))
    return { analysisId: analysis.id, estimates: targets ? estimateTranslation(metrics, targets) : estimateTranslation(metrics) }
  }
}

/** Rehydrates stored metric rows into the analysis module's own shape. */
export function toMixMetrics(rows: MixMetricRecord[]): MixMetric[] {
  return rows.map((row) => ({
    key: row.metricKey,
    value: row.value,
    unit: (mixMetricDefinition(row.metricKey)?.unit ?? 'index') as MixMetric['unit'],
    confidence: row.confidence,
    analysisMethod: row.analysisMethod,
    provider: row.provider,
    note: row.note,
  }))
}

/** Which note category a Mix Doctor finding belongs in when it becomes a note. */
function categoryForIssue(issueType: string): StudioNoteCategory {
  switch (issueType) {
    case 'vocal_masking':
    case 'vocal_level_change':
    case 'sibilance':
      return 'vocal'
    case 'clipping':
    case 'dc_offset':
    case 'insufficient_headroom':
      return 'technical'
    case 'midrange_congestion':
    case 'low_end_buildup':
      return 'arrangement'
    default:
      return 'mix'
  }
}
