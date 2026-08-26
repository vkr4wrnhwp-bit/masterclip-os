import { AppError } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import {
  LOW_SAMPLE_THRESHOLD,
  compareToCohort,
  defaultCohortDefinitions,
  describeCohort,
  generateObservations,
  topThingsWorthTesting,
  type BenchmarkComparison,
  type CohortFilterDefinition,
  type CohortSourceDefinition,
  type SongObservationDraft,
} from '@masterclip/music-benchmarking'
import { registerMetrics, repeatedSectionContrasts } from '@masterclip/song-structure'
import type { SectionFeatures, DetectedSection } from '@masterclip/song-analysis'
import type { BenchmarkCohortRecord, SongObservationRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'
import { toDetected, toSectionFeatures } from './analysis.js'

/**
 * Benchmarking and observation generation.
 *
 * Cohort values are pulled from stored per-song features where a cohort has
 * them, and from the configured benchmark provider otherwise. Either way the
 * sample size and provenance travel with the result, and a small cohort is
 * flagged rather than quietly presented as authoritative.
 */
export class SongBenchmarkService {
  constructor(private readonly deps: SongLabDeps) {}

  /** Cohorts this organization may actually see. */
  async listCohorts(actor: Actor, entitledToProprietary: boolean): Promise<Array<BenchmarkCohortRecord & { definition: string; lowSample: boolean }>> {
    const cohorts = await this.deps.repos.cohorts.listVisible(actor.orgId, entitledToProprietary)
    return cohorts.map((cohort) => ({
      ...cohort,
      definition: describeCohort(cohort),
      lowSample: cohort.sampleSize < LOW_SAMPLE_THRESHOLD,
    }))
  }

  /** Publishes the built-in cohorts. Idempotent — safe on every boot. */
  async ensureDefaultCohorts(createdBy = 'system'): Promise<void> {
    for (const definition of defaultCohortDefinitions()) {
      const existing = await this.deps.repos.cohorts.findByName(null, definition.name)
      if (existing) continue
      await this.deps.repos.cohorts.create({
        orgId: null,
        ...definition,
        providerId: this.deps.providers.benchmarks.providerId,
        createdBy,
      })
    }
  }

  async createCustomCohort(input: {
    actor: Actor
    name: string
    description: string
    filterDefinition: CohortFilterDefinition
    sourceDefinition?: CohortSourceDefinition
  }): Promise<BenchmarkCohortRecord> {
    // A custom cohort inherits the provider's provenance unless the caller
    // supplies its own. It never gets an empty one: `validateCohortDefinition`
    // rejects that, which is what keeps every published cohort attributable.
    const sourceDefinition: CohortSourceDefinition = input.sourceDefinition ?? {
      sources: [
        {
          kind: 'internal_analysis',
          name: `${this.deps.providers.benchmarks.providerId} distributions`,
          basis: 'Derived from the configured Song Lab benchmark provider. No master recordings are stored.',
          capturedAt: this.deps.clock.isoNow(),
          storesMasters: false,
        },
      ],
      notes: `Custom cohort built by ${input.actor.userId}.`,
    }

    const cohort = await this.deps.repos.cohorts.create({
      orgId: input.actor.orgId,
      name: input.name,
      description: input.description,
      cohortType: 'custom',
      filterDefinition: input.filterDefinition,
      sourceDefinition,
      sampleSize: 0,
      status: 'draft',
      proprietary: false,
      providerId: this.deps.providers.benchmarks.providerId,
      createdBy: input.actor.userId,
    })

    // Query once at creation so the picker can show a real sample size rather
    // than a promise of one.
    const result = await this.deps.providers.benchmarks.queryCohort({
      cohortId: cohort.id,
      filterDefinition: input.filterDefinition,
      organizationId: input.actor.orgId,
    })
    await this.deps.repos.cohorts.setSampleSize(cohort.id, result.sampleSize)
    await this.deps.db.run("UPDATE benchmark_cohorts SET status = 'published', updated_at = ? WHERE id = ?", [this.deps.clock.isoNow(), cohort.id])

    return this.deps.repos.cohorts.getForOrg(input.actor.orgId, cohort.id, false)
  }

  /** Selects a cohort for a project and queues the comparison. */
  async selectCohort(actor: Actor, projectId: string, cohortId: string, entitledToProprietary: boolean): Promise<void> {
    // Reading the cohort through the entitlement-aware accessor is what stops
    // a partner from selecting a flagship cohort by pasting its id.
    await this.deps.repos.cohorts.getForOrg(actor.orgId, cohortId, entitledToProprietary)
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    await this.deps.repos.projects.update(actor.orgId, projectId, { selectedBenchmarkCohortId: cohortId })

    if (!project.currentVersionId) return
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, project.currentVersionId)
    if (!analysis) return

    await this.deps.queue.enqueue({
      queue: QUEUES.songLab,
      type: JOB_TYPES.songLabCompareBenchmark,
      payload: { analysisId: analysis.id, orgId: actor.orgId, cohortId },
      dedupeKey: `song_lab.benchmark:${analysis.id}:${cohortId}`,
    })
  }

  /**
   * Runs one comparison and generates the observations that follow from it.
   *
   * The two happen together because an observation with no benchmark result
   * behind it is exactly the kind of ungrounded claim this product refuses to
   * make.
   */
  async compare(orgId: string, analysisId: string, cohortId: string): Promise<{ comparison: BenchmarkComparison; observations: SongObservationRecord[] }> {
    const analysis = await this.deps.repos.analyses.get(orgId, analysisId)
    if (!analysis.featureVector) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_vector', message: 'this analysis has no feature vector yet' })
    }
    // Entitlement was checked when the cohort was selected; jobs re-read with
    // the flagship allowance because they act for the deployment, not a user.
    const cohort = await this.deps.repos.cohorts.getForOrg(orgId, cohortId, true)

    let values = await this.deps.repos.cohorts.cohortValues(cohortId)
    let sampleSize = cohort.sampleSize
    if (Object.keys(values).length === 0) {
      const result = await this.deps.providers.benchmarks.queryCohort({
        cohortId,
        filterDefinition: cohort.filterDefinition,
        organizationId: orgId,
      })
      values = result.values
      sampleSize = result.sampleSize
      if (sampleSize !== cohort.sampleSize) await this.deps.repos.cohorts.setSampleSize(cohortId, sampleSize)
    }

    const comparison = compareToCohort({
      vector: analysis.featureVector,
      cohort: { id: cohort.id, name: cohort.name, sampleSize, filterDefinition: cohort.filterDefinition },
      cohortValues: { values },
    })

    const stored = await this.deps.repos.benchmarkResults.replace(orgId, analysisId, cohortId, comparison.results)
    const resultIdsByMetric: Record<string, string> = {}
    for (const result of stored) resultIdsByMetric[result.metricKey] = result.id

    const observations = await this.generateObservations(orgId, analysis.id, comparison, resultIdsByMetric)
    await this.deps.repos.projects.setStatus(orgId, analysis.songLabProjectId, 'benchmarked')

    return { comparison, observations }
  }

  private async generateObservations(
    orgId: string,
    analysisId: string,
    comparison: BenchmarkComparison,
    resultIdsByMetric: Record<string, string>,
  ): Promise<SongObservationRecord[]> {
    const analysis = await this.deps.repos.analyses.get(orgId, analysisId)
    const sections = await this.deps.repos.sections.list(orgId, analysisId)
    const featureMap = await this.deps.repos.sections.features(orgId, analysisId)
    const detected = sections.map(toDetected)
    const features = sections.map((section) => toSectionFeatures(featureMap.get(section.id)))
    const repeats = repeatedSectionContrasts(detected, features)

    const drafts: SongObservationDraft[] = generateObservations({
      comparison,
      repeatedSimilarities: repeats.map((entry) => ({ fromLabel: entry.fromLabel, toLabel: entry.toLabel, similarity: entry.similarity })),
      registerContrast: registerContrastFor(detected, features),
      structureConfirmed: sections.some((section) => section.humanConfirmed),
    })

    const stored = await this.deps.repos.observations.replaceForAnalysis({
      orgId,
      songLabProjectId: analysis.songLabProjectId,
      songVersionId: analysis.songVersionId,
      songAnalysisId: analysisId,
      benchmarkCohortId: comparison.cohortId,
      drafts,
      benchmarkResultIdsByMetric: resultIdsByMetric,
    })

    // Open the closed loop the moment a recommendation is made, so
    // "suggested at" is recorded even if nobody ever acts on it — an ignored
    // recommendation is data too.
    for (const observation of stored) {
      for (const recommendation of observation.recommendations ?? []) {
        await this.deps.repos.outcomes.record({
          orgId,
          songLabProjectId: analysis.songLabProjectId,
          recommendationId: recommendation.id,
          observationId: observation.id,
          suggestedAt: recommendation.createdAt,
        })
      }
    }
    return stored
  }

  /** The overview's three headline items, in the product's own language. */
  async thingsWorthTesting(actor: Actor, projectId: string, limit = 3): Promise<SongObservationRecord[]> {
    const observations = await this.deps.repos.observations.listForProject(actor.orgId, projectId)
    const drafts = observations.map((observation) => ({
      observationType: observation.observationType,
      category: observation.category,
      title: observation.title,
      description: observation.description,
      severity: observation.severity,
      confidence: observation.confidence,
      sourceMetricKeys: observation.sourceMetricKeys,
      recommendations: [],
    }))
    const top = topThingsWorthTesting(drafts, limit)
    return top
      .map((draft) => observations.find((observation) => observation.title === draft.title))
      .filter((observation): observation is SongObservationRecord => Boolean(observation))
  }
}

/**
 * The verse-to-chorus register comparison, when both ends were measured.
 *
 * Returns undefined rather than a zero lift when either side is unmeasured: a
 * song with no detectable lead vocal has no register contrast to report, and
 * saying "no lift" would be a claim the analysis cannot support.
 */
function registerContrastFor(sections: DetectedSection[], features: SectionFeatures[]) {
  const metrics = registerMetrics(sections, features)
  if (metrics.verseRegister === null || metrics.chorusRegister === null || metrics.chorusRegisterLift === null) return undefined

  const labelFor = (types: string[]) =>
    [...sections]
      .sort((a, b) => a.startMs - b.startMs)
      .find((section) => types.includes(section.sectionType) && features[section.orderIndex]?.register.median !== null)?.label

  return {
    verseLabel: labelFor(['verse']) ?? 'the verse',
    chorusLabel: labelFor(['chorus', 'final_chorus']) ?? 'the chorus',
    verseRegister: metrics.verseRegister,
    chorusRegister: metrics.chorusRegister,
    lift: metrics.chorusRegisterLift,
    confidence: metrics.confidence,
  }
}
