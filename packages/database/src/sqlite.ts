import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import type { Db, Row, SqlParam } from './driver.js'
import { normalizeParams } from './driver.js'

// `node:sqlite` is newer than most bundlers' built-in module lists, so a static
// import gets rewritten and fails to resolve under Vite/vitest. Loading it
// through `createRequire` hands resolution back to Node in every runner —
// tsx, vitest, and the esbuild bundles alike. The type import above is
// erased at compile time and costs nothing.
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType }

/**
 * SQLite driver built on Node's built-in `node:sqlite`.
 *
 * This is the zero-setup default so the app runs from a clean checkout with no
 * services. The Postgres driver is the same interface and the same SQL; see
 * docs/architecture.md for which one to run where.
 */
export class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const
  private readonly db: DatabaseSyncType
  private inTransaction = false

  constructor(path: string) {
    const resolved = path === ':memory:' ? path : resolve(path)
    if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved)
    // WAL lets the API and the worker hold the same file open concurrently;
    // NORMAL sync is the standard WAL durability/throughput trade-off.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 10000')
  }

  async query<T = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...normalizeParams(params)) as T[]
  }

  async get<T = Row>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...normalizeParams(params)) as T | undefined
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...normalizeParams(params))
    return { changes: Number(result.changes ?? 0) }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Nested calls join the outer transaction. Financial writes are wrapped at
    // the use-case boundary, and a savepoint that silently rolls back part of a
    // ledger write would be worse than no nesting at all.
    if (this.inTransaction) return fn(this)
    this.db.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    try {
      const result = await fn(this)
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* rollback of an already-aborted transaction is not an error worth masking the cause with */
      }
      throw err
    } finally {
      this.inTransaction = false
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
