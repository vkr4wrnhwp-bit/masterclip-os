import type { SongOutcomeLinkRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'

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
  async recommendationSummary(actor: Actor): Promise<
    Array<{ recommendationType: string; suggested: number; accepted: number; implemented: number; released: number; observedMetrics: Record<string, number> }>
  > {
    const rows = await this.deps.db.query(
      `SELECT r.recommendation_type AS recommendation_type, o.accepted AS accepted, o.implemented AS implemented,
              o.release_id AS release_id, o.outcome_metrics AS outcome_metrics
       FROM song_outcome_links o
       JOIN song_recommendations r ON r.id = o.recommendation_id
       WHERE o.org_id = ?`,
      [actor.orgId],
    )

    const grouped = new Map<string, { suggested: number; accepted: number; implemented: number; released: number; metrics: Record<string, number[]> }>()
    for (const row of rows) {
      const type = String(row.recommendation_type ?? 'unknown')
      const entry = grouped.get(type) ?? { suggested: 0, accepted: 0, implemented: 0, released: 0, metrics: {} }
      entry.suggested++
      if (Number(row.accepted) === 1) entry.accepted++
      if (Number(row.implemented) === 1) entry.implemented++
      if (row.release_id) entry.released++
      const metrics = safeParse(row.outcome_metrics)
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === 'number' && Number.isFinite(value)) (entry.metrics[key] ??= []).push(value)
      }
      grouped.set(type, entry)
    }

    return [...grouped.entries()].map(([recommendationType, entry]) => ({
      recommendationType,
      suggested: entry.suggested,
      accepted: entry.accepted,
      implemented: entry.implemented,
      released: entry.released,
      observedMetrics: Object.fromEntries(Object.entries(entry.metrics).map(([key, values]) => [key, median(values)])),
    }))
  }
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
