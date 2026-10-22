import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, SqliteDb, runMigrations } from '@masterclip/database'

describe('MOTION isolated staging backup and restore drill', () => {
  it('restores an offline snapshot after a migration and verifies no source loss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motion-backup-recovery-'))
    const originalPath = join(dir, 'staging-simulation.sqlite')
    const backupPath = join(dir, 'offline-backup.sqlite')
    const recoveredPath = join(dir, 'restored.sqlite')
    let original: SqliteDb | null = null
    let restored: SqliteDb | null = null
    try {
      original = new SqliteDb(originalPath)
      const legacy = MIGRATIONS.filter(m => ['0001_init','0002_agent_runs',
        '0003_street_banker_workspaces'].includes(m.id))
      await runMigrations(original, legacy)
      await original.run('INSERT INTO orgs(id,name,created_at) VALUES (?,?,?)',
        ['restore-org', 'MOTION ORIGINAL DATA', '2026-01-01T00:00:00.000Z'])
      // All connections are closed BEFORE copying: copying an open WAL-mode
      // SQLite file alone is not a safe database backup strategy.
      await original.close()
      original = null
      await copyFile(originalPath, backupPath)
      original = new SqliteDb(originalPath)
      await runMigrations(original)
      await original.run('UPDATE orgs SET name = ? WHERE id = ?',
        ['POST-BACKUP CHANGE', 'restore-org'])
      await original.close()
      original = null

      await copyFile(backupPath, recoveredPath)
      restored = new SqliteDb(recoveredPath)
      const sentinel = await restored.get<{name:string}>(
        'SELECT name FROM orgs WHERE id = ?', ['restore-org'])
      expect(sentinel?.name).toBe('MOTION ORIGINAL DATA')
      const upgraded = await runMigrations(restored)
      expect(upgraded.applied).toEqual([
        '0004_media_finish_leases','0005_motion_music_timelines',
        '0006_motion_timeline_exports','0007_motion_music_sections', '0008_session_street_banker_email',
        '0009_motion_credit_spends','0010_master_vault_delivery','0011_suite_wipe_receipts',
      ])
      const repeat = await runMigrations(restored)
      expect(repeat.applied).toEqual([])
      expect((await restored.get<{name:string}>(
        'SELECT name FROM orgs WHERE id = ?', ['restore-org']))?.name).toBe('MOTION ORIGINAL DATA')
    } finally {
      await restored?.close()
      await original?.close()
      await rm(dir, {recursive:true,force:true})
    }
  })
})
