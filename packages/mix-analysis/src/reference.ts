import { metricValue } from './analyze.js'
import { median } from './spectrum.js'
import { mixMetricDefinition, type MixMetric } from './types.js'

/**
 * Reference DNA.
 *
 * What this does: measures characteristics of tracks the user has told us they
 * are entitled to use as references, and states the difference between their
 * record and the median of that set.
 *
 * What it deliberately does not do: reproduce, regenerate, approximate or
 * "match" a copyrighted recording. There is no function here that takes a
 * reference and produces audio, and the comparison output is a set of
 * observations — measurements of the user's own record, described relative to a
 * cohort they chose.
 *
 * Every observation names its cohort size. A comparison against one reference
 * is a comparison against one record, and the copy says exactly that rather
 * than implying a norm.
 */

export interface ReferenceProfile {
  referenceId: string
  label: string
  metrics: MixMetric[]
  /** Structural timings, where a structural analysis exists for the reference. */
  structure?: ReferenceStructure | null
}

export interface ReferenceStructure {
  durationMs: number | null
  bpm: number | null
  key: string | null
  introMs: number | null
  firstChorusMs: number | null
  verseMs: number | null
  preChorusMs: number | null
}

export interface ReferenceComparisonRow {
  metricKey: string
  label: string
  unit: string
  yours: number | null
  referenceMedian: number | null
  delta: number | null
  /** Cohort size behind `referenceMedian`. Printed with every row. */
  cohortSize: number
  observation: string
}

export interface ReferenceComparison {
  cohortSize: number
  cohortLabels: string[]
  rows: ReferenceComparisonRow[]
  /** The handful of differences worth leading with, as complete sentences. */
  headlines: string[]
  caveat: string
}

export const REFERENCE_CAVEAT =
  'References describe a comparison set you chose, not a standard. A difference is a difference — it is only a problem if it is not what you wanted.'

/**
 * Metrics worth comparing, and how large a difference must be before it is
 * worth a sentence.
 *
 * Metrics absent from this list are still measured; they are just not compared,
 * because the difference between two records' clipping counts or DC offsets
 * says nothing useful about either.
 */
const COMPARABLE: Array<{ key: string; meaningful: number; higher: string; lower: string }> = [
  { key: 'integrated_lufs', meaningful: 1, higher: 'a higher measured loudness', lower: 'a lower measured loudness' },
  { key: 'dynamic_range_db', meaningful: 1.5, higher: 'more dynamic range', lower: 'less dynamic range' },
  { key: 'loudness_range_lu', meaningful: 1.5, higher: 'a wider loudness range', lower: 'a narrower loudness range' },
  { key: 'true_peak_dbtp', meaningful: 0.5, higher: 'a higher peak ceiling', lower: 'a lower peak ceiling' },
  { key: 'sub_energy_pct', meaningful: 2, higher: 'more sub energy', lower: 'less sub energy' },
  { key: 'low_energy_pct', meaningful: 2, higher: 'more low-frequency energy', lower: 'less low-frequency energy' },
  { key: 'low_mid_energy_pct', meaningful: 2, higher: 'more low-mid energy', lower: 'less low-mid energy' },
  { key: 'mid_energy_pct', meaningful: 2, higher: 'more midrange energy', lower: 'less midrange energy' },
  { key: 'high_mid_energy_pct', meaningful: 2, higher: 'more upper-mid energy', lower: 'less upper-mid energy' },
  { key: 'high_energy_pct', meaningful: 1.5, higher: 'more energy above 6 kHz', lower: 'less energy above 6 kHz' },
  { key: 'spectral_centroid_hz', meaningful: 200, higher: 'a brighter overall balance', lower: 'a darker overall balance' },
  { key: 'spectral_tilt_db_per_oct', meaningful: 0.5, higher: 'a flatter spectral slope', lower: 'a steeper spectral slope' },
  { key: 'stereo_width', meaningful: 0.05, higher: 'a wider stereo image', lower: 'a narrower stereo image' },
  { key: 'phase_correlation', meaningful: 0.1, higher: 'more mono-compatible channels', lower: 'less mono-compatible channels' },
  { key: 'low_end_centroid_hz', meaningful: 8, higher: 'low-end weight sitting higher', lower: 'low-end weight sitting lower' },
  { key: 'vocal_presence_index', meaningful: 0.1, higher: 'more of the record carrying a lead vocal', lower: 'less of the record carrying a lead vocal' },
]

export function compareToReferences(yours: MixMetric[], references: ReferenceProfile[]): ReferenceComparison {
  const usable = references.filter((reference) => reference.metrics.length > 0)
  const rows: ReferenceComparisonRow[] = []

  for (const entry of COMPARABLE) {
    const mine = metricValue(yours, entry.key)
    const theirs = usable.map((reference) => metricValue(reference.metrics, entry.key)).filter((value): value is number => value !== null)
    const definition = mixMetricDefinition(entry.key)
    if (!definition) continue

    if (mine === null || theirs.length === 0) {
      rows.push({
        metricKey: entry.key,
        label: definition.label,
        unit: definition.unit,
        yours: mine,
        referenceMedian: theirs.length > 0 ? round(median(theirs)) : null,
        delta: null,
        cohortSize: theirs.length,
        observation:
          mine === null
            ? 'Not measured on your record, so there is nothing to compare.'
            : 'None of your references could be measured for this, so there is no comparison.',
      })
      continue
    }

    const referenceMedian = median(theirs)
    const delta = mine - referenceMedian
    const meaningful = Math.abs(delta) >= entry.meaningful
    rows.push({
      metricKey: entry.key,
      label: definition.label,
      unit: definition.unit,
      yours: round(mine),
      referenceMedian: round(referenceMedian),
      delta: round(delta),
      cohortSize: theirs.length,
      observation: meaningful
        ? `Your record has ${delta > 0 ? entry.higher : entry.lower} than the median of ${cohortPhrase(theirs.length)}.`
        : `Close to the median of ${cohortPhrase(theirs.length)}.`,
    })
  }

  return {
    cohortSize: usable.length,
    cohortLabels: usable.map((reference) => reference.label),
    rows,
    headlines: buildHeadlines(rows, yours, usable),
    caveat: REFERENCE_CAVEAT,
  }
}

/**
 * The three or four differences worth reading first.
 *
 * Ranked by how far each sits beyond its own meaningfulness threshold, so a
 * 4 LU loudness gap outranks a 2.1 % midrange difference even though both
 * cleared their bar.
 */
function buildHeadlines(rows: ReferenceComparisonRow[], yours: MixMetric[], references: ReferenceProfile[]): string[] {
  const ranked = rows
    .map((row) => {
      const entry = COMPARABLE.find((candidate) => candidate.key === row.metricKey)
      if (!entry || row.delta === null) return null
      const excess = Math.abs(row.delta) / entry.meaningful
      return excess >= 1 ? { row, excess } : null
    })
    .filter((value): value is { row: ReferenceComparisonRow; excess: number } => value !== null)
    .sort((a, b) => b.excess - a.excess)
    .slice(0, 4)

  const headlines = ranked.map(({ row }) => {
    const unit = unitSuffix(row.unit)
    return `${row.observation.replace(/\.$/, '')} — ${row.yours}${unit} against ${row.referenceMedian}${unit}.`
  })

  const structural = structuralHeadline(yours, references)
  if (structural) headlines.unshift(structural)
  return headlines
}

/**
 * Arrangement timing, where the caller supplied structure for both sides.
 *
 * This is the observation the module is really for — "your first chorus arrives
 * later than your references" is a decision an artist can act on, in a way that
 * a spectral tilt difference is not.
 */
function structuralHeadline(yours: MixMetric[], references: ReferenceProfile[]): string | null {
  const mine = references.find((reference) => reference.structure && reference.referenceId === 'self')?.structure
  const others = references.filter((reference) => reference.referenceId !== 'self' && reference.structure?.firstChorusMs != null)
  if (!mine?.firstChorusMs || others.length === 0) return null
  const theirs = others.map((reference) => reference.structure?.firstChorusMs).filter((value): value is number => typeof value === 'number')
  if (theirs.length === 0) return null
  const referenceMedian = median(theirs)
  const deltaSeconds = (mine.firstChorusMs - referenceMedian) / 1000
  if (Math.abs(deltaSeconds) < 4) return null
  return `Your first chorus arrives approximately ${Math.abs(deltaSeconds).toFixed(0)} seconds ${deltaSeconds > 0 ? 'later' : 'earlier'} than the median of ${cohortPhrase(theirs.length)}.`
}

function cohortPhrase(size: number): string {
  return size === 1 ? 'your single reference' : `your ${size} references`
}

function unitSuffix(unit: string): string {
  switch (unit) {
    case 'lufs':
      return ' LUFS'
    case 'lu':
      return ' LU'
    case 'db':
    case 'dbfs':
      return ' dB'
    case 'dbtp':
      return ' dBTP'
    case 'percent':
      return '%'
    case 'hz':
      return ' Hz'
    default:
      return ''
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
