import pg from 'pg'
import type { Db, Row, SqlParam } from './driver.js'
import { normalizeParams, toPositional } from './driver.js'

// Micro-USD ledger amounts live in BIGINT columns. node-postgres returns int8
// as a string by default to avoid precision loss; our magnitudes are far below
// 2^53 (that ceiling is ~$9e9 of spend), so parsing to number is exact and
// keeps the row shape identical to the SQLite driver's.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v))

class PgConnection implements Db {
  readonly dialect = 'postgres' as const
  constructor(private readonly client: pg.PoolClient | pg.Pool) {}

  async query<T = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const result = await this.client.query(toPositional(sql), normalizeParams(params))
    return result.rows as T[]
  }

  async get<T = Row>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params)
    return rows[0]
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    const result = await this.client.query(toPositional(sql), normalizeParams(params))
    return { changes: result.rowCount ?? 0 }
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql)
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Already inside a checked-out client and a BEGIN — join it.
    return fn(this)
  }

  async close(): Promise<void> {
    /* connection lifetime is owned by the pool */
  }
}

export class PostgresDb implements Db {
  readonly dialect = 'postgres' as const
  private readonly pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 })
  }

  async query<T = Row>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const result = await this.pool.query(toPositional(sql), normalizeParams(params))
    return result.rows as T[]
  }

  async get<T = Row>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params)
    return rows[0]
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    const result = await this.pool.query(toPositional(sql), normalizeParams(params))
    return { changes: result.rowCount ?? 0 }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql)
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(new PgConnection(client))
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* the transaction is already aborted; surface the original failure */
      }
      throw err
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
