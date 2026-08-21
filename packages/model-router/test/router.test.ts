import { describe, expect, it } from 'vitest'
import { deriveRequirements, emptyShot } from '@masterclip/shot-schema'
import { perSecondUsd, type ModelCapabilities, type NormalizedModel, type ProviderHealth } from '@masterclip/provider-core'
import { usdToMicros } from '@masterclip/shared'
import type { ModelPerformance } from '@masterclip/cost-engine'
import { compareStrategies, predictApproval, routeShot, ROUTING_PROFILES } from '../src/index.js'

function model(
  providerId: string,
  modelId: string,
  usdPerSecond: number | null,
  capabilities: Partial<ModelCapabilities> = {},
): NormalizedModel {
  return {
    providerId,
    modelId,
    displayName: `${providerId}/${modelId}`,
    family: 'test',
    capabilities: {
      modes: ['text_to_video', 'image_to_video'],
      duration: { minSeconds: 4, maxSeconds: 10, allowedSeconds: [4, 6, 8, 10] },
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16'],
      fps: [24],
      nativeAudio: false,
      dialogue: false,
      firstFrame: true,
      lastFrame: true,
      videoReference: false,
      extension: false,
      maxReferenceImages: 2,
      seed: true,
      negativePrompt: true,
      maxPromptChars: 3000,
      tier: 'standard',
      safetyControls: [],
      ...capabilities,
    },
    pricing: usdPerSecond === null ? null : perSecondUsd(usdPerSecond, { retrievedAt: '2026-08-17', sourceUrl: 'test' }),
    enabled: true,
    raw: {},
    fetchedAt: '2026-08-17T00:00:00Z',
    source: 'static',
  }
}

function performance(providerId: string, modelId: string, submitted: number, approved: number, category = 'performance'): ModelPerformance {
  return {
    projectId: 'p',
    providerId,
    modelId,
    shotCategory: category,
    submitted,
    technicallyValid: submitted,
    approved,
    rejected: submitted - approved,
    totalMicros: usdToMicros(submitted * 0.5),
    approvedMicros: usdToMicros(approved * 0.5),
    approvedSeconds: approved * 8,
    submittedSeconds: submitted * 8,
    meanLatencyMs: 45_000,
  }
}

const shot = emptyShot({
  generation_mode: 'text_to_video',
  action: 'she turns',
  duration_seconds: 8,
  target_resolution: '720p',
  routing_profile: 'BALANCED',
  shot_category: 'performance',
})

describe('approval prediction', () => {
  it('starts from a conservative tier prior with no data', () => {
    const draft = predictApproval('draft')
    const premium = predictApproval('premium')
    expect(draft.rate).toBeCloseTo(0.12, 2)
    expect(premium.rate).toBeCloseTo(0.42, 2)
    expect(draft.confidence).toBe(0)
  })

  it('does not let a tiny sample dominate the prior', () => {
    // 1 of 2 approved is not evidence of a 50% model.
    const small = predictApproval('draft', performance('a', 'b', 2, 1))
    expect(small.rate).toBeLessThan(0.35)
    expect(small.confidence).toBeLessThan(0.25)
  })

  it('converges on measured behaviour once there is real data', () => {
    const large = predictApproval('draft', performance('a', 'b', 200, 120))
    expect(large.rate).toBeGreaterThan(0.55)
    expect(large.confidence).toBeGreaterThan(0.95)
  })
})

describe('routing', () => {
  it('prefers the model with the lowest expected cost per approved second, not the cheapest render', () => {
    // cheap: $0.02/s but approved 5% of the time  → ~$0.40/approved second
    // solid: $0.10/s but approved 60% of the time → ~$0.17/approved second
    const decision = routeShot({
      shot,
      requirements: deriveRequirements(shot),
      models: [model('a', 'cheap', 0.02), model('b', 'solid', 0.1)],
      performance: [performance('a', 'cheap', 200, 10), performance('b', 'solid', 200, 120)],
    })
    expect(decision.chosen?.modelId).toBe('solid')
    const cheap = decision.candidates.find((c) => c.modelId === 'cheap')
    expect(cheap?.expectedApprovedCostPerSecondMicros).toBeGreaterThan(decision.chosen?.expectedApprovedCostPerSecondMicros ?? 0)
  })

  it('flags low confidence when the ranking rests on priors', () => {
    const decision = routeShot({ shot, requirements: deriveRequirements(shot), models: [model('a', 'x', 0.05)] })
    expect(decision.lowConfidence).toBe(true)
    expect(decision.explanation).toMatch(/confidence is low/)
  })

  it('excludes models the shot forbids and honours preferences', () => {
    const decision = routeShot({
      shot: { ...shot, excluded_models: ['a/blocked'], preferred_models: ['b/wanted'] },
      requirements: deriveRequirements(shot),
      models: [model('a', 'blocked', 0.01), model('b', 'wanted', 0.12)],
    })
    expect(decision.rejected.find((r) => r.modelId === 'blocked')?.reasons.join()).toMatch(/excluded by the shot/)
    expect(decision.chosen?.modelId).toBe('wanted')
  })

  it('refuses to route a storyboard test to a premium model', () => {
    const storyboard = { ...shot, routing_profile: 'STORYBOARD' as const }
    const decision = routeShot({
      shot: storyboard,
      requirements: deriveRequirements(storyboard),
      models: [model('a', 'premium', 0.02, { tier: 'premium' }), model('b', 'draft', 0.02, { tier: 'draft' })],
    })
    expect(decision.chosen?.modelId).toBe('draft')
    expect(decision.rejected.find((r) => r.modelId === 'premium')?.reasons.join()).toMatch(/tier premium not allowed/)
  })

  it('enforces the profile cost ceiling', () => {
    const storyboard = { ...shot, routing_profile: 'STORYBOARD' as const }
    const decision = routeShot({
      shot: storyboard,
      requirements: deriveRequirements(storyboard),
      models: [model('a', 'expensive', 0.5, { tier: 'draft' })],
    })
    expect(decision.chosen).toBeNull()
    expect(decision.rejected[0]?.reasons.join()).toMatch(/exceeds the profile ceiling/)
  })

  it('drops models that cannot do what the shot needs', () => {
    const audioShot = emptyShot({ generation_mode: 'text_to_video', action: 'she sings', audio_mode: 'native_generated', routing_profile: 'NATIVE_AUDIO' })
    const decision = routeShot({
      shot: audioShot,
      requirements: deriveRequirements(audioShot),
      models: [model('a', 'silent', 0.05), model('b', 'loud', 0.2, { nativeAudio: true })],
    })
    expect(decision.chosen?.modelId).toBe('loud')
    expect(decision.rejected.find((r) => r.modelId === 'silent')).toBeDefined()
  })

  it('excludes an unavailable provider and de-rates a degraded one', () => {
    const health: ProviderHealth[] = [
      { providerId: 'a', status: 'unavailable', latencyMs: null, message: 'down', checkedAt: '' },
      { providerId: 'b', status: 'degraded', latencyMs: 9000, message: 'slow', checkedAt: '' },
    ]
    const decision = routeShot({ shot, requirements: deriveRequirements(shot), models: [model('a', 'x', 0.01), model('b', 'y', 0.05)], health })
    expect(decision.rejected.find((r) => r.providerId === 'a')?.reasons.join()).toMatch(/unavailable/)
    expect(decision.candidates[0]?.warnings.join()).toMatch(/degraded/)
  })

  it('excludes a candidate that would exceed the remaining shot budget', () => {
    const decision = routeShot({
      shot,
      requirements: deriveRequirements(shot),
      models: [model('a', 'pricey', 0.5)],
      remainingBudgetMicros: usdToMicros(1),
    })
    expect(decision.rejected[0]?.reasons.join()).toMatch(/remaining shot budget/)
  })

  it('keeps an unpriced model usable but never lets it win on cost alone', () => {
    const decision = routeShot({ shot, requirements: deriveRequirements(shot), models: [model('a', 'unpriced', null), model('b', 'known', 0.05)] })
    const unpriced = decision.candidates.find((c) => c.modelId === 'unpriced')
    expect(unpriced?.warnings.join()).toMatch(/live provider quote is required/)
    expect(unpriced?.expectedApprovedCostMicros).toBeNull()
  })

  it('every routing profile is defined and internally consistent', () => {
    for (const profile of Object.values(ROUTING_PROFILES)) {
      expect(profile.allowedTiers).toContain(profile.preferredTier)
      expect(profile.costWeight + profile.qualityWeight + profile.latencyWeight).toBeCloseTo(1, 5)
    }
  })
})

describe('draft-first strategy comparison', () => {
  it('shows the saving when drafting lifts the final-model approval rate', () => {
    const result = compareStrategies({
      masters: 500,
      draftsPerMaster: 6,
      draftCostPerClipMicros: usdToMicros(0.1),
      finalCostPerClipMicros: usdToMicros(0.8),
      guidedApprovalRate: 0.55,
      blindApprovalRate: 0.2,
    })
    expect(result.savingsMicros).toBeGreaterThan(0)
    expect(result.savingsPercent).toBeGreaterThan(0)
    expect(result.assumptions.join(' ')).toMatch(/excludes retries/)
  })

  it('shows drafting losing when it does not improve acceptance', () => {
    const result = compareStrategies({
      masters: 100,
      draftsPerMaster: 10,
      draftCostPerClipMicros: usdToMicros(0.2),
      finalCostPerClipMicros: usdToMicros(0.5),
      guidedApprovalRate: 0.5,
      blindApprovalRate: 0.5,
    })
    // Same acceptance either way: the drafts are pure added cost.
    expect(result.savingsMicros).toBeLessThan(0)
  })
})
