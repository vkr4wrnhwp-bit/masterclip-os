import { AppError } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import {
  buildAlternateOutro,
  buildEarlierChorus,
  buildSectionCut,
  buildSectionDuplicate,
  buildShorterIntro,
  buildTempoExperiment,
  mapSourceToOutput,
  projectEdl,
  validateEdl,
  type BuilderContext,
  type ExperimentDefinition,
  type ExperimentEdit,
} from '@masterclip/audio-experiments'
import type { SongExperimentRecord, SongVersionRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'
import { SONG_LAB_ANALYSIS_STAGES, toDetected } from './analysis.js'

/**
 * The What If? engine.
 *
 * Every path in this service reads the source and writes somewhere else. There
 * is no method that mutates a source asset, and `accept` creates a *new*
 * version pointing at the preview rather than replacing the version it came
 * from — so the original recording remains playable, analysable and
 * downloadable after any number of experiments.
 */
export class SongExperimentService {
  constructor(private readonly deps: SongLabDeps) {}

  /**
   * Creates an experiment from a recommendation.
   *
   * Returns null when the recommendation is a writing or arrangement note
   * rather than an edit — Song Lab suggests those but will not fabricate audio
   * for them.
   */
  async createFromRecommendation(actor: Actor, projectId: string, recommendationId: string): Promise<SongExperimentRecord | null> {
    const recommendation = await this.deps.repos.observations.getRecommendation(actor.orgId, recommendationId)
    if (!recommendation.experimentSupported) return null

    const context = await this.builderContext(actor, projectId)
    const definition = this.definitionFor(recommendation.recommendationType, recommendation.title, context)
    if (!definition) return null

    return this.create({ actor, projectId, definition, recommendationId })
  }

  /** Creates an experiment from an explicit request. */
  async createExperiment(input: {
    actor: Actor
    projectId: string
    experimentType: ExperimentDefinition['experimentType']
    name?: string
    /** Seconds for cut/intro experiments, target BPM for tempo experiments. */
    amount?: number
    sectionOrderIndex?: number
    repeatFinalHook?: boolean
    /** A hand-authored edit list, for the advanced path. */
    editDecisionList?: ExperimentEdit[]
    intent?: string
  }): Promise<SongExperimentRecord> {
    const context = await this.builderContext(input.actor, input.projectId)

    let definition: ExperimentDefinition | null = null
    if (input.editDecisionList && input.editDecisionList.length > 0) {
      definition = {
        name: input.name ?? 'Custom experiment',
        experimentType: input.experimentType,
        editDecisionList: input.editDecisionList,
        bpmOverride: null,
        intent: input.intent ?? 'Custom edit list.',
      }
    } else {
      switch (input.experimentType) {
        case 'earlier_chorus':
          definition = buildEarlierChorus(context, input.amount ?? 8)
          break
        case 'shorter_intro':
          definition = buildShorterIntro(context, input.amount ?? 8)
          break
        case 'section_cut':
          definition = buildSectionCut(context, input.sectionOrderIndex ?? 0, input.amount ?? 8)
          break
        case 'section_duplicate':
          definition = buildSectionDuplicate(context, input.sectionOrderIndex ?? 0)
          break
        case 'tempo':
          definition = buildTempoExperiment(context, input.amount ?? (context.bpm ?? 0) + 4)
          break
        case 'alternate_outro':
          definition = buildAlternateOutro(context, { repeatFinalHook: input.repeatFinalHook ?? false })
          break
        default:
          definition = null
      }
    }

    if (!definition) {
      throw new AppError({
        kind: 'validation',
        code: 'song_lab.experiment_not_possible',
        message: 'this experiment cannot be built from the current structure — the sections it needs were not identified',
      })
    }
    if (input.name) definition = { ...definition, name: input.name }
    return this.create({ actor: input.actor, projectId: input.projectId, definition, recommendationId: null })
  }

  private async create(input: {
    actor: Actor
    projectId: string
    definition: ExperimentDefinition
    recommendationId: string | null
  }): Promise<SongExperimentRecord> {
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)
    if (!project.currentVersionId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'this project has no audio to experiment on' })
    }
    const version = await this.deps.repos.versions.get(input.actor.orgId, project.currentVersionId)
    const durationMs = await this.durationFor(input.actor, version)

    // Validate before persisting, so a stored edit list is always renderable.
    validateEdl(input.definition.editDecisionList, { sourceDurationMs: durationMs, availableStems: [] })
    const outcome = projectEdl(input.definition.editDecisionList, durationMs)

    const experiment = await this.deps.repos.experiments.create({
      orgId: input.actor.orgId,
      songLabProjectId: project.id,
      sourceVersionId: version.id,
      recommendationId: input.recommendationId,
      name: input.definition.name,
      experimentType: input.definition.experimentType,
      intent: input.definition.intent,
      editDecisionList: input.definition.editDecisionList,
      bpmOverride: input.definition.bpmOverride,
      predictedDurationMs: outcome.durationMs,
      createdBy: input.actor.userId,
    })

    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'song_lab.experiment.created',
      targetType: 'song_experiment',
      targetId: experiment.id,
      data: { experimentType: experiment.experimentType, edits: experiment.editDecisionList.length },
    })
    return experiment
  }

  async queueRender(actor: Actor, experimentId: string): Promise<void> {
    const experiment = await this.deps.repos.experiments.get(actor.orgId, experimentId)
    await this.deps.repos.experiments.setStatus(actor.orgId, experimentId, 'rendering')
    await this.deps.queue.enqueue({
      queue: QUEUES.songLab,
      type: JOB_TYPES.songLabRenderExperiment,
      payload: { experimentId: experiment.id, orgId: actor.orgId, userId: actor.userId },
      dedupeKey: `song_lab.render:${experiment.id}`,
    })
  }

  /**
   * Renders the preview.
   *
   * Reads the source bytes, writes a brand-new asset, and attaches it to the
   * experiment. The source asset id is never passed to a write path.
   */
  async render(experimentId: string, expectedOrgId: string): Promise<SongExperimentRecord> {
    const experiment = await this.deps.repos.experiments.getForJob(experimentId, expectedOrgId)
    try {
      const version = await this.deps.repos.versions.get(experiment.orgId, experiment.sourceVersionId)
      if (!version.sourceAssetId) {
        throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'the source version has no audio' })
      }
      const asset = await this.deps.platform.audioAssetRepo.get(experiment.orgId, version.sourceAssetId)
      const bytes = await this.deps.storage.getBuffer(asset.storageKey)

      const result = await this.deps.providers.renderer.renderExperiment({
        experimentId: experiment.id,
        sourceBytes: bytes,
        sourceMimeType: asset.mimeType,
        sourceDurationMs: asset.durationMs ?? experiment.predictedDurationMs ?? 0,
        editDecisionList: experiment.editDecisionList,
      })

      const preview = await this.deps.platform.audioAssets.storeGenerated({
        orgId: experiment.orgId,
        ownerUserId: experiment.createdBy,
        bytes: result.bytes,
        contentType: result.contentType,
        filename: `${slug(experiment.name)}-preview.wav`,
        area: 'song-lab-previews',
        projectType: 'song_lab',
        projectId: experiment.songLabProjectId,
        assetType: 'song_lab_experiment_preview',
        // Previews are reproducible from the stored edit list, so they expire
        // on the generated-audio schedule rather than the master's.
        retentionKind: 'generated',
        rightsStatus: 'derived_from_authorized_source',
      })

      await this.deps.repos.experiments.attachPreview(experiment.orgId, experiment.id, {
        assetId: preview.id,
        durationMs: result.durationMs,
        renderer: result.renderer,
        rendererVersion: result.rendererVersion,
        placeholder: result.placeholder,
      })
      return this.deps.repos.experiments.get(experiment.orgId, experiment.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.deps.repos.experiments.setStatus(experiment.orgId, experiment.id, 'failed', message)
      throw err
    }
  }

  /**
   * Accepts an experiment.
   *
   * Creates a new version whose parent is the source version and whose asset is
   * the *preview*, then points the project at it. Nothing about the source is
   * touched, so "go back to the original" is always one click.
   */
  async accept(actor: Actor, experimentId: string, versionLabel?: string): Promise<SongVersionRecord> {
    const experiment = await this.deps.repos.experiments.get(actor.orgId, experimentId)
    if (experiment.status !== 'ready') {
      throw new AppError({
        kind: 'conflict',
        code: 'song_lab.experiment_not_ready',
        message: 'render the experiment before accepting it',
      })
    }
    if (!experiment.previewAssetId) {
      throw new AppError({ kind: 'conflict', code: 'song_lab.no_preview', message: 'this experiment has no rendered preview' })
    }
    if (experiment.placeholderPreview) {
      // The preview is a placeholder because audio rendering was unavailable.
      // Accepting it would adopt a silent file as a version of the song and
      // let its meaningless measurements become the project's headline
      // figures. An artist cannot accept a version they were never able to
      // hear — the edit list survives, and this becomes acceptable the moment
      // it renders for real.
      throw new AppError({
        kind: 'conflict',
        code: 'song_lab.placeholder_preview',
        message:
          'this experiment has no real audio preview — audio rendering is unavailable on this deployment, so there is nothing to listen to before accepting it',
      })
    }

    const version = await this.deps.repos.versions.create({
      orgId: actor.orgId,
      songLabProjectId: experiment.songLabProjectId,
      parentVersionId: experiment.sourceVersionId,
      versionType: 'song_lab_experiment',
      versionLabel: versionLabel ?? experiment.name,
      sourceAssetId: experiment.previewAssetId,
      experimentId: experiment.id,
      notes: experiment.intent,
      createdBy: actor.userId,
    })

    await this.deps.repos.experiments.markAccepted(actor.orgId, experiment.id, version.id)
    await this.deps.repos.projects.setCurrentVersion(actor.orgId, experiment.songLabProjectId, version.id)
    // The lyric belongs to the song, not the take, so it follows the version.
    await this.deps.repos.lyrics.copyToVersion(actor.orgId, experiment.sourceVersionId, version.id)

    // Closed loop: a recommendation the artist actually acted on.
    if (experiment.recommendationId) {
      const link = await this.deps.repos.outcomes.findByRecommendation(actor.orgId, experiment.recommendationId)
      if (link) {
        await this.deps.repos.outcomes.markAccepted(actor.orgId, link.id)
        await this.deps.repos.outcomes.markImplemented(actor.orgId, link.id, version.id)
      }
    }

    // The accepted version is a different recording — shorter, faster, or
    // rearranged — so it needs its own analysis. Without this, "Version A →
    // Version B" would have measurements on one side only, which is exactly
    // the comparison the artist accepted the experiment in order to make.
    await this.queueAnalysisFor(actor, experiment, version.id, experiment.previewAssetId)

    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'song_lab.experiment.accepted',
      targetType: 'song_experiment',
      targetId: experiment.id,
      data: { versionId: version.id, sourceVersionId: experiment.sourceVersionId },
    })
    return version
  }

  /**
   * Queues analysis of a newly accepted version.
   *
   * Best-effort: a failure here must not undo an acceptance the artist has
   * already made, so it is logged and the version stands. The project can
   * always be reanalysed from the UI.
   */
  private async queueAnalysisFor(actor: Actor, experiment: SongExperimentRecord, versionId: string, assetId: string): Promise<void> {
    try {
      const asset = await this.deps.platform.audioAssetRepo.get(actor.orgId, assetId)
      const analysis = await this.deps.repos.analyses.create({
        orgId: actor.orgId,
        songLabProjectId: experiment.songLabProjectId,
        songVersionId: versionId,
        analysisVersion: this.deps.config.SONG_LAB_ANALYSIS_PROVIDER,
        engineVersion: SONG_LAB_ANALYSIS_STAGES.engineVersion,
        sourceChecksum: asset.checksum,
        configuration: {
          provider: this.deps.config.SONG_LAB_ANALYSIS_PROVIDER,
          acceptedExperiment: true,
          experimentId: experiment.id,
          // The edit list knows where every section moved, so the artist's
          // structure travels with the edit instead of being re-detected as
          // something else on what is, to a detector, an unfamiliar recording.
          carriedSections: await this.carrySections(actor, experiment),
        },
      })
      await this.deps.queue.enqueue({
        queue: QUEUES.songLab,
        type: JOB_TYPES.songLabAnalyzeAudio,
        payload: { analysisId: analysis.id, orgId: actor.orgId, userId: actor.userId },
        dedupeKey: `song_lab.analyze:${analysis.id}`,
      })
    } catch (err) {
      this.deps.logger.warn('song_lab.accepted_version_analysis_failed', {
        version_id: versionId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Maps the source version's sections through the edit onto the new timeline.
   *
   * A section the edit removed entirely is dropped rather than given a
   * fabricated position — `mapSourceToOutput` returns null for it, and null
   * means gone.
   */
  private async carrySections(
    actor: Actor,
    experiment: SongExperimentRecord,
  ): Promise<Array<{ sectionType: string; label: string; startMs: number; endMs: number }>> {
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, experiment.sourceVersionId)
    if (!analysis) return []
    const sections = await this.deps.repos.sections.list(actor.orgId, analysis.id)
    if (sections.length === 0) return []

    const outcome = projectEdl(experiment.editDecisionList, analysis.durationMs ?? 0)
    const carried: Array<{ sectionType: string; label: string; startMs: number; endMs: number }> = []
    for (const section of sections) {
      const startMs = mapSourceToOutput(outcome, section.startMs)
      const endMs = mapSourceToOutput(outcome, section.endMs)
      if (startMs === null || endMs === null || endMs - startMs < 1000) continue
      carried.push({ sectionType: section.sectionType, label: section.label, startMs, endMs })
    }
    return carried
  }

  /** Rejecting touches only the experiment row. */
  async reject(actor: Actor, experimentId: string): Promise<void> {
    await this.deps.repos.experiments.markRejected(actor.orgId, experimentId)
  }

  /** Where each section lands after an edit — for the A/B timeline overlay. */
  async sectionMapping(actor: Actor, experimentId: string): Promise<Array<{ label: string; sourceMs: number; outputMs: number | null }>> {
    const experiment = await this.deps.repos.experiments.get(actor.orgId, experimentId)
    const version = await this.deps.repos.versions.get(actor.orgId, experiment.sourceVersionId)
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, version.id)
    if (!analysis) return []
    const sections = await this.deps.repos.sections.list(actor.orgId, analysis.id)
    const outcome = projectEdl(experiment.editDecisionList, analysis.durationMs ?? 0)
    return sections.map((section) => ({
      label: section.label,
      sourceMs: section.startMs,
      outputMs: mapSourceToOutput(outcome, section.startMs),
    }))
  }

  private definitionFor(
    recommendationType: string,
    title: string,
    context: BuilderContext,
  ): ExperimentDefinition | null {
    switch (recommendationType) {
      case 'earlier_chorus':
        return buildEarlierChorus(context, extractSeconds(title) ?? 8)
      case 'shorter_intro':
        return buildShorterIntro(context, extractSeconds(title) ?? 8)
      case 'section_cut':
        return buildSectionCut(context, firstVerseIndex(context), extractSeconds(title) ?? 8)
      case 'tempo': {
        const delta = extractSeconds(title)
        if (!context.bpm) return null
        // "+4 BPM" / "−4 BPM" — the sign lives in the title the observation
        // generator wrote, and the builder needs an absolute target.
        const direction = title.includes('−') || title.includes('-') ? -1 : 1
        return buildTempoExperiment(context, context.bpm + direction * (delta ?? 4))
      }
      case 'tempo_change': {
        if (!context.bpm) return null
        const delta = extractSeconds(title) ?? 4
        const direction = title.includes('−') || title.trimStart().startsWith('-') ? -1 : 1
        return buildTempoExperiment(context, context.bpm + direction * delta)
      }
      case 'alternate_outro':
        return buildAlternateOutro(context, { repeatFinalHook: /hook/i.test(title) })
      default:
        return null
    }
  }

  private async builderContext(actor: Actor, projectId: string): Promise<BuilderContext> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.currentVersionId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'this project has no analysed audio' })
    }
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, project.currentVersionId)
    if (!analysis) {
      throw new AppError({ kind: 'validation', code: 'song_lab.not_analyzed', message: 'analyse this song before creating experiments' })
    }
    const sections = await this.deps.repos.sections.list(actor.orgId, analysis.id)
    return {
      sections: sections.map(toDetected),
      durationMs: analysis.durationMs ?? 0,
      bpm: analysis.bpm,
      // Meter is used only to snap cuts to bars. Where the estimate was too
      // weak to report, the builder falls back to plain seconds rather than
      // cutting on a bar line that may not exist.
      beatsPerBar: analysis.meter,
    }
  }

  private async durationFor(actor: Actor, version: SongVersionRecord): Promise<number> {
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, version.id)
    if (analysis?.durationMs) return analysis.durationMs
    if (version.sourceAssetId) {
      const asset = await this.deps.platform.audioAssetRepo.get(actor.orgId, version.sourceAssetId)
      if (asset.durationMs) return asset.durationMs
    }
    throw new AppError({
      kind: 'validation',
      code: 'song_lab.unknown_duration',
      message: 'the runtime of this recording is not known yet — run analysis first',
    })
  }
}

function extractSeconds(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

function firstVerseIndex(context: BuilderContext): number {
  return context.sections.find((section) => section.sectionType === 'verse')?.orderIndex ?? 0
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'experiment'
}
