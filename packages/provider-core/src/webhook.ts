import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError, hmacHex, safeEqual } from '@masterclip/shared'

/**
 * Webhook verification helpers shared by adapters.
 *
 * Two rules hold everywhere: signatures are checked against the *raw* body
 * (re-serializing JSON changes bytes and breaks HMACs), and a timestamp window
 * is enforced so a captured delivery cannot be replayed later.
 */
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300

export interface HmacVerifyInput {
  rawBody: string
  signatureHeader: string | null
  secret: string
  /** Some providers sign `${timestamp}.${body}`. */
  timestampHeader?: string | null
  replayWindowSeconds?: number
  nowMs?: number
  /** Provider prefix such as `sha256=`. Stripped before comparison. */
  prefix?: string
  algorithm?: 'sha256' | 'sha512'
}

export function verifyHmacSignature(input: HmacVerifyInput): void {
  const { rawBody, signatureHeader, secret } = input
  if (!secret) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.no_secret', message: 'webhook secret is not configured' })
  }
  if (!signatureHeader) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.missing_signature', message: 'missing webhook signature' })
  }

  const now = input.nowMs ?? Date.now()
  const window = (input.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS) * 1000
  let signedPayload = rawBody
  if (input.timestampHeader) {
    const timestampMs = Number(input.timestampHeader) * (input.timestampHeader.length > 12 ? 1 : 1000)
    if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > window) {
      throw new AppError({ kind: 'forbidden', code: 'webhook.stale', message: 'webhook timestamp outside the replay window' })
    }
    signedPayload = `${input.timestampHeader}.${rawBody}`
  }

  const provided = signatureHeader.startsWith(input.prefix ?? '')
    ? signatureHeader.slice((input.prefix ?? '').length)
    : signatureHeader
  const expected = hmacHex(secret, signedPayload, input.algorithm ?? 'sha256')
  if (!safeEqual(expected, provided.trim())) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.bad_signature', message: 'webhook signature mismatch' })
  }
}

/**
 * Signs our own callback URLs.
 *
 * Providers that offer no signature of their own still cannot be trusted to be
 * the only caller of a public endpoint, so the URL we hand out carries a token
 * bound to the job id. An attacker who does not hold the secret cannot fabricate
 * a completion for a job.
 */
export function signCallbackUrl(secret: string, baseUrl: string, providerId: string, jobId: string): string {
  const token = hmacHex(secret, `${providerId}:${jobId}`)
  const url = new URL(`/api/webhooks/${encodeURIComponent(providerId)}`, baseUrl)
  url.searchParams.set('job', jobId)
  url.searchParams.set('token', token)
  return url.toString()
}

export function verifyCallbackToken(secret: string, providerId: string, jobId: string, token: string | undefined): void {
  if (!token) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.missing_token', message: 'missing callback token' })
  }
  if (!safeEqual(hmacHex(secret, `${providerId}:${jobId}`), token)) {
    throw new AppError({ kind: 'forbidden', code: 'webhook.bad_token', message: 'invalid callback token' })
  }
}

/** Ed25519/JWKS-style providers hand back base64 signatures over the raw body. */
export function verifyBase64Hmac(rawBody: string, signature: string, secret: string, algorithm: 'sha256' | 'sha512' = 'sha256'): boolean {
  const expected = createHmac(algorithm, secret).update(rawBody).digest()
  const provided = Buffer.from(signature, 'base64')
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}
