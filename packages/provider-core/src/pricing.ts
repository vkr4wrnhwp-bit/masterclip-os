import { applyRate, hashObject, usdToMicros, type MicroUsd } from '@masterclip/shared'
import { RESOLUTION_PIXELS } from '@masterclip/shot-schema'
import type { CanonicalRenderRequest, PriceFormula, PriceQuote, QuoteConfidence } from './types.js'

/** Quotes go stale; a submission with an expired quote is refused by the cost engine. */
export const QUOTE_TTL_MS = 10 * 60_000

/**
 * Deterministic hash of the price-relevant parts of a request.
 *
 * Prompt text is excluded on purpose: no provider prices by prompt content, and
 * including it would invalidate a quote every time a compiler tweak reflows a
 * sentence.
 */
export function priceRequestHash(request: CanonicalRenderRequest): string {
  return hashObject({
    provider: request.providerId,
    model: request.modelId,
    mode: request.mode,
    duration: request.durationSeconds,
    resolution: request.resolution,
    aspect: request.aspectRatio,
    fps: request.fps,
    audio: request.audio.mode,
    references: request.inputs.references.length,
    firstFrame: Boolean(request.inputs.firstFrame),
    lastFrame: Boolean(request.inputs.lastFrame),
    video: Boolean(request.inputs.video),
  })
}

/**
 * Applies a published rate card. This is the *fallback* path: adapters whose
 * provider exposes an estimate endpoint must call it and mark the quote
 * `provider_quote`/`exact` instead.
 */
export function estimateFromFormula(
  providerId: string,
  request: CanonicalRenderRequest,
  formula: PriceFormula,
  nowMs: number,
): PriceQuote {
  const seconds = request.durationSeconds
  const wantsAudio = request.audio.mode === 'native_generated' || request.audio.mode === 'native_dialogue'
  const perResolution = formula.perResolutionMicros?.[request.resolution]
  const rate = perResolution ?? formula.rateMicros

  let micros: MicroUsd
  switch (formula.basis) {
    case 'per_second':
      micros = applyRate(rate, seconds)
      break
    case 'per_video':
      micros = rate
      break
    case 'per_megapixel_second': {
      const { width, height } = RESOLUTION_PIXELS[request.resolution]
      const megapixels = (width * height) / 1_000_000
      micros = applyRate(rate, megapixels * seconds)
      break
    }
    case 'per_credit':
      // A credit rate with no credit count is not a price. Callers must obtain
      // a live quote; returning a confident-looking number here would be a lie.
      micros = 0
      break
    default:
      micros = 0
  }

  if (wantsAudio && formula.audioSurchargeMicros) {
    micros += applyRate(formula.audioSurchargeMicros, seconds)
  }
  if (formula.minimumMicros && micros < formula.minimumMicros) micros = formula.minimumMicros

  const confidence: QuoteConfidence =
    formula.basis === 'unknown' || formula.basis === 'per_credit' ? 'unknown' : formula.dynamic ? 'estimated' : 'estimated'

  return {
    providerId,
    modelId: request.modelId,
    estimatedMicros: micros,
    credits: null,
    currency: 'USD',
    source: 'published_rate_card',
    confidence,
    quotedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + QUOTE_TTL_MS).toISOString(),
    requestHash: priceRequestHash(request),
    raw: { formula, appliedRateMicros: rate, seconds, wantsAudio },
  }
}

export function quoteFromProvider(input: {
  providerId: string
  request: CanonicalRenderRequest
  micros: MicroUsd
  credits?: number | null
  nowMs: number
  raw: unknown
  ttlMs?: number
}): PriceQuote {
  return {
    providerId: input.providerId,
    modelId: input.request.modelId,
    estimatedMicros: input.micros,
    credits: input.credits ?? null,
    currency: 'USD',
    source: 'provider_quote',
    confidence: 'exact',
    quotedAt: new Date(input.nowMs).toISOString(),
    expiresAt: new Date(input.nowMs + (input.ttlMs ?? QUOTE_TTL_MS)).toISOString(),
    requestHash: priceRequestHash(input.request),
    raw: input.raw,
  }
}

export function isQuoteValid(quote: PriceQuote, request: CanonicalRenderRequest, nowMs: number): { ok: boolean; reason: string } {
  if (quote.providerId !== request.providerId || quote.modelId !== request.modelId) {
    return { ok: false, reason: 'quote is for a different provider/model' }
  }
  if (quote.requestHash !== priceRequestHash(request)) {
    return { ok: false, reason: 'request changed since the quote was issued' }
  }
  if (Date.parse(quote.expiresAt) <= nowMs) {
    return { ok: false, reason: `quote expired at ${quote.expiresAt}` }
  }
  return { ok: true, reason: '' }
}

/** Helper for adapters declaring static rate cards from documented USD figures. */
export function perSecondUsd(usd: number, meta: { retrievedAt: string; sourceUrl: string; notes?: string; dynamic?: boolean }): PriceFormula {
  return {
    basis: 'per_second',
    rateMicros: usdToMicros(usd),
    dynamic: meta.dynamic ?? false,
    retrievedAt: meta.retrievedAt,
    sourceUrl: meta.sourceUrl,
    ...(meta.notes ? { notes: meta.notes } : {}),
  }
}

export function perVideoUsd(usd: number, meta: { retrievedAt: string; sourceUrl: string; notes?: string; dynamic?: boolean }): PriceFormula {
  return {
    basis: 'per_video',
    rateMicros: usdToMicros(usd),
    dynamic: meta.dynamic ?? false,
    retrievedAt: meta.retrievedAt,
    sourceUrl: meta.sourceUrl,
    ...(meta.notes ? { notes: meta.notes } : {}),
  }
}

/** A model whose price must be fetched per request. Never guesses a number. */
export function dynamicPricing(meta: { retrievedAt: string; sourceUrl: string; notes?: string }): PriceFormula {
  return {
    basis: 'unknown',
    rateMicros: 0,
    dynamic: true,
    retrievedAt: meta.retrievedAt,
    sourceUrl: meta.sourceUrl,
    notes: meta.notes ?? 'price must be quoted per request via the provider API',
  }
}
