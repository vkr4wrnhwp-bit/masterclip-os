import type { Db } from '@masterclip/database'
import { toNum, toStr } from '@masterclip/database'
import { formatUsd, loadConfig, microsToUsd, systemClock, type AppConfig, type Clock, type MicroUsd } from '@masterclip/shared'
import { isQuoteValid, type CanonicalRenderRequest, type ModelTier, type PriceQuote } from '@masterclip/provider-core'
import { BudgetStore, windowBounds, type Budget } from './budget.js'
import { CostLedger } from './ledger.js'

export interface AuthorizationRequest {
  orgId: string
  projectId: string
  sceneId?: string | null
  shotId: string
  batchId?: string | null
  /**
   * The render job being authorized, when there is one already (at submit time).
   * Its own in-flight reservation is left out of the customer's running total,
   * or the job would be counted against itself.
   */
  jobId?: string | null
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
  | 'spend.customer_cap'
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
    /** Left of this customer's monthly cap; null when no customer cap applies. */
    customerCapMicros: MicroUsd | null
  }
}

/** Where one customer stands against CUSTOMER_SPEND_CAP_USD this calendar month (UTC). */
export interface CustomerStanding {
  /** CUSTOMER_SPEND_CAP_USD is set for this deployment. */
  configured: boolean
  /** The cap, or null when none is set. */
  capMicros: MicroUsd | null
  /** The cap is set and this organization is held to it (the house organization is not). */
  applies: boolean
  /** This organization's live spend since the 1st of the month, settled charges only. */
  spentMicros: MicroUsd
}

/**
 * Whole dollars when they are whole ("$10"), cents otherwise ("$7.50"): the way
 * a person reads a safety cap, rather than the four decimals a ledger prints.
 */
function plainDollars(micros: MicroUsd): string {
  const usd = Math.max(0, microsToUsd(micros))
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`
}

/**
 * What a customer is told when the monthly cap stops a render, in words a
 * musician reads without help. Shared with the visual-QC check, which refuses
 * for the same reason, so both say the same thing under the same code.
 */
export function customerCapMessage(capMicros: MicroUsd, usedMicros: MicroUsd): string {
  const cap = plainDollars(capMicros)
  if (usedMicros >= capMicros) return `You've reached this month's ${cap} safety cap for paid MOTION renders. It resets on the 1st. Buying credits does not raise this cap.`
  return `This render would exceed your ${cap} monthly safety cap for paid MOTION renders (${plainDollars(usedMicros)} used so far). It resets on the 1st. Buying credits does not raise this cap.`
}

/**
 * What a customer is told when the whole-service ceiling stops them. The
 * ceiling counts every customer's spend, so its figures are not theirs to see:
 * with few customers they would reveal what the others spent. The operator
 * (the house organization) still gets the full sentence.
 */
export const SERVICE_PAUSED_MESSAGE = 'MOTION renders are paused for now. Try again later.'

/**
 * The gate every billable submission passes through.
 *
 * Nothing else in the system is allowed to call a provider's `submit()`
 * directly — the render worker asks here first, and a denial is final until
 * either the budget changes or a human approves. Two limits sit above the
 * project budgets. The per-customer monthly cap (CUSTOMER_SPEND_CAP_USD) is the
 * most one customer may spend in a calendar month, and it is checked with the
 * organization's monthly budget. The live-spend ceiling is checked last and
 * separately because it is a whole-service guard rail, not a budget: it counts
 * every customer's spend this calendar month, and exists so a bug in routing
 * cannot spend real money at scale.
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

  /**
   * True for the house organization: the one no Street Banker workspace lives
   * in, where OWNER_EMAILS accounts land. It is the operator's own account, not
   * a customer. Same rule as `AuthService.houseOrgId()`, asked of the database
   * directly so the cost engine does not depend on the auth package.
   */
  async isHouseOrg(orgId: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>('SELECT id FROM orgs WHERE street_banker_identity IS NULL ORDER BY created_at, id LIMIT 1')
    return row !== undefined && toStr(row.id) === orgId
  }

  /**
   * The monthly cap this organization is held to, in micro-dollars, or null
   * when none applies: CUSTOMER_SPEND_CAP_USD is unset, or this is the house
   * organization, which is bound only by the whole-service ceiling.
   */
  async customerCapMicros(orgId: string): Promise<MicroUsd | null> {
    const cap = this.config.customerSpendCapMicros
    if (cap === null) return null
    return (await this.isHouseOrg(orgId)) ? null : cap
  }

  /** What to show a customer: the cap, whether it applies to them, and their spend this month. */
  async customerStanding(orgId: string, nowMs: number = this.clock.now()): Promise<CustomerStanding> {
    const capMicros = this.config.customerSpendCapMicros
    const applies = capMicros !== null && !(await this.isHouseOrg(orgId))
    const spentMicros = await this.ledger.spend('org', orgId, { since: windowBounds(nowMs).monthStart })
    return { configured: capMicros !== null, capMicros, applies, spentMicros }
  }

  /**
   * For live spend that is not a provider generation, such as visual QC, and so
   * never passes through `authorize()`: whether this customer has already used
   * the whole of this month's cap. Null means they may spend. `excludeJobId` is
   * the render the work is for: it was already paid for and is still in flight,
   * so counting it would refuse QC of a render the customer already bought.
   */
  async customerCapReached(
    orgId: string,
    opts: { nowMs?: number; excludeJobId?: string } = {},
  ): Promise<{ capMicros: MicroUsd; usedMicros: MicroUsd } | null> {
    const capMicros = await this.customerCapMicros(orgId)
    if (capMicros === null) return null
    const nowMs = opts.nowMs ?? this.clock.now()
    const usedMicros =
      (await this.ledger.spend('org', orgId, { since: windowBounds(nowMs).monthStart })) +
      (await this.ledger.committedInFlight({ orgId, ...(opts.excludeJobId ? { excludeJobId: opts.excludeJobId } : {}) }))
    return usedMicros >= capMicros ? { capMicros, usedMicros } : null
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
      customerCapMicros: null,
    }

    this.checkCap(denials, warnings, 'budget.shot_cap', projectBudget.perShotCapMicros, shotSpend, estimated, projectBudget, 'shot')
    this.checkCap(denials, warnings, 'budget.project_daily', projectBudget.dailyCapMicros, projectDay, estimated, projectBudget, 'project daily')
    this.checkCap(denials, warnings, 'budget.project_monthly', projectBudget.monthlyCapMicros, projectMonth, estimated, projectBudget, 'project monthly')
    this.checkCap(denials, warnings, 'budget.project_lifetime', projectBudget.lifetimeCapMicros, projectLifetime, estimated, projectBudget, 'project lifetime')
    this.checkCap(denials, warnings, 'budget.org_daily', orgBudget.dailyCapMicros, orgDay, estimated, orgBudget, 'organization daily')

    // --- the organization's monthly cap, and the per-customer cap ------------
    // Both limit the same thing, one organization's live spend this calendar
    // month, so the smaller one is the cap. When CUSTOMER_SPEND_CAP_USD is the
    // smaller (or the only) one it does the talking, in plain words and under
    // its own code; when the stored organization budget is smaller it does, as
    // it always has. The house organization has no customer cap, and sandbox
    // renders cost nothing, so neither is held to it.
    const customerCap = sandbox ? null : await this.customerCapMicros(input.orgId)
    const customerCapSpeaks =
      customerCap !== null && (orgBudget.monthlyCapMicros === null || customerCap <= orgBudget.monthlyCapMicros)
    this.checkCap(
      denials,
      warnings,
      'budget.org_monthly',
      customerCapSpeaks ? null : orgBudget.monthlyCapMicros,
      orgMonth,
      estimated,
      orgBudget,
      'organization monthly',
    )
    if (customerCap !== null && customerCapSpeaks) {
      // Spend with a provider that has not settled yet counts too, or a customer
      // could start many renders at once and pass a cap no single one breaches.
      const inFlight = await this.ledger.committedInFlight({ orgId: input.orgId, ...(input.jobId ? { excludeJobId: input.jobId } : {}) })
      const used = orgMonth + inFlight
      remaining.customerCapMicros = customerCap - used
      if (used + estimated > customerCap) {
        // Credits pay for every live generation; they never bypass this safety cap.
        denials.push({ code: 'spend.customer_cap', message: customerCapMessage(customerCap, used) })
      } else if (((used + estimated) / customerCap) * 100 >= orgBudget.warnThresholdPct) {
        warnings.push(
          `After this render, ${plainDollars(used + estimated)} of your ${plainDollars(customerCap)} monthly safety cap for paid MOTION renders will be used.`,
        )
      }
    }

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

    // --- the whole-service live-spend ceiling (optional) ----------------------
    // Only when LIVE_SPEND_CAP_USD is set (or neither cap is, which keeps the
    // built-in default); with just CUSTOMER_SPEND_CAP_USD there is no ceiling.
    const ceiling = this.config.liveSpendCapMicros
    if (!sandbox && ceiling !== null) {
      // This calendar month's settled charges from every customer together, plus
      // this batch's running total, plus anything already with a provider and not
      // yet settled. Leaving that last term out let each of N concurrent
      // submissions authorize against a balance that none of the others had yet
      // moved. The charges are this month's only (monthStart, UTC): counted over
      // all time, the ceiling would stop a live service for good once its
      // lifetime spend passed it. In-flight work is current by definition.
      // The job being authorized (at submit it is already `authorizing`, so in
      // flight) is left out, or it would be counted against itself and a render
      // that planned fine would be blocked at submit.
      const liveSpend =
        (await this.ledger.totalLiveSpend({ since: monthStart })) +
        committed +
        (await this.ledger.committedInFlight(input.jobId ? { excludeJobId: input.jobId } : {}))
      const cap = ceiling
      remaining.liveCapMicros = cap - liveSpend
      // The figures belong to the operator: they add up every customer's spend.
      const operator = await this.isHouseOrg(input.orgId)
      if (liveSpend + estimated > cap) {
        denials.push({
          code: 'spend.live_cap',
          message: operator
            ? `live-spend cap reached: ${formatUsd(liveSpend)} spent this month by all customers + ${formatUsd(estimated)} estimated exceeds the ${formatUsd(cap, 2)} monthly authorization. Raise LIVE_SPEND_CAP_USD only with explicit approval.`
            : SERVICE_PAUSED_MESSAGE,
        })
      } else if (operator && liveSpend + estimated > cap * 0.75) {
        warnings.push(`this request brings this month's live spend to ${formatUsd(liveSpend + estimated)} of the ${formatUsd(cap, 2)} cap`)
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
