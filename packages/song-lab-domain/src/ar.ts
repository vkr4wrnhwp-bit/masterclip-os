import { insertRow, parseJsonColumn, toNum, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { AppError, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { ArRating, ArRecommendation, HandoffTarget, SongArReviewRecord, SongLabHandoffRecord, SongOutcomeLinkRecord } from './types.js'

/**
 * Internal A&R reviews, outcome links and cross-module handoffs.
 *
 * A review is created as a `draft`. Approving one requires a user id and
 * rejects any attempt to approve without one: an AI cannot sign, reject, fund
 * or promise anything to an artist, and the only path to `approved` in this
 * codebase runs through a named human.
 */
export class SongArReviewRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async createDraft(input: {
    orgId: string
    songLabProjectId: string
    songAnalysisId: string | null
    structureRating: ArRating
    hookRating: ArRating
    earlyPayoffRating: ArRating
    arrangementContrastRating: ArRating
    vocalMemorabilityRating: ArRating
    streamingFitRating: ArRating
    livePotentialRating: ArRating
    syncPotentialRating: ArRating
    recommendation: ArRecommendation
    why: string
    evidence: Array<{ dimension: string; metricKeys: string[]; note: string }>
    confidence: number
    createdBy: string
  }): Promise<SongArReviewRecord> {
    const now = this.clock.isoNow()
    const id = newId('sar', this.clock.now())
    // A new draft supersedes any earlier draft, so the desk shows one live
    // assessment rather than a stack of half-finished ones.
    await this.db.run("UPDATE song_ar_reviews SET status = 'superseded', updated_at = ? WHERE org_id = ? AND song_lab_project_id = ? AND status = 'draft'", [
      now,
      input.orgId,
      input.songLabProjectId,
    ])
    await insertRow(this.db, 'song_ar_reviews', {
      id,
      org_id: input.orgId,
      song_lab_project_id: input.songLabProjectId,
      song_analysis_id: input.songAnalysisId,
      structure_rating: input.structureRating,
      hook_rating: input.hookRating,
      early_payoff_rating: input.earlyPayoffRating,
      arrangement_contrast_rating: input.arrangementContrastRating,
      vocal_memorability_rating: input.vocalMemorabilityRating,
      streaming_fit_rating: input.streamingFitRating,
      live_potential_rating: input.livePotentialRating,
      sync_potential_rating: input.syncPotentialRating,
      recommendation: input.recommendation,
      why: input.why,
      evidence: JSON.stringify(input.evidence),
      confidence: input.confidence,
      status: 'draft',
      reviewed_by: null,
      reviewed_at: null,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    })
    return this.get(input.orgId, id)
  }

  async get(orgId: string, id: string): Promise<SongArReviewRecord> {
    const row = await this.db.get('SELECT * FROM song_ar_reviews WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('song A&R review', id)
    return mapReview(row)
  }

  async latest(orgId: string, projectId: string): Promise<SongArReviewRecord | null> {
    const row = await this.db.get(
      "SELECT * FROM song_ar_reviews WHERE org_id = ? AND song_lab_project_id = ? AND status != 'superseded' ORDER BY created_at DESC LIMIT 1",
      [orgId, projectId],
    )
    return row ? mapReview(row) : null
  }

  async history(orgId: string, projectId: string): Promise<SongArReviewRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_ar_reviews WHERE org_id = ? AND song_lab_project_id = ? ORDER BY created_at DESC',
      [orgId, projectId],
    )
    return rows.map(mapReview)
  }

  /** Operator override of any rating, the recommendation, or the why text. */
  async override(
    orgId: string,
    id: string,
    patch: Partial<Omit<SongArReviewRecord, 'id' | 'orgId' | 'songLabProjectId' | 'createdAt' | 'createdBy' | 'status'>>,
    editedBy: string,
  ): Promise<SongArReviewRecord> {
    const existing = await this.get(orgId, id)
    if (existing.status === 'superseded') {
      throw new AppError({ kind: 'conflict', code: 'song_lab.review_superseded', message: 'this review has been superseded' })
    }
    const columns: Record<string, string> = {
      structureRating: 'structure_rating',
      hookRating: 'hook_rating',
      earlyPayoffRating: 'early_payoff_rating',
      arrangementContrastRating: 'arrangement_contrast_rating',
      vocalMemorabilityRating: 'vocal_memorability_rating',
      streamingFitRating: 'streaming_fit_rating',
      livePotentialRating: 'live_potential_rating',
      syncPotentialRating: 'sync_potential_rating',
      recommendation: 'recommendation',
      why: 'why',
    }
    const sets: string[] = []
    const params: Array<string | number> = []
    for (const [key, column] of Object.entries(columns)) {
      const value = patch[key as keyof typeof patch]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      params.push(value as string)
    }
    if (patch.evidence !== undefined) {
      sets.push('evidence = ?')
      params.push(JSON.stringify(patch.evidence))
    }
    if (sets.length === 0) return existing
    sets.push('reviewed_by = ?', 'updated_at = ?')
    params.push(editedBy, this.clock.isoNow())
    await this.db.run(`UPDATE song_ar_reviews SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`, [...params, id, orgId])
    return this.get(orgId, id)
  }

  /**
   * Human approval. `approvedBy` is a required parameter with no default, so
   * there is no way to reach the approved state without naming a person.
   */
  async approve(orgId: string, id: string, approvedBy: string): Promise<SongArReviewRecord> {
    if (!approvedBy) {
      throw new AppError({
        kind: 'validation',
        code: 'song_lab.review_requires_human',
        message: 'an A&R review can only be approved by a named person',
      })
    }
    const review = await this.get(orgId, id)
    if (review.status === 'superseded') {
      throw new AppError({ kind: 'conflict', code: 'song_lab.review_superseded', message: 'this review has been superseded' })
    }
    const now = this.clock.isoNow()
    await this.db.run("UPDATE song_ar_reviews SET status = 'approved', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND org_id = ?", [
      approvedBy,
      now,
      now,
      id,
      orgId,
    ])
    return this.get(orgId, id)
  }
}

export class SongOutcomeRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Opens the loop: a recommendation was made at a point in time. */
  async record(input: {
    orgId: string
    songLabProjectId: string
    recommendationId: string | null
    observationId: string | null
    suggestedAt: string
  }): Promise<SongOutcomeLinkRecord> {
    const now = this.clock.isoNow()
    const id = newId('sout', this.clock.now())
    await insertRow(this.db, 'song_outcome_links', {
      id,
      org_id: input.orgId,
      song_lab_project_id: input.songLabProjectId,
      recommendation_id: input.recommendationId,
      observation_id: input.observationId,
      suggested_at: input.suggestedAt,
      accepted: 0,
      accepted_at: null,
      implemented: 0,
      implemented_version_id: null,
      release_id: null,
      released_at: null,
      outcome_window: '',
      outcome_metrics: JSON.stringify({}),
      correlation_notes: '',
      created_at: now,
      updated_at: now,
    })
    return this.get(input.orgId, id)
  }

  async get(orgId: string, id: string): Promise<SongOutcomeLinkRecord> {
    const row = await this.db.get('SELECT * FROM song_outcome_links WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('song outcome link', id)
    return mapOutcome(row)
  }

  async listForProject(orgId: string, projectId: string): Promise<SongOutcomeLinkRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_outcome_links WHERE org_id = ? AND song_lab_project_id = ? ORDER BY created_at DESC',
      [orgId, projectId],
    )
    return rows.map(mapOutcome)
  }

  async findByRecommendation(orgId: string, recommendationId: string): Promise<SongOutcomeLinkRecord | null> {
    const row = await this.db.get('SELECT * FROM song_outcome_links WHERE org_id = ? AND recommendation_id = ? ORDER BY created_at DESC LIMIT 1', [
      orgId,
      recommendationId,
    ])
    return row ? mapOutcome(row) : null
  }

  async markAccepted(orgId: string, id: string): Promise<void> {
    const now = this.clock.isoNow()
    await this.db.run('UPDATE song_outcome_links SET accepted = 1, accepted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      now,
      now,
      id,
      orgId,
    ])
  }

  async markImplemented(orgId: string, id: string, versionId: string): Promise<void> {
    await this.db.run('UPDATE song_outcome_links SET implemented = 1, implemented_version_id = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      versionId,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async markReleased(orgId: string, id: string, releaseId: string, releasedAt: string): Promise<void> {
    await this.db.run('UPDATE song_outcome_links SET release_id = ?, released_at = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      releaseId,
      releasedAt,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  /**
   * Attaches observed post-release metrics.
   *
   * `correlationNotes` is the only free-text field, and the service that writes
   * it phrases findings as correlation. No column here records causation
   * because the data cannot establish it.
   */
  async attachOutcome(orgId: string, id: string, outcomeWindow: string, metrics: Record<string, number>, notes: string): Promise<void> {
    await this.db.run(
      'UPDATE song_outcome_links SET outcome_window = ?, outcome_metrics = ?, correlation_notes = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      [outcomeWindow, JSON.stringify(metrics), notes, this.clock.isoNow(), id, orgId],
    )
  }
}

export class SongLabHandoffRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    songLabProjectId: string
    songVersionId: string
    target: HandoffTarget
    payload: Record<string, unknown>
    targetRecordId?: string | null
    status?: 'pending' | 'delivered' | 'failed'
    failureReason?: string | null
    createdBy: string
  }): Promise<SongLabHandoffRecord> {
    const now = this.clock.isoNow()
    const id = newId('shof', this.clock.now())
    await insertRow(this.db, 'song_lab_handoffs', {
      id,
      org_id: input.orgId,
      song_lab_project_id: input.songLabProjectId,
      song_version_id: input.songVersionId,
      target: input.target,
      target_record_id: input.targetRecordId ?? null,
      status: input.status ?? 'pending',
      payload: JSON.stringify(input.payload),
      failure_reason: input.failureReason ?? null,
      created_by: input.createdBy,
      created_at: now,
    })
    return {
      id,
      orgId: input.orgId,
      songLabProjectId: input.songLabProjectId,
      songVersionId: input.songVersionId,
      target: input.target,
      targetRecordId: input.targetRecordId ?? null,
      status: input.status ?? 'pending',
      payload: input.payload,
      failureReason: input.failureReason ?? null,
      createdBy: input.createdBy,
      createdAt: now,
    }
  }

  async list(orgId: string, projectId: string): Promise<SongLabHandoffRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_lab_handoffs WHERE org_id = ? AND song_lab_project_id = ? ORDER BY created_at DESC',
      [orgId, projectId],
    )
    return rows.map(mapHandoff)
  }
}

function mapReview(row: Row): SongArReviewRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    songAnalysisId: toStrOrNull(row.song_analysis_id),
    structureRating: toStr(row.structure_rating) as ArRating,
    hookRating: toStr(row.hook_rating) as ArRating,
    earlyPayoffRating: toStr(row.early_payoff_rating) as ArRating,
    arrangementContrastRating: toStr(row.arrangement_contrast_rating) as ArRating,
    vocalMemorabilityRating: toStr(row.vocal_memorability_rating) as ArRating,
    streamingFitRating: toStr(row.streaming_fit_rating) as ArRating,
    livePotentialRating: toStr(row.live_potential_rating) as ArRating,
    syncPotentialRating: toStr(row.sync_potential_rating) as ArRating,
    recommendation: toStr(row.recommendation) as ArRecommendation,
    why: toStr(row.why),
    evidence: parseJsonColumn<SongArReviewRecord['evidence']>(row.evidence, []),
    confidence: toNum(row.confidence),
    status: toStr(row.status) as SongArReviewRecord['status'],
    reviewedBy: toStrOrNull(row.reviewed_by),
    reviewedAt: toStrOrNull(row.reviewed_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapOutcome(row: Row): SongOutcomeLinkRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    recommendationId: toStrOrNull(row.recommendation_id),
    observationId: toStrOrNull(row.observation_id),
    suggestedAt: toStr(row.suggested_at),
    accepted: toNum(row.accepted) === 1,
    acceptedAt: toStrOrNull(row.accepted_at),
    implemented: toNum(row.implemented) === 1,
    implementedVersionId: toStrOrNull(row.implemented_version_id),
    releaseId: toStrOrNull(row.release_id),
    releasedAt: toStrOrNull(row.released_at),
    outcomeWindow: toStr(row.outcome_window),
    outcomeMetrics: parseJsonColumn<Record<string, number>>(row.outcome_metrics, {}),
    correlationNotes: toStr(row.correlation_notes),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapHandoff(row: Row): SongLabHandoffRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    songVersionId: toStr(row.song_version_id),
    target: toStr(row.target) as HandoffTarget,
    targetRecordId: toStrOrNull(row.target_record_id),
    status: toStr(row.status) as SongLabHandoffRecord['status'],
    payload: parseJsonColumn<Record<string, unknown>>(row.payload, {}),
    failureReason: toStrOrNull(row.failure_reason),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}
