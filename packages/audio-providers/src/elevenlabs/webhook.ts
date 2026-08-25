import { createHmac } from 'node:crypto'
import { AppError, safeEqual } from '@masterclip/shared'

/**
 * ElevenLabs webhook signature verification.
 *
 * The header carries `t=<unix seconds>,v0=<hex hmac>`, where the HMAC-SHA256 is
 * computed over `${t}.${rawBody}` with the endpoint's webhook secret. The SDK
 * enforces a 30-minute tolerance; we match it. Verification always runs against
 * the raw request bytes — re-serialized JSON breaks the HMAC by construction.
 */
export const ELEVENLABS_SIGNATURE_HEADER = 'elevenlabs-signature'
export const ELEVENLABS_REPLAY_TOLERANCE_MS = 30 * 60 * 1000

export function verifyElevenLabsSignature(rawBody: string, signatureHeader: string | null | undefined, secret: string, nowMs = Date.now()): void {
  if (!secret) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.no_secret', message: 'elevenlabs webhook secret is not configured' })
  }
  if (!signatureHeader) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.missing_signature', message: 'missing elevenlabs-signature header' })
  }
  const parts = signatureHeader.split(',')
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2)
  const signature = parts.find((p) => p.startsWith('v0='))
  if (!timestamp || !signature) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.bad_scheme', message: 'no v0 signature found in header' })
  }
  const timestampMs = Number(timestamp) * 1000
  if (!Number.isFinite(timestampMs) || nowMs - timestampMs > ELEVENLABS_REPLAY_TOLERANCE_MS) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.stale', message: 'webhook timestamp outside the replay tolerance' })
  }
  const expected = `v0=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
  if (!safeEqual(expected, signature)) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.bad_signature', message: 'elevenlabs webhook signature mismatch' })
  }
}

/** Builds a valid signature header — used by tests and the mock provider. */
export function signElevenLabsPayload(rawBody: string, secret: string, nowMs = Date.now()): string {
  const timestamp = String(Math.floor(nowMs / 1000))
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},v0=${digest}`
}
