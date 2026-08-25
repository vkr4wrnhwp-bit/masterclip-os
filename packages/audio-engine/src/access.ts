import {
  AUDIO_FEATURE_FLAGS,
  CAPABILITY_FLAGS,
  assertGate,
  evaluateGate,
  type AudioCapability,
  type AudioFeatureFlag,
  type AudioFlagState,
  type AudioProviderRegistry,
  type AudioCapabilitySlot,
  type GateCheck,
  type GateDecision,
} from '@masterclip/audio-core'
import type { AppConfig } from '@masterclip/shared'
import type { AudioPolicyRepo, AudioUsageRepo } from '@masterclip/audio-domain'
import type { Actor } from './deps.js'

export function flagStateFromConfig(config: AppConfig): AudioFlagState {
  const state = {} as AudioFlagState
  for (const flag of AUDIO_FEATURE_FLAGS) state[flag] = Boolean(config[flag as keyof AppConfig])
  return state
}

export interface AuthorizeOptions {
  capability: AudioCapability
  actor: Actor
  /** Minimum org role: member acts, admin configures, owner administers providers. */
  minimumRole?: 'member' | 'admin' | 'owner'
  /** Estimated spend for the budget layer; 0 checks only monthly exhaustion. */
  estimatedCostMicros?: number
  /** Which provider slot this feature exercises, for the health layer. */
  slot?: AudioCapabilitySlot
}

const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }

/**
 * The layered access gate, evaluated server-side on every request and job:
 * global flag → org entitlement → org toggle → provider entitlement → user
 * permission → usage limit. Consent, rights, and retention are enforced by the
 * individual services with the request in hand (they need the specific consent
 * record, not a boolean), and each names its own refusal.
 */
export class AudioAccessControl {
  constructor(
    private readonly config: AppConfig,
    private readonly policyRepo: AudioPolicyRepo,
    private readonly usageRepo: AudioUsageRepo,
    private readonly registry: AudioProviderRegistry,
  ) {}

  async decide(opts: AuthorizeOptions): Promise<GateDecision & { warning: string | null }> {
    const flags = flagStateFromConfig(this.config)
    const checks: GateCheck[] = []

    const requiredFlags: AudioFeatureFlag[] = ['AUDIO_INTELLIGENCE_ENABLED', ...(CAPABILITY_FLAGS[opts.capability] ?? [])]
    const offFlag = requiredFlags.find((flag) => !flags[flag])
    checks.push({
      name: 'global_flag',
      pass: !offFlag,
      message: offFlag ? `${offFlag} is disabled on this deployment` : 'ok',
    })

    const entitlement = await this.policyRepo.hasEntitlement(opts.actor.orgId, opts.capability)
    checks.push({
      name: 'org_entitlement',
      pass: entitlement.granted,
      message: entitlement.granted ? 'ok' : `this organization's plan does not include ${opts.capability}`,
    })

    const settings = await this.policyRepo.getSettings(opts.actor.orgId)
    const toggledOff = entitlement.granted && (!entitlement.enabled || settings.featureToggles[opts.capability] === false)
    checks.push({
      name: 'org_toggle',
      pass: !toggledOff,
      message: toggledOff ? `${opts.capability} is switched off by an organization admin` : 'ok',
    })

    let providerOk = true
    let providerMessage = 'ok'
    if (opts.slot) {
      try {
        const provider = this.registry.resolve(opts.slot, settings.defaultProviders[opts.slot])
        if (provider.providerId !== 'mock-audio' && provider.providerId === 'elevenlabs' && !this.config.ELEVENLABS_ENABLED) {
          providerOk = false
          providerMessage = 'the configured audio provider is disabled'
        } else if (!provider.isConfigured()) {
          providerOk = false
          providerMessage = `provider ${provider.providerId} is not configured`
        }
      } catch (err) {
        providerOk = false
        providerMessage = err instanceof Error ? err.message : 'no provider available'
      }
    }
    checks.push({ name: 'provider_entitlement', pass: providerOk, message: providerMessage })

    const roleOk = (ROLE_RANK[opts.actor.orgRole] ?? 0) >= ROLE_RANK[opts.minimumRole ?? 'member']!
    checks.push({
      name: 'user_permission',
      pass: roleOk,
      message: roleOk ? 'ok' : `this action requires ${opts.minimumRole ?? 'member'} access`,
    })

    const budget = await this.usageRepo.check(opts.actor.orgId, opts.actor.userId, opts.capability, opts.estimatedCostMicros ?? 0)
    checks.push({ name: 'usage_limit', pass: budget.allowed, message: budget.reason ?? 'ok' })

    const decision = evaluateGate(checks)
    return { ...decision, warning: budget.warning }
  }

  /** Decide and throw on refusal. Returns the budget warning (if any) for display. */
  async authorize(opts: AuthorizeOptions): Promise<{ warning: string | null }> {
    const decision = await this.decide(opts)
    assertGate(decision)
    return { warning: decision.warning }
  }
}
