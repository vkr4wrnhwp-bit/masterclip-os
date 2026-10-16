import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { inflateSync } from 'node:zlib'

export class WipeRejected extends Error {
  constructor(readonly reason: 'no token' | 'bad signature' | 'expired' | 'wrong suite' | 'unrecognised token' | 'incomplete token') { super(reason) }
}

export const SUITE_WIPE_SALT = 'street-banker-suite-wipe-v1'
export interface WipeIdentity { uid: string; email: string; nonce: string }

/** itsdangerous URLSafeTimedSerializer, using the wipe-only salt and 60-second age. */
export function verifySuiteWipe(token: unknown, secret: string, now = Math.floor(Date.now() / 1000)): WipeIdentity {
  if (typeof token !== 'string' || !token) throw new WipeRejected('no token')
  const dot = token.lastIndexOf('.'), signed = token.slice(0, dot), stampDot = signed.lastIndexOf('.')
  if (dot < 1 || stampDot < 1) throw new WipeRejected('bad signature')
  const key = createHash('sha1').update(`${SUITE_WIPE_SALT}signer${secret}`).digest()
  const expected = createHmac('sha1', key).update(signed).digest(), given = Buffer.from(token.slice(dot + 1), 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected) || given.toString('base64url') !== token.slice(dot + 1)) throw new WipeRejected('bad signature')
  const stamp = Buffer.from(signed.slice(stampDot + 1), 'base64url')
  if (!stamp.length || stamp.length > 6) throw new WipeRejected('unrecognised token')
  let issued = 0
  for (const byte of stamp) issued = issued * 256 + byte
  if (now - issued > 60 || issued > now) throw new WipeRejected('expired')
  let p: Record<string, unknown>
  try {
    const body = signed.slice(0, stampDot), compressed = body.startsWith('.')
    const raw = Buffer.from(compressed ? body.slice(1) : body, 'base64url')
    p = JSON.parse((compressed ? inflateSync(raw, { maxOutputLength: 65536 }) : raw).toString('utf8'))
  } catch { throw new WipeRejected('bad signature') }
  if (!p || Array.isArray(p) || p.v !== 1 || p.kind !== 'wipe') throw new WipeRejected('unrecognised token')
  if (p.suite !== 'motion') throw new WipeRejected('wrong suite')
  if (typeof p.uid !== 'string' || !p.uid.trim() || typeof p.email !== 'string' || !p.email.includes('@') || typeof p.nonce !== 'string' || !p.nonce.trim()) throw new WipeRejected('incomplete token')
  return { uid: p.uid, email: p.email.trim().toLowerCase(), nonce: p.nonce }
}
