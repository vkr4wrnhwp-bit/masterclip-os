import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { crc32, inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteDb, runMigrations } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { SUITE_BACKUP_SALT, SUITE_SSO_SALT, SUITE_WIPE_SALT, verifySuiteBackup } from '@masterclip/auth'
import { buildServer } from '../apps/api/src/server.js'
import { BACKUP_EXPORT_PATH, backupSecret, buildBackup } from '../apps/api/src/routes/backup-export.js'
import type { FastifyInstance } from 'fastify'

/**
 * Street Banker's nightly backup pulls everything Motion keeps (owner,
 * 2026-10-20: "yes"). POST /api/street-banker/backup with {"token": ...}:
 * itsdangerous, salt "street-banker-backup-v1", 120 seconds, once. Every
 * refusal is JSON and never a redirect; the archive is a real zip whose
 * database snapshot opens and has Motion's tables and rows.
 */
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

const secret = 'backup-test-only'
let db: SqliteDb, runtime: Runtime, app: FastifyInstance, root: string, storageRoot: string

beforeEach(async () => {
  delete process.env.SUITE_SSO_SECRET
  delete process.env.SUITE_BACKUP_MAX_MB
  process.env.SUITE_SSO_SECRET_MOTION = secret
  root = await mkdtemp(join(tmpdir(), 'motion-backup-test-'))
  storageRoot = join(root, 'storage')
  db = new SqliteDb(join(root, 'motion.sqlite'))
  await runMigrations(db)
  const config = loadConfig({ NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: storageRoot, ASSET_SIGNING_SECRET: secret, SESSION_SECRET: secret }, true)
  runtime = await createRuntime({ config, db, logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root: storageRoot, signingSecret: secret }) })
  app = await buildServer({ runtime, logger: silentLogger })
  await app.ready()
})

afterEach(async () => {
  delete process.env.SUITE_SSO_SECRET_MOTION
  delete process.env.SUITE_SSO_SECRET
  delete process.env.SUITE_BACKUP_MAX_MB
  await app.close()
  await db.close()
  await rm(root, { recursive: true, force: true })
})

function token(payload: Record<string, unknown> = {}, opts: { age?: number; salt?: string; key?: string } = {}) {
  const body = Buffer.from(JSON.stringify({ v: 1, kind: 'backup', suite: 'motion', nonce: randomUUID(), iat: 0, ...payload })).toString('base64url')
  const stamp = Buffer.alloc(4)
  stamp.writeUInt32BE(Math.floor(Date.now() / 1000) - (opts.age ?? 0))
  const signed = `${body}.${stamp.toString('base64url')}`
  const key = createHash('sha1').update(`${opts.salt ?? SUITE_BACKUP_SALT}signer${opts.key ?? secret}`).digest()
  return `${signed}.${createHmac('sha1', key).update(signed).digest('base64url')}`
}

const pull = (value: unknown) => app.inject({ method: 'POST', url: BACKUP_EXPORT_PATH, payload: { token: value } })

/** A small, independent ZIP reader: the central directory, then each entry's data, CRC-checked. */
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThan(0)
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50)
    const method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16)
    const csize = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24)
    const nameLen = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    expect(zip.readUInt32LE(local)).toBe(0x04034b50)
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(dataAt, dataAt + csize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    expect(data.length).toBe(size)
    expect(crc32(data) >>> 0).toBe(crc >>> 0)
    out.set(name, data)
    at += 46 + nameLen + extra + comment
  }
  return out
}

async function seedProject() {
  await db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', ['org-1', 'Backup Org', '2026-10-21T09:00:00.000Z'])
  await runtime.storage.putBuffer('proj-1/reference_image/a1/photo.png', Buffer.from('reference picture'))
  await runtime.storage.putBuffer('proj-1/generated_video/a2/render.mp4', Buffer.from('a render'.repeat(100)))
  await runtime.storage.putBuffer('proj-1/delivery/a3/master.mp4', Buffer.from('the master'))
}

describe('backup export: refusals', () => {
  it('answers a GET with 403 JSON', async () => {
    const r = await app.inject({ method: 'GET', url: BACKUP_EXPORT_PATH })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toEqual({ ok: false, error: 'post_only' })
    expect(r.headers.location).toBeUndefined()
  })

  it('refuses no token, a sign-in token, a wipe token and another suite with 403 JSON', async () => {
    for (const [value, error] of [
      [undefined, 'no token'],
      ['', 'no token'],
      ['abc.def.ghi', 'bad signature'],
      [token({}, { salt: SUITE_SSO_SALT }), 'bad signature'],
      [token({ kind: 'wipe', uid: 'a', email: 'a@example.test' }, { salt: SUITE_WIPE_SALT }), 'bad signature'],
      [token({ suite: 'tour' }), 'wrong suite'],
      [token({ kind: 'wipe' }), 'unrecognised token'],
      [token({}, { key: 'some-other-suites-key' }), 'bad signature'],
    ] as const) {
      const r = await pull(value)
      expect(r.statusCode, String(error)).toBe(403)
      expect(r.json()).toEqual({ ok: false, error })
      expect(r.headers.location).toBeUndefined()
    }
  })

  it('refuses an expired token, and one stamped too far ahead', async () => {
    expect((await pull(token({}, { age: 121 }))).json()).toEqual({ ok: false, error: 'expired' })
    expect((await pull(token({}, { age: -31 }))).json()).toEqual({ ok: false, error: 'expired' })
  })

  it('refuses everything when no key is set', async () => {
    delete process.env.SUITE_SSO_SECRET_MOTION
    const r = await pull(token())
    expect(r.statusCode).toBe(403)
    expect(r.json()).toEqual({ ok: false, error: 'not_configured' })
  })

  it('takes only its own key in production', () => {
    delete process.env.SUITE_SSO_SECRET_MOTION
    process.env.SUITE_SSO_SECRET = 'shared-by-every-suite'
    expect(backupSecret(true)).toBe('')
    expect(backupSecret(false)).toBe('shared-by-every-suite')
    process.env.SUITE_SSO_SECRET_MOTION = 'motion-own'
    expect(backupSecret(true)).toBe('motion-own')
  })

  it('reads the real Python itsdangerous wire format', () => {
    // Minted with sb_suite_sso's URLSafeTimedSerializer at 1792118979, not the JavaScript helper above.
    const signed = 'eyJ2IjoxLCJraW5kIjoiYmFja3VwIiwic3VpdGUiOiJtb3Rpb24iLCJub25jZSI6InB5dGhvbi1maXh0dXJlIiwiaWF0IjoxNzkyMTE4OTc5fQ.atGQww.M5lNJOtcfDd_WLdu3AS8gaanCIo'
    expect(verifySuiteBackup(signed, secret, 1792118979 + 5)).toEqual({ nonce: 'python-fixture' })
    expect(() => verifySuiteBackup(signed, secret, 1792118979 + 121)).toThrow('expired')
  })
})

describe('backup export: the archive', () => {
  it('answers the right token with a real snapshot and the files, once', async () => {
    await seedProject()
    const value = token()
    const r = await pull(value)
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('application/zip')
    expect(Number(r.headers['content-length'])).toBe(r.rawPayload.length)
    expect(Number(r.headers['x-backup-files'])).toBe(3)
    expect(Number(r.headers['x-backup-db-bytes'])).toBeGreaterThan(0)
    const entries = readZip(r.rawPayload)
    expect([...entries.keys()].sort()).toEqual([
      'FILES.csv', 'MANIFEST.json',
      'files/proj-1/delivery/a3/master.mp4', 'files/proj-1/generated_video/a2/render.mp4', 'files/proj-1/reference_image/a1/photo.png',
      'motion.sqlite',
    ])
    expect(entries.get('files/proj-1/reference_image/a1/photo.png')!.toString()).toBe('reference picture')
    const manifest = JSON.parse(entries.get('MANIFEST.json')!.toString())
    expect(manifest.suite).toBe('motion')
    expect(manifest.files).toMatchObject({ storage: 'local', on_disk: 3, included: 3, skipped_over_cap: 0 })
    expect(entries.get('FILES.csv')!.toString()).toContain('files/proj-1/delivery/a3/master.mp4,10,yes')

    const snap = join(root, 'restored.sqlite')
    await writeFile(snap, entries.get('motion.sqlite')!)
    const restored = new DatabaseSync(snap)
    try {
      expect((restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
      const tables = new Set((restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name))
      for (const t of ['orgs', 'users', 'projects', 'assets', 'render_jobs', 'masters', 'suite_wipe_receipts']) expect(tables.has(t), t).toBe(true)
      expect((restored.prepare('SELECT name FROM orgs WHERE id = ?').get('org-1') as { name: string }).name).toBe('Backup Org')
    } finally {
      restored.close()
    }

    const again = await pull(value)
    expect(again.statusCode).toBe(403)
    expect(again.json()).toEqual({ ok: false, error: 'replayed' })
  })

  it('refuses a database over the cap with 413 and the reason', async () => {
    process.env.SUITE_BACKUP_MAX_MB = '1'
    const r = await pull(token())
    expect(r.statusCode).toBe(413)
    expect(r.json()).toMatchObject({ ok: false, error: 'too_large' })
    expect(r.json().message).toMatch(/over the 1 MB cap/)
  })

  it('carries the artist uploads first and lists what does not fit', async () => {
    await seedProject()
    await runtime.storage.putBuffer('proj-1/generated_video/a4/big.mp4', Buffer.alloc(3 * 1024 * 1024, 7))
    const work = await mkdtemp(join(tmpdir(), 'motion-backup-build-'))
    try {
      // 3 MB: the database and the small files fit, the 3 MB render does not.
      const { zipPath, summary } = await buildBackup(runtime, work, 3 * 1024 * 1024)
      const entries = readZip(await readFile(zipPath))
      expect(entries.has('files/proj-1/reference_image/a1/photo.png')).toBe(true)
      expect(entries.has('files/proj-1/delivery/a3/master.mp4')).toBe(true)
      expect(entries.has('files/proj-1/generated_video/a4/big.mp4')).toBe(false)
      expect(summary.files.skipped_over_cap).toBe(1)
      expect(entries.get('FILES.csv')!.toString()).toContain(`files/proj-1/generated_video/a4/big.mp4,${3 * 1024 * 1024},no - over the archive size cap`)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
