import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, SqliteDb, runMigrations } from '@masterclip/database'

/**
 * Before a deploy's migrations change an existing database, MOTION keeps an
 * exact copy of it as it was, next to it on the same disk: the rollback point
 * for the release (live runs 0001-0003; this release brings 0004-0008).
 */
describe('migration backup', () => {
  it('copies an existing database before new migrations change it, once, and never a fresh one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motion-migration-backup-'))
    const path = join(dir, 'motion.sqlite')
    let db: SqliteDb | null = null
    try {
      // A fresh database: nothing to keep.
      db = new SqliteDb(path)
      await runMigrations(db, MIGRATIONS.filter((m) => ['0001_init', '0002_agent_runs', '0003_street_banker_workspaces'].includes(m.id)))
      expect((await readdir(dir)).filter((f) => f.includes('.before-'))).toEqual([])
      await db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', ['live-org', 'LIVE DATA', '2026-01-01T00:00:00.000Z'])

      // The release: 0004-0008 waiting. The copy is taken first.
      const upgrade = await runMigrations(db)
      expect(upgrade.applied[0]).toBe('0004_media_finish_leases')
      const copies = (await readdir(dir)).filter((f) => f.includes('.before-0004_media_finish_leases-'))
      expect(copies).toHaveLength(1)

      const copy = new SqliteDb(join(dir, copies[0]!))
      expect((await copy.get<{ name: string }>('SELECT name FROM orgs WHERE id = ?', ['live-org']))?.name).toBe('LIVE DATA')
      const ids = (await copy.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')).map((r) => r.id)
      expect(ids).toEqual(['0001_init', '0002_agent_runs', '0003_street_banker_workspaces'])
      await copy.close()

      // Nothing pending: no new copy on the next start.
      await runMigrations(db)
      expect((await readdir(dir)).filter((f) => f.includes('.before-'))).toHaveLength(1)
    } finally {
      await db?.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
