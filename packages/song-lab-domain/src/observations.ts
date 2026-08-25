import { insertRow, parseJsonColumn, toBool, toNum, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { ObservationSeverity, ObservationStatus, ObservationType, RecommendationType, SongObservationDraft } from '@masterclip/music-benchmarking'
import type { SongObservationRecord, SongRecommendationRecord } from './types.js'

/**
 * Observations and their recommendations.
 *
 * A recommendation is stored with `human_approved = 0`. Nothing in this
 * repository can set it to 1 without a user id, which is the storage-level
 * expression of the rule that the system suggests and a person decides.
 */
export class SongObservationRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Replaces the observation set for one analysis+cohort pairing. */
  async replaceForAnalysis(input: {
    orgId: string
    songLabProjectId: string
    songVersionId: string
    songAnalysisId: string
    benchmarkCohortId: string | null
    drafts: SongObservationDraft[]
    benchmarkResultIdsByMetric?: Record<string, string>
  }): Promise<SongObservationRecord[]> {
    const existing = await this.db.query('SELECT id FROM song_observations WHERE org_id = ? AND song_analysis_id = ?', [
      input.orgId,
      input.songAnalysisId,
    ])
    for (const row of existing) {
      await this.db.run('DELETE FROM song_recommendations WHERE song_observation_id = ?', [toStr(row.id)])
    }
    await this.db.run('DELETE FROM song_observations WHERE org_id = ? AND song_analysis_id = ?', [input.orgId, input.songAnalysisId])

    const now = this.clock.isoNow()
    const created: SongObservationRecord[] = []
    for (const draft of input.drafts) {
      const id = newId('sobs', this.clock.now())
      const resultIds = draft.sourceMetricKeys
        .map((key) => input.benchmarkResultIdsByMetric?.[key])
        .filter((value): value is string => Boolean(value))

      await insertRow(this.db, 'song_observations', {
        id,
        org_id: input.orgId,
        song_lab_project_id: input.songLabProjectId,
        song_version_id: input.songVersionId,
        song_analysis_id: input.songAnalysisId,
        benchmark_cohort_id: input.benchmarkCohortId,
        observation_type: draft.observationType,
        category: draft.category,
        title: draft.title,
        description: draft.description,
        severity: draft.severity,
        confidence: draft.confidence,
        source_metric_keys: JSON.stringify(draft.sourceMetricKeys),
        benchmark_result_ids: JSON.stringify(resultIds),
        status: 'open',
        created_at: now,
        updated_at: now,
      })

      const recommendations: SongRecommendationRecord[] = []
      for (const recommendation of draft.recommendations) {
        const recommendationId = newId('srec', this.clock.now())
        await insertRow(this.db, 'song_recommendations', {
          id: recommendationId,
          org_id: input.orgId,
          song_observation_id: id,
          recommendation_type: recommendation.recommendationType,
          title: recommendation.title,
          description: recommendation.description,
          experiment_supported: recommendation.experimentSupported ? 1 : 0,
          confidence: recommendation.confidence,
          human_approved: 0,
          approved_by: null,
          approved_at: null,
          created_at: now,
        })
        recommendations.push({
          id: recommendationId,
          orgId: input.orgId,
          songObservationId: id,
          recommendationType: recommendation.recommendationType,
          title: recommendation.title,
          description: recommendation.description,
          experimentSupported: recommendation.experimentSupported,
          confidence: recommendation.confidence,
          humanApproved: false,
          approvedBy: null,
          approvedAt: null,
          createdAt: now,
        })
      }

      created.push({
        id,
        orgId: input.orgId,
        songLabProjectId: input.songLabProjectId,
        songVersionId: input.songVersionId,
        songAnalysisId: input.songAnalysisId,
        benchmarkCohortId: input.benchmarkCohortId,
        observationType: draft.observationType,
        category: draft.category,
        title: draft.title,
        description: draft.description,
        severity: draft.severity,
        confidence: draft.confidence,
        sourceMetricKeys: draft.sourceMetricKeys,
        benchmarkResultIds: resultIds,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        recommendations,
      })
    }
    return created
  }

  async listForProject(orgId: string, projectId: string): Promise<SongObservationRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_observations WHERE org_id = ? AND song_lab_project_id = ? ORDER BY confidence DESC, created_at DESC',
      [orgId, projectId],
    )
    const observations = rows.map(mapObservation)
    for (const observation of observations) {
      observation.recommendations = await this.recommendationsFor(orgId, observation.id)
    }
    return observations
  }

  async get(orgId: string, id: string): Promise<SongObservationRecord> {
    const row = await this.db.get('SELECT * FROM song_observations WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('song observation', id)
    const observation = mapObservation(row)
    observation.recommendations = await this.recommendationsFor(orgId, id)
    return observation
  }

  async recommendationsFor(orgId: string, observationId: string): Promise<SongRecommendationRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_recommendations WHERE org_id = ? AND song_observation_id = ? ORDER BY created_at ASC',
      [orgId, observationId],
    )
    return rows.map(mapRecommendation)
  }

  async getRecommendation(orgId: string, id: string): Promise<SongRecommendationRecord> {
    const row = await this.db.get('SELECT * FROM song_recommendations WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('song recommendation', id)
    return mapRecommendation(row)
  }

  async setStatus(orgId: string, id: string, status: ObservationStatus): Promise<void> {
    await this.db.run('UPDATE song_observations SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      status,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  /** Human approval. `approvedBy` is required — there is no machine path here. */
  async approveRecommendation(orgId: string, id: string, approvedBy: string): Promise<SongRecommendationRecord> {
    await this.getRecommendation(orgId, id)
    await this.db.run('UPDATE song_recommendations SET human_approved = 1, approved_by = ?, approved_at = ? WHERE id = ? AND org_id = ?', [
      approvedBy,
      this.clock.isoNow(),
      id,
      orgId,
    ])
    return this.getRecommendation(orgId, id)
  }
}

function mapObservation(row: Row): SongObservationRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    songVersionId: toStr(row.song_version_id),
    songAnalysisId: toStr(row.song_analysis_id),
    benchmarkCohortId: toStrOrNull(row.benchmark_cohort_id),
    observationType: toStr(row.observation_type) as ObservationType,
    category: toStr(row.category),
    title: toStr(row.title),
    description: toStr(row.description),
    severity: toStr(row.severity) as ObservationSeverity,
    confidence: toNum(row.confidence),
    sourceMetricKeys: parseJsonColumn<string[]>(row.source_metric_keys, []),
    benchmarkResultIds: parseJsonColumn<string[]>(row.benchmark_result_ids, []),
    status: toStr(row.status) as ObservationStatus,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapRecommendation(row: Row): SongRecommendationRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songObservationId: toStr(row.song_observation_id),
    recommendationType: toStr(row.recommendation_type) as RecommendationType,
    title: toStr(row.title),
    description: toStr(row.description),
    experimentSupported: toBool(row.experiment_supported),
    confidence: toNum(row.confidence),
    humanApproved: toBool(row.human_approved),
    approvedBy: toStrOrNull(row.approved_by),
    approvedAt: toStrOrNull(row.approved_at),
    createdAt: toStr(row.created_at),
  }
}
