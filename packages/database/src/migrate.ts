import type { Db } from './driver.js'
import { MIGRATIONS, type Migration } from './migrations.js'

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

/**
 * Forward-only migrations, recorded by id. Each migration runs inside a
 * transaction so a half-applied schema is never left behind.
 */
export async function runMigrations(db: Db, migrations: Migration[] = MIGRATIONS): Promise<MigrationResult> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  )`)

  const rows = await db.query<{ id: string }>('SELECT id FROM schema_migrations')
  const done = new Set(rows.map((r) => r.id))
  const applied: string[] = []
  const skipped: string[] = []

  for (const migration of migrations) {
    if (done.has(migration.id)) {
      skipped.push(migration.id)
      continue
    }
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql)
      await tx.run('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        new Date().toISOString(),
      ])
    })
    applied.push(migration.id)
  }

  return { applied, skipped }
}

export async function migrationStatus(db: Db): Promise<{ id: string; applied: boolean }[]> {
  const exists = await db
    .query<{ id: string }>('SELECT id FROM schema_migrations')
    .catch(() => [] as { id: string }[])
  const done = new Set(exists.map((r) => r.id))
  return MIGRATIONS.map((m) => ({ id: m.id, applied: done.has(m.id) }))
}
