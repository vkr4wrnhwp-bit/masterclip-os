import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * Canonical JSON: object keys sorted at every depth, `undefined` dropped.
 * Two structurally identical request bodies must hash identically, otherwise
 * request de-duplication (which is what stops a retry becoming a second paid
 * generation) silently stops working.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value === undefined ? null : value
  if (Array.isArray(value)) return value.map(canonicalize)
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) out[k] = canonicalize(v)
  return out
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Stable content hash of a request payload — the idempotency key's backbone. */
export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export function hmacHex(secret: string, message: string, algo: 'sha256' | 'sha512' = 'sha256'): string {
  return createHmac(algo, secret).update(message).digest('hex')
}

export function hmacBase64(secret: string, message: string, algo: 'sha256' | 'sha512' = 'sha256'): string {
  return createHmac(algo, secret).update(message).digest('base64')
}

/** Constant-time compare that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    // Still burn a comparison so timing does not leak the length difference.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}
