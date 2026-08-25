import { type Db, insertRow, toNum, toNumOrNull, toStr, toStrOrNull, upsertRow } from '@masterclip/database'
import { newId, systemClock, type Clock } from '@masterclip/shared'

export interface AudioUsageEntry {
  id: string
  orgId: string
  userId: string
  projectType: string
  projectId: string | null
  provider: string
  operation: string
  model: string
  unit: string
  inputUnits: number
  outputUnits: number
  estimatedCostMicros: number
  finalCostMicros: number
  currency: string
  providerRequestId: string | null
  jobId: string | null
  createdAt: string
}

export type BudgetScope = 'org' | 'user' | 'feature'

export interface AudioBudgetRecord {
  id: string
  orgId: string
  scope: BudgetScope
  scopeId: string
  monthlyCapMicros: number | null
  perJobCapMicros: number | null
  approvalAboveMicros: number | null
  warnThresholdPct: number
  hardStop: boolean
  createdAt: string
  updatedAt: string
}

export interface BudgetVerdict {
  allowed: boolean
  warning: string | null
  reason: string | null
  monthSpendMicros: number
  capMicros: number | null
}

/**
 * Usage ledger and budgets.
 *
 * The ledger is append-only and records what the provider measured plus what
 * we estimated and (later) reconciled — never a price table hardcoded into
 * product logic. Budgets read the ledger; nothing else does accounting.
 */
export class AudioUsageRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async record(input: Omit<AudioUsageEntry, 'id' | 'createdAt'>): Promise<AudioUsageEntry> {
    const entry: AudioUsageEntry = { ...input, id: newId('ause', this.clock.now()), createdAt: this.clock.isoNow() }
    await insertRow(this.db, 'audio_usage_ledger', {
      id: entry.id,
      org_id: entry.orgId,
      user_id: entry.userId,
      project_type: entry.projectType,
      project_id: entry.projectId,
      provider: entry.provider,
      operation: entry.operation,
      model: entry.model,
      unit: entry.unit,
      input_units: entry.inputUnits,
      output_units: entry.outputUnits,
      estimated_cost_micros: entry.estimatedCostMicros,
      final_cost_micros: entry.finalCostMicros,
      currency: entry.currency,
      provider_request_id: entry.providerRequestId,
      job_id: entry.jobId,
      created_at: entry.createdAt,
    })
    return entry
  }

  async list(orgId: string, limit = 200): Promise<AudioUsageEntry[]> {
    const rows = await this.db.query(
      `SELECT * FROM audio_usage_ledger WHERE org_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId],
    )
    return rows.map(mapEntry)
  }

  async monthSpendMicros(orgId: string, opts: { userId?: string; featureKey?: string } = {}, nowMs = this.clock.now()): Promise<number> {
    const monthStart = new Date(nowMs)
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const clauses = ['org_id = ?', 'created_at >= ?']
    const params: string[] = [orgId, monthStart.toISOString()]
    if (opts.userId) {
      clauses.push('user_id = ?')
      params.push(opts.userId)
    }
    if (opts.featureKey) {
      clauses.push('operation = ?')
      params.push(opts.featureKey)
    }
    const row = await this.db.get<{ total: number }>(
      `SELECT COALESCE(SUM(CASE WHEN final_cost_micros > 0 THEN final_cost_micros ELSE estimated_cost_micros END), 0) AS total
         FROM audio_usage_ledger WHERE ${clauses.join(' AND ')}`,
      params,
    )
    return toNum(row?.total)
  }

  async summary(orgId: string, nowMs = this.clock.now()): Promise<{ monthSpendMicros: number; byOperation: Array<{ operation: string; provider: string; count: number; micros: number }> }> {
    const monthStart = new Date(nowMs)
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const rows = await this.db.query<{ operation: string; provider: string; n: number; micros: number }>(
      `SELECT operation, provider, COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN final_cost_micros > 0 THEN final_cost_micros ELSE estimated_cost_micros END), 0) AS micros
         FROM audio_usage_ledger WHERE org_id = ? AND created_at >= ?
        GROUP BY operation, provider ORDER BY micros DESC`,
      [orgId, monthStart.toISOString()],
    )
    const byOperation = rows.map((row) => ({
      operation: toStr(row.operation),
      provider: toStr(row.provider),
      count: toNum(row.n),
      micros: toNum(row.micros),
    }))
    return { monthSpendMicros: byOperation.reduce((a, b) => a + b.micros, 0), byOperation }
  }

  async getBudget(orgId: string, scope: BudgetScope, scopeId: string): Promise<AudioBudgetRecord | null> {
    const row = await this.db.get('SELECT * FROM audio_budgets WHERE org_id = ? AND scope = ? AND scope_id = ?', [orgId, scope, scopeId])
    return row ? mapBudget(row) : null
  }

  async listBudgets(orgId: string): Promise<AudioBudgetRecord[]> {
    const rows = await this.db.query('SELECT * FROM audio_budgets WHERE org_id = ? ORDER BY scope, scope_id', [orgId])
    return rows.map(mapBudget)
  }

  async setBudget(input: Omit<AudioBudgetRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<AudioBudgetRecord> {
    const now = this.clock.isoNow()
    const record: AudioBudgetRecord = { ...input, id: newId('abud', this.clock.now()), createdAt: now, updatedAt: now }
    await upsertRow(
      this.db,
      'audio_budgets',
      {
        id: record.id,
        org_id: record.orgId,
        scope: record.scope,
        scope_id: record.scopeId,
        monthly_cap_micros: record.monthlyCapMicros,
        per_job_cap_micros: record.perJobCapMicros,
        approval_above_micros: record.approvalAboveMicros,
        warn_threshold_pct: record.warnThresholdPct,
        hard_stop: record.hardStop ? 1 : 0,
        created_at: now,
        updated_at: now,
      },
      ['org_id', 'scope', 'scope_id'],
    )
    return record
  }

  /**
   * Budget check for a prospective job. Evaluates org, user, and feature
   * budgets; the tightest applicable constraint decides. A soft budget
   * produces a warning the caller shows; a hard one refuses.
   */
  async check(orgId: string, userId: string, featureKey: string, estimatedCostMicros: number): Promise<BudgetVerdict> {
    const scopes: Array<{ scope: BudgetScope; scopeId: string; spendOpts: { userId?: string; featureKey?: string } }> = [
      { scope: 'org', scopeId: orgId, spendOpts: {} },
      { scope: 'user', scopeId: userId, spendOpts: { userId } },
      { scope: 'feature', scopeId: featureKey, spendOpts: { featureKey } },
    ]
    let warning: string | null = null
    let monthSpendMicros = 0
    for (const { scope, scopeId, spendOpts } of scopes) {
      const budget = await this.getBudget(orgId, scope, scopeId)
      if (!budget) continue
      const spend = await this.monthSpendMicros(orgId, spendOpts)
      if (scope === 'org') monthSpendMicros = spend
      if (budget.perJobCapMicros !== null && estimatedCostMicros > budget.perJobCapMicros) {
        return {
          allowed: false,
          warning: null,
          reason: `estimated cost exceeds the per-job maximum for this ${scope} budget`,
          monthSpendMicros: spend,
          capMicros: budget.perJobCapMicros,
        }
      }
      if (budget.monthlyCapMicros !== null) {
        const projected = spend + estimatedCostMicros
        if (projected > budget.monthlyCapMicros && budget.hardStop) {
          return {
            allowed: false,
            warning: null,
            reason: `the ${scope} monthly audio budget is exhausted`,
            monthSpendMicros: spend,
            capMicros: budget.monthlyCapMicros,
          }
        }
        if (projected > budget.monthlyCapMicros * budget.warnThresholdPct) {
          warning = `${scope} audio budget at ${Math.round((projected / budget.monthlyCapMicros) * 100)}% of its monthly cap`
        }
      }
    }
    return { allowed: true, warning, reason: null, monthSpendMicros, capMicros: null }
  }
}

function mapEntry(row: Record<string, unknown>): AudioUsageEntry {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    userId: toStr(row.user_id),
    projectType: toStr(row.project_type),
    projectId: toStrOrNull(row.project_id),
    provider: toStr(row.provider),
    operation: toStr(row.operation),
    model: toStr(row.model),
    unit: toStr(row.unit),
    inputUnits: toNum(row.input_units),
    outputUnits: toNum(row.output_units),
    estimatedCostMicros: toNum(row.estimated_cost_micros),
    finalCostMicros: toNum(row.final_cost_micros),
    currency: toStr(row.currency),
    providerRequestId: toStrOrNull(row.provider_request_id),
    jobId: toStrOrNull(row.job_id),
    createdAt: toStr(row.created_at),
  }
}

function mapBudget(row: Record<string, unknown>): AudioBudgetRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    scope: toStr(row.scope) as BudgetScope,
    scopeId: toStr(row.scope_id),
    monthlyCapMicros: toNumOrNull(row.monthly_cap_micros),
    perJobCapMicros: toNumOrNull(row.per_job_cap_micros),
    approvalAboveMicros: toNumOrNull(row.approval_above_micros),
    warnThresholdPct: toNum(row.warn_threshold_pct, 0.8),
    hardStop: toNum(row.hard_stop) === 1,
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
