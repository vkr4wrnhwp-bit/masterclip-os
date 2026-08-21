import type { Db } from '@masterclip/database'
import { toNum } from '@masterclip/database'
import { formatUsd, loadConfig, systemClock, type AppConfig, type Clock, type MicroUsd } from '@masterclip/shared'
import { isQuoteValid, type CanonicalRenderRequest, type ModelTier, type PriceQuote } from '@masterclip/provider-core'
import { BudgetStore, windowBounds, type Budget } from './budget.js'
import { CostLedger } from './ledger.js'

export interface AuthorizationRequest {
  orgId: string
  projectId: string
  sceneId?: string | null
  shotId: string
  batchId?: string | null
  request: CanonicalRenderRequest
  quote: PriceQuote
  tier: ModelTier
  /** Attempts already made for this shot, used against the per-shot attempt cap. */
  attemptsSoFar?: number
  premiumAttemptsSoFar?: number
  /** A human has explicitly approved this spend in the UI. */
  humanApproved?: boolean
  /**
   * Spend already committed by earlier candidates in the same batch but not yet
   * charged. Without this, every candidate in a batch is authorized against the
   * same starting balance and a batch collectively blows a cap that no single
   * render would have breached.
   */
  committedMicros?: MicroUsd
  nowMs?: number
}

export type DenialCode =
  | 'quote.invalid'
  | 'quote.expired'
  | 'budget.shot_cap'
  | 'budget.project_daily'
  | 'budget.project_monthly'
  | 'budget.project_lifetime'
  | 'budget.org_daily'
  | 'budget.org_monthly'
  | 'budget.attempts'
  | 'budget.premium_attempts'
  | 'spend.live_cap'
  | 'mode.sandbox_required'
  | 'approval.required'

export interface Authorization {
  allowed: boolean
  denials: Array<{ code: DenialCode; message: string }>
  warnings: string[]
  /** Set when the only thing standing between this request and approval is a human. */
  requiresHumanApproval: boolean
  estimatedMicros: MicroUsd
  remaining: {
    shotMicros: MicroUsd | null
    projectDailyMicros: MicroUsd | null
    projectMonthlyMicros: MicroUsd | null
    liveCapMicros: MicroUsd | null
  }
}

/**
 * The gate every billable submission passes through.
 *
 * Nothing else in the system is allowed to call a provider's `submit()`
 * directly — the render worker asks here first, and a denial is final until
 * either the budget changes or a human approves. The live-spend cap is checked
 * last and separately because it is a global guard rail, not a project budget:
 * it exists so a bug in routing cannot spend real money at scale.
 */
export class CostController {
  private readonly budgets: BudgetStore
  private readonly ledger: CostLedger

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig = loadConfig(),
    private readonly clock: Clock = systemClock,
  ) {
    this.budgets = new BudgetStore(db, clock)
    this.ledger = new CostLedger(db, clock)
  }

  get budgetStore(): BudgetStore {
    return this.budgets
  }

  get costLedger(): CostLedger {
    return this.ledger
  }

  async authorize(input: AuthorizationRequest): Promise<Authorization> {
    const now = input.nowMs ?? this.clock.now()
    const denials: Authorization['denials'] = []
    const warnings: string[] = []
    const estimated = input.quote.estimatedMicros
    const sandbox = input.request.sandbox

    // --- the quote must actually describe this request ----------------------
    const quoteCheck = isQuoteValid(input.quote, input.request, now)
    if (!quoteCheck.ok) {
      denials.push({ code: quoteCheck.reason.includes('expired') ? 'quote.expired' : 'quote.invalid', message: quoteCheck.reason })
    }
    if (input.quote.confidence === 'unknown' && !sandbox) {
      denials.push({
        code: 'quote.invalid',
        message: 'this model has no confident price; obtain a live provider quote before submitting',
      })
    }
    // A zero or negative estimate satisfies every cap by arithmetic and slides
    // under the human-approval threshold, so an adapter that fails to price a
    // request must not be able to buy an unlimited one by returning nothing.
    // `unknown` confidence is the honest way to say "no price"; zero is not.
    if (!Number.isFinite(estimated) || estimated <= 0) {
      if (!sandbox) {
        denials.push({
          code: 'quote.invalid',
          message: `a billable request needs a positive price; this quote reports ${estimated} µUSD. A provider that cannot price a request must report confidence 'unknown' rather than zero.`,
        })
      }
    }

    if (input.quote.confidence === 'estimated') {
      warnings.push(`price is a rate-card estimate (${input.quote.source}), not a live provider quote`)
    }

    // --- global posture ------------------------------------------------------
    if (this.config.isSandbox && !sandbox) {
      denials.push({
        code: 'mode.sandbox_required',
        message: 'MASTERCLIP_MODE=sandbox — set it to "live" to submit billable requests',
      })
    }

    // --- per-shot ceiling from the shot spec --------------------------------
    if (estimated > input.request.maxCostMicros) {
      denials.push({
        code: 'budget.shot_cap',
        message: `estimate ${formatUsd(estimated)} exceeds the shot's max_cost_usd of ${formatUsd(input.request.maxCostMicros)}`,
      })
    }

    const projectBudget = await this.budgets.ensureDefaults('project', input.projectId)
    const orgBudget = await this.budgets.ensureDefaults('org', input.orgId)
    const { dayStart, monthStart } = windowBounds(now)

    const committed = input.committedMicros ?? 0
    const [rawShot, rawProjectDay, rawProjectMonth, rawProjectLifetime, rawOrgDay, rawOrgMonth] = await Promise.all([
      this.ledger.spend('shot', input.shotId, { includeSandbox: sandbox }),
      this.ledger.spend('project', input.projectId, { since: dayStart, includeSandbox: sandbox }),
      this.ledger.spend('project', input.projectId, { since: monthStart, includeSandbox: sandbox }),
      this.ledger.spend('project', input.projectId, { includeSandbox: sandbox }),
      this.ledger.spend('org', input.orgId, { since: dayStart, includeSandbox: sandbox }),
      this.ledger.spend('org', input.orgId, { since: monthStart, includeSandbox: sandbox }),
    ])
    // Everything already committed by this batch counts as spent for the
    // purposes of this decision, even though no charge has landed yet.
    const shotSpend = rawShot + committed
    const projectDay = rawProjectDay + committed
    const projectMonth = rawProjectMonth + committed
    const projectLifetime = rawProjectLifetime + committed
    const orgDay = rawOrgDay + committed
    const orgMonth = rawOrgMonth + committed

    const remaining: Authorization['remaining'] = {
      shotMicros: projectBudget.perShotCapMicros === null ? null : projectBudget.perShotCapMicros - shotSpend,
      projectDailyMicros: projectBudget.dailyCapMicros === null ? null : projectBudget.dailyCapMicros - projectDay,
      projectMonthlyMicros: projectBudget.monthlyCapMicros === null ? null : projectBudget.monthlyCapMicros - projectMonth,
      liveCapMicros: null,
    }

    this.checkCap(denials, warnings, 'budget.shot_cap', projectBudget.perShotCapMicros, shotSpend, estimated, projectBudget, 'shot')
    this.checkCap(denials, warnings, 'budget.project_daily', projectBudget.dailyCapMicros, projectDay, estimated, projectBudget, 'project daily')
    this.checkCap(denials, warnings, 'budget.project_monthly', projectBudget.monthlyCapMicros, projectMonth, estimated, projectBudget, 'project monthly')
    this.checkCap(denials, warnings, 'budget.project_lifetime', projectBudget.lifetimeCapMicros, projectLifetime, estimated, projectBudget, 'project lifetime')
    this.checkCap(denials, warnings, 'budget.org_daily', orgBudget.dailyCapMicros, orgDay, estimated, orgBudget, 'organization daily')
    this.checkCap(denials, warnings, 'budget.org_monthly', orgBudget.monthlyCapMicros, orgMonth, estimated, orgBudget, 'organization monthly')

    // --- attempt ceilings ----------------------------------------------------
    const attempts = input.attemptsSoFar ?? (await this.attemptsForShot(input.shotId))
    if (projectBudget.maxAttempts !== null && attempts >= projectBudget.maxAttempts) {
      denials.push({
        code: 'budget.attempts',
        message: `shot already has ${attempts} attempts (cap ${projectBudget.maxAttempts}) — raise the cap or change approach`,
      })
    }
    if (input.tier === 'premium' && projectBudget.maxPremiumAttempts !== null) {
      const premium = input.premiumAttemptsSoFar ?? (await this.attemptsForShot(input.shotId, 'premium'))
      if (premium >= projectBudget.maxPremiumAttempts) {
        denials.push({
          code: 'budget.premium_attempts',
          message: `shot already has ${premium} premium attempts (cap ${projectBudget.maxPremiumAttempts}) — draft first, then promote`,
        })
      }
    }

    // --- the global live-spend guard rail ------------------------------------
    if (!sandbox) {
      // Settled charges, plus this batch's running total, plus anything already
      // with a provider and not yet settled. Leaving that last term out let each
      // of N concurrent submissions authorize against a balance that none of the
      // others had yet moved.
      const liveSpend = (await this.ledger.totalLiveSpend()) + committed + (await this.ledger.committedInFlight())
      const cap = this.config.liveSpendCapMicros
      remaining.liveCapMicros = cap - liveSpend
      if (liveSpend + estimated > cap) {
        denials.push({
          code: 'spend.live_cap',
          message: `live-spend cap reached: ${formatUsd(liveSpend)} spent + ${formatUsd(estimated)} estimated exceeds the ${formatUsd(cap, 2)} authorization. Raise LIVE_SPEND_CAP_USD only with explicit approval.`,
        })
      } else if (liveSpend + estimated > cap * 0.75) {
        warnings.push(`this request brings live spend to ${formatUsd(liveSpend + estimated)} of the ${formatUsd(cap, 2)} cap`)
      }
    }

    // --- human approval ------------------------------------------------------
    const approvalThreshold = projectBudget.approvalRequiredAboveMicros
    const needsApproval =
      !sandbox && ((approvalThreshold !== null && estimated > approvalThreshold) || input.tier === 'premium')
    const requiresHumanApproval = needsApproval && !input.humanApproved
    if (requiresHumanApproval) {
      denials.push({
        code: 'approval.required',
        message:
          input.tier === 'premium'
            ? 'premium-tier renders require explicit human approval before submission'
            : `estimates above ${formatUsd(approvalThreshold ?? 0)} require explicit human approval`,
      })
    }

    return {
      allowed: denials.length === 0,
      denials,
      warnings,
      requiresHumanApproval,
      estimatedMicros: estimated,
      remaining,
    }
  }

  private checkCap(
    denials: Authorization['denials'],
    warnings: string[],
    code: DenialCode,
    cap: MicroUsd | null,
    spent: MicroUsd,
    estimated: MicroUsd,
    budget: Budget,
    label: string,
  ): void {
    if (cap === null) return
    if (spent + estimated > cap) {
      denials.push({
        code,
        message: `${label} budget exceeded: ${formatUsd(spent)} spent + ${formatUsd(estimated)} estimated > ${formatUsd(cap)} cap`,
      })
      return
    }
    const pct = ((spent + estimated) / cap) * 100
    if (pct >= budget.warnThresholdPct) {
      warnings.push(`${label} budget at ${pct.toFixed(0)}% after this render`)
    }
  }

  private async attemptsForShot(shotId: string, tier?: ModelTier): Promise<number> {
    const row = tier
      ? await this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM render_attempts a JOIN render_jobs j ON j.id = a.job_id
            WHERE j.shot_id = ? AND a.billable = 1 AND j.routing_profile = 'HERO'`,
          [shotId],
        )
      : await this.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM render_attempts a JOIN render_jobs j ON j.id = a.job_id
            WHERE j.shot_id = ? AND a.billable = 1`,
          [shotId],
        )
    return toNum(row?.n, 0)
  }
}
