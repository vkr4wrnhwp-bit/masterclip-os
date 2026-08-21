import { divideMicros, type MicroUsd } from '@masterclip/shared'
import type { CanonicalShot, ShotRequirements } from '@masterclip/shot-schema'
import {
  matchCapabilities,
  type CapabilityMismatch,
  type HealthStatus,
  type ModelTier,
  type NormalizedModel,
  type ProviderHealth,
} from '@masterclip/provider-core'
import type { ModelPerformance } from '@masterclip/cost-engine'
import { PRIOR_STRENGTH, ROUTING_PROFILES, TIER_APPROVAL_PRIOR, type ProfileRules } from './profiles.js'

export * from './profiles.js'

export interface RoutingCandidate {
  providerId: string
  modelId: string
  displayName: string
  tier: ModelTier
  /** Rate-card estimate for this shot's duration; null when only a live quote can price it. */
  estimatedMicros: MicroUsd | null
  estimatedPerSecondMicros: MicroUsd | null
  predictedApprovalRate: number
  /** 0..1 — how much project data stands behind `predictedApprovalRate`. */
  confidence: number
  expectedApprovedCostMicros: MicroUsd | null
  expectedApprovedCostPerSecondMicros: MicroUsd | null
  observedApprovals: number
  observedSubmissions: number
  health: HealthStatus
  meanLatencyMs: number
  score: number
  reasons: string[]
  warnings: string[]
}

export interface RoutingDecision {
  profile: ProfileRules
  candidates: RoutingCandidate[]
  chosen: RoutingCandidate | null
  rejected: Array<{ providerId: string; modelId: string; reasons: string[] }>
  /** True when the ranking rests mostly on priors rather than measurements. */
  lowConfidence: boolean
  explanation: string
}

export interface RouteInput {
  shot: CanonicalShot
  requirements: ShotRequirements
  models: NormalizedModel[]
  performance?: ModelPerformance[]
  health?: ProviderHealth[]
  /** Remaining budget for this shot; candidates above it are excluded. */
  remainingBudgetMicros?: MicroUsd | null
  /** Project-level manual ratings, -2..+2, keyed `provider/model`. */
  modelRatings?: Record<string, number>
  profileOverride?: ProfileRules
}

/**
 * Ranks models for a shot by **expected cost per approved second**, not by
 * sticker price.
 *
 *     expected approved cost = estimated cost ÷ P(creative approval)
 *
 * A model that costs three times more but lands twice as often is cheaper per
 * usable second, and this is the only formula in the system that captures that.
 * Until a project has real data the approval term is a conservative prior, and
 * every decision carries the confidence so nobody mistakes a guess for a
 * measurement.
 */
export function routeShot(input: RouteInput): RoutingDecision {
  const profile = input.profileOverride ?? ROUTING_PROFILES[input.shot.routing_profile]
  const performanceIndex = indexPerformance(input.performance ?? [])
  const healthIndex = new Map((input.health ?? []).map((h) => [h.providerId, h]))
  const excluded = new Set(input.shot.excluded_models)
  const preferred = new Set(input.shot.preferred_models)

  const candidates: RoutingCandidate[] = []
  const rejected: RoutingDecision['rejected'] = []

  for (const model of input.models) {
    const key = `${model.providerId}/${model.modelId}`
    const reasons: string[] = []
    const warnings: string[] = []
    const blockers: string[] = []

    if (!model.enabled) blockers.push('model disabled in provider settings')
    if (excluded.has(key) || excluded.has(model.modelId)) blockers.push('excluded by the shot')
    if (profile.selfHostedOnly && model.providerId !== 'selfhosted') blockers.push('profile is self-hosted only')
    if (!profile.allowedTiers.includes(model.capabilities.tier)) {
      blockers.push(`tier ${model.capabilities.tier} not allowed by ${profile.profile}`)
    }
    if (profile.requireNativeAudio && !model.capabilities.nativeAudio) blockers.push('profile requires native audio')
    if (profile.requireFrameControl && !(model.capabilities.firstFrame && model.capabilities.lastFrame)) {
      blockers.push('profile requires first- and last-frame control')
    }
    if (profile.requireVideoEdit && !(model.capabilities.videoReference || model.capabilities.extension)) {
      blockers.push('profile requires video-to-video or extension')
    }

    const mismatches: CapabilityMismatch[] = matchCapabilities(input.requirements, model.capabilities)
    for (const mismatch of mismatches) {
      if (mismatch.severity === 'hard') blockers.push(`${mismatch.field}: needs ${mismatch.required}, supports ${mismatch.supported}`)
      else warnings.push(`${mismatch.field} will be coerced (${mismatch.required} → ${mismatch.supported})`)
    }

    const health = healthIndex.get(model.providerId)
    if (health?.status === 'unavailable') blockers.push('provider is currently unavailable')
    if (health?.status === 'unconfigured') blockers.push('provider has no credentials configured')
    if (health?.status === 'degraded') warnings.push('provider health is degraded')

    const perSecond = pricePerSecond(model)
    const estimated = perSecond === null ? null : Math.round(perSecond * input.requirements.durationSeconds)

    if (perSecond !== null && profile.maxCostPerSecondMicros !== null && perSecond > profile.maxCostPerSecondMicros) {
      blockers.push(`${(perSecond / 1_000_000).toFixed(4)} USD/s exceeds the profile ceiling`)
    }
    if (estimated !== null && input.remainingBudgetMicros != null && estimated > input.remainingBudgetMicros) {
      blockers.push('estimate exceeds the remaining shot budget')
    }
    if (perSecond === null) {
      warnings.push('no published rate — a live provider quote is required before submission')
    }

    if (blockers.length > 0) {
      rejected.push({ providerId: model.providerId, modelId: model.modelId, reasons: blockers })
      continue
    }

    const stats = performanceIndex.get(`${key}|${input.shot.shot_category}`) ?? performanceIndex.get(`${key}|*`)
    const { rate, confidence, approvals, submissions } = predictApproval(model.capabilities.tier, stats)

    const expectedApproved = estimated === null ? null : Math.round(estimated / Math.max(0.01, rate))
    const expectedApprovedPerSecond =
      expectedApproved === null ? null : divideMicros(expectedApproved, input.requirements.durationSeconds)

    if (stats) {
      reasons.push(
        `${stats.approved}/${stats.submitted} approved on this project${input.shot.shot_category ? ` for ${input.shot.shot_category} shots` : ''}`,
      )
    } else {
      reasons.push(`no project history yet — using the conservative ${model.capabilities.tier}-tier prior`)
    }
    if (preferred.has(key) || preferred.has(model.modelId)) reasons.push('preferred by the shot')
    if (model.capabilities.tier === profile.preferredTier) reasons.push(`${profile.preferredTier} tier matches the profile`)

    const candidate: RoutingCandidate = {
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
      tier: model.capabilities.tier,
      estimatedMicros: estimated,
      estimatedPerSecondMicros: perSecond,
      predictedApprovalRate: Number(rate.toFixed(4)),
      confidence: Number(confidence.toFixed(3)),
      expectedApprovedCostMicros: expectedApproved,
      expectedApprovedCostPerSecondMicros: expectedApprovedPerSecond,
      observedApprovals: approvals,
      observedSubmissions: submissions,
      health: health?.status ?? 'healthy',
      meanLatencyMs: stats?.meanLatencyMs ?? 0,
      score: 0,
      reasons,
      warnings,
    }
    candidate.score = scoreCandidate(candidate, profile, {
      preferred: preferred.has(key) || preferred.has(model.modelId),
      rating: input.modelRatings?.[key] ?? 0,
    })
    candidates.push(candidate)
  }

  candidates.sort((a, b) => b.score - a.score || (a.expectedApprovedCostMicros ?? Infinity) - (b.expectedApprovedCostMicros ?? Infinity))
  const chosen = candidates[0] ?? null
  const lowConfidence = chosen ? chosen.confidence < 0.35 : true

  return {
    profile,
    candidates,
    chosen,
    rejected,
    lowConfidence,
    explanation: explain(profile, chosen, candidates, lowConfidence),
  }
}

function explain(profile: ProfileRules, chosen: RoutingCandidate | null, candidates: RoutingCandidate[], lowConfidence: boolean): string {
  if (!chosen) return `No model satisfies the ${profile.profile} profile and this shot's requirements.`
  const runnerUp = candidates[1]
  const parts = [
    `${profile.profile}: ${chosen.providerId}/${chosen.modelId}`,
    chosen.expectedApprovedCostPerSecondMicros !== null
      ? `expected $${(chosen.expectedApprovedCostPerSecondMicros / 1_000_000).toFixed(4)} per approved second (${(chosen.predictedApprovalRate * 100).toFixed(0)}% predicted approval)`
      : 'price requires a live quote',
  ]
  if (runnerUp) {
    parts.push(
      `ahead of ${runnerUp.providerId}/${runnerUp.modelId}${
        runnerUp.expectedApprovedCostPerSecondMicros !== null
          ? ` at $${(runnerUp.expectedApprovedCostPerSecondMicros / 1_000_000).toFixed(4)}/approved-second`
          : ''
      }`,
    )
  }
  if (lowConfidence) {
    parts.push('confidence is low — this ranking mostly reflects priors, not measured acceptance for this project')
  }
  return parts.join('; ') + '.'
}

/**
 * Beta-style posterior over creative approval.
 *
 * Prior mean comes from the model tier and carries `PRIOR_STRENGTH`
 * pseudo-observations, so a model with 1 approval out of 2 does not leap to the
 * top of the ranking. Confidence is the share of the posterior backed by real
 * observations.
 */
export function predictApproval(
  tier: ModelTier,
  stats?: ModelPerformance,
): { rate: number; confidence: number; approvals: number; submissions: number } {
  const priorMean = TIER_APPROVAL_PRIOR[tier]
  const alpha0 = priorMean * PRIOR_STRENGTH
  const beta0 = (1 - priorMean) * PRIOR_STRENGTH
  const approvals = stats?.approved ?? 0
  const submissions = stats?.submitted ?? 0
  const rate = (alpha0 + approvals) / (alpha0 + beta0 + submissions)
  const confidence = submissions / (submissions + PRIOR_STRENGTH)
  return { rate, confidence, approvals, submissions }
}

function pricePerSecond(model: NormalizedModel): MicroUsd | null {
  const pricing = model.pricing
  if (!pricing) return null
  if (pricing.basis === 'per_second') return pricing.rateMicros
  if (pricing.basis === 'per_video') return null
  return null
}

function scoreCandidate(
  candidate: RoutingCandidate,
  profile: ProfileRules,
  extras: { preferred: boolean; rating: number },
): number {
  // Each term is normalized to 0..1 so profile weights are comparable.
  const costTerm =
    candidate.expectedApprovedCostPerSecondMicros === null
      ? 0.35 // unknown price: usable, but never beats a known-cheap option
      : 1 / (1 + candidate.expectedApprovedCostPerSecondMicros / 100_000)
  const qualityTerm = candidate.predictedApprovalRate
  const latencyTerm = candidate.meanLatencyMs > 0 ? 1 / (1 + candidate.meanLatencyMs / 60_000) : 0.5

  let score = profile.costWeight * costTerm + profile.qualityWeight * qualityTerm + profile.latencyWeight * latencyTerm

  if (candidate.health === 'degraded') score *= 0.8
  if (extras.preferred) score += 0.15
  score += Math.max(-0.2, Math.min(0.2, extras.rating * 0.05))
  // Nudge toward the profile's intended tier so a marginal score difference
  // does not send a storyboard test to a premium model.
  if (candidate.tier === profile.preferredTier) score += 0.05

  return Number(score.toFixed(6))
}

function indexPerformance(performance: ModelPerformance[]): Map<string, ModelPerformance> {
  const index = new Map<string, ModelPerformance>()
  const aggregate = new Map<string, ModelPerformance>()
  for (const row of performance) {
    const base = `${row.providerId}/${row.modelId}`
    index.set(`${base}|${row.shotCategory}`, row)
    const existing = aggregate.get(base)
    if (existing) {
      existing.submitted += row.submitted
      existing.approved += row.approved
      existing.rejected += row.rejected
      existing.technicallyValid += row.technicallyValid
      existing.totalMicros += row.totalMicros
      existing.approvedMicros += row.approvedMicros
      existing.approvedSeconds += row.approvedSeconds
      existing.submittedSeconds += row.submittedSeconds
    } else {
      aggregate.set(base, { ...row, shotCategory: '*' })
    }
  }
  // `*` is the cross-category fallback used when a model has no data for this
  // shot's specific category yet.
  for (const [base, row] of aggregate) index.set(`${base}|*`, row)
  return index
}

/**
 * Draft-then-final strategy comparison for the Cost Lab.
 *
 * Answers the question the whole architecture is built around: is it cheaper to
 * shoot N cheap drafts and one expensive final, or to go straight to the
 * expensive model? The answer depends entirely on the two acceptance rates,
 * which is why this takes them as inputs rather than assuming them.
 */
export interface StrategyComparison {
  draftFirstMicros: MicroUsd
  premiumOnlyMicros: MicroUsd
  savingsMicros: MicroUsd
  savingsPercent: number | null
  assumptions: string[]
}

export function compareStrategies(input: {
  masters: number
  draftsPerMaster: number
  draftCostPerClipMicros: MicroUsd
  finalCostPerClipMicros: MicroUsd
  /** Probability a premium render is approved when directed by an approved draft. */
  guidedApprovalRate: number
  /** Probability a premium render is approved with no draft to direct it. */
  blindApprovalRate: number
}): StrategyComparison {
  const guided = Math.max(0.01, Math.min(1, input.guidedApprovalRate))
  const blind = Math.max(0.01, Math.min(1, input.blindApprovalRate))

  const draftFirst = Math.round(
    input.masters * (input.draftsPerMaster * input.draftCostPerClipMicros + input.finalCostPerClipMicros / guided),
  )
  const premiumOnly = Math.round(input.masters * (input.finalCostPerClipMicros / blind))
  const savings = premiumOnly - draftFirst

  return {
    draftFirstMicros: draftFirst,
    premiumOnlyMicros: premiumOnly,
    savingsMicros: savings,
    savingsPercent: premiumOnly > 0 ? (savings / premiumOnly) * 100 : null,
    assumptions: [
      `${input.draftsPerMaster} drafts per master`,
      `${(guided * 100).toFixed(0)}% approval on a draft-directed final`,
      `${(blind * 100).toFixed(0)}% approval going straight to the final model`,
      'excludes retries beyond the approval model, storage, QC, and finishing',
    ],
  }
}
