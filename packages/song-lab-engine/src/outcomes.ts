import { measured, unknown, type Measured } from '@masterclip/song-feature-vectors'
import type { SongOutcomeLinkRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'

/**
 * Below this a median is a number about a handful of releases, not a finding.
 *
 * The same floor a benchmark cohort has to clear before it may be published.
 * A recommendation type is a population too, and it does not become one
 * because it is easier to count.
 */
const MINIMUM_OUTCOME_SAMPLE = 8

const SOURCE = { provider: 'song-lab-outcomes', modelVersion: '2.0.0' }

/**
 * The closed loop.
 *
 * Records the chain: a recommendation was suggested → accepted or not →
 * implemented or not → released or not → and then, from authorized post-release
 * metrics, what happened.
 *
 * The language here is load-bearing. Nothing in this service produces the word
 * "caused", and the summary it builds says "correlated with" because that is
 * all an observational dataset of this kind can support. A recommendation that
 * an artist accepted and a release that did well are two facts; whether one
 * produced the other is not something this data can settle, and pretending
 * otherwise would poison the benchmarks the loop exists to improve.
 */
export class SongOutcomeService {
  constructor(private readonly deps: SongLabDeps) {}

  async listForProject(actor: Actor, projectId: string): Promise<SongOutcomeLinkRecord[]> {
    return this.deps.repos.outcomes.listForProject(actor.orgId, projectId)
  }

  /** Links an implemented version to the release it shipped as. */
  async markReleased(actor: Actor, outcomeId: string, releaseId: string, releasedAt: string): Promise<void> {
    await this.deps.repos.outcomes.markReleased(actor.orgId, outcomeId, releaseId, releasedAt)
  }

  /**
   * Attaches observed metrics for a window after release.
   *
   * Metrics arrive from Signal, which owns performance data; Song Lab stores
   * them against the recommendation so the correlation is answerable later. It
   * does not compute a causal estimate, and there is no field in which to store
   * one.
   */
  async attachOutcome(input: {
    actor: Actor
    outcomeId: string
    outcomeWindow: string
    metrics: Record<string, number>
  }): Promise<SongOutcomeLinkRecord> {
    const link = await this.deps.repos.outcomes.get(input.actor.orgId, input.outcomeId)
    const notes = correlationNote(link, input.outcomeWindow, input.metrics)
    await this.deps.repos.outcomes.attachOutcome(input.actor.orgId, input.outcomeId, input.outcomeWindow, input.metrics, notes)
    return this.deps.repos.outcomes.get(input.actor.orgId, input.outcomeId)
  }

  /**
   * Aggregate view for the flagship: for each recommendation type, how often it
   * was accepted, implemented and released, and what was observed afterwards.
   *
   * Reported as counts and observed medians. No effect size, because the sample
   * is not randomized and every song differs in a hundred ways the loop does
   * not control for.
   */
  /**
   * What happened, per recommendation type, split by whether it was taken up.
   *
   * Two things this deliberately does not do, both of which the previous
   * version did:
   *
   *   - **It does not pool implemented and not-implemented releases.** A median
   *     over every release that happened to carry a recommendation answers no
   *     question: it mixes the songs that took the note with the songs that
   *     ignored it. The only comparison this data supports is between those two
   *     groups, so that is the only one it reports.
   *   - **It does not report a median over a handful of releases as though it
   *     were a finding.** Below the sample floor each metric comes back as an
   *     explicit unknown carrying its own count, the same way every other
   *     figure in Song Lab reports insufficient evidence.
   *
   * Even at full sample this is observational. Artists who take a note differ
   * from artists who do not in ways nothing here measures, so a difference
   * between the groups is an association and is labelled one.
   */
  async recommendationSummary(actor: Actor): Promise<RecommendationOutcomeSummary[]> {
    const rows = await this.deps.db.query(
      `SELECT r.recommendation_type AS recommendation_type, o.accepted AS accepted, o.implemented AS implemented,
              o.release_id AS release_id, o.outcome_metrics AS outcome_metrics
       FROM song_outcome_links o
       JOIN song_recommendations r ON r.id = o.recommendation_id
       WHERE o.org_id = ?`,
      [actor.orgId],
    )

    const grouped = new Map<string, Bucket>()
    for (const row of rows) {
      const type = String(row.recommendation_type ?? 'unknown')
      const entry = grouped.get(type) ?? emptyBucket()
      entry.suggested++
      if (Number(row.accepted) === 1) entry.accepted++
      const wasImplemented = Number(row.implemented) === 1
      if (wasImplemented) entry.implemented++
      // Only a released song has an outcome to observe. An unreleased one
      // contributes to the counts and to nothing else.
      if (!row.release_id) {
        grouped.set(type, entry)
        continue
      }
      entry.released++
      const side = wasImplemented ? entry.implementedMetrics : entry.notImplementedMetrics
      for (const [key, value] of Object.entries(safeParse(row.outcome_metrics))) {
        if (typeof value === 'number' && Number.isFinite(value)) (side[key] ??= []).push(value)
      }
      grouped.set(type, entry)
    }

    return [...grouped.entries()].map(([recommendationType, entry]) => ({
      recommendationType,
      suggested: entry.suggested,
      accepted: entry.accepted,
      implemented: entry.implemented,
      released: entry.released,
      implementedOutcome: summarise(entry.implementedMetrics, 'implemented'),
      notImplementedOutcome: summarise(entry.notImplementedMetrics, 'not implemented'),
    }))
  }
}

export interface OutcomeGroup {
  /** Released songs in this group. The denominator for every median below. */
  sampleSize: number
  /** Median per metric, or an explicit unknown when the group is too small. */
  metrics: Record<string, Measured<number>>
}

export interface RecommendationOutcomeSummary {
  recommendationType: string
  suggested: number
  accepted: number
  implemented: number
  released: number
  implementedOutcome: OutcomeGroup
  notImplementedOutcome: OutcomeGroup
}

interface Bucket {
  suggested: number
  accepted: number
  implemented: number
  released: number
  implementedMetrics: Record<string, number[]>
  notImplementedMetrics: Record<string, number[]>
}

function emptyBucket(): Bucket {
  return { suggested: 0, accepted: 0, implemented: 0, released: 0, implementedMetrics: {}, notImplementedMetrics: {} }
}

function summarise(metrics: Record<string, number[]>, label: string): OutcomeGroup {
  // Every metric in the group shares one denominator: the releases observed.
  const sampleSize = Math.max(0, ...Object.values(metrics).map((values) => values.length))
  const summarised: Record<string, Measured<number>> = {}
  for (const [key, values] of Object.entries(metrics)) {
    summarised[key] =
      values.length < MINIMUM_OUTCOME_SAMPLE
        ? unknown<number>(
            'outcome_median',
            SOURCE,
            `${values.length} released song${values.length === 1 ? '' : 's'} where this was ${label} — below the ${MINIMUM_OUTCOME_SAMPLE} needed to report a median`,
          )
        : measured(
            median(values),
            // Confidence grows with the sample and is capped well short of
            // certainty: this is observational data about self-selected
            // groups, and no sample size fixes that.
            Math.min(0.6, 0.3 + values.length / 100),
            'outcome_median',
            SOURCE,
            `median over ${values.length} released songs where this was ${label} — association only`,
          )
  }
  return { sampleSize, metrics: summarised }
}

function correlationNote(link: SongOutcomeLinkRecord, window: string, metrics: Record<string, number>): string {
  const summary = Object.entries(metrics)
    .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`)
    .join(', ')
  const state = link.implemented ? 'was implemented' : link.accepted ? 'was accepted but not implemented' : 'was not accepted'
  // "correlated with", never "caused". One observational record establishes an
  // association at most, and often not even that.
  return `This recommendation ${state}. Over the ${window} window the release correlated with: ${summary || 'no metrics supplied'}. Association only — this record cannot establish cause.`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function safeParse(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}
