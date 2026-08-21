import { type Db, toNum, toStr, upsertRow } from '@masterclip/database'
import { divideMicros, newId, systemClock, type Clock, type MicroUsd } from '@masterclip/shared'

export interface CostMetrics {
  rawSpendMicros: MicroUsd
  sandboxSpendMicros: MicroUsd
  submittedCount: number
  technicallyValidCount: number
  approvedCount: number
  rejectedCount: number
  masterCount: number
  submittedSeconds: number
  technicallyValidSeconds: number
  approvedSeconds: number
  masterSeconds: number
  /** null where the denominator is zero — never a fabricated number. */
  costPerSubmittedSecond: MicroUsd | null
  costPerTechnicallyValidSecond: MicroUsd | null
  costPerApprovedSecond: MicroUsd | null
  costPerMasterSecond: MicroUsd | null
  costPerApprovedClip: MicroUsd | null
  approvalRate: number | null
  technicalPassRate: number | null
}

export interface ModelPerformance {
  projectId: string
  providerId: string
  modelId: string
  shotCategory: string
  submitted: number
  technicallyValid: number
  approved: number
  rejected: number
  totalMicros: MicroUsd
  approvedMicros: MicroUsd
  approvedSeconds: number
  submittedSeconds: number
  meanLatencyMs: number
}

/**
 * The metric the whole system optimizes: **cost per approved second**.
 *
 * Cost per render is the number that misleads — a $0.10 render that fails nine
 * times costs more than a $0.60 render that lands first time. Every ratio here
 * returns null rather than zero when there is no data, so the UI shows "no data
 * yet" instead of an encouraging lie.
 */
export class MetricsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async projectMetrics(projectId: string, opts: { includeSandbox?: boolean } = {}): Promise<CostMetrics> {
    const includeSandbox = opts.includeSandbox ?? true

    const spend = await this.db.get<{ live: number | null; sandbox: number | null }>(
      `SELECT
         SUM(CASE WHEN sandbox = 0 THEN micros ELSE 0 END) AS live,
         SUM(CASE WHEN sandbox = 1 THEN micros ELSE 0 END) AS sandbox
       FROM cost_ledger
       WHERE project_id = ? AND entry_type IN ('charge','refund','adjustment','qc')`,
      [projectId],
    )

    const outputs = await this.db.query<{
      id: string
      duration_seconds: number | null
      technical_pass: number | null
      decision: string | null
    }>(
      `SELECT o.id,
              o.duration_seconds,
              (SELECT MAX(q.technical_pass) FROM output_qc q WHERE q.output_id = o.id AND q.layer = 'technical') AS technical_pass,
              -- Only decisions that carry a verdict. 'rank' orders candidates
              -- against each other and 'reset' clears a decision; neither says
              -- the clip was good or bad, and taking simply the newest review
              -- meant ranking a shortlist after approving one of its clips
              -- silently turned that approval into a failure.
              (SELECT r.decision FROM reviews r WHERE r.output_id = o.id
                AND r.decision IN ('approve', 'promote', 'reject', 'regenerate')
                ORDER BY r.created_at DESC LIMIT 1) AS decision
         FROM outputs o
        WHERE o.project_id = ?`,
      [projectId],
    )

    const masters = await this.db.query<{ duration_seconds: number | null }>(
      `SELECT o.duration_seconds FROM masters m JOIN outputs o ON o.id = m.output_id WHERE m.project_id = ?`,
      [projectId],
    )

    let submittedSeconds = 0
    let validSeconds = 0
    let approvedSeconds = 0
    let technicallyValid = 0
    let approved = 0
    let rejected = 0

    for (const row of outputs) {
      const seconds = toNum(row.duration_seconds, 0)
      submittedSeconds += seconds
      const passed = toNum(row.technical_pass, 0) === 1
      if (passed) {
        technicallyValid++
        validSeconds += seconds
      }
      const decision = toStr(row.decision)
      if (decision === 'approve' || decision === 'promote') {
        approved++
        approvedSeconds += seconds
      } else if (decision === 'reject') {
        rejected++
      }
    }

    const masterSeconds = masters.reduce((acc, m) => acc + toNum(m.duration_seconds, 0), 0)
    const live = toNum(spend?.live, 0)
    const sandboxSpend = toNum(spend?.sandbox, 0)
    const rawSpend = includeSandbox ? live + sandboxSpend : live

    return {
      rawSpendMicros: rawSpend,
      sandboxSpendMicros: sandboxSpend,
      submittedCount: outputs.length,
      technicallyValidCount: technicallyValid,
      approvedCount: approved,
      rejectedCount: rejected,
      masterCount: masters.length,
      submittedSeconds: round(submittedSeconds),
      technicallyValidSeconds: round(validSeconds),
      approvedSeconds: round(approvedSeconds),
      masterSeconds: round(masterSeconds),
      costPerSubmittedSecond: divideMicros(rawSpend, submittedSeconds),
      costPerTechnicallyValidSecond: divideMicros(rawSpend, validSeconds),
      costPerApprovedSecond: divideMicros(rawSpend, approvedSeconds),
      costPerMasterSecond: divideMicros(rawSpend, masterSeconds),
      costPerApprovedClip: divideMicros(rawSpend, approved),
      approvalRate: outputs.length > 0 ? approved / outputs.length : null,
      technicalPassRate: outputs.length > 0 ? technicallyValid / outputs.length : null,
    }
  }

  /**
   * Rebuilds the model_performance table from the source rows.
   *
   * Derived data is recomputed rather than incrementally patched so a bug in
   * one update path cannot permanently skew routing.
   */
  async recomputeModelPerformance(projectId: string): Promise<ModelPerformance[]> {
    const rows = await this.db.query<{
      provider_id: string
      model_id: string
      shot_category: string | null
      output_id: string
      duration_seconds: number | null
      technical_pass: number | null
      decision: string | null
      job_id: string
      latency_ms: number | null
    }>(
      `SELECT o.provider_id, o.model_id, o.id AS output_id, o.duration_seconds, o.job_id,
              (SELECT MAX(q.technical_pass) FROM output_qc q WHERE q.output_id = o.id AND q.layer = 'technical') AS technical_pass,
              (SELECT r.decision FROM reviews r WHERE r.output_id = o.id
                AND r.decision IN ('approve', 'promote', 'reject', 'regenerate')
                ORDER BY r.created_at DESC LIMIT 1) AS decision,
              (SELECT a.latency_ms FROM render_attempts a WHERE a.job_id = o.job_id ORDER BY a.attempt DESC LIMIT 1) AS latency_ms,
              (SELECT sv.spec FROM render_jobs j JOIN shot_versions sv ON sv.id = j.shot_version_id WHERE j.id = o.job_id) AS shot_category
         FROM outputs o
        WHERE o.project_id = ?`,
      [projectId],
    )

    const costByJob = new Map<string, MicroUsd>()
    const costRows = await this.db.query<{ job_id: string; total: number }>(
      `SELECT job_id, SUM(micros) AS total FROM cost_ledger
        WHERE project_id = ? AND entry_type IN ('charge','refund','adjustment') AND job_id IS NOT NULL
        GROUP BY job_id`,
      [projectId],
    )
    for (const row of costRows) costByJob.set(toStr(row.job_id), toNum(row.total))

    const buckets = new Map<string, ModelPerformance & { latencySum: number; latencyN: number }>()
    for (const row of rows) {
      const category = extractCategory(row.shot_category)
      const key = `${toStr(row.provider_id)}|${toStr(row.model_id)}|${category}`
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = {
          projectId,
          providerId: toStr(row.provider_id),
          modelId: toStr(row.model_id),
          shotCategory: category,
          submitted: 0,
          technicallyValid: 0,
          approved: 0,
          rejected: 0,
          totalMicros: 0,
          approvedMicros: 0,
          approvedSeconds: 0,
          submittedSeconds: 0,
          meanLatencyMs: 0,
          latencySum: 0,
          latencyN: 0,
        }
        buckets.set(key, bucket)
      }
      const seconds = toNum(row.duration_seconds, 0)
      const cost = costByJob.get(toStr(row.job_id)) ?? 0
      bucket.submitted++
      bucket.submittedSeconds += seconds
      bucket.totalMicros += cost
      if (toNum(row.technical_pass, 0) === 1) bucket.technicallyValid++
      const decision = toStr(row.decision)
      if (decision === 'approve' || decision === 'promote') {
        bucket.approved++
        bucket.approvedSeconds += seconds
        bucket.approvedMicros += cost
      } else if (decision === 'reject') bucket.rejected++
      const latency = toNum(row.latency_ms, 0)
      if (latency > 0) {
        bucket.latencySum += latency
        bucket.latencyN++
      }
    }

    const out: ModelPerformance[] = []
    const now = this.clock.isoNow()
    for (const bucket of buckets.values()) {
      const performance: ModelPerformance = {
        ...bucket,
        submittedSeconds: round(bucket.submittedSeconds),
        approvedSeconds: round(bucket.approvedSeconds),
        meanLatencyMs: bucket.latencyN > 0 ? Math.round(bucket.latencySum / bucket.latencyN) : 0,
      }
      out.push(performance)
      await upsertRow(
        this.db,
        'model_performance',
        {
          id: newId('model', this.clock.now()),
          project_id: performance.projectId,
          provider_id: performance.providerId,
          model_id: performance.modelId,
          shot_category: performance.shotCategory,
          submitted: performance.submitted,
          technically_valid: performance.technicallyValid,
          approved: performance.approved,
          rejected: performance.rejected,
          total_micros: Math.round(performance.totalMicros),
          approved_micros: Math.round(performance.approvedMicros),
          approved_seconds: performance.approvedSeconds,
          submitted_seconds: performance.submittedSeconds,
          latency_ms_total: bucket.latencySum,
          updated_at: now,
        },
        ['project_id', 'provider_id', 'model_id', 'shot_category'],
      )
    }
    return out
  }

  async modelPerformance(projectId: string): Promise<ModelPerformance[]> {
    const rows = await this.db.query(`SELECT * FROM model_performance WHERE project_id = ?`, [projectId])
    return rows.map((row) => ({
      projectId: toStr(row.project_id),
      providerId: toStr(row.provider_id),
      modelId: toStr(row.model_id),
      shotCategory: toStr(row.shot_category),
      submitted: toNum(row.submitted),
      technicallyValid: toNum(row.technically_valid),
      approved: toNum(row.approved),
      rejected: toNum(row.rejected),
      totalMicros: toNum(row.total_micros),
      approvedMicros: toNum(row.approved_micros),
      approvedSeconds: toNum(row.approved_seconds),
      submittedSeconds: toNum(row.submitted_seconds),
      meanLatencyMs: toNum(row.submitted) > 0 ? Math.round(toNum(row.latency_ms_total) / toNum(row.submitted)) : 0,
    }))
  }

  async recordRejectionReasons(projectId: string, providerId: string, modelId: string, reasons: string[]): Promise<void> {
    for (const reason of reasons) {
      const existing = await this.db.get<{ count_n: number }>(
        `SELECT count_n FROM rejection_stats WHERE project_id = ? AND provider_id = ? AND model_id = ? AND reason = ?`,
        [projectId, providerId, modelId, reason],
      )
      await upsertRow(
        this.db,
        'rejection_stats',
        {
          id: newId('rev', this.clock.now()),
          project_id: projectId,
          provider_id: providerId,
          model_id: modelId,
          reason,
          count_n: toNum(existing?.count_n, 0) + 1,
          updated_at: this.clock.isoNow(),
        },
        ['project_id', 'provider_id', 'model_id', 'reason'],
        ['count_n', 'updated_at'],
      )
    }
  }

  async rejectionBreakdown(projectId: string): Promise<Array<{ providerId: string; modelId: string; reason: string; count: number }>> {
    const rows = await this.db.query(
      `SELECT provider_id, model_id, reason, count_n FROM rejection_stats WHERE project_id = ? ORDER BY count_n DESC`,
      [projectId],
    )
    return rows.map((r) => ({
      providerId: toStr(r.provider_id),
      modelId: toStr(r.model_id),
      reason: toStr(r.reason),
      count: toNum(r.count_n),
    }))
  }

  /**
   * Spend that auto-rejection prevented: outputs QC killed before anyone paid
   * for a finishing pass or a follow-on premium render. Reported as an estimate,
   * because the counterfactual is a model, not a measurement.
   */
  async qcAvoidedSpend(projectId: string): Promise<{ autoRejected: number; estimatedAvoidedMicros: MicroUsd }> {
    const row = await this.db.get<{ n: number; avg_cost: number | null }>(
      `SELECT COUNT(*) AS n,
              (SELECT AVG(micros) FROM cost_ledger WHERE project_id = ? AND entry_type = 'charge') AS avg_cost
         FROM output_qc q
        WHERE q.recommended_action = 'AUTO_REJECT'
          AND q.output_id IN (SELECT id FROM outputs WHERE project_id = ?)`,
      [projectId, projectId],
    )
    const count = toNum(row?.n, 0)
    const avg = toNum(row?.avg_cost, 0)
    return { autoRejected: count, estimatedAvoidedMicros: Math.round(count * avg) }
  }
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

/** The shot spec is stored as JSON; only its category matters here. */
function extractCategory(specJson: unknown): string {
  if (typeof specJson !== 'string') return 'unknown'
  try {
    const parsed = JSON.parse(specJson) as { shot_category?: string }
    return parsed.shot_category ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
