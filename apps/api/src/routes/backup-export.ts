import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { BackupRejected, verifySuiteBackup } from '@masterclip/auth'
import type { Runtime } from '@masterclip/runtime'
import { SqliteDb } from '@masterclip/database'
import { MAX_ZIP_ENTRIES, ZipWriter } from '../backup-zip.js'

/**
 * Street Banker's nightly backup pulls a copy of everything Motion keeps
 * (owner, 2026-10-20: "yes").
 *
 * Motion keeps its data on this service's Render disk (/var/data, 5 GB):
 * the SQLite database (SQLITE_PATH) and, with the local storage driver,
 * every upload, render, master and delivery under STORAGE_LOCAL_ROOT. It is
 * not a Render Postgres, so nothing else backs it up. Street Banker's
 * /backup/run, after its own upload, POSTs {"token": ...} here and stores
 * the zip in its bucket as motion/YYYY-MM/motion-<stamp>.zip:
 *
 *   motion.sqlite   a consistent snapshot of the live database (VACUUM INTO,
 *                   SqliteDb.backupTo: the same call the pre-migration
 *                   backup uses; never a copy of the live file)
 *   files/<key>     the stored files, the artist's own uploads first, then
 *                   finished deliveries, then renders, then the rest, while
 *                   the archive stays under the cap (SUITE_BACKUP_MAX_MB,
 *                   500 MB by default); past it each is listed, not carried
 *   FILES.csv       every stored file and every file the database names, with
 *                   whether this archive carries it
 *   MANIFEST.json   what this is, how big, and what it does not cover
 *
 * The token: itsdangerous, salt "street-banker-backup-v1" (suite-backup.ts),
 * 120 seconds, once. In production only Motion's own key opens it
 * (SUITE_SSO_SECRET_MOTION): the shared key is in every suite's environment,
 * and this answer is the whole suite. Every refusal is JSON, 403 for the
 * request and never a redirect; a database over the cap is 413 with the
 * reason. One export at a time. The token is never logged.
 */
export const BACKUP_EXPORT_PATH = '/api/street-banker/backup'
export const DEFAULT_MAX_MB = 500
// Room for the zip's directory, the file list and the manifest.
const OVERHEAD = 1024 * 1024
// Already compressed: stored as they are, which saves the CPU on a small instance.
const STORED = new Set(['.mp4', '.mov', '.webm', '.m4a', '.mp3', '.aac', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.zip'])

export class BackupTooLarge extends Error {}

export interface BackupSummary {
  suite: 'motion'
  made_at: string
  database: Record<string, unknown>
  files: {
    storage: string
    on_disk: number
    included: number
    included_bytes: number
    skipped_over_cap: number
    in_object_storage: number
    named_but_missing: number
  }
  cap_bytes: number
  not_covered: string[]
  seconds: number
  zip_bytes?: number
}

/** The cap on one archive: SUITE_BACKUP_MAX_MB, 500 MB unless set. */
export function backupCapBytes(): number {
  const raw = (process.env.SUITE_BACKUP_MAX_MB ?? '').trim()
  const mb = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MAX_MB
  return Math.max(1, mb) * 1024 * 1024
}

/** The key backup requests are checked with: Motion's own, or (outside production) the shared one. */
export function backupSecret(production: boolean): string {
  const own = (process.env.SUITE_SSO_SECRET_MOTION ?? '').trim()
  if (own || production) return own
  return (process.env.SUITE_SSO_SECRET ?? '').trim()
}

/** The artist's own uploads first, then finished work, then renders, then what can be made again. */
function rank(key: string): number {
  const kind = key.split('/')[1] ?? ''
  if (kind === 'audio' || kind.startsWith('reference')) return 0
  if (kind === 'delivery') return 1
  if (kind === 'generated_video') return 2
  return 3
}

const csvCell = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** Builds the archive in `work`. Returns its path and what it holds. */
export async function buildBackup(runtime: Runtime, work: string, cap: number = backupCapBytes()): Promise<{ zipPath: string; summary: BackupSummary }> {
  const started = Date.now()
  const notCovered = [
    'the service settings and keys (they live in Render, never in a backup)',
    'files over the cap (named in FILES.csv)',
  ]
  const zipPath = join(work, 'motion-backup.zip')
  const zip = await ZipWriter.create(zipPath)
  try {
    let database: Record<string, unknown>
    let dbBytes = 0
    if (runtime.db instanceof SqliteDb) {
      const snapshot = join(work, 'motion.sqlite')
      await runtime.db.backupTo(snapshot)
      dbBytes = (await stat(snapshot)).size
      if (dbBytes + OVERHEAD > cap) {
        throw new BackupTooLarge(`the database alone is ${dbBytes.toLocaleString('en-US')} bytes, over the ${Math.floor(cap / 1048576)} MB cap (SUITE_BACKUP_MAX_MB)`)
      }
      const tables = await runtime.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")
      await zip.addFile('motion.sqlite', snapshot, true)
      await rm(snapshot, { force: true })
      database = {
        file: 'motion.sqlite', dialect: 'sqlite', path_on_server: runtime.db.path, bytes: dbBytes, tables: Number(tables?.n ?? 0),
        how: 'VACUUM INTO: a consistent snapshot of the live database, never a copy of the live file',
      }
      // The copies the migration runner leaves beside the database before each
      // migration (MIGRATION_BACKUP): old states, not carried.
      if (runtime.db.path !== ':memory:') {
        const dir = dirname(runtime.db.path), stem = `${basename(runtime.db.path)}.before-`
        const old = (await readdir(dir).catch(() => [] as string[])).filter(n => n.startsWith(stem))
        if (old.length) notCovered.push(`${old.length} pre-migration database copies beside the database (${old.join(', ')})`)
      }
    } else {
      database = { dialect: runtime.db.dialect, note: 'PostgreSQL (DATABASE_URL): its own managed backups cover it; not in this archive' }
      notCovered.push('the PostgreSQL database (its own managed backups cover it)')
    }

    const rows: string[][] = [['key', 'bytes', 'in_this_archive']]
    const named = await runtime.db.query<{ storage_key: string; bytes: number }>('SELECT storage_key, bytes FROM assets')
    let onDisk = 0, included = 0, includedBytes = 0, skipped = 0, elsewhere = 0, missing = 0
    if (runtime.storage.name === 'local') {
      const keys = await runtime.storage.list('')
      const items: { key: string; path: string; bytes: number }[] = []
      for (const key of keys) {
        const path = runtime.storage.localPath(key)
        if (!path) continue
        try {
          items.push({ key, path, bytes: (await stat(path)).size })
        } catch {
          // gone between the listing and the look: nothing to carry
        }
      }
      onDisk = items.length
      items.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
      let budget = cap - zip.bytes - OVERHEAD
      for (const item of items) {
        if (item.bytes > budget || zip.count >= MAX_ZIP_ENTRIES - 3) {
          rows.push([`files/${item.key}`, String(item.bytes), 'no - over the archive size cap'])
          skipped += 1
          continue
        }
        await zip.addFile(`files/${item.key}`, item.path, !STORED.has(extname(item.key).toLowerCase()))
        budget -= item.bytes
        included += 1
        includedBytes += item.bytes
        rows.push([`files/${item.key}`, String(item.bytes), 'yes'])
      }
      const present = new Set(keys)
      for (const asset of named) {
        if (!present.has(asset.storage_key)) {
          rows.push([asset.storage_key, String(asset.bytes ?? ''), 'no - named in the database but not in storage'])
          missing += 1
        }
      }
    } else {
      for (const asset of named) {
        rows.push([asset.storage_key, String(asset.bytes ?? ''), 'no - already in object storage (S3)'])
        elsewhere += 1
      }
      notCovered.push('stored files: they are in the S3 bucket, which is their copy (named in FILES.csv)')
    }
    await zip.addBuffer('FILES.csv', Buffer.from(rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n', 'utf8'))
    const summary: BackupSummary = {
      suite: 'motion',
      made_at: new Date().toISOString(),
      database,
      files: {
        storage: runtime.storage.name, on_disk: onDisk, included, included_bytes: includedBytes,
        skipped_over_cap: skipped, in_object_storage: elsewhere, named_but_missing: missing,
      },
      cap_bytes: cap,
      not_covered: notCovered,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    }
    await zip.addBuffer('MANIFEST.json', Buffer.from(JSON.stringify(summary, null, 2), 'utf8'))
    await zip.close()
    summary.zip_bytes = (await stat(zipPath)).size
    return { zipPath, summary }
  } catch (error) {
    await zip.abandon()
    throw error
  }
}

export async function registerBackupExport(app: FastifyInstance, runtime: Runtime): Promise<void> {
  let busy = false
  const refuse = (reply: FastifyReply, status: number, error: string, message?: string) =>
    reply.code(status).header('cache-control', 'no-store').send({ ok: false, error, ...(message ? { message } : {}) })

  app.get(BACKUP_EXPORT_PATH, async (_request, reply) => refuse(reply, 403, 'post_only'))

  app.post(BACKUP_EXPORT_PATH, {
    bodyLimit: 64 * 1024,
    errorHandler(error, _request, reply) {
      return refuse(reply, error.statusCode === 413 ? 413 : 403, error.statusCode === 413 ? 'too_large' : 'malformed')
    },
  }, async (request, reply) => {
    const secret = backupSecret(runtime.config.NODE_ENV === 'production')
    if (!secret) return refuse(reply, 403, 'not_configured')
    let asked
    try {
      asked = verifySuiteBackup((request.body as { token?: unknown } | null)?.token, secret)
    } catch (e) {
      return refuse(reply, 403, e instanceof BackupRejected ? e.reason : 'bad signature')
    }
    if (busy) return refuse(reply, 409, 'busy', 'a backup export is already running')
    // Kept with the wipe receipts (hashed, account-independent), under their own
    // prefix, so the same request cannot be sent twice, even after a restart.
    const nonce = createHash('sha256').update(`backup:${asked.nonce}`).digest('hex')
    const receipt = await runtime.db.run(
      'INSERT INTO suite_wipe_receipts (nonce_hash, used_at) VALUES (?, ?) ON CONFLICT (nonce_hash) DO NOTHING',
      [nonce, new Date().toISOString()],
    )
    if (!receipt.changes) return refuse(reply, 403, 'replayed')

    busy = true
    const work = await mkdtemp(join(tmpdir(), 'motion-backup-'))
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      busy = false
      void rm(work, { recursive: true, force: true })
    }
    let built
    try {
      built = await buildBackup(runtime, work)
    } catch (error) {
      cleanup()
      if (error instanceof BackupTooLarge) {
        runtime.logger.warn('backup.export.too_large', { message: error.message })
        return refuse(reply, 413, 'too_large', error.message)
      }
      runtime.logger.error('backup.export.failed', { err: error })
      return refuse(reply, 500, 'failed')
    }
    const { zipPath, summary } = built
    const stamp = summary.made_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    const stream = createReadStream(zipPath)
    stream.once('close', cleanup)
    // A reply that never starts must not hold the lock or the disk forever.
    setTimeout(cleanup, 30 * 60 * 1000).unref()
    runtime.logger.info('backup.export', {
      bytes: summary.zip_bytes, files: summary.files.included, skipped: summary.files.skipped_over_cap, seconds: summary.seconds,
    })
    return reply
      .code(200)
      .header('content-type', 'application/zip')
      .header('content-length', String(summary.zip_bytes))
      .header('content-disposition', `attachment; filename="motion-${stamp}.zip"`)
      .header('cache-control', 'no-store')
      .header('x-backup-db-bytes', String(summary.database.bytes ?? 0))
      .header('x-backup-files', String(summary.files.included))
      .header('x-backup-files-skipped', String(summary.files.skipped_over_cap))
      .header('x-backup-files-elsewhere', String(summary.files.in_object_storage))
      .header('x-backup-seconds', String(summary.seconds))
      .send(stream)
  })
}
