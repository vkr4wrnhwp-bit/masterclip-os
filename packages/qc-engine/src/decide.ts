import type { CanonicalShot } from '@masterclip/shot-schema'
import type { MicroUsd } from '@masterclip/shared'
import type { QcFinding, TechnicalQcResult } from './technical.js'
import type { VisualQcResult } from './visual.js'

export type QcAction =
  | 'AUTO_REJECT'
  | 'HUMAN_REVIEW'
  | 'APPROVE_FOR_DRAFT'
  | 'PROMOTE_TO_FINAL'
  | 'REGENERATE_WITH_CORRECTION'
  | 'SEND_TO_DIFFERENT_MODEL'

export interface QcReport {
  technical_pass: boolean
  creative_score: number
  identity_score: number
  continuity_score: number
  motion_score: number
  realism_score: number
  hard_failures: string[]
  warnings: string[]
  recommended_action: QcAction
  confidence: number
  /** Human-readable justification for the recommendation. */
  rationale: string
  /** Correction to feed back into the prompt compiler on a regenerate. */
  correction: string
  costMicros: MicroUsd
  engines: { technical: string; visual: string }
}

export interface DecideInput {
  shot: CanonicalShot
  technical: TechnicalQcResult
  visual: VisualQcResult | null
  /** Failures that are our own I/O problem rather than the model's output. */
  treatAsInfrastructure?: string[]
}

const INFRASTRUCTURE_CODES = new Set(['file.missing', 'file.empty', 'container.unreadable', 'decode.errors'])

/**
 * Turns measurements and scores into one recommended action.
 *
 * Two rules are non-negotiable and encoded here rather than left to a model:
 *
 *  - Automatic rejection is only ever for *demonstrated* failures — a frozen
 *    clip, an all-black clip, a wrong duration, a duplicate render. Weak
 *    creative work goes to a human.
 *  - Nothing is ever automatically promoted to a final master. A person signs
 *    off on what ships, always.
 */
export function decide(input: DecideInput): QcReport {
  const { shot, technical, visual } = input
  const hardFailures = technical.hardFailures.map(describe)
  const warnings = technical.warnings.map(describe)
  if (visual) {
    hardFailures.push(...visual.hardFailures)
    warnings.push(...visual.warnings)
  }

  const infrastructure = technical.hardFailures.filter((f) => INFRASTRUCTURE_CODES.has(f.code))
  const contentFailures = technical.hardFailures.filter((f) => !INFRASTRUCTURE_CODES.has(f.code))

  let action: QcAction
  let rationale: string
  let correction = ''
  const confidence = computeConfidence(technical, visual)

  if (infrastructure.length > 0 && contentFailures.length === 0) {
    // The bytes never arrived intact. That is our failure, not the model's, and
    // re-downloading costs nothing — it must not be recorded as a rejected render.
    action = 'REGENERATE_WITH_CORRECTION'
    rationale = `Delivery failure rather than a bad render (${infrastructure.map((f) => f.code).join(', ')}). Re-fetch or re-submit; do not count this against the model's acceptance rate.`
    correction = 'no prompt change required — this was a download or container failure'
  } else if (contentFailures.length > 0) {
    action = 'AUTO_REJECT'
    rationale = `Demonstrated technical failure: ${contentFailures.map((f) => f.message).join('; ')}.`
    correction = suggestCorrection(contentFailures)
  } else if (visual && visual.confidence >= 0.6 && visual.hardFailures.length > 0) {
    action = 'AUTO_REJECT'
    rationale = `Visual QC found blocking defects with ${(visual.confidence * 100).toFixed(0)}% confidence: ${visual.hardFailures.join('; ')}.`
    correction = visual.hardFailures.join('; ')
  } else if (!visual || visual.confidence < 0.3) {
    action = 'HUMAN_REVIEW'
    rationale = visual
      ? `Visual QC confidence is only ${(visual.confidence * 100).toFixed(0)}% — not enough to decide automatically.`
      : 'Technically valid, but no visual QC was performed.'
  } else if (visual.identityScore > 0 && visual.identityScore < 55 && hasIdentityLocks(shot)) {
    action = 'REGENERATE_WITH_CORRECTION'
    rationale = `Identity drift: identity score ${visual.identityScore}/100 against strict identity locks.`
    correction = 'strengthen identity references and restate the locked facial and wardrobe details early in the prompt'
  } else if (visual.realismScore > 0 && visual.realismScore < 45) {
    action = 'SEND_TO_DIFFERENT_MODEL'
    rationale = `Realism score ${visual.realismScore}/100 — this model is not producing physically plausible results for this shot.`
    correction = 'route to a higher-tier model or a different family; prompt changes are unlikely to fix a realism floor'
  } else if (visual.creativeScore >= 75 && visual.confidence >= 0.6) {
    if (requiresHuman(shot)) {
      action = 'HUMAN_REVIEW'
      rationale = `Strong candidate (creative ${visual.creativeScore}/100) but this shot requires human approval before it can become a master.`
    } else {
      action = 'APPROVE_FOR_DRAFT'
      rationale = `Meets the bar for draft use (creative ${visual.creativeScore}/100, realism ${visual.realismScore}/100). Promotion to a final master still needs a human.`
    }
  } else {
    action = 'HUMAN_REVIEW'
    rationale = visual
      ? `Creative score ${visual.creativeScore}/100 — usable but not clearly a winner. A person should rank it against its siblings.`
      : 'Technically valid; awaiting human review.'
  }

  return {
    technical_pass: technical.pass,
    creative_score: visual?.creativeScore ?? 0,
    identity_score: visual?.identityScore ?? 0,
    continuity_score: visual?.continuityScore ?? 0,
    motion_score: visual?.motionScore ?? 0,
    realism_score: visual?.realismScore ?? 0,
    hard_failures: hardFailures,
    warnings,
    recommended_action: action,
    confidence: Number(confidence.toFixed(2)),
    rationale,
    correction,
    costMicros: visual?.costMicros ?? 0,
    engines: { technical: 'ffprobe+ffmpeg', visual: visual?.engine ?? 'none' },
  }
}

function describe(finding: QcFinding): string {
  return finding.measured ? `${finding.message} (measured ${finding.measured}, expected ${finding.expected ?? 'n/a'})` : finding.message
}

function hasIdentityLocks(shot: CanonicalShot): boolean {
  return shot.identity_locks.some((lock) => lock.strength === 'strict')
}

function requiresHuman(shot: CanonicalShot): boolean {
  return (
    shot.routing_profile === 'HERO' ||
    shot.approval_requirements.includes('human_review_required') ||
    shot.approval_requirements.includes('director_approval') ||
    shot.approval_requirements.includes('client_approval')
  )
}

/**
 * Technical failures map to concrete, actionable corrections. Deliberately
 * mechanical: a model is not needed to know that a frozen clip means the motion
 * direction was too weak.
 */
function suggestCorrection(failures: QcFinding[]): string {
  const codes = new Set(failures.map((f) => f.code))
  const parts: string[] = []
  if (codes.has('content.frozen') || codes.has('content.long_freeze')) {
    parts.push('state an explicit, continuous physical action and a motivated camera move; the model produced a still')
  }
  if (codes.has('content.all_black') || codes.has('content.black_frames')) {
    parts.push('raise the described light level and name a visible practical source; the render came back black')
  }
  if (codes.has('duration.mismatch')) parts.push("request a duration the model natively supports rather than one it truncates")
  if (codes.has('output.duplicate')) parts.push('vary the seed or the prompt — the provider returned an identical render')
  if (codes.has('bitrate.too_low')) parts.push('request a higher output quality tier from the provider')
  return parts.join('; ')
}

/**
 * Confidence in the *recommendation*, which is not the same as the vision
 * model's confidence: a demonstrated technical failure is certain regardless of
 * what any model thinks.
 */
function computeConfidence(technical: TechnicalQcResult, visual: VisualQcResult | null): number {
  if (technical.hardFailures.length > 0) return 0.98
  if (!visual) return 0.25
  return Math.max(0.1, Math.min(0.95, visual.confidence))
}
