import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, SqliteDb, migrationStatus, runMigrations } from '@masterclip/database'

/**
 * Upgrade drill on a disposable on-disk SQLite database — NEVER on a live
 * or mounted customer database. This checks a real persisted pre-feature
 * schema, forward-only upgrades, untouched customer-sentinel rows and restart.
 */
describe('MOTION disposable staging migration preflight', () => {
  it('upgrades legacy tables through every stacked MOTION migration without losing existing data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motion-staging-upgrade-'))
    const path = join(root, 'isolated.db')
    let db: SqliteDb | null = null
    try {
      db = new SqliteDb(path)
      const baseMigrations = MIGRATIONS.filter(m =>
        ['0001_initial', '0002_agent_runs', '0003_street_banker_workspaces'].includes(m.id))
      expect(baseMigrations.map(m => m.id)).toEqual([
        '0001_initial', '0002_agent_runs', '0003_street_banker_workspaces',
      ])
      await runMigrations(db, baseMigrations)
      const orgId = 'migration-preflight-org'
      const sentinel = 'CUSTOMER-DATA-DO-NOT-ALTER'
      await db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)',
        [orgId, sentinel, '2026-01-01T00:00:00.000Z'])
      await db.close()
      db = new SqliteDb(path)
      const upgrade = await runMigrations(db)
      expect(upgrade.applied).toEqual([
        '0004_media_finish_leases', '0005_motion_music_timelines',
        '0006_motion_timeline_exports', '0007_motion_music_sections',
      ])
      const original = await db.get<{ name: string }>(
        'SELECT name FROM orgs WHERE id = ?', [orgId])
      expect(original?.name).toBe(sentinel)
      for (const table of [
        'media_finish_leases', 'motion_music_timelines',
        'motion_timeline_exports', 'motion_music_sections',
      ]) {
        const row = await db.get<{name:string}>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
        expect(row?.name).toBe(table)
      }
      const repeated = await runMigrations(db)
      expect(repeated.applied).toEqual([])
      expect((await migrationStatus(db)).every(m=>m.applied)).toBe(true)
      await db.close()
      db = new SqliteDb(path)
      const persisted = await db.get<{ name:string }>(
        'SELECT name FROM orgs WHERE id = ?', [orgId])
      expect(persisted?.name).toBe(sentinel)
    } finally {
      await db?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
