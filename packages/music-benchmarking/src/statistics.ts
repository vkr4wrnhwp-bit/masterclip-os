/**
 * Percentile statistics.
 *
 * Linear-interpolating percentiles (the `numpy`/`R` type-7 definition) so a
 * cohort of 40 does not produce staircased quartiles. Sample size travels with
 * every result because a percentile computed over nine songs is arithmetic, not
 * evidence, and the UI has to be able to say which it is looking at.
 */

export interface DistributionSummary {
  sampleSize: number
  min: number
  max: number
  mean: number
  median: number
  p10: number
  p25: number
  p75: number
  p90: number
  standardDeviation: number
}

export function summarize(values: number[]): DistributionSummary | null {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (usable.length === 0) return null
  const mean = usable.reduce((sum, value) => sum + value, 0) / usable.length
  const variance = usable.length > 1 ? usable.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (usable.length - 1) : 0
  return {
    sampleSize: usable.length,
    min: usable[0]!,
    max: usable[usable.length - 1]!,
    mean: round(mean),
    median: round(percentileOf(usable, 50)),
    p10: round(percentileOf(usable, 10)),
    p25: round(percentileOf(usable, 25)),
    p75: round(percentileOf(usable, 75)),
    p90: round(percentileOf(usable, 90)),
    standardDeviation: round(Math.sqrt(variance)),
  }
}

/** Value at percentile `p` (0–100) of an already-sorted array. */
export function percentileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]!
  const rank = ((p / 100) * (sorted.length - 1))
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (rank - lower) * (sorted[upper]! - sorted[lower]!)
}

/**
 * Where `value` sits in `sorted`, 0–100.
 *
 * Uses the midpoint rule so ties do not report 0 or 100 — a song exactly at the
 * cohort median should read as the 50th percentile, not the 0th.
 */
export function percentileRank(sorted: number[], value: number): number {
  if (sorted.length === 0 || !Number.isFinite(value)) return NaN
  let below = 0
  let equal = 0
  for (const entry of sorted) {
    if (entry < value) below++
    else if (entry === value) equal++
  }
  return round(((below + equal / 2) / sorted.length) * 100)
}

/** Standard scores away from the cohort mean. Null when the cohort is flat. */
export function zScore(summary: DistributionSummary, value: number): number | null {
  if (summary.standardDeviation <= 0) return null
  return round((value - summary.mean) / summary.standardDeviation)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
