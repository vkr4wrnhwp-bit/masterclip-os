import { mixMetricDefinition } from './types.js'

/**
 * Where a recommendation came from, how sure it is, and what it could not see.
 *
 * Every piece of advice this product gives carries one of these. The reason is
 * the product's central promise: nothing here is presented as objectively
 * correct, and a reader deserves to know whether a suggestion rests on a
 * measurement of their file, on a threshold this module chose, or on a
 * comparison against three other records.
 *
 * `missingInputs` is the half that is easy to skip and matters most. A finding
 * that says "moderate confidence" and stops has told the reader nothing they
 * can act on. One that says the vocal was inferred from the full mix because no
 * isolated stem was supplied has told them exactly what to do about it.
 */

export const RECOMMENDATION_SOURCES = [
  'measurement',
  'derived_measurement',
  'heuristic',
  'reference_cohort',
  'stated_preference',
  'platform_specification',
] as const

export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number]

export const RECOMMENDATION_SOURCE_LABELS: Record<RecommendationSource, string> = {
  measurement: 'Measured from your audio',
  derived_measurement: 'Derived from measurements of your audio',
  heuristic: 'A threshold this module chose',
  reference_cohort: 'Compared against your reference tracks',
  stated_preference: 'A preference you stated',
  platform_specification: 'A published platform specification',
}

export const RECOMMENDATION_SOURCE_DESCRIPTIONS: Record<RecommendationSource, string> = {
  measurement: 'A number read directly from the file.',
  derived_measurement: 'Computed from figures measured in the file, using a mapping this module owns.',
  heuristic: 'A rule of thumb. It is a starting point for a conversation, not a verdict.',
  reference_cohort: 'A comparison against the records you supplied. It says what is different, not what is better.',
  stated_preference: 'Something you told the platform. It outranks anything inferred.',
  platform_specification: 'A figure published by a streaming service or a delivery standard.',
}

export type ConfidenceLabel = 'low' | 'moderate' | 'high'

export interface RecommendationBasis {
  source: RecommendationSource
  sourceLabel: string
  confidence: number
  confidenceLabel: ConfidenceLabel
  /** Metric keys the recommendation actually read. */
  measuredFrom: string[]
  /** Those keys as labels, for a reader. */
  measuredFromLabels: string[]
  /**
   * What was not available, in words. Each entry names something a person could
   * supply, not an internal key they have never heard of.
   */
  missingInputs: string[]
  /** One sentence combining the above, for a surface with no room for a table. */
  statement: string
}

/**
 * Bands rather than a bare number.
 *
 * 0.62 and 0.71 are not meaningfully different, and printing them as though
 * they were is the fake precision this product exists to avoid. The number is
 * still carried for sorting and for callers that need it.
 */
export function confidenceLabelFor(confidence: number): ConfidenceLabel {
  // A confidence that is not a number is not a high confidence. Without this
  // guard NaN falls through both comparisons and lands on 'high', which is the
  // worst possible default: an unmeasurable input reported as a sure thing.
  if (!Number.isFinite(confidence)) return 'low'
  if (confidence < 0.4) return 'low'
  if (confidence < 0.7) return 'moderate'
  return 'high'
}

export function basisFor(input: {
  source: RecommendationSource
  confidence: number
  measuredFrom?: string[]
  missingInputs?: string[]
}): RecommendationBasis {
  const measuredFrom = input.measuredFrom ?? []
  const missingInputs = input.missingInputs ?? []
  const confidence = clamp01(input.confidence)
  const label = confidenceLabelFor(confidence)
  const measuredFromLabels = measuredFrom.map((key) => mixMetricDefinition(key)?.label ?? key)

  const parts = [RECOMMENDATION_SOURCE_LABELS[input.source]]
  if (measuredFromLabels.length > 0) parts.push(`from ${joinList(measuredFromLabels)}`)
  parts.push(`${label} confidence`)
  if (missingInputs.length > 0) parts.push(`limited by: ${joinList(missingInputs)}`)

  return {
    source: input.source,
    sourceLabel: RECOMMENDATION_SOURCE_LABELS[input.source],
    confidence,
    confidenceLabel: label,
    measuredFrom,
    measuredFromLabels,
    missingInputs,
    statement: `${parts.join('. ')}.`,
  }
}

/**
 * The inputs a Mix Doctor finding rests on, declared once per issue type.
 *
 * Declared centrally rather than repeated in eleven detectors so a detector
 * cannot quietly stop reporting its basis, and so "which inputs were missing"
 * is computed against the real analysis rather than asserted by the detector
 * that already decided it had enough.
 */
export const ISSUE_BASIS: Record<
  string,
  { source: RecommendationSource; metrics: string[]; needs?: Array<{ when: string; missing: string }> }
> = {
  clipping: { source: 'measurement', metrics: ['peak_dbfs', 'clipped_sample_pct', 'clipping_runs'] },
  phase_concern: { source: 'measurement', metrics: ['phase_correlation', 'mono_fold_loss_db'] },
  vocal_masking: {
    source: 'derived_measurement',
    metrics: ['vocal_masking_index', 'vocal_presence_index'],
    needs: [{ when: 'no_vocal_stem', missing: 'an isolated vocal stem — the voice was inferred from the full mix' }],
  },
  vocal_level_change: {
    source: 'derived_measurement',
    metrics: ['vocal_level_stability'],
    needs: [{ when: 'no_vocal_stem', missing: 'an isolated vocal stem — the voice was inferred from the full mix' }],
  },
  kick_bass_collision: { source: 'derived_measurement', metrics: ['kick_bass_masking_index', 'low_energy_pct'] },
  upper_mid_harshness: { source: 'derived_measurement', metrics: ['harshness_index', 'high_mid_energy_pct'] },
  sibilance: { source: 'derived_measurement', metrics: ['sibilance_index'] },
  low_end_buildup: { source: 'derived_measurement', metrics: ['sub_energy_pct', 'low_energy_pct', 'low_end_centroid_hz'] },
  midrange_congestion: { source: 'derived_measurement', metrics: ['midrange_congestion_index', 'mid_energy_pct'] },
  level_drop: { source: 'measurement', metrics: ['short_term_loudness', 'loudness_range_lu'] },
  stereo_imbalance: { source: 'measurement', metrics: ['stereo_imbalance_db'] },
  insufficient_headroom: { source: 'measurement', metrics: ['true_peak_dbtp', 'headroom_db'] },
  dc_offset: { source: 'measurement', metrics: ['dc_offset'] },
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
