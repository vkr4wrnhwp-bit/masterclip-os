import type { RoutingProfile } from '@masterclip/shot-schema'
import type { ModelTier } from '@masterclip/provider-core'
import { usdToMicros, type MicroUsd } from '@masterclip/shared'

export interface ProfileRules {
  profile: RoutingProfile
  purpose: string
  /** Tiers this profile will consider, cheapest-first preference order. */
  allowedTiers: ModelTier[]
  preferredTier: ModelTier
  /** Hard ceiling on estimated cost per second of output. */
  maxCostPerSecondMicros: MicroUsd | null
  /** Resolution the profile drives toward when the shot leaves it open. */
  preferResolutionOrder: string[]
  requireNativeAudio: boolean
  requireFrameControl: boolean
  requireVideoEdit: boolean
  /** Submission is blocked until a human approves. */
  requireHumanApproval: boolean
  /** Weight on price versus predicted acceptance when ranking (0..1). */
  costWeight: number
  latencyWeight: number
  qualityWeight: number
  /** Only consider self-hosted endpoints. */
  selfHostedOnly: boolean
}

/**
 * Routing profiles.
 *
 * A profile expresses intent ("this is a storyboard test", "this is the hero
 * shot") and the router turns that into a model choice using live capability,
 * price, health, and this project's own acceptance history. Nothing here names
 * a model: that is the point — a project switches providers without touching
 * its shot list.
 */
export const ROUTING_PROFILES: Record<RoutingProfile, ProfileRules> = {
  STORYBOARD: {
    profile: 'STORYBOARD',
    purpose: 'Cheapest possible visual or motion exploration. Low resolution, fast turnaround.',
    allowedTiers: ['draft'],
    preferredTier: 'draft',
    maxCostPerSecondMicros: usdToMicros(0.03),
    preferResolutionOrder: ['480p', '540p', '720p'],
    requireNativeAudio: false,
    requireFrameControl: false,
    requireVideoEdit: false,
    requireHumanApproval: false,
    costWeight: 0.75,
    latencyWeight: 0.2,
    qualityWeight: 0.05,
    selfHostedOnly: false,
  },
  DRAFT_MOTION: {
    profile: 'DRAFT_MOTION',
    purpose: 'Animate an approved still; test blocking, camera direction, and environmental motion cheaply.',
    allowedTiers: ['draft', 'standard'],
    preferredTier: 'draft',
    maxCostPerSecondMicros: usdToMicros(0.08),
    preferResolutionOrder: ['720p', '540p', '480p'],
    requireNativeAudio: false,
    requireFrameControl: false,
    requireVideoEdit: false,
    requireHumanApproval: false,
    costWeight: 0.6,
    latencyWeight: 0.15,
    qualityWeight: 0.25,
    selfHostedOnly: false,
  },
  BALANCED: {
    profile: 'BALANCED',
    purpose: 'Strong quality without hero-level spending. Social and secondary campaign clips.',
    allowedTiers: ['standard', 'draft', 'premium'],
    preferredTier: 'standard',
    maxCostPerSecondMicros: usdToMicros(0.15),
    preferResolutionOrder: ['1080p', '720p'],
    requireNativeAudio: false,
    requireFrameControl: false,
    requireVideoEdit: false,
    requireHumanApproval: false,
    costWeight: 0.4,
    latencyWeight: 0.1,
    qualityWeight: 0.5,
    selfHostedOnly: false,
  },
  HERO: {
    profile: 'HERO',
    purpose: 'Final commercial, billboard, LED, music-video, or key-art motion. Highest continuity and realism.',
    allowedTiers: ['premium', 'standard'],
    preferredTier: 'premium',
    maxCostPerSecondMicros: null,
    preferResolutionOrder: ['1080p', '1440p', '2160p', '720p'],
    requireNativeAudio: false,
    requireFrameControl: false,
    requireVideoEdit: false,
    // A hero render is the expensive one; a person signs off before it is sent.
    requireHumanApproval: true,
    costWeight: 0.15,
    latencyWeight: 0.05,
    qualityWeight: 0.8,
    selfHostedOnly: false,
  },
  CONTINUITY: {
    profile: 'CONTINUITY',
    purpose: 'First- and last-frame control, reference-heavy character work, shot chaining, scene extension.',
    allowedTiers: ['standard', 'premium'],
    preferredTier: 'standard',
    maxCostPerSecondMicros: usdToMicros(0.2),
    preferResolutionOrder: ['1080p', '720p'],
    requireNativeAudio: false,
    requireFrameControl: true,
    requireVideoEdit: false,
    requireHumanApproval: false,
    costWeight: 0.25,
    latencyWeight: 0.05,
    qualityWeight: 0.7,
    selfHostedOnly: false,
  },
  NATIVE_AUDIO: {
    profile: 'NATIVE_AUDIO',
    purpose: 'Synchronized generated dialogue, ambience, or sound. Only models with real audio capability.',
    allowedTiers: ['standard', 'premium'],
    preferredTier: 'premium',
    maxCostPerSecondMicros: null,
    preferResolutionOrder: ['1080p', '720p'],
    requireNativeAudio: true,
    requireFrameControl: false,
    requireVideoEdit: false,
    requireHumanApproval: false,
    costWeight: 0.25,
    latencyWeight: 0.05,
    qualityWeight: 0.7,
    selfHostedOnly: false,
  },
  VIDEO_EDIT: {
    profile: 'VIDEO_EDIT',
    purpose: 'Perspective changes, object replacement, wardrobe correction, environment adjustment, extension.',
    allowedTiers: ['standard', 'premium'],
    preferredTier: 'standard',
    maxCostPerSecondMicros: null,
    preferResolutionOrder: ['1080p', '720p'],
    requireNativeAudio: false,
    requireFrameControl: false,
    requireVideoEdit: true,
    requireHumanApproval: false,
    costWeight: 0.3,
    latencyWeight: 0.1,
    qualityWeight: 0.6,
    selfHostedOnly: false,
  },
  SELF_HOSTED_DRAFT: {
    profile: 'SELF_HOSTED_DRAFT',
    purpose: 'High-volume low-cost generation on our own GPUs — only after benchmarks prove it is cheaper per accepted second.',
    allowedTiers: ['draft', 'standard'],
    preferredTier: 'draft',
    maxCostPerSecondMicros: usdToMicros(0.05),
    preferResolutionOrder: ['720p', '540p', '480p'],
    requireNativeAudio: false,
    requireFrameControl: false,
    requireVideoEdit: false,
    requireHumanApproval: false,
    costWeight: 0.8,
    latencyWeight: 0.15,
    qualityWeight: 0.05,
    selfHostedOnly: true,
  },
}

/**
 * Conservative priors for predicted creative approval, by tier.
 *
 * These are starting beliefs, not measurements. They are deliberately
 * pessimistic and are swamped by real project data after roughly
 * `PRIOR_STRENGTH` observations — which is also why every routing decision
 * reports its confidence rather than presenting a prior as a finding.
 */
export const TIER_APPROVAL_PRIOR: Record<ModelTier, number> = {
  draft: 0.12,
  standard: 0.28,
  premium: 0.42,
}

/** Pseudo-observations behind each prior. Higher = slower to trust new data. */
export const PRIOR_STRENGTH = 8
