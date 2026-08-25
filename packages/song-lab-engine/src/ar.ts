import { AppError } from '@masterclip/shared'
import type { ArRating, ArRecommendation, SongArReviewRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'

/**
 * Internal A&R.
 *
 * The service *drafts* an assessment from measured features and cohort
 * comparisons, and every rating it produces carries the metric keys it rests
 * on. A draft is not a decision: it cannot leave `draft` status without a named
 * human approving it, and there is no code path — here or in the repository —
 * by which the system signs, rejects, funds, or promises anything to an artist.
 */

export interface ArDraftInput {
  actor: Actor
  projectId: string
}

const NOT_ENOUGH: ArRating = 'not_enough_data'

export class SongArService {
  constructor(private readonly deps: SongLabDeps) {}

  /**
   * Builds a draft from evidence.
   *
   * Where a dimension has no supporting measurement, it is rated
   * `not_enough_data` rather than assigned a middling default — an A&R view
   * full of confident-looking "moderate" ratings derived from nothing would be
   * worse than an honest gap.
   */
  async draft(input: ArDraftInput): Promise<SongArReviewRecord> {
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)
    if (!project.currentVersionId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.not_analyzed', message: 'analyse this song before drafting an A&R review' })
    }
    const analysis = await this.deps.repos.analyses.latestForVersion(input.actor.orgId, project.currentVersionId)
    if (!analysis?.featureVector) {
      throw new AppError({ kind: 'validation', code: 'song_lab.not_analyzed', message: 'analyse this song before drafting an A&R review' })
    }

    const results = project.selectedBenchmarkCohortId
      ? await this.deps.repos.benchmarkResults.list(input.actor.orgId, analysis.id, project.selectedBenchmarkCohortId)
      : []
    const percentile = (key: string): number | null => results.find((result) => result.metricKey === key)?.percentile ?? null
    const metric = (key: string): number | null => analysis.featureVector?.metrics[key]?.value ?? null
    const confidenceOf = (key: string): number => analysis.featureVector?.metrics[key]?.confidence ?? 0

    const evidence: SongArReviewRecord['evidence'] = []
    const rate = (dimension: string, metricKeys: string[], value: ArRating, note: string): ArRating => {
      evidence.push({ dimension, metricKeys, note })
      return value
    }

    // ----- structure --------------------------------------------------------
    const sectionCount = metric('section_count')
    const symmetry = metric('structural_symmetry')
    const structureRating =
      sectionCount === null
        ? rate('structure', ['section_count'], NOT_ENOUGH, 'structure could not be determined')
        : rate(
            'structure',
            ['section_count', 'structural_symmetry', 'repetition_frequency'],
            symmetry !== null && symmetry >= 0.55 && sectionCount >= 6 ? 'strong' : 'moderate',
            `${sectionCount} sections, symmetry ${symmetry ?? 'unknown'}`,
          )

    // ----- hook -------------------------------------------------------------
    const chorusShare = metric('chorus_share')
    const titleRepetition = metric('title_repetition')
    const hookRating =
      chorusShare === null
        ? rate('hook', ['chorus_share'], NOT_ENOUGH, 'no chorus sections were identified')
        : rate(
            'hook',
            ['chorus_share', 'title_repetition', 'hook_repetition'],
            chorusShare >= 30 && (titleRepetition === null || titleRepetition >= 3) ? 'strong' : 'needs_review',
            `chorus occupies ${Math.round(chorusShare)}% of runtime`,
          )

    // ----- early payoff -----------------------------------------------------
    const firstChorusPercentile = percentile('first_chorus_seconds')
    const earlyPayoffRating =
      firstChorusPercentile === null
        ? rate('early_payoff', ['first_chorus_seconds'], NOT_ENOUGH, 'no cohort comparison is available')
        : rate(
            'early_payoff',
            ['first_chorus_seconds', 'first_vocal_seconds'],
            firstChorusPercentile >= 80 ? 'below_cohort' : firstChorusPercentile <= 55 ? 'strong' : 'moderate',
            `first chorus at the ${Math.round(firstChorusPercentile)}th percentile of the selected cohort`,
          )

    // ----- arrangement contrast --------------------------------------------
    const similarity = metric('chorus_similarity')
    const dynamicContrast = metric('dynamic_contrast')
    const arrangementRating =
      similarity === null && dynamicContrast === null
        ? rate('arrangement_contrast', ['chorus_similarity'], NOT_ENOUGH, 'no repeated sections to compare')
        : rate(
            'arrangement_contrast',
            ['chorus_similarity', 'dynamic_contrast', 'energy_range'],
            similarity !== null && similarity >= 92 ? 'needs_review' : 'strong',
            similarity === null ? 'measured from section energy only' : `repeated choruses measure ${Math.round(similarity)}% similar`,
          )

    // ----- vocal memorability ----------------------------------------------
    const vocalContrast = metric('vocal_density_contrast')
    const vocalConfidence = confidenceOf('vocal_density_contrast')
    const vocalRating =
      vocalContrast === null || vocalConfidence < 0.3
        ? rate('vocal_memorability', ['vocal_density_contrast'], NOT_ENOUGH, 'vocal analysis confidence is too low to rate')
        : rate(
            'vocal_memorability',
            ['vocal_density_contrast', 'chorus_vocal_occupancy', 'title_repetition'],
            vocalContrast >= 0.12 ? 'promising' : 'moderate',
            `verse-to-chorus vocal density change ${vocalContrast}`,
          )

    // ----- format fits ------------------------------------------------------
    const duration = metric('duration_seconds')
    const streamingRating =
      duration === null
        ? rate('streaming_fit', ['duration_seconds'], NOT_ENOUGH, 'runtime is unknown')
        : rate(
            'streaming_fit',
            ['duration_seconds', 'first_chorus_seconds', 'intro_seconds'],
            duration <= 240 && (firstChorusPercentile === null || firstChorusPercentile <= 75) ? 'strong' : 'moderate',
            `runtime ${Math.round(duration)}s`,
          )

    const chantCount = (await this.deps.repos.observations.listForProject(input.actor.orgId, input.projectId)).length
    const liveRating = rate(
      'live_potential',
      ['dynamic_contrast', 'energy_range', 'hook_repetition'],
      dynamicContrast !== null && dynamicContrast >= 0.12 ? 'promising' : 'moderate',
      `${chantCount} observations recorded; section energy contrast ${dynamicContrast ?? 'unknown'}`,
    )

    const introSeconds = metric('intro_seconds')
    const syncRating =
      introSeconds === null
        ? rate('sync_potential', ['intro_seconds'], NOT_ENOUGH, 'no intro section was identified')
        : rate(
            'sync_potential',
            ['intro_seconds', 'energy_range', 'vocal_occupancy'],
            introSeconds <= 20 ? 'promising' : 'moderate',
            `intro runs ${Math.round(introSeconds)}s`,
          )

    const ratings = [structureRating, hookRating, earlyPayoffRating, arrangementRating, vocalRating, streamingRating, liveRating, syncRating]
    const known = ratings.filter((rating) => rating !== NOT_ENOUGH).length
    // Confidence is the share of dimensions that had evidence at all. A review
    // built on three of eight measurable dimensions says so.
    const confidence = Math.round((known / ratings.length) * 100) / 100

    return this.deps.repos.arReviews.createDraft({
      orgId: input.actor.orgId,
      songLabProjectId: input.projectId,
      songAnalysisId: analysis.id,
      structureRating,
      hookRating,
      earlyPayoffRating,
      arrangementContrastRating: arrangementRating,
      vocalMemorabilityRating: vocalRating,
      streamingFitRating: streamingRating,
      livePotentialRating: liveRating,
      syncPotentialRating: syncRating,
      recommendation: recommendationFrom(ratings, known === 0),
      why: buildWhy(evidence, ratings),
      evidence,
      confidence,
      createdBy: input.actor.userId,
    })
  }

  async override(actor: Actor, reviewId: string, patch: Parameters<SongLabDeps['repos']['arReviews']['override']>[2]): Promise<SongArReviewRecord> {
    return this.deps.repos.arReviews.override(actor.orgId, reviewId, patch, actor.userId)
  }

  /** Human approval. The only route to an approved review. */
  async approve(actor: Actor, reviewId: string): Promise<SongArReviewRecord> {
    const review = await this.deps.repos.arReviews.approve(actor.orgId, reviewId, actor.userId)
    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'song_lab.ar_review.approved',
      targetType: 'song_ar_review',
      targetId: reviewId,
      data: { recommendation: review.recommendation, confidence: review.confidence },
    })
    return review
  }

  async latest(actor: Actor, projectId: string): Promise<SongArReviewRecord | null> {
    return this.deps.repos.arReviews.latest(actor.orgId, projectId)
  }

  async history(actor: Actor, projectId: string): Promise<SongArReviewRecord[]> {
    return this.deps.repos.arReviews.history(actor.orgId, projectId)
  }
}

/**
 * The suggested state.
 *
 * `develop` and `review_with_producer` are the two the draft can reach on its
 * own. It never suggests `release_ready` or `pass_for_now`: signing a record
 * off and passing on an artist are both human calls, and offering them as a
 * default would make them feel like the system's opinion.
 */
function recommendationFrom(ratings: ArRating[], noEvidence: boolean): ArRecommendation {
  if (noEvidence) return 'needs_more_data'
  if (ratings.filter((rating) => rating === 'not_enough_data').length >= 4) return 'needs_more_data'
  if (ratings.some((rating) => rating === 'needs_review' || rating === 'below_cohort')) return 'review_with_producer'
  return 'develop'
}

function buildWhy(evidence: SongArReviewRecord['evidence'], ratings: ArRating[]): string {
  const strengths = evidence.filter((_, index) => ratings[index] === 'strong' || ratings[index] === 'promising')
  const concerns = evidence.filter((_, index) => ratings[index] === 'needs_review' || ratings[index] === 'below_cohort')
  const gaps = evidence.filter((_, index) => ratings[index] === NOT_ENOUGH)

  const parts: string[] = []
  if (strengths.length > 0) parts.push(`Measured strengths: ${strengths.map((entry) => entry.note).join('; ')}.`)
  if (concerns.length > 0) parts.push(`Main concerns: ${concerns.map((entry) => entry.note).join('; ')}.`)
  if (gaps.length > 0) parts.push(`Not enough information on ${gaps.map((entry) => entry.dimension.replace(/_/g, ' ')).join(', ')}.`)
  parts.push('This is a draft assembled from measurements and cohort comparisons. A person decides.')
  return parts.join(' ')
}
