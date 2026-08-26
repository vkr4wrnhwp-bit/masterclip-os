import { METRICS } from '@masterclip/song-feature-vectors'
import type { BenchmarkCohortDefinition, CohortFilterDefinition } from './cohorts.js'
import type { CohortMetricValues } from './compare.js'

/**
 * The benchmark data seam.
 *
 * A provider answers one question: *for this cohort, what are the per-metric
 * distributions?* It never returns audio, and the interface gives it no way to.
 * That constraint is the architecture: a benchmark library built from licensed
 * *metadata and derived features* is defensible, and a library of other
 * people's masters is not.
 */

export interface BenchmarkQuery {
  cohortId: string
  filterDefinition: CohortFilterDefinition
  /** Restrict to these metrics. Omit for everything the provider holds. */
  metricKeys?: string[]
  /** Requesting organization, for tenant-scoped cohorts. */
  organizationId: string
}

export interface BenchmarkCohortResult {
  cohortId: string
  sampleSize: number
  values: CohortMetricValues['values']
  /** Provenance echoed back with the numbers, so results carry their basis. */
  provenance: Array<{ kind: string; name: string; basis: string; capturedAt: string }>
  providerId: string
}

export interface BenchmarkProvider {
  readonly providerId: string
  isConfigured(): boolean
  queryCohort(input: BenchmarkQuery): Promise<BenchmarkCohortResult>
}

/**
 * The reference-distribution provider.
 *
 * Distributions are generated from published, openly-documented *ranges* for
 * broad song characteristics (runtime, tempo, section counts), widened to
 * plausible spreads and seeded deterministically per cohort. It stores no
 * master recordings and claims no licensed catalogue: it exists so the product
 * is fully operable before a licensed data agreement is in place, and every
 * result it returns is stamped `reference_distribution` in its provenance so
 * nothing downstream can mistake it for market data.
 */
export class ReferenceBenchmarkProvider implements BenchmarkProvider {
  readonly providerId = 'reference-distribution'

  constructor(private readonly sampleSize = 120) {}

  isConfigured(): boolean {
    return true
  }

  async queryCohort(input: BenchmarkQuery): Promise<BenchmarkCohortResult> {
    const random = seeded(input.cohortId)
    const keys = input.metricKeys ?? METRICS.map((metric) => metric.key)
    const values: CohortMetricValues['values'] = {}

    for (const key of keys) {
      const shape = REFERENCE_SHAPES[key]
      if (!shape) continue
      const genre = input.filterDefinition.genre?.[0]
      const adjusted = applyGenreShift(key, shape, genre)
      values[key] = Array.from({ length: this.sampleSize }, () => sampleNormal(random, adjusted.centre, adjusted.spread, adjusted.min, adjusted.max))
    }

    return {
      cohortId: input.cohortId,
      sampleSize: this.sampleSize,
      values,
      provenance: [
        {
          kind: 'reference_distribution',
          name: 'Song Lab reference distributions',
          basis: 'Synthetic distributions over published general song-characteristic ranges. Not market data, not licensed catalogue data, no master recordings.',
          capturedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      providerId: this.providerId,
    }
  }
}

interface ReferenceShape {
  centre: number
  spread: number
  min: number
  max: number
}

/** Broad, genre-agnostic starting points. Deliberately wide. */
const REFERENCE_SHAPES: Record<string, ReferenceShape> = {
  duration_seconds: { centre: 200, spread: 42, min: 90, max: 400 },
  bpm: { centre: 118, spread: 22, min: 60, max: 190 },
  tempo_stability: { centre: 0.88, spread: 0.1, min: 0.3, max: 1 },
  loudness_lufs: { centre: -9.5, spread: 2.2, min: -20, max: -4 },
  dynamic_range_db: { centre: 8, spread: 3, min: 2, max: 20 },
  stereo_width: { centre: 0.27, spread: 0.09, min: 0.02, max: 0.6 },
  intro_seconds: { centre: 13, spread: 7, min: 0, max: 45 },
  first_vocal_seconds: { centre: 17, spread: 9, min: 0, max: 70 },
  first_hook_seconds: { centre: 44, spread: 15, min: 8, max: 120 },
  first_chorus_seconds: { centre: 46, spread: 15, min: 10, max: 130 },
  runtime_before_first_repeat: { centre: 78, spread: 22, min: 20, max: 180 },
  runtime_after_final_hook: { centre: 16, spread: 11, min: 0, max: 70 },
  section_count: { centre: 9, spread: 2.2, min: 4, max: 16 },
  unique_section_count: { centre: 5.4, spread: 1.3, min: 2, max: 9 },
  chorus_count: { centre: 3.1, spread: 0.9, min: 1, max: 6 },
  verse_count: { centre: 2.4, spread: 0.8, min: 1, max: 5 },
  average_section_seconds: { centre: 24, spread: 6, min: 8, max: 60 },
  section_length_variance: { centre: 0.42, spread: 0.14, min: 0.05, max: 1 },
  first_verse_seconds: { centre: 28, spread: 8, min: 10, max: 70 },
  second_verse_seconds: { centre: 27, spread: 8, min: 8, max: 70 },
  chorus_seconds: { centre: 27, spread: 7, min: 8, max: 60 },
  bridge_position_ratio: { centre: 0.66, spread: 0.09, min: 0.35, max: 0.9 },
  outro_seconds: { centre: 14, spread: 9, min: 0, max: 60 },
  structural_symmetry: { centre: 0.6, spread: 0.17, min: 0, max: 1 },
  repetition_frequency: { centre: 0.5, spread: 0.13, min: 0.1, max: 0.85 },
  chorus_share: { centre: 32, spread: 8, min: 10, max: 60 },
  hook_repetition: { centre: 3.2, spread: 1, min: 1, max: 7 },
  title_repetition: { centre: 4.1, spread: 1.8, min: 0, max: 12 },
  final_chorus_contrast: { centre: 0.18, spread: 0.09, min: 0, max: 0.6 },
  peak_energy_position: { centre: 0.74, spread: 0.13, min: 0.2, max: 1 },
  energy_range: { centre: 0.42, spread: 0.12, min: 0.05, max: 0.9 },
  chorus_energy_lift: { centre: 0.17, spread: 0.08, min: -0.1, max: 0.5 },
  dynamic_contrast: { centre: 0.13, spread: 0.05, min: 0.01, max: 0.4 },
  arrangement_density: { centre: 0.55, spread: 0.12, min: 0.15, max: 0.95 },
  spectral_density: { centre: 0.47, spread: 0.11, min: 0.1, max: 0.9 },
  transient_density: { centre: 0.49, spread: 0.12, min: 0.1, max: 0.95 },
  low_frequency_density: { centre: 0.35, spread: 0.1, min: 0.05, max: 0.75 },
  chorus_similarity: { centre: 78, spread: 11, min: 40, max: 99 },
  // Scale-free shape quantities, siblings of dynamic_contrast and
  // chorus_similarity above: a mean delta over a 0–1 density, and a 0–100
  // similarity. The absolute register metrics deliberately have no shape here —
  // see the note below REFERENCE_SHAPES.
  rhythmic_contrast: { centre: 0.14, spread: 0.06, min: 0.01, max: 0.45 },
  melodic_contour_repetition: { centre: 74, spread: 13, min: 30, max: 99 },
  vocal_occupancy: { centre: 58, spread: 12, min: 15, max: 92 },
  verse_vocal_occupancy: { centre: 66, spread: 12, min: 20, max: 95 },
  chorus_vocal_occupancy: { centre: 71, spread: 11, min: 25, max: 97 },
  vocal_density_contrast: { centre: 0.12, spread: 0.07, min: -0.2, max: 0.45 },
  average_phrase_seconds: { centre: 2.4, spread: 0.7, min: 0.7, max: 6 },
  longest_phrase_seconds: { centre: 5.1, spread: 1.6, min: 1.5, max: 14 },
  rest_ratio: { centre: 38, spread: 11, min: 8, max: 80 },
  syllables_per_second: { centre: 3.4, spread: 1.1, min: 0.6, max: 9 },
  chorus_syllables_per_second: { centre: 3.1, spread: 1, min: 0.5, max: 9 },
  hook_line_syllables: { centre: 7.2, spread: 2.3, min: 2, max: 18 },
  verse_chorus_vocabulary_overlap: { centre: 21, spread: 9, min: 2, max: 60 },
  lyric_repetition: { centre: 26, spread: 11, min: 0, max: 70 },
}

/**
 * Deliberately absent: `verse_register`, `chorus_register`,
 * `vocal_register_range`, `peak_register_position` and `chorus_register_lift`.
 *
 * A register here is a position on *this analyser's* normalized centroid scale,
 * not a pitch. A synthetic "cohort median register" would therefore be a number
 * about Song Lab's own DSP rather than about any body of records, and inventing
 * one would be exactly the fabricated comparison this module refuses to make.
 * Register findings come from the recording itself — the verse-to-chorus lift is
 * measured within one song, where the scale cancels — and a licensed provider
 * that genuinely holds register distributions can supply these keys without any
 * change here: the comparison and observation paths for them already exist.
 */

/** Documented, coarse genre tendencies. Applied to a handful of metrics only. */
const GENRE_SHIFTS: Record<string, Partial<Record<string, number>>> = {
  metal: { bpm: 26, loudness_lufs: 1.5, low_frequency_density: 0.06 },
  punk: { bpm: 34, duration_seconds: -45, intro_seconds: -5 },
  dance: { bpm: 8, duration_seconds: 22, intro_seconds: 9, first_chorus_seconds: 12 },
  electronic: { bpm: 6, intro_seconds: 7, first_chorus_seconds: 8 },
  hip_hop: { bpm: -22, syllables_per_second: 1.6, first_chorus_seconds: -6 },
  country: { bpm: -6, first_chorus_seconds: 4, title_repetition: 1.2 },
  singer_songwriter: { bpm: -14, arrangement_density: -0.12, dynamic_range_db: 3 },
  indie: { loudness_lufs: -1.5, dynamic_range_db: 1.5 },
  pop: { first_chorus_seconds: -6, intro_seconds: -3, title_repetition: 0.9 },
  alternative: { dynamic_range_db: 1, first_chorus_seconds: -4, bpm: -6 },
  rock: { dynamic_range_db: 0.8 },
  r_and_b: { bpm: -12, vocal_occupancy: 4 },
}

function applyGenreShift(key: string, shape: ReferenceShape, genre: string | undefined): ReferenceShape {
  const shift = genre ? GENRE_SHIFTS[genre]?.[key] : undefined
  if (shift === undefined) return shape
  return { ...shape, centre: Math.max(shape.min, Math.min(shape.max, shape.centre + shift)) }
}

/** Box–Muller, clamped to the metric's plausible range. */
function sampleNormal(random: () => number, centre: number, spread: number, min: number, max: number): number {
  const u1 = Math.max(1e-9, random())
  const u2 = random()
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.round(Math.max(min, Math.min(max, centre + normal * spread)) * 1000) / 1000
}

function seeded(key: string): () => number {
  let state = 0
  for (let i = 0; i < key.length; i++) state = (Math.imul(state, 31) + key.charCodeAt(i)) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Cohort definitions the deployment ships with. */
export function defaultCohortDefinitions(): Array<Omit<BenchmarkCohortDefinition, 'id' | 'organizationId'>> {
  const provenance = {
    sources: [
      {
        kind: 'internal_analysis' as const,
        name: 'Song Lab reference distributions',
        basis: 'Synthetic distributions over published general song-characteristic ranges. No master recordings, no licensed catalogue data.',
        capturedAt: '2026-01-01T00:00:00.000Z',
        storesMasters: false,
      },
    ],
    notes:
      'Ships with the platform so the benchmark flow is operable before a licensed data agreement exists. Replace with a licensed provider ' +
      'before presenting these figures as market data.',
  }

  return [
    {
      name: 'Alternative — Independent — 2022–2026',
      description: 'Independent alternative releases from 2022 onward.',
      cohortType: 'genre',
      filterDefinition: { genre: ['alternative'], releaseYearFrom: 2022, releaseYearTo: 2026, labelType: ['independent'] },
      sourceDefinition: provenance,
      sampleSize: 120,
      status: 'published',
      proprietary: false,
    },
    {
      name: 'Pop — Streaming Breakouts',
      description: 'Pop records that broke through primarily on streaming.',
      cohortType: 'genre',
      filterDefinition: { genre: ['pop'], performanceCohort: ['streaming_breakouts'] },
      sourceDefinition: provenance,
      sampleSize: 120,
      status: 'published',
      proprietary: false,
    },
    {
      name: 'Current Top Songs — All Genres',
      description: 'A broad cross-genre comparison group.',
      cohortType: 'broad',
      filterDefinition: { performanceCohort: ['current_top_songs'] },
      sourceDefinition: provenance,
      sampleSize: 120,
      status: 'published',
      proprietary: false,
    },
    {
      name: 'Street Banker Successful Releases',
      description: 'Releases through this platform that met their release goals. Flagship intelligence.',
      cohortType: 'platform',
      filterDefinition: { performanceCohort: ['street_banker_releases'] },
      sourceDefinition: provenance,
      sampleSize: 120,
      status: 'published',
      // Proprietary: partner organizations see it only with an explicit grant.
      proprietary: true,
    },
  ]
}
