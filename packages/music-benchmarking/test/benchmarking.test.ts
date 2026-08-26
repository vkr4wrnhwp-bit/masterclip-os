import { describe, expect, it } from 'vitest'
import {
  LOW_SAMPLE_THRESHOLD,
  MINIMUM_SAMPLE_SIZE,
  ReferenceBenchmarkProvider,
  compareToCohort,
  defaultCohortDefinitions,
  describeCohort,
  generateObservations,
  percentileOf,
  percentileRank,
  summarize,
  topThingsWorthTesting,
  validateCohortDefinition,
} from '../src/index.js'
import { FEATURE_VECTOR_VERSION, measured, ordinal, unknown, type SongFeatureVector } from '@masterclip/song-feature-vectors'

/**
 * Benchmarking.
 *
 * The tests that matter here are about honesty: percentiles are arithmetically
 * right, a small cohort is flagged, an unmeasured value produces no comparison
 * at all, a cohort with no provenance cannot be published, and no generated
 * recommendation claims a guaranteed outcome.
 */

const SOURCE = { provider: 'test', modelVersion: '1' }

function vector(metrics: Record<string, number | null>): SongFeatureVector {
  const out: SongFeatureVector = {
    provenance: {
      engineVersion: '1.0.0',
      featureVectorVersion: FEATURE_VECTOR_VERSION,
      providers: { features: SOURCE },
      sourceChecksum: 'abc',
      analyzedAt: '2026-01-01T00:00:00.000Z',
      configuration: {},
    },
    metrics: {},
  }
  for (const [key, value] of Object.entries(metrics)) {
    out.metrics[key] = value === null ? unknown<number>('test', SOURCE, 'not measured') : measured(value, 0.8, 'test', SOURCE)
  }
  return out
}

const RANGE_1_TO_100 = Array.from({ length: 100 }, (_, index) => index + 1)

describe('percentile statistics', () => {
  it('computes interpolated percentiles', () => {
    const sorted = [...RANGE_1_TO_100]
    expect(percentileOf(sorted, 50)).toBeCloseTo(50.5, 1)
    expect(percentileOf(sorted, 25)).toBeCloseTo(25.75, 1)
    expect(percentileOf(sorted, 75)).toBeCloseTo(75.25, 1)
  })

  it('places a value at the midpoint of its ties', () => {
    // Exactly at the median should read as the 50th percentile, not the 0th.
    expect(percentileRank([10, 20, 30], 20)).toBeCloseTo(50, 1)
    expect(percentileRank([10, 20, 30], 5)).toBe(0)
    expect(percentileRank([10, 20, 30], 40)).toBe(100)
  })

  it('summarizes a distribution', () => {
    const summary = summarize(RANGE_1_TO_100)!
    expect(summary.sampleSize).toBe(100)
    expect(summary.median).toBeCloseTo(50.5, 1)
    expect(summary.p10).toBeCloseTo(10.9, 1)
    expect(summary.p90).toBeCloseTo(90.1, 1)
  })

  it('returns null rather than a fabricated summary for no data', () => {
    expect(summarize([])).toBeNull()
  })
})

describe('cohort validation', () => {
  const base = {
    organizationId: null,
    name: 'Test cohort',
    description: '',
    cohortType: 'genre' as const,
    filterDefinition: {},
    sampleSize: 100,
    status: 'published' as const,
    proprietary: false,
  }

  it('refuses a cohort with no provenance', () => {
    const issues = validateCohortDefinition({ ...base, sourceDefinition: { sources: [], notes: '' } })
    expect(issues.some((issue) => issue.field === 'sourceDefinition')).toBe(true)
  })

  it('refuses a licensed-metadata source that claims to store masters', () => {
    const issues = validateCohortDefinition({
      ...base,
      sourceDefinition: {
        sources: [{ kind: 'licensed_metadata', name: 'x', basis: 'contract', capturedAt: '2026-01-01T00:00:00.000Z', storesMasters: true }],
        notes: '',
      },
    })
    expect(issues.some((issue) => issue.message.includes('cannot also store master recordings'))).toBe(true)
  })

  it('refuses publishing a cohort below the minimum sample size', () => {
    const issues = validateCohortDefinition({
      ...base,
      sampleSize: MINIMUM_SAMPLE_SIZE - 1,
      sourceDefinition: {
        sources: [{ kind: 'internal_analysis', name: 'x', basis: 'internal', capturedAt: '2026-01-01T00:00:00.000Z', storesMasters: false }],
        notes: '',
      },
    })
    expect(issues.some((issue) => issue.field === 'sampleSize')).toBe(true)
  })

  it('accepts a well-formed cohort', () => {
    expect(
      validateCohortDefinition({
        ...base,
        sourceDefinition: {
          sources: [{ kind: 'internal_analysis', name: 'x', basis: 'internal', capturedAt: '2026-01-01T00:00:00.000Z', storesMasters: false }],
          notes: '',
        },
      }),
    ).toEqual([])
  })

  it('every shipped cohort definition validates and stores no masters', () => {
    for (const definition of defaultCohortDefinitions()) {
      expect(validateCohortDefinition({ ...definition, organizationId: null })).toEqual([])
      expect(definition.sourceDefinition.sources.every((source) => !source.storesMasters)).toBe(true)
    }
  })

  it('describes a cohort in human terms', () => {
    const text = describeCohort({
      name: 'x',
      sampleSize: 100,
      filterDefinition: { genre: ['alternative'], releaseYearFrom: 2022, releaseYearTo: 2026, labelType: ['independent'], territory: ['US', 'UK'] },
    })
    expect(text).toContain('Alternative')
    expect(text).toContain('2022–2026')
    expect(text).toContain('independent')
  })
})

describe('comparison engine', () => {
  const cohortValues = { values: { bpm: RANGE_1_TO_100.map((value) => 80 + value * 0.5), first_chorus_seconds: RANGE_1_TO_100 } }
  const cohort = { id: 'coh_1', name: 'Test cohort', sampleSize: 100, filterDefinition: {} }

  it('computes a percentile against the cohort', () => {
    const comparison = compareToCohort({ vector: vector({ bpm: 105 }), cohort, cohortValues, metricKeys: ['bpm'] })
    const result = comparison.results[0]!
    expect(result.percentile).toBeGreaterThan(45)
    expect(result.percentile).toBeLessThan(55)
    expect(result.sampleSize).toBe(100)
  })

  it('labels an extreme value an outlier and a typical one similar', () => {
    const high = compareToCohort({ vector: vector({ bpm: 129 }), cohort, cohortValues, metricKeys: ['bpm'] }).results[0]!
    expect(high.classification).toBe('structure_outlier')
    expect(high.classificationLabel).toContain('Outlier')

    const typical = compareToCohort({ vector: vector({ bpm: 105 }), cohort, cohortValues, metricKeys: ['bpm'] }).results[0]!
    expect(typical.classification).toBe('similar_to_cohort')
    expect(typical.classificationLabel).toBe('Similar To Cohort')
  })

  it(`uses the metric own direction words rather than high and low`, () => {
    const late = compareToCohort({
      vector: vector({ first_chorus_seconds: 99 }),
      cohort,
      cohortValues,
      metricKeys: ['first_chorus_seconds'],
    }).results[0]!
    expect(late.classificationLabel).toContain('Later Than Cohort')
  })

  it('produces no comparison for a value the analyser could not measure', () => {
    const comparison = compareToCohort({ vector: vector({ bpm: null }), cohort, cohortValues, metricKeys: ['bpm'] })
    const result = comparison.results[0]!
    expect(result.classification).toBe('insufficient_data')
    expect(result.percentile).toBeNull()
    // The crucial property: an unmeasured value never becomes a zero.
    expect(result.songValue).toBeNull()
    expect(result.songDisplay).toBe('not enough information')
  })

  it('drops a metric the cohort holds no data for', () => {
    const comparison = compareToCohort({ vector: vector({ stereo_width: 0.3 }), cohort, cohortValues, metricKeys: ['stereo_width'] })
    expect(comparison.results).toHaveLength(0)
    expect(comparison.unavailableMetrics).toContain('stereo_width')
  })

  it('refuses to compute against a cohort below the minimum sample size', () => {
    const comparison = compareToCohort({
      vector: vector({ bpm: 100 }),
      cohort: { ...cohort, sampleSize: 4 },
      cohortValues: { values: { bpm: [90, 100, 110, 120] } },
      metricKeys: ['bpm'],
    })
    expect(comparison.results).toHaveLength(0)
  })

  it('flags a cohort under the low-sample threshold', () => {
    const small = Array.from({ length: 12 }, (_, index) => 90 + index)
    const comparison = compareToCohort({
      vector: vector({ bpm: 100 }),
      cohort: { ...cohort, sampleSize: 12 },
      cohortValues: { values: { bpm: small } },
      metricKeys: ['bpm'],
    })
    expect(comparison.lowSample).toBe(true)
    expect(comparison.results[0]!.lowSample).toBe(true)
    expect(comparison.sampleSize).toBeLessThan(LOW_SAMPLE_THRESHOLD)
  })

  it('caps confidence by sample size as well as by measurement quality', () => {
    const small = Array.from({ length: 10 }, (_, index) => 90 + index)
    const result = compareToCohort({
      vector: vector({ bpm: 100 }),
      cohort: { ...cohort, sampleSize: 10 },
      cohortValues: { values: { bpm: small } },
      metricKeys: ['bpm'],
    }).results[0]!
    // Measurement confidence was 0.8; the ten-song cohort must pull it down.
    expect(result.confidence).toBeLessThan(0.8)
  })
})

describe('observations', () => {
  const cohortValues = { values: { first_chorus_seconds: RANGE_1_TO_100.map((value) => value * 0.6) } }
  const cohort = { id: 'coh_1', name: 'Alternative — Independent', sampleSize: 100, filterDefinition: {} }

  it('suggests an earlier chorus when the chorus lands late, framed as worth testing', () => {
    const comparison = compareToCohort({
      vector: vector({ first_chorus_seconds: 58 }),
      cohort,
      cohortValues,
      metricKeys: ['first_chorus_seconds'],
    })
    const drafts = generateObservations({ comparison })
    const draft = drafts.find((entry) => entry.observationType === 'timing_outlier')!
    expect(draft).toBeDefined()
    expect(draft.severity).toBe('worth_testing')
    expect(draft.recommendations[0]!.recommendationType).toBe('earlier_chorus')
    expect(draft.recommendations[0]!.experimentSupported).toBe(true)
  })

  it('never claims a recommendation guarantees an outcome', () => {
    const comparison = compareToCohort({
      vector: vector({ first_chorus_seconds: 58 }),
      cohort,
      cohortValues,
      metricKeys: ['first_chorus_seconds'],
    })
    const drafts = generateObservations({
      comparison,
      repeatedSimilarities: [{ fromLabel: 'Chorus 1', toLabel: 'Chorus 2', similarity: 0.95 }],
    })
    const text = drafts
      .flatMap((draft) => [draft.title, draft.description, ...draft.recommendations.flatMap((r) => [r.title, r.description])])
      .join(' ')
      .toLowerCase()

    for (const forbidden of ['will perform better', 'guarantee', 'will be a hit', 'this will make', 'proven to', 'your song is wrong', 'bad chorus', 'too slow']) {
      expect(text).not.toContain(forbidden)
    }
    expect(text).toContain('worth')
  })

  it('raises low section contrast from measured similarity, not from a cohort', () => {
    const comparison = compareToCohort({ vector: vector({}), cohort, cohortValues: { values: {} }, metricKeys: [] })
    const drafts = generateObservations({
      comparison,
      repeatedSimilarities: [{ fromLabel: 'Chorus 1', toLabel: 'Chorus 2', similarity: 0.94 }],
    })
    const draft = drafts.find((entry) => entry.observationType === 'low_section_contrast')!
    expect(draft).toBeDefined()
    expect(draft.description).toContain('94%')
    // It is a note for a producer, not something the engine can render.
    expect(draft.recommendations[0]!.experimentSupported).toBe(false)
  })

  it('says nothing when a similarity is unremarkable', () => {
    const comparison = compareToCohort({ vector: vector({}), cohort, cohortValues: { values: {} }, metricKeys: [] })
    const drafts = generateObservations({
      comparison,
      repeatedSimilarities: [{ fromLabel: 'Chorus 1', toLabel: 'Chorus 2', similarity: 0.6 }],
    })
    expect(drafts).toHaveLength(0)
  })

  it('raises low register contrast from this recording alone, with no cohort involved', () => {
    const comparison = compareToCohort({ vector: vector({}), cohort, cohortValues: { values: {} }, metricKeys: [] })
    const drafts = generateObservations({
      comparison,
      registerContrast: {
        verseLabel: 'Verse 1',
        chorusLabel: 'Chorus 1',
        verseRegister: 0.34,
        chorusRegister: 0.36,
        lift: 0.02,
        confidence: 0.45,
      },
    })
    const draft = drafts.find((entry) => entry.observationType === 'melodic_contrast')!
    expect(draft).toBeDefined()
    expect(draft.description).toContain('Verse 1')
    expect(draft.sourceMetricKeys).toContain('chorus_register_lift')
    // A melody is a writing and performance decision. Nothing here renders.
    expect(draft.recommendations[0]!.experimentSupported).toBe(false)
    // The claim is about a normalized band, and the text has to say so rather
    // than implying transcribed pitch.
    expect(draft.description.toLowerCase()).toContain('not a transcribed melody')
  })

  it('says nothing about register when the chorus genuinely lifts away from the verse', () => {
    const comparison = compareToCohort({ vector: vector({}), cohort, cohortValues: { values: {} }, metricKeys: [] })
    const drafts = generateObservations({
      comparison,
      registerContrast: {
        verseLabel: 'Verse 1',
        chorusLabel: 'Chorus 1',
        verseRegister: 0.31,
        chorusRegister: 0.52,
        lift: 0.21,
        confidence: 0.45,
      },
    })
    expect(drafts).toHaveLength(0)
  })

  it('will not raise a register finding it is not confident enough to support', () => {
    const comparison = compareToCohort({ vector: vector({}), cohort, cohortValues: { values: {} }, metricKeys: [] })
    const drafts = generateObservations({
      comparison,
      registerContrast: {
        verseLabel: 'Verse 1',
        chorusLabel: 'Chorus 1',
        verseRegister: 0.34,
        chorusRegister: 0.35,
        lift: 0.01,
        // Below MIN_OBSERVATION_CONFIDENCE: measured, but not firmly enough to
        // put in front of an artist as a finding.
        confidence: 0.1,
      },
    })
    expect(drafts).toHaveLength(0)
  })

  it('phrases a below-cohort register lift as a comparison, never as a fault', () => {
    const comparison = compareToCohort({
      vector: vector({ chorus_register_lift: 0.01 }),
      cohort,
      cohortValues: { values: { chorus_register_lift: Array.from({ length: 60 }, (_, i) => 0.05 + i * 0.004) } },
      metricKeys: ['chorus_register_lift'],
    })
    const draft = generateObservations({ comparison }).find((entry) => entry.observationType === 'melodic_contrast')!
    expect(draft).toBeDefined()
    expect(draft.severity).toBe('potential_opportunity')
    const text = `${draft.title} ${draft.description}`.toLowerCase()
    expect(text).not.toContain('too low')
    expect(text).not.toContain('weak')
    expect(text).toContain('cohort')
  })

  it('returns fewer than three headline items rather than padding', () => {
    expect(topThingsWorthTesting([], 3)).toHaveLength(0)
  })

  it('folds two metrics describing the same finding into one observation', () => {
    // A song whose hook *is* its chorus reports both metrics late. That is one
    // finding, and showing it twice would make it look like two.
    const comparison = compareToCohort({
      vector: vector({ first_chorus_seconds: 58, first_hook_seconds: 58 }),
      cohort,
      cohortValues: { values: { first_chorus_seconds: cohortValues.values.first_chorus_seconds, first_hook_seconds: cohortValues.values.first_chorus_seconds } },
      metricKeys: ['first_chorus_seconds', 'first_hook_seconds'],
    })
    const drafts = generateObservations({ comparison })
    const titles = drafts.map((draft) => draft.title)
    expect(new Set(titles).size).toBe(titles.length)
    const merged = drafts.find((draft) => draft.title === 'Chorus sooner')!
    // Both metrics are still credited as evidence.
    expect(merged.sourceMetricKeys).toContain('first_chorus_seconds')
    expect(merged.sourceMetricKeys).toContain('first_hook_seconds')
  })

  it('writes correct ordinals in the summary text', () => {
    const comparison = compareToCohort({
      vector: vector({ first_chorus_seconds: 50 }),
      cohort,
      cohortValues,
      metricKeys: ['first_chorus_seconds'],
    })
    const summary = comparison.results[0]!.summary
    expect(summary).toMatch(/\d+(st|nd|rd|th) percentile/)
    expect(summary).not.toMatch(/\d*1th|\d*2th|\d*3th/)
  })
})

describe('ordinals', () => {
  it('handles the teens and the single digits', () => {
    const cases: Array<[number, string]> = [
      [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'],
      [11, '11th'], [12, '12th'], [13, '13th'],
      [21, '21st'], [22, '22nd'], [23, '23rd'],
      [83, '83rd'], [100, '100th'], [111, '111th'],
    ]
    for (const [value, expected] of cases) expect(ordinal(value), String(value)).toBe(expected)
  })
})

describe('reference benchmark provider', () => {
  it('is deterministic for a given cohort id', async () => {
    const provider = new ReferenceBenchmarkProvider(60)
    const first = await provider.queryCohort({ cohortId: 'coh_x', filterDefinition: {}, organizationId: 'org_1' })
    const second = await provider.queryCohort({ cohortId: 'coh_x', filterDefinition: {}, organizationId: 'org_1' })
    expect(first.values.bpm).toEqual(second.values.bpm)
  })

  it('stamps its provenance so nothing mistakes it for market data', async () => {
    const provider = new ReferenceBenchmarkProvider(60)
    const result = await provider.queryCohort({ cohortId: 'coh_x', filterDefinition: {}, organizationId: 'org_1' })
    expect(result.provenance[0]!.kind).toBe('reference_distribution')
    expect(result.provenance[0]!.basis).toContain('Not market data')
  })

  it('shifts the distribution by genre', async () => {
    const provider = new ReferenceBenchmarkProvider(200)
    const punk = await provider.queryCohort({ cohortId: 'coh_a', filterDefinition: { genre: ['punk'] }, organizationId: 'org_1' })
    const singer = await provider.queryCohort({ cohortId: 'coh_a', filterDefinition: { genre: ['singer_songwriter'] }, organizationId: 'org_1' })
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    expect(mean(punk.values.bpm!)).toBeGreaterThan(mean(singer.values.bpm!))
  })
})
