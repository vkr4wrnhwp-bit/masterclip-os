import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { inflateSync } from 'node:zlib'

/**
 * Street Banker's nightly backup asking Motion for a copy of everything it
 * keeps (owner, 2026-10-20: "yes"). Server to server: Street Banker POSTs
 * {"token": ...} to /api/street-banker/backup and stores the zip it gets in
 * its bucket as motion/YYYY-MM/motion-<stamp>.zip.
 *
 * The token is minted in Python by itsdangerous' URLSafeTimedSerializer
 * (sb_suite_sso.issue_backup) under its own salt, so a sign-in hand-off, a
 * Vault proof or a wipe can never be read as a backup request, and a backup
 * request can never sign anybody in. Good for 120 seconds, 30 seconds of
 * clock leeway; the route keeps each nonce once.
 */
export const SUITE_BACKUP_SALT = 'street-banker-backup-v1'
export const SUITE_BACKUP_MAX_AGE_SECONDS = 120

export class BackupRejected extends Error {
  constructor(readonly reason: 'no token' | 'bad signature' | 'expired' | 'wrong suite' | 'unrecognised token' | 'incomplete token') {
    super(reason)
  }
}

export interface BackupRequest {
  nonce: string
}

export function verifySuiteBackup(token: unknown, secret: string, now = Math.floor(Date.now() / 1000)): BackupRequest {
  if (typeof token !== 'string' || !token) throw new BackupRejected('no token')
  const dot = token.lastIndexOf('.'), signed = token.slice(0, dot), stampDot = signed.lastIndexOf('.')
  if (dot < 1 || stampDot < 1) throw new BackupRejected('bad signature')
  const key = createHash('sha1').update(`${SUITE_BACKUP_SALT}signer${secret}`).digest()
  const expected = createHmac('sha1', key).update(signed).digest(), given = Buffer.from(token.slice(dot + 1), 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected) || given.toString('base64url') !== token.slice(dot + 1)) {
    throw new BackupRejected('bad signature')
  }
  const stamp = Buffer.from(signed.slice(stampDot + 1), 'base64url')
  if (!stamp.length || stamp.length > 6) throw new BackupRejected('unrecognised token')
  let issued = 0
  for (const byte of stamp) issued = issued * 256 + byte
  if (now - issued > SUITE_BACKUP_MAX_AGE_SECONDS || issued - now > 30) throw new BackupRejected('expired')
  let p: Record<string, unknown>
  try {
    const body = signed.slice(0, stampDot), compressed = body.startsWith('.')
    const raw = Buffer.from(compressed ? body.slice(1) : body, 'base64url')
    p = JSON.parse((compressed ? inflateSync(raw, { maxOutputLength: 65536 }) : raw).toString('utf8'))
  } catch {
    throw new BackupRejected('bad signature')
  }
  if (!p || Array.isArray(p) || p.v !== 1 || p.kind !== 'backup') throw new BackupRejected('unrecognised token')
  if (p.suite !== 'motion') throw new BackupRejected('wrong suite')
  if (typeof p.nonce !== 'string' || !p.nonce.trim()) throw new BackupRejected('incomplete token')
  return { nonce: p.nonce }
}
