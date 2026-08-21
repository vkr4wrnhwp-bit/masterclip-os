import { describe, expect, it } from 'vitest'
import { deriveRequirements, emptyShot } from '@masterclip/shot-schema'
import { hmacHex } from '@masterclip/shared'
import {
  estimateFromFormula,
  filterCompatibleModels,
  isQuoteValid,
  matchCapabilities,
  perSecondUsd,
  priceRequestHash,
  sampleRequest,
  signCallbackUrl,
  snapDuration,
  validateAgainstCapabilities,
  verifyCallbackToken,
  verifyHmacSignature,
  type ModelCapabilities,
  type NormalizedModel,
} from '../src/index.js'

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    modes: ['text_to_video', 'image_to_video'],
    duration: { minSeconds: 4, maxSeconds: 10, allowedSeconds: [4, 6, 8, 10] },
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16'],
    fps: [24],
    nativeAudio: false,
    dialogue: false,
    firstFrame: true,
    lastFrame: false,
    videoReference: false,
    extension: false,
    maxReferenceImages: 1,
    seed: true,
    negativePrompt: true,
    maxPromptChars: 2000,
    tier: 'standard',
    safetyControls: [],
    ...overrides,
  }
}

describe('capability matching', () => {
  it('reports every mismatch, not just the first', () => {
    const requirements = deriveRequirements(
      emptyShot({ generation_mode: 'video_to_video', target_resolution: '2160p', aspect_ratio: '21:9', audio_mode: 'native_generated' }),
    )
    const mismatches = matchCapabilities(requirements, caps())
    const fields = mismatches.map((m) => m.field)
    expect(fields).toContain('generation_mode')
    expect(fields).toContain('target_resolution')
    expect(fields).toContain('aspect_ratio')
    expect(fields).toContain('audio_mode')
  })

  it('treats a discrete-duration mismatch as coercible but an out-of-range one as fatal', () => {
    const inRange = deriveRequirements(emptyShot({ generation_mode: 'text_to_video', duration_seconds: 5 }))
    expect(matchCapabilities(inRange, caps()).find((m) => m.field === 'duration_seconds')?.severity).toBe('soft')

    const tooLong = deriveRequirements(emptyShot({ generation_mode: 'text_to_video', duration_seconds: 30 }))
    expect(matchCapabilities(tooLong, caps()).find((m) => m.field === 'duration_seconds')?.severity).toBe('hard')
  })

  it('filters a catalog down to what can actually run the shot', () => {
    const models: NormalizedModel[] = [
      { providerId: 'a', modelId: 'audio', displayName: '', family: '', capabilities: caps({ nativeAudio: true }), pricing: null, enabled: true, raw: {}, fetchedAt: '', source: 'static' },
      { providerId: 'b', modelId: 'silent', displayName: '', family: '', capabilities: caps(), pricing: null, enabled: true, raw: {}, fetchedAt: '', source: 'static' },
      { providerId: 'c', modelId: 'disabled', displayName: '', family: '', capabilities: caps({ nativeAudio: true }), pricing: null, enabled: false, raw: {}, fetchedAt: '', source: 'static' },
    ]
    const requirements = deriveRequirements(emptyShot({ generation_mode: 'text_to_video', audio_mode: 'native_generated', duration_seconds: 8 }))
    expect(filterCompatibleModels(requirements, models).map((m) => m.modelId)).toEqual(['audio'])
  })
})

describe('duration snapping', () => {
  it('snaps within range and refuses outside it', () => {
    expect(snapDuration(5, caps())).toBe(6)
    expect(snapDuration(8, caps())).toBe(8)
    // 999s must be a rejection, not a silent 10s clip.
    expect(snapDuration(999, caps())).toBeNull()
    expect(snapDuration(1, caps())).toBeNull()
  })

  it('breaks ties toward the longer legal duration', () => {
    expect(snapDuration(5, caps({ duration: { minSeconds: 4, maxSeconds: 10, allowedSeconds: [4, 6] } }))).toBe(6)
  })

  it('honours a step when there is no discrete list', () => {
    expect(snapDuration(7.3, caps({ duration: { minSeconds: 4, maxSeconds: 10, step: 0.5 } }))).toBe(7.5)
  })
})

describe('request validation', () => {
  it('accepts a well-formed request and lists coercions separately from errors', () => {
    const result = validateAgainstCapabilities(sampleRequest({ durationSeconds: 5, resolution: '720p', aspectRatio: '16:9', mode: 'text_to_video' }), caps())
    expect(result.ok).toBe(true)
    expect(result.adjustments.find((a) => a.field === 'durationSeconds')).toBeDefined()
  })

  it('warns rather than fails when references exceed the provider limit', () => {
    const request = sampleRequest({
      mode: 'text_to_video',
      durationSeconds: 8,
      inputs: {
        references: [
          { assetId: 'a', sha256: 'x', mime: 'image/png', bytes: 1 },
          { assetId: 'b', sha256: 'y', mime: 'image/png', bytes: 1 },
        ],
      },
    })
    const result = validateAgainstCapabilities(request, caps({ maxReferenceImages: 1 }))
    expect(result.ok).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/identity accuracy may drop/)
  })

  it('fails a request asking for audio the model cannot produce', () => {
    const request = sampleRequest({ mode: 'text_to_video', durationSeconds: 8, audio: { mode: 'native_generated', dialogue: '', ambient: '' } })
    expect(validateAgainstCapabilities(request, caps()).ok).toBe(false)
  })
})

describe('pricing', () => {
  const formula = perSecondUsd(0.05, { retrievedAt: '2026-08-17', sourceUrl: 'https://example.test' })

  it('applies a per-second rate exactly', () => {
    const request = sampleRequest({ durationSeconds: 8 })
    const quote = estimateFromFormula('test', request, formula, 1_700_000_000_000)
    expect(quote.estimatedMicros).toBe(400_000)
    expect(quote.source).toBe('published_rate_card')
  })

  it('adds an audio surcharge only when audio is requested', () => {
    const withSurcharge = { ...formula, audioSurchargeMicros: 50_000 }
    const silent = estimateFromFormula('test', sampleRequest({ durationSeconds: 4 }), withSurcharge, 0)
    const loud = estimateFromFormula(
      'test',
      sampleRequest({ durationSeconds: 4, audio: { mode: 'native_generated', dialogue: '', ambient: '' } }),
      withSurcharge,
      0,
    )
    expect(loud.estimatedMicros - silent.estimatedMicros).toBe(200_000)
  })

  it('never reports a confident price for a credit-only model', () => {
    const credits = { ...formula, basis: 'per_credit' as const }
    const quote = estimateFromFormula('test', sampleRequest(), credits, 0)
    expect(quote.estimatedMicros).toBe(0)
    expect(quote.confidence).toBe('unknown')
  })

  it('invalidates a quote when the request changes materially', () => {
    const request = sampleRequest({ providerId: 'test', durationSeconds: 8 })
    const quote = estimateFromFormula('test', request, formula, 1_000_000)
    expect(isQuoteValid(quote, request, 1_000_000).ok).toBe(true)
    expect(isQuoteValid(quote, { ...request, durationSeconds: 10 }, 1_000_000).ok).toBe(false)
    expect(isQuoteValid(quote, request, 1_000_000 + 11 * 60_000).reason).toMatch(/expired/)
  })

  it('ignores prompt text when hashing, since no provider prices by prose', () => {
    const a = sampleRequest({ prompt: 'one phrasing' })
    const b = sampleRequest({ prompt: 'a different phrasing entirely' })
    expect(priceRequestHash(a)).toBe(priceRequestHash(b))
  })
})

describe('webhook security', () => {
  it('verifies an HMAC signature over the raw body', () => {
    const body = '{"request_id":"abc","status":"OK"}'
    const secret = 'webhook-secret'
    expect(() => verifyHmacSignature({ rawBody: body, signatureHeader: hmacHex(secret, body), secret })).not.toThrow()
    expect(() => verifyHmacSignature({ rawBody: body, signatureHeader: 'deadbeef', secret })).toThrow(/signature mismatch/)
    expect(() => verifyHmacSignature({ rawBody: body, signatureHeader: null, secret })).toThrow(/missing webhook signature/)
  })

  it('rejects a replayed delivery outside the timestamp window', () => {
    const secret = 'webhook-secret'
    const body = '{"a":1}'
    const timestamp = String(Math.floor(1_700_000_000_000 / 1000))
    const signature = hmacHex(secret, `${timestamp}.${body}`)
    expect(() =>
      verifyHmacSignature({ rawBody: body, signatureHeader: signature, timestampHeader: timestamp, secret, nowMs: 1_700_000_000_000 }),
    ).not.toThrow()
    expect(() =>
      verifyHmacSignature({ rawBody: body, signatureHeader: signature, timestampHeader: timestamp, secret, nowMs: 1_700_000_000_000 + 3_600_000 }),
    ).toThrow(/replay window/)
  })

  it('binds our own callback URL to the job it was issued for', () => {
    const url = signCallbackUrl('secret', 'https://masterclip.test', 'fal', 'job_123')
    const token = new URL(url).searchParams.get('token') ?? ''
    expect(() => verifyCallbackToken('secret', 'fal', 'job_123', token)).not.toThrow()
    // A token minted for one job must not authorize another.
    expect(() => verifyCallbackToken('secret', 'fal', 'job_456', token)).toThrow(/invalid callback token/)
    expect(() => verifyCallbackToken('secret', 'muapi', 'job_123', token)).toThrow(/invalid callback token/)
    expect(() => verifyCallbackToken('secret', 'fal', 'job_123', undefined)).toThrow(/missing callback token/)
  })
})
