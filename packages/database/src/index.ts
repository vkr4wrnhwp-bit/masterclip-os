import { loadConfig, type AppConfig } from '@masterclip/shared'
import type { Db } from './driver.js'
import { SqliteDb } from './sqlite.js'
import { PostgresDb } from './postgres.js'
import { runMigrations } from './migrate.js'

export * from './driver.js'
export * from './sql.js'
export { runMigrations, migrationStatus } from './migrate.js'
export { MIGRATIONS } from './migrations.js'
export type { Migration } from './migrations.js'
export { SqliteDb } from './sqlite.js'
export { PostgresDb } from './postgres.js'

export interface CreateDbOptions {
  driver?: 'sqlite' | 'postgres'
  sqlitePath?: string
  databaseUrl?: string
  migrate?: boolean
}

/**
 * Resolves the configured driver. SQLite is the default so `pnpm dev` works on
 * a clean machine; set DB_DRIVER=postgres + DATABASE_URL (or run
 * `pnpm docker:up`) to use PostgreSQL.
 */
export async function createDb(opts: CreateDbOptions = {}, config: AppConfig = loadConfig()): Promise<Db> {
  const driver = opts.driver ?? config.DB_DRIVER
  let db: Db
  if (driver === 'postgres') {
    const url = opts.databaseUrl ?? config.DATABASE_URL
    if (!url) throw new Error('DB_DRIVER=postgres requires DATABASE_URL')
    db = new PostgresDb(url)
  } else {
    db = new SqliteDb(opts.sqlitePath ?? config.SQLITE_PATH)
  }
  if (opts.migrate !== false) await runMigrations(db)
  return db
}

/** In-memory database with the schema applied. Used by unit and integration tests. */
export async function createTestDb(): Promise<Db> {
  const db = new SqliteDb(':memory:')
  await runMigrations(db)
  return db
}
