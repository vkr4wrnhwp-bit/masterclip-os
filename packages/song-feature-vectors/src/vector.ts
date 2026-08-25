import type { Measured } from './measured.js'
import { valueOrNull } from './measured.js'

/**
 * The song feature vector.
 *
 * One flat, versioned bag of comparable numbers plus the provenance needed to
 * know whether a comparison is fair. Benchmarking reads only this — it never
 * touches audio — which is what lets the same comparison run against a cohort
 * of licensed metadata that contains no masters at all.
 */

/** Bumped whenever extraction changes in a way that makes old vectors incomparable. */
export const FEATURE_VECTOR_VERSION = '1.0.0'

export interface FeatureVectorProvenance {
  /** Version of the extraction pipeline that produced this vector. */
  engineVersion: string
  featureVectorVersion: string
  /** Per-stage provider identity, so a mixed run stays traceable. */
  providers: Record<string, { provider: string; modelVersion: string }>
  /** SHA-256 of the analysed source bytes. A different checksum is a different song. */
  sourceChecksum: string
  analyzedAt: string
  /** Free-form configuration echoed back for reproducibility. */
  configuration: Record<string, unknown>
}

export interface SongFeatureVector {
  provenance: FeatureVectorProvenance
  /** metric key → measured value. Absent keys mean "not measured at all". */
  metrics: Record<string, Measured<number>>
}

export function emptyVector(provenance: FeatureVectorProvenance): SongFeatureVector {
  return { provenance, metrics: {} }
}

/** Plain `{ key: number }` of everything that has a value. Unknowns are dropped. */
export function numericMetrics(vector: SongFeatureVector): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(vector.metrics)) {
    const value = valueOrNull(entry)
    if (value !== null && Number.isFinite(value)) out[key] = value
  }
  return out
}

/** Metric keys the analyser explicitly could not determine. */
export function unknownMetrics(vector: SongFeatureVector): string[] {
  return Object.entries(vector.metrics)
    .filter(([, entry]) => valueOrNull(entry) === null)
    .map(([key]) => key)
}

export function metricValue(vector: SongFeatureVector, key: string): number | null {
  return valueOrNull(vector.metrics[key])
}

export function metricMeasured(vector: SongFeatureVector, key: string): Measured<number> | null {
  return vector.metrics[key] ?? null
}

export function setMetric(vector: SongFeatureVector, key: string, entry: Measured<number>): void {
  vector.metrics[key] = entry
}

/**
 * Whether two vectors were produced by comparable engines. A benchmark that
 * mixes extraction versions is a benchmark that measures the extractor.
 */
export function vectorsComparable(a: FeatureVectorProvenance, b: FeatureVectorProvenance): boolean {
  return a.featureVectorVersion === b.featureVectorVersion
}
