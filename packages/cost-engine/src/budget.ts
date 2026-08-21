import { type Db, insertRow, toNum, toNumOrNull, upsertRow } from '@masterclip/database'
import { newId, systemClock, usdToMicros, type Clock, type MicroUsd } from '@masterclip/shared'

export type BudgetScope = 'org' | 'project' | 'scene' | 'shot'

export interface Budget {
  scope: BudgetScope
  scopeId: string
  dailyCapMicros: MicroUsd | null
  monthlyCapMicros: MicroUsd | null
  lifetimeCapMicros: MicroUsd | null
  perShotCapMicros: MicroUsd | null
  maxAttempts: number | null
  maxPremiumAttempts: number | null
  warnThresholdPct: number
  approvalRequiredAboveMicros: MicroUsd | null
}

export const DEFAULT_BUDGET: Omit<Budget, 'scope' | 'scopeId'> = {
  dailyCapMicros: usdToMicros(50),
  monthlyCapMicros: usdToMicros(500),
  lifetimeCapMicros: null,
  perShotCapMicros: usdToMicros(5),
  maxAttempts: 12,
  maxPremiumAttempts: 3,
  warnThresholdPct: 80,
  approvalRequiredAboveMicros: usdToMicros(5),
}

export class BudgetStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(scope: BudgetScope, scopeId: string): Promise<Budget | null> {
    const row = await this.db.get('SELECT * FROM budgets WHERE scope = ? AND scope_id = ?', [scope, scopeId])
    if (!row) return null
    return {
      scope,
      scopeId,
      dailyCapMicros: toNumOrNull(row.daily_cap_micros),
      monthlyCapMicros: toNumOrNull(row.monthly_cap_micros),
      lifetimeCapMicros: toNumOrNull(row.lifetime_cap_micros),
      perShotCapMicros: toNumOrNull(row.per_shot_cap_micros),
      maxAttempts: toNumOrNull(row.max_attempts),
      maxPremiumAttempts: toNumOrNull(row.max_premium_attempts),
      warnThresholdPct: toNum(row.warn_threshold_pct, 80),
      approvalRequiredAboveMicros: toNumOrNull(row.approval_required_above_micros),
    }
  }

  async set(budget: Budget): Promise<void> {
    const now = this.clock.isoNow()
    await upsertRow(
      this.db,
      'budgets',
      {
        id: newId('bud', this.clock.now()),
        scope: budget.scope,
        scope_id: budget.scopeId,
        daily_cap_micros: budget.dailyCapMicros,
        monthly_cap_micros: budget.monthlyCapMicros,
        lifetime_cap_micros: budget.lifetimeCapMicros,
        per_shot_cap_micros: budget.perShotCapMicros,
        max_attempts: budget.maxAttempts,
        max_premium_attempts: budget.maxPremiumAttempts,
        warn_threshold_pct: budget.warnThresholdPct,
        approval_required_above_micros: budget.approvalRequiredAboveMicros,
        created_at: now,
        updated_at: now,
      },
      ['scope', 'scope_id'],
      [
        'daily_cap_micros',
        'monthly_cap_micros',
        'lifetime_cap_micros',
        'per_shot_cap_micros',
        'max_attempts',
        'max_premium_attempts',
        'warn_threshold_pct',
        'approval_required_above_micros',
        'updated_at',
      ],
    )
  }

  async ensureDefaults(scope: BudgetScope, scopeId: string): Promise<Budget> {
    const existing = await this.get(scope, scopeId)
    if (existing) return existing
    const budget: Budget = { scope, scopeId, ...DEFAULT_BUDGET }
    await this.set(budget)
    return budget
  }

  async recordEvent(scope: BudgetScope, scopeId: string, event: string, micros: MicroUsd, message: string): Promise<void> {
    await insertRow(this.db, 'budget_events', {
      id: newId('bud', this.clock.now()),
      scope,
      scope_id: scopeId,
      event,
      micros: Math.round(micros),
      message,
      created_at: this.clock.isoNow(),
    })
  }

  async events(scope: BudgetScope, scopeId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
    return this.db.query(
      `SELECT * FROM budget_events WHERE scope = ? AND scope_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [scope, scopeId],
    )
  }
}

/** UTC day and month boundaries used by the daily/monthly caps. */
export function windowBounds(nowMs: number): { dayStart: string; monthStart: string } {
  const now = new Date(nowMs)
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  return { dayStart, monthStart }
}
