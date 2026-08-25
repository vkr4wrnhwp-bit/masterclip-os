import { formatMetric, metricDefinition, ordinal, type SongFeatureVector } from '@masterclip/song-feature-vectors'
import { LOW_SAMPLE_THRESHOLD, MINIMUM_SAMPLE_SIZE, type BenchmarkCohortDefinition } from './cohorts.js'
import { percentileRank, summarize, zScore, type DistributionSummary } from './statistics.js'

/**
 * The comparison engine.
 *
 * Turns "your song" plus "this cohort" into per-metric percentile results, and
 * classifies each as an outlier or not. The classification vocabulary is fixed
 * and deliberately non-judgemental — `Later Than Cohort`, `Higher Density`,
 * `Similar To Cohort` — because a difference from a comparison group is a fact
 * about a comparison group, not a defect in a song.
 */

export type OutlierClassification =
  | 'similar_to_cohort'
  | 'above_cohort'
  | 'below_cohort'
  | 'structure_outlier'
  | 'insufficient_data'

export interface BenchmarkMetricResult {
  metricKey: string
  metricLabel: string
  songValue: number | null
  /** Formatted for display, e.g. `0:56`. */
  songDisplay: string
  cohortMedian: number | null
  cohortMean: number | null
  p10: number | null
  p25: number | null
  p75: number | null
  p90: number | null
  percentile: number | null
  zScore: number | null
  sampleSize: number
  /** 0–1: how much weight this result can bear, given sample size and the
   *  confidence of the underlying measurement. */
  confidence: number
  lowSample: boolean
  classification: OutlierClassification
  /** The neutral label shown as a chip, e.g. `Later Than Cohort`. */
  classificationLabel: string
  /** One factual sentence. No advice — advice lives in observations. */
  summary: string
}

export interface CohortMetricValues {
  /** metric key → the cohort's values for that metric. */
  values: Record<string, number[]>
}

export interface CompareInput {
  vector: SongFeatureVector
  cohort: Pick<BenchmarkCohortDefinition, 'id' | 'name' | 'sampleSize' | 'filterDefinition'>
  cohortValues: CohortMetricValues
  /** Restrict the comparison to these metrics. Defaults to everything shared. */
  metricKeys?: string[]
}

export interface BenchmarkComparison {
  cohortId: string
  cohortName: string
  results: BenchmarkMetricResult[]
  /** Metrics the song has but the cohort does not, and vice versa. */
  unavailableMetrics: string[]
  /** True when the whole cohort is under the low-sample threshold. */
  lowSample: boolean
  sampleSize: number
}

/**
 * Two thresholds, doing different jobs.
 *
 * Outside the interquartile range is where a difference is worth *mentioning*:
 * the song sits outside the middle half of the comparison group, which is a
 * fact an artist can act on. Outside the 10th–90th is where it is worth calling
 * an *outlier*: the song is unlike almost everything in the group.
 *
 * Keeping these separate is what lets the product say "later than three
 * quarters of this cohort" without inflating it into "outlier", and say
 * "outlier" only when the word is earned.
 */
const OUTLIER_PERCENTILE_LOW = 10
const OUTLIER_PERCENTILE_HIGH = 90
const SIMILAR_PERCENTILE_LOW = 25
const SIMILAR_PERCENTILE_HIGH = 75

export function compareToCohort(input: CompareInput): BenchmarkComparison {
  const results: BenchmarkMetricResult[] = []
  const unavailable: string[] = []
  const keys = input.metricKeys ?? Object.keys(input.vector.metrics)

  for (const metricKey of keys) {
    const measurement = input.vector.metrics[metricKey]
    const cohortValues = input.cohortValues.values[metricKey]
    if (!measurement) continue
    if (!cohortValues || cohortValues.length === 0) {
      unavailable.push(metricKey)
      continue
    }
    const summary = summarize(cohortValues)
    if (!summary || summary.sampleSize < MINIMUM_SAMPLE_SIZE) {
      unavailable.push(metricKey)
      continue
    }
    results.push(buildResult(metricKey, measurement.value, measurement.confidence, summary, cohortValues))
  }

  results.sort((a, b) => severity(b) - severity(a))

  return {
    cohortId: input.cohort.id,
    cohortName: input.cohort.name,
    results,
    unavailableMetrics: unavailable,
    lowSample: input.cohort.sampleSize < LOW_SAMPLE_THRESHOLD,
    sampleSize: input.cohort.sampleSize,
  }
}

function buildResult(
  metricKey: string,
  songValue: number | null,
  measurementConfidence: number,
  summary: DistributionSummary,
  cohortValues: number[],
): BenchmarkMetricResult {
  const definition = metricDefinition(metricKey)
  const label = definition?.label ?? metricKey
  const sorted = [...cohortValues].sort((a, b) => a - b)
  const lowSample = summary.sampleSize < LOW_SAMPLE_THRESHOLD

  const base: BenchmarkMetricResult = {
    metricKey,
    metricLabel: label,
    songValue,
    songDisplay: formatMetric(metricKey, songValue),
    cohortMedian: summary.median,
    cohortMean: summary.mean,
    p10: summary.p10,
    p25: summary.p25,
    p75: summary.p75,
    p90: summary.p90,
    percentile: null,
    zScore: null,
    sampleSize: summary.sampleSize,
    confidence: 0,
    lowSample,
    classification: 'insufficient_data',
    classificationLabel: 'Not Enough Information',
    summary: `${label} could not be measured for this recording, so there is nothing to compare.`,
  }

  // No measurement means no comparison. Not a zero, not a guess.
  if (songValue === null || !Number.isFinite(songValue)) return base

  const percentile = percentileRank(sorted, songValue)
  const classification = classify(percentile)
  // Sample size caps how much a percentile can be trusted, independently of how
  // well the song itself was measured. Both have to hold up.
  const sampleConfidence = Math.min(1, summary.sampleSize / (LOW_SAMPLE_THRESHOLD * 2))

  return {
    ...base,
    percentile,
    zScore: zScore(summary, songValue),
    confidence: Math.round(Math.min(measurementConfidence, sampleConfidence) * 100) / 100,
    classification,
    classificationLabel: classificationLabel(metricKey, classification, percentile),
    summary: summaryFor(metricKey, label, songValue, summary, percentile, classification),
  }
}

function classify(percentile: number): OutlierClassification {
  if (!Number.isFinite(percentile)) return 'insufficient_data'
  if (percentile <= OUTLIER_PERCENTILE_LOW || percentile >= OUTLIER_PERCENTILE_HIGH) return 'structure_outlier'
  if (percentile >= SIMILAR_PERCENTILE_LOW && percentile <= SIMILAR_PERCENTILE_HIGH) return 'similar_to_cohort'
  return percentile > 50 ? 'above_cohort' : 'below_cohort'
}

/**
 * The chip text. Uses the metric's own direction words so a slow tempo reads
 * "Slower Than Cohort" and a late chorus reads "Later Than Cohort", rather than
 * a generic "high"/"low" that implies a target.
 */
function classificationLabel(metricKey: string, classification: OutlierClassification, percentile: number): string {
  if (classification === 'insufficient_data') return 'Not Enough Information'
  if (classification === 'similar_to_cohort') return 'Similar To Cohort'
  const direction = metricDefinition(metricKey)?.direction
  const word = percentile > 50 ? direction?.above : direction?.below
  if (classification === 'structure_outlier') return word ? `${word} — Outlier` : 'Outlier'
  return word ?? (percentile > 50 ? 'Above Cohort' : 'Below Cohort')
}

function summaryFor(
  metricKey: string,
  label: string,
  songValue: number,
  summary: DistributionSummary,
  percentile: number,
  classification: OutlierClassification,
): string {
  const song = formatMetric(metricKey, songValue)
  const median = formatMetric(metricKey, summary.median)
  if (classification === 'similar_to_cohort') {
    return `${label} is ${song}, close to this cohort's median of ${median} (${ordinal(Math.round(percentile))} percentile).`
  }
  const side = percentile > 50 ? 'above' : 'below'
  return `${label} is ${song} against a cohort median of ${median} — ${side} the median, at the ${ordinal(Math.round(percentile))} percentile of ${summary.sampleSize} songs.`
}

/** Ranks results so the biggest, best-supported differences surface first. */
function severity(result: BenchmarkMetricResult): number {
  if (result.percentile === null) return -1
  const distance = Math.abs(result.percentile - 50) / 50
  return distance * result.confidence
}
