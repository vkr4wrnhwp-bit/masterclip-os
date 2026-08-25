/**
 * The measured value.
 *
 * Song Lab's whole claim is "evidence first". That only means something if a
 * number can say how it was arrived at and how much to trust it, so no derived
 * musical feature travels through this system as a bare number: every one
 * carries its provider, method, model version and confidence, and a feature the
 * analyser could not determine is `null` rather than a plausible-looking zero.
 *
 * A fabricated value is worse than a missing one here — the user is being asked
 * to make an artistic decision from it.
 */

export interface Measured<T = number> {
  /** `null` means "not enough information", never "zero". */
  value: T | null
  /** 0–1. Meaningless without `value`; kept at 0 when the value is null. */
  confidence: number
  /** How this was derived, e.g. `onset_autocorrelation`. */
  analysisMethod: string
  /** Which provider produced it, e.g. `local-dsp` or `mock-song-analysis`. */
  provider: string
  /** Provider-side model/engine version, so results stay comparable over time. */
  modelVersion: string
  /** Optional human-readable caveat shown next to a low-confidence figure. */
  note?: string
}

export type ConfidenceBand = 'high' | 'moderate' | 'low' | 'insufficient'

export const CONFIDENCE_BANDS: Array<{ band: ConfidenceBand; min: number; label: string }> = [
  { band: 'high', min: 0.75, label: 'HIGH CONFIDENCE' },
  { band: 'moderate', min: 0.5, label: 'MODERATE CONFIDENCE' },
  { band: 'low', min: 0.25, label: 'LOW CONFIDENCE' },
  { band: 'insufficient', min: 0, label: 'NOT ENOUGH INFORMATION' },
]

export function confidenceBand<T>(measured: Measured<T> | null | undefined): ConfidenceBand {
  if (!measured || measured.value === null || measured.value === undefined) return 'insufficient'
  for (const entry of CONFIDENCE_BANDS) {
    if (measured.confidence >= entry.min) return entry.band
  }
  return 'insufficient'
}

export function confidenceLabel<T>(measured: Measured<T> | null | undefined): string {
  const band = confidenceBand(measured)
  return CONFIDENCE_BANDS.find((entry) => entry.band === band)?.label ?? 'NOT ENOUGH INFORMATION'
}

/** True when a figure is solid enough to drive a recommendation on its own. */
export function isActionable<T>(measured: Measured<T> | null | undefined): boolean {
  const band = confidenceBand(measured)
  return band === 'high' || band === 'moderate'
}

export interface MeasuredSource {
  provider: string
  modelVersion: string
}

/** Builds a populated measurement. Confidence is clamped to 0–1. */
export function measured<T>(
  value: T,
  confidence: number,
  analysisMethod: string,
  source: MeasuredSource,
  note?: string,
): Measured<T> {
  return {
    value,
    confidence: Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0)),
    analysisMethod,
    provider: source.provider,
    modelVersion: source.modelVersion,
    ...(note ? { note } : {}),
  }
}

/**
 * Builds an explicitly-unknown measurement. Used wherever a feature could not
 * be determined reliably — a mono file has no stereo width, a spoken-word
 * upload has no defensible key.
 */
export function unknown<T = number>(analysisMethod: string, source: MeasuredSource, note: string): Measured<T> {
  return { value: null, confidence: 0, analysisMethod, provider: source.provider, modelVersion: source.modelVersion, note }
}

/** The raw number, or `fallback` when the measurement is unknown. */
export function valueOr<T>(measured: Measured<T> | null | undefined, fallback: T): T {
  if (!measured || measured.value === null || measured.value === undefined) return fallback
  return measured.value
}

/** The raw number, or null. Use in comparison code so unknowns cannot be averaged. */
export function valueOrNull<T>(measured: Measured<T> | null | undefined): T | null {
  if (!measured || measured.value === null || measured.value === undefined) return null
  return measured.value
}
