/**
 * Benchmark cohorts.
 *
 * The central rule of this module: there is no universal hit-song formula, and
 * this code will not simulate one. Every comparison names the population it
 * compared against, how many records were in it, and where those records'
 * numbers came from. A cohort with no provenance cannot be published.
 */

export const COHORT_TYPES = ['broad', 'genre', 'custom', 'catalog', 'platform'] as const
export type CohortType = (typeof COHORT_TYPES)[number]

/** Broad cohorts offered in the picker. Availability is entitlement-gated. */
export const BROAD_COHORTS = [
  { key: 'current_top_songs', label: 'Current Top Songs', description: 'Widely-performing current releases across genres.' },
  { key: 'genre_leaders', label: 'Genre Leaders', description: 'The best-performing records within a single genre.' },
  { key: 'catalog_classics', label: 'Catalog Classics', description: 'Long-lived catalogue records still performing today.' },
  { key: 'streaming_breakouts', label: 'Streaming Breakouts', description: 'Records that broke through primarily on streaming.' },
  { key: 'radio_hits', label: 'Radio Hits', description: 'Records with substantial radio performance.' },
  { key: 'viral_records', label: 'Viral Records', description: 'Records that broke through social platforms first.' },
  { key: 'sync_friendly', label: 'Sync-Friendly Records', description: 'Records with strong synchronization placement history.' },
  { key: 'independent_breakouts', label: 'Independent Breakouts', description: 'Independently released records that broke through.' },
  { key: 'street_banker_releases', label: 'Street Banker Successful Releases', description: 'Releases through this platform that met their release goals.' },
  { key: 'artist_own_catalog', label: "Artist's Own Catalogue", description: "The artist's previously analysed songs. The only cohort of one artist." },
] as const

export const GENRE_COHORTS = [
  'alternative', 'rock', 'metal', 'punk', 'pop', 'country', 'hip_hop', 'r_and_b',
  'electronic', 'dance', 'indie', 'singer_songwriter', 'other',
] as const

export type GenreCohort = (typeof GENRE_COHORTS)[number]

export const GENRE_LABELS: Record<GenreCohort, string> = {
  alternative: 'Alternative',
  rock: 'Rock',
  metal: 'Metal',
  punk: 'Punk',
  pop: 'Pop',
  country: 'Country',
  hip_hop: 'Hip-Hop',
  r_and_b: 'R&B',
  electronic: 'Electronic',
  dance: 'Dance',
  indie: 'Indie',
  singer_songwriter: 'Singer-Songwriter',
  other: 'Other',
}

/** Filters for the custom cohort builder. Every field is optional. */
export interface CohortFilterDefinition {
  genre?: string[]
  subgenre?: string[]
  releaseYearFrom?: number
  releaseYearTo?: number
  territory?: string[]
  labelType?: Array<'independent' | 'major' | 'self_released'>
  performanceCohort?: string[]
  streamsFrom?: number
  streamsTo?: number
  chartedOnly?: boolean
  radioOnly?: boolean
  artistCareerStage?: Array<'developing' | 'established' | 'legacy'>
  durationSecondsFrom?: number
  durationSecondsTo?: number
  bpmFrom?: number
  bpmTo?: number
  /** Only where a rights holder supplied it as metadata; never inferred from audio. */
  vocalConfiguration?: Array<'lead_male' | 'lead_female' | 'mixed' | 'instrumental' | 'unspecified'>
  orientation?: Array<'live' | 'streaming' | 'radio' | 'sync'>
  /** Restricts to one artist's own catalogue within the organization. */
  artistId?: string
}

/**
 * Where a cohort's numbers came from.
 *
 * Required, not optional. A benchmark cohort with `sources: []` is refused at
 * publication — see `validateCohortDefinition`. This is the field that keeps
 * the benchmark library defensible.
 */
export interface CohortSourceDefinition {
  sources: Array<{
    /** e.g. `licensed_metadata_provider`, `internal_analysis`, `public_dataset`. */
    kind: 'licensed_metadata' | 'internal_analysis' | 'public_dataset' | 'rights_holder_supplied' | 'partner_supplied'
    name: string
    /** Licence or authorization reference. Free text, but must not be empty. */
    basis: string
    /** When the data was captured. */
    capturedAt: string
    /** Whether any master recordings were stored. Must be false for licensed metadata. */
    storesMasters: boolean
  }>
  notes: string
}

export interface BenchmarkCohortDefinition {
  id: string
  organizationId: string | null
  name: string
  description: string
  cohortType: CohortType
  filterDefinition: CohortFilterDefinition
  sourceDefinition: CohortSourceDefinition
  sampleSize: number
  status: 'draft' | 'published' | 'retired'
  /** Proprietary cohorts are visible only to entitled organizations. */
  proprietary: boolean
}

/** Below this a percentile is arithmetic, not evidence. The UI must warn. */
export const LOW_SAMPLE_THRESHOLD = 30
/** Below this we refuse to publish a percentile at all. */
export const MINIMUM_SAMPLE_SIZE = 8

export interface CohortValidationIssue {
  field: string
  message: string
}

/**
 * Refuses a cohort that could mislead: no provenance, stored masters claimed
 * under a metadata licence, or too small to support a percentile.
 */
export function validateCohortDefinition(definition: Omit<BenchmarkCohortDefinition, 'id'>): CohortValidationIssue[] {
  const issues: CohortValidationIssue[] = []
  if (definition.name.trim().length === 0) issues.push({ field: 'name', message: 'a cohort needs a name' })
  if (definition.sourceDefinition.sources.length === 0) {
    issues.push({ field: 'sourceDefinition', message: 'a cohort must record where its benchmark data came from' })
  }
  for (const [index, source] of definition.sourceDefinition.sources.entries()) {
    if (source.basis.trim().length === 0) {
      issues.push({ field: `sourceDefinition.sources[${index}].basis`, message: 'every source needs a licence or authorization basis' })
    }
    if (source.kind === 'licensed_metadata' && source.storesMasters) {
      issues.push({
        field: `sourceDefinition.sources[${index}].storesMasters`,
        message: 'a licensed-metadata source cannot also store master recordings',
      })
    }
  }
  if (definition.status === 'published' && definition.sampleSize < MINIMUM_SAMPLE_SIZE) {
    issues.push({ field: 'sampleSize', message: `a published cohort needs at least ${MINIMUM_SAMPLE_SIZE} songs` })
  }
  const filter = definition.filterDefinition
  if (filter.releaseYearFrom && filter.releaseYearTo && filter.releaseYearFrom > filter.releaseYearTo) {
    issues.push({ field: 'filterDefinition.releaseYearFrom', message: 'the release-year range is inverted' })
  }
  if (filter.bpmFrom && filter.bpmTo && filter.bpmFrom > filter.bpmTo) {
    issues.push({ field: 'filterDefinition.bpmFrom', message: 'the tempo range is inverted' })
  }
  return issues
}

/** Human-readable cohort definition, e.g. `Alternative · 2022–2026 · Independent · US, UK`. */
export function describeCohort(definition: Pick<BenchmarkCohortDefinition, 'name' | 'filterDefinition' | 'sampleSize'>): string {
  const filter = definition.filterDefinition
  const parts: string[] = []
  if (filter.genre?.length) parts.push(filter.genre.map(labelForGenre).join(' / '))
  if (filter.releaseYearFrom || filter.releaseYearTo) parts.push(`${filter.releaseYearFrom ?? '…'}–${filter.releaseYearTo ?? '…'}`)
  if (filter.labelType?.length) parts.push(filter.labelType.join(' / '))
  if (filter.territory?.length) parts.push(filter.territory.join(' + '))
  if (filter.streamsFrom || filter.streamsTo) {
    parts.push(`${compact(filter.streamsFrom)}–${compact(filter.streamsTo)} streams`)
  }
  return parts.length > 0 ? parts.join(' · ') : definition.name
}

function labelForGenre(genre: string): string {
  return GENRE_LABELS[genre as GenreCohort] ?? genre
}

function compact(value: number | undefined): string {
  if (value === undefined) return '…'
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
  return String(value)
}
