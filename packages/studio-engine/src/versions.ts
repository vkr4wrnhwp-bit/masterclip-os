import { AppError } from '@masterclip/shared'
import { mixMetricDefinition, type MixMetric } from '@masterclip/mix-analysis'
import type { StudioVersionRecord } from '@masterclip/studio-domain'
import type { Actor, StudioDeps } from './deps.js'
import { toMixMetrics } from './mix.js'

/**
 * Version Vault and the difference engine.
 *
 * The engine answers one question — what changed between these two versions? —
 * in the language an engineer uses, not in raw metric deltas. "Lead vocal
 * increased approximately 1.1 dB" is actionable; "vocal_band_share +0.014" is
 * not, and the mapping between the two is this file's whole job.
 *
 * Everything it says is hedged with "approximately", because it is comparing
 * measurements of two mixes rather than watching a fader move. It cannot know
 * that the vocal went up — only that the band the vocal occupies carries more
 * energy relative to everything else.
 */
export class StudioVersionService {
  constructor(private readonly deps: StudioDeps) {}

  async list(actor: Actor, projectId: string): Promise<StudioVersionRecord[]> {
    return this.deps.repos.versions.list(actor.orgId, projectId)
  }

  /**
   * Compares two versions of the same project.
   *
   * Refuses across projects, and refuses when either side has not been analysed
   * — a diff against nothing would be a list of the other side's numbers
   * presented as changes.
   */
  async compare(actor: Actor, projectId: string, versionIdA: string, versionIdB: string) {
    const [a, b] = await Promise.all([this.deps.repos.versions.get(actor.orgId, versionIdA), this.deps.repos.versions.get(actor.orgId, versionIdB)])
    for (const version of [a, b]) {
      if (version.studioProjectId !== projectId) {
        throw new AppError({ kind: 'validation', code: 'studio.version_mismatch', message: 'that version belongs to a different project' })
      }
    }

    const [analysisA, analysisB] = await Promise.all([
      this.deps.repos.analyses.latestForVersion(actor.orgId, a.id),
      this.deps.repos.analyses.latestForVersion(actor.orgId, b.id),
    ])

    const metricsA = analysisA ? toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysisA.id)) : []
    const metricsB = analysisB ? toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysisB.id)) : []

    // Two analyses from different analyzer-set versions are not directly
    // comparable, and saying so is better than printing deltas that mix
    // measurement changes with mix changes.
    const comparable =
      analysisA !== null && analysisB !== null && analysisA.analyzerSetVersion === analysisB.analyzerSetVersion

    const [notesA, notesB, approvals] = await Promise.all([
      this.deps.repos.notes.list(actor.orgId, projectId, { versionId: a.id }),
      this.deps.repos.notes.list(actor.orgId, projectId, { versionId: b.id }),
      this.deps.repos.approvals.list(actor.orgId, projectId),
    ])

    return {
      a: { version: a, analysis: analysisA, metrics: metricsA, notes: notesA, lineage: await this.deps.repos.versions.lineage(actor.orgId, a.id) },
      b: { version: b, analysis: analysisB, metrics: metricsB, notes: notesB, lineage: await this.deps.repos.versions.lineage(actor.orgId, b.id) },
      comparable,
      incomparableReason: comparable
        ? null
        : analysisA === null || analysisB === null
          ? 'One of these versions has not been analysed yet, so there is nothing to compare it against.'
          : 'These versions were measured by different analyzer versions, so differences between them may be measurement changes rather than mix changes.',
      differences: comparable ? describeDifferences(metricsA, metricsB, a, b) : [],
      approvals: approvals.filter((approval) => approval.studioVersionId === a.id || approval.studioVersionId === b.id),
    }
  }
}

export interface VersionDifference {
  /** The metric this rests on, so the claim can be checked. */
  metricKey: string
  statement: string
  before: number | null
  after: number | null
  delta: number
  /** How sure the phrasing is allowed to be. */
  confidence: 'observed' | 'inferred'
}

/**
 * Metric → sentence.
 *
 * `inferred` marks the claims that translate a measurement into a musical
 * statement across an inference — the vocal-band figure is a proxy for the
 * lead vocal, and the copy says "approximately" because of it. `observed`
 * claims are direct readings.
 */
const DIFFERENCE_RULES: Array<{
  key: string
  threshold: number
  confidence: 'observed' | 'inferred'
  up: (delta: number) => string
  down: (delta: number) => string
}> = [
  {
    key: 'integrated_lufs',
    threshold: 0.5,
    confidence: 'observed',
    up: (delta) => `Overall level increased approximately ${delta.toFixed(1)} dB`,
    down: (delta) => `Overall level decreased approximately ${delta.toFixed(1)} dB`,
  },
  {
    key: 'vocal_presence_index',
    threshold: 0.05,
    confidence: 'inferred',
    up: (delta) => `Lead vocal appears more present across approximately ${(delta * 100).toFixed(0)}% more of the record`,
    down: (delta) => `Lead vocal appears present across approximately ${(delta * 100).toFixed(0)}% less of the record`,
  },
  {
    key: 'mid_energy_pct',
    threshold: 1.5,
    confidence: 'inferred',
    up: (delta) => `Midrange energy increased approximately ${delta.toFixed(1)} percentage points`,
    down: (delta) => `Midrange energy reduced approximately ${delta.toFixed(1)} percentage points`,
  },
  {
    key: 'low_energy_pct',
    threshold: 1.5,
    confidence: 'observed',
    up: (delta) => `Low-frequency energy increased approximately ${delta.toFixed(1)} percentage points`,
    down: (delta) => `Low-frequency energy reduced approximately ${delta.toFixed(1)} percentage points`,
  },
  {
    key: 'sub_energy_pct',
    threshold: 1.5,
    confidence: 'observed',
    up: (delta) => `Sub energy increased approximately ${delta.toFixed(1)} percentage points`,
    down: (delta) => `Sub energy reduced approximately ${delta.toFixed(1)} percentage points`,
  },
  {
    key: 'high_energy_pct',
    threshold: 1,
    confidence: 'observed',
    up: (delta) => `Top end lifted approximately ${delta.toFixed(1)} percentage points`,
    down: (delta) => `Top end reduced approximately ${delta.toFixed(1)} percentage points`,
  },
  {
    key: 'stereo_width',
    threshold: 0.04,
    confidence: 'observed',
    up: () => 'Stereo presentation widened',
    down: () => 'Stereo presentation narrowed',
  },
  {
    key: 'phase_correlation',
    threshold: 0.08,
    confidence: 'observed',
    up: () => 'Channels became more mono-compatible',
    down: () => 'Channels became less mono-compatible',
  },
  {
    key: 'dynamic_range_db',
    threshold: 0.8,
    confidence: 'observed',
    up: (delta) => `Dynamic range increased approximately ${delta.toFixed(1)} dB`,
    down: (delta) => `Dynamic range reduced approximately ${delta.toFixed(1)} dB`,
  },
  {
    key: 'true_peak_dbtp',
    threshold: 0.3,
    confidence: 'observed',
    up: (delta) => `Peak level rose approximately ${delta.toFixed(1)} dB`,
    down: (delta) => `Peak level fell approximately ${delta.toFixed(1)} dB`,
  },
  {
    key: 'harshness_index',
    threshold: 0.08,
    confidence: 'inferred',
    up: () => 'Upper-mid concentration increased',
    down: () => 'Upper-mid concentration reduced',
  },
  {
    key: 'spectral_centroid_hz',
    threshold: 200,
    confidence: 'observed',
    up: (delta) => `Overall balance is brighter — the spectral centre moved up approximately ${Math.round(delta)} Hz`,
    down: (delta) => `Overall balance is darker — the spectral centre moved down approximately ${Math.round(delta)} Hz`,
  },
]

export function describeDifferences(
  before: MixMetric[],
  after: MixMetric[],
  versionA?: StudioVersionRecord,
  versionB?: StudioVersionRecord,
): VersionDifference[] {
  const differences: VersionDifference[] = []

  for (const rule of DIFFERENCE_RULES) {
    if (!mixMetricDefinition(rule.key)) continue
    const beforeValue = before.find((metric) => metric.key === rule.key)?.value ?? null
    const afterValue = after.find((metric) => metric.key === rule.key)?.value ?? null
    if (beforeValue === null || afterValue === null) continue
    const delta = afterValue - beforeValue
    if (Math.abs(delta) < rule.threshold) continue
    differences.push({
      metricKey: rule.key,
      statement: delta > 0 ? rule.up(Math.abs(delta)) : rule.down(Math.abs(delta)),
      before: beforeValue,
      after: afterValue,
      delta: Math.round(delta * 1000) / 1000,
      confidence: rule.confidence,
    })
  }

  // Length is not a metric — it is a fact about the two files — so it is
  // compared directly rather than through the rules table.
  if (versionA?.durationMs && versionB?.durationMs) {
    const deltaSeconds = (versionB.durationMs - versionA.durationMs) / 1000
    if (Math.abs(deltaSeconds) >= 1) {
      differences.push({
        metricKey: 'duration',
        statement:
          deltaSeconds > 0
            ? `Runtime is approximately ${deltaSeconds.toFixed(1)} seconds longer`
            : `Runtime is approximately ${Math.abs(deltaSeconds).toFixed(1)} seconds shorter`,
        before: versionA.durationMs,
        after: versionB.durationMs,
        delta: Math.round(deltaSeconds * 10) / 10,
        confidence: 'observed',
      })
    }
  }

  // Largest movements first, normalized by each rule's own threshold so a
  // 200 Hz centroid shift can outrank a 0.6 dB level change.
  return differences
    .filter((difference) => difference.statement.length > 0)
    .sort((a, b) => {
      const ruleA = DIFFERENCE_RULES.find((rule) => rule.key === a.metricKey)?.threshold ?? 1
      const ruleB = DIFFERENCE_RULES.find((rule) => rule.key === b.metricKey)?.threshold ?? 1
      return Math.abs(b.delta) / ruleB - Math.abs(a.delta) / ruleA
    })
}
