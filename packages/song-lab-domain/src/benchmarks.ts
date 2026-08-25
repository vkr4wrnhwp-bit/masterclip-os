import { insertRow, parseJsonColumn, toBool, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { AppError, forbidden, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import {
  validateCohortDefinition,
  type BenchmarkMetricResult,
  type CohortFilterDefinition,
  type CohortSourceDefinition,
  type CohortType,
} from '@masterclip/music-benchmarking'
import type { BenchmarkCohortRecord, SongBenchmarkResultRecord } from './types.js'

/**
 * Cohorts, provenance and stored comparisons.
 *
 * Two access rules are enforced here rather than in the routes, because they
 * are the ones that would be expensive to get wrong:
 *
 *   - A cohort belonging to another organization is invisible, full stop.
 *   - A proprietary cohort requires an explicit entitlement, which the caller
 *     passes in. `listVisible` cannot be called without stating whether the
 *     caller holds it.
 */
export class BenchmarkCohortRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string | null
    name: string
    description: string
    cohortType: CohortType
    filterDefinition: CohortFilterDefinition
    sourceDefinition: CohortSourceDefinition
    sampleSize: number
    status: 'draft' | 'published' | 'retired'
    proprietary: boolean
    providerId: string
    createdBy: string
  }): Promise<BenchmarkCohortRecord> {
    const issues = validateCohortDefinition({
      organizationId: input.orgId,
      name: input.name,
      description: input.description,
      cohortType: input.cohortType,
      filterDefinition: input.filterDefinition,
      sourceDefinition: input.sourceDefinition,
      sampleSize: input.sampleSize,
      status: input.status,
      proprietary: input.proprietary,
    })
    if (issues.length > 0) {
      throw new AppError({
        kind: 'validation',
        code: 'song_lab.invalid_cohort',
        message: issues.map((issue) => issue.message).join('; '),
        details: { issues },
      })
    }

    const now = this.clock.isoNow()
    const id = newId('bcoh', this.clock.now())
    await insertRow(this.db, 'benchmark_cohorts', {
      id,
      org_id: input.orgId,
      name: input.name,
      description: input.description,
      cohort_type: input.cohortType,
      filter_definition: JSON.stringify(input.filterDefinition),
      source_definition: JSON.stringify(input.sourceDefinition),
      sample_size: input.sampleSize,
      status: input.status,
      proprietary: input.proprietary ? 1 : 0,
      provider_id: input.providerId,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    })
    // Provenance is denormalized into its own table so it can be listed,
    // audited and exported without parsing every cohort's JSON.
    for (const source of input.sourceDefinition.sources) {
      await insertRow(this.db, 'benchmark_provenance', {
        id: newId('bprov', this.clock.now()),
        benchmark_cohort_id: id,
        source_kind: source.kind,
        source_name: source.name,
        basis: source.basis,
        captured_at: source.capturedAt,
        stores_masters: source.storesMasters ? 1 : 0,
        created_at: now,
      })
    }
    return this.getForOrg(input.orgId ?? '', id, true)
  }

  /**
   * A cohort the caller may read.
   *
   * `entitledToProprietary` is required rather than defaulted, so a caller
   * cannot accidentally read flagship intelligence by omitting an argument.
   */
  async getForOrg(orgId: string, id: string, entitledToProprietary: boolean): Promise<BenchmarkCohortRecord> {
    const row = await this.db.get('SELECT * FROM benchmark_cohorts WHERE id = ?', [id])
    if (!row) throw notFound('benchmark cohort', id)
    const cohort = mapCohort(row)
    if (cohort.orgId !== null && cohort.orgId !== orgId) throw forbidden('this cohort belongs to another organization')
    if (cohort.proprietary && !entitledToProprietary) {
      throw forbidden('this organization is not entitled to proprietary Street Banker benchmark cohorts')
    }
    return cohort
  }

  async listVisible(orgId: string, entitledToProprietary: boolean): Promise<BenchmarkCohortRecord[]> {
    const rows = await this.db.query(
      "SELECT * FROM benchmark_cohorts WHERE (org_id IS NULL OR org_id = ?) AND status = 'published' ORDER BY proprietary ASC, name ASC",
      [orgId],
    )
    return rows.map(mapCohort).filter((cohort) => entitledToProprietary || !cohort.proprietary)
  }

  async countCustomForOrg(orgId: string): Promise<number> {
    const row = await this.db.get("SELECT COUNT(*) AS total FROM benchmark_cohorts WHERE org_id = ? AND cohort_type = 'custom'", [orgId])
    return toNum(row?.total)
  }

  async findByName(orgId: string | null, name: string): Promise<BenchmarkCohortRecord | null> {
    const row = orgId
      ? await this.db.get('SELECT * FROM benchmark_cohorts WHERE org_id = ? AND name = ?', [orgId, name])
      : await this.db.get('SELECT * FROM benchmark_cohorts WHERE org_id IS NULL AND name = ?', [name])
    return row ? mapCohort(row) : null
  }

  async provenance(cohortId: string): Promise<Array<{ kind: string; name: string; basis: string; capturedAt: string; storesMasters: boolean }>> {
    const rows = await this.db.query('SELECT * FROM benchmark_provenance WHERE benchmark_cohort_id = ? ORDER BY created_at ASC', [cohortId])
    return rows.map((row) => ({
      kind: toStr(row.source_kind),
      name: toStr(row.source_name),
      basis: toStr(row.basis),
      capturedAt: toStr(row.captured_at),
      storesMasters: toBool(row.stores_masters),
    }))
  }

  async setSampleSize(id: string, sampleSize: number): Promise<void> {
    await this.db.run('UPDATE benchmark_cohorts SET sample_size = ?, updated_at = ? WHERE id = ?', [sampleSize, this.clock.isoNow(), id])
  }

  /** Stored per-song derived features for a cohort. Never audio. */
  async addSongFeatures(input: {
    cohortId: string
    benchmarkSongId: string
    provenanceId: string
    featureVector: Record<string, number>
    metadata: Record<string, unknown>
  }): Promise<void> {
    await insertRow(this.db, 'benchmark_song_features', {
      id: newId('bsf', this.clock.now()),
      benchmark_cohort_id: input.cohortId,
      benchmark_song_id: input.benchmarkSongId,
      provenance_id: input.provenanceId,
      feature_vector: JSON.stringify(input.featureVector),
      metadata: JSON.stringify(input.metadata),
      created_at: this.clock.isoNow(),
    })
  }

  /** metric key → cohort values, assembled from stored per-song features. */
  async cohortValues(cohortId: string): Promise<Record<string, number[]>> {
    const rows = await this.db.query('SELECT feature_vector FROM benchmark_song_features WHERE benchmark_cohort_id = ?', [cohortId])
    const values: Record<string, number[]> = {}
    for (const row of rows) {
      const vector = parseJsonColumn<Record<string, number>>(row.feature_vector, {})
      for (const [key, value] of Object.entries(vector)) {
        if (!Number.isFinite(value)) continue
        ;(values[key] ??= []).push(value)
      }
    }
    return values
  }
}

export class SongBenchmarkResultRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Replaces this analysis's results for one cohort. Re-running is idempotent. */
  async replace(orgId: string, analysisId: string, cohortId: string, results: BenchmarkMetricResult[]): Promise<SongBenchmarkResultRecord[]> {
    await this.db.run('DELETE FROM song_benchmark_results WHERE org_id = ? AND song_analysis_id = ? AND benchmark_cohort_id = ?', [
      orgId,
      analysisId,
      cohortId,
    ])
    const now = this.clock.isoNow()
    const created: SongBenchmarkResultRecord[] = []
    for (const result of results) {
      const id = newId('sbr', this.clock.now())
      await insertRow(this.db, 'song_benchmark_results', {
        id,
        org_id: orgId,
        song_analysis_id: analysisId,
        benchmark_cohort_id: cohortId,
        metric_key: result.metricKey,
        song_value: result.songValue,
        percentile: result.percentile,
        cohort_median: result.cohortMedian,
        cohort_mean: result.cohortMean,
        p10: result.p10,
        p25: result.p25,
        p75: result.p75,
        p90: result.p90,
        z_score: result.zScore,
        sample_size: result.sampleSize,
        confidence: result.confidence,
        classification: result.classification,
        classification_label: result.classificationLabel,
        summary: result.summary,
        created_at: now,
      })
      created.push({
        id,
        orgId,
        songAnalysisId: analysisId,
        benchmarkCohortId: cohortId,
        metricKey: result.metricKey,
        songValue: result.songValue,
        percentile: result.percentile,
        cohortMedian: result.cohortMedian,
        cohortMean: result.cohortMean,
        p10: result.p10,
        p25: result.p25,
        p75: result.p75,
        p90: result.p90,
        zScore: result.zScore,
        sampleSize: result.sampleSize,
        confidence: result.confidence,
        classification: result.classification,
        classificationLabel: result.classificationLabel,
        summary: result.summary,
        createdAt: now,
      })
    }
    return created
  }

  async list(orgId: string, analysisId: string, cohortId?: string): Promise<SongBenchmarkResultRecord[]> {
    const rows = cohortId
      ? await this.db.query(
          'SELECT * FROM song_benchmark_results WHERE org_id = ? AND song_analysis_id = ? AND benchmark_cohort_id = ? ORDER BY metric_key ASC',
          [orgId, analysisId, cohortId],
        )
      : await this.db.query('SELECT * FROM song_benchmark_results WHERE org_id = ? AND song_analysis_id = ? ORDER BY metric_key ASC', [
          orgId,
          analysisId,
        ])
    return rows.map(mapResult)
  }
}

export function mapCohort(row: Row): BenchmarkCohortRecord {
  return {
    id: toStr(row.id),
    orgId: toStrOrNull(row.org_id),
    name: toStr(row.name),
    description: toStr(row.description),
    cohortType: toStr(row.cohort_type) as CohortType,
    filterDefinition: parseJsonColumn<CohortFilterDefinition>(row.filter_definition, {}),
    sourceDefinition: parseJsonColumn<CohortSourceDefinition>(row.source_definition, { sources: [], notes: '' }),
    sampleSize: toNum(row.sample_size),
    status: toStr(row.status) as BenchmarkCohortRecord['status'],
    proprietary: toBool(row.proprietary),
    providerId: toStr(row.provider_id),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapResult(row: Row): SongBenchmarkResultRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songAnalysisId: toStr(row.song_analysis_id),
    benchmarkCohortId: toStr(row.benchmark_cohort_id),
    metricKey: toStr(row.metric_key),
    songValue: toNumOrNull(row.song_value),
    percentile: toNumOrNull(row.percentile),
    cohortMedian: toNumOrNull(row.cohort_median),
    cohortMean: toNumOrNull(row.cohort_mean),
    p10: toNumOrNull(row.p10),
    p25: toNumOrNull(row.p25),
    p75: toNumOrNull(row.p75),
    p90: toNumOrNull(row.p90),
    zScore: toNumOrNull(row.z_score),
    sampleSize: toNum(row.sample_size),
    confidence: toNum(row.confidence),
    classification: toStr(row.classification),
    classificationLabel: toStr(row.classification_label),
    summary: toStr(row.summary),
    createdAt: toStr(row.created_at),
  }
}
