import { mkdtemp, mkdir, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { verifyPreMigrationBackup } from '../scripts/motion-release-backup.mjs'

describe('MOTION pre-migration production rollback guard', () => {
  it('backs up a real existing SQLite DB, verifies integrity and preserves pre-migration rows', async () => {
    const disk = await mkdtemp(join(tmpdir(),'motion-deploy-backup-'))
    const sqlite = join(disk,'live.sqlite')
    const storage = join(disk,'uploaded-media')
    await mkdir(storage)
    const seed = new DatabaseSync(sqlite)
    try {
      seed.exec(`CREATE TABLE schema_migrations(id TEXT);
        CREATE TABLE orgs(id TEXT);
        CREATE TABLE users(id TEXT);
        CREATE TABLE projects(id TEXT);
        CREATE TABLE assets(id TEXT);`)
      seed.prepare('INSERT INTO orgs (id) VALUES (?)').run('ORIGINAL-CUSTOMER-ORG')
    } finally { seed.close() }
    const env = {NODE_ENV:'production',DB_DRIVER:'sqlite',STORAGE_DRIVER:'local',
      SQLITE_PATH:sqlite,STORAGE_LOCAL_ROOT:storage}
    try {
      const backup=await verifyPreMigrationBackup(env,{mountPath:disk,releaseId:'local-rehearsal'})
      expect(backup).toMatchObject({verified:true,existing:false,releaseId:'local-rehearsal'})
      const old=new DatabaseSync(backup.backupPath,{readOnly:true})
      try {
        expect(old.prepare('SELECT id FROM orgs').get().id).toBe('ORIGINAL-CUSTOMER-ORG')
        expect(old.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok')
      } finally {old.close()}
      const changed=new DatabaseSync(sqlite)
      changed.prepare('INSERT INTO orgs (id) VALUES (?)').run('AFTER-DEPLOY-CHANGE')
      changed.close()
      const again=await verifyPreMigrationBackup(env,{mountPath:disk,releaseId:'local-rehearsal'})
      expect(again).toMatchObject({verified:true,existing:true,sha256:backup.sha256})
      const saved=new DatabaseSync(again.backupPath,{readOnly:true})
      try {expect(saved.prepare('SELECT COUNT(*) AS n FROM orgs').get().n).toBe(1)}
      finally {saved.close()}
      const manifest=JSON.parse(await readFile(join(disk,'motion-release-rollback/local-rehearsal/verified.json'),'utf8'))
      expect(manifest.sha256).toBe(backup.sha256)
      expect((await stat(again.backupPath)).size).toBeGreaterThan(0)
    } finally {await rm(disk,{recursive:true,force:true})}
  },40_000)

  it('refuses missing database, off-disk storage and external driver before any app startup', async () => {
    const disk=await mkdtemp(join(tmpdir(),'motion-bad-deploy-'))
    const media=join(disk,'media')
    await mkdir(media)
    try{
      const base={NODE_ENV:'production',DB_DRIVER:'sqlite',STORAGE_DRIVER:'local',
        SQLITE_PATH:join(disk,'missing.sqlite'),STORAGE_LOCAL_ROOT:media}
      await expect(verifyPreMigrationBackup(base,{mountPath:disk})).rejects.toThrow(/must already exist/)
      await expect(verifyPreMigrationBackup({...base,DB_DRIVER:'postgres'},
        {mountPath:disk})).rejects.toThrow(/separately verified/)
      const noProd=await verifyPreMigrationBackup({...base,NODE_ENV:'test'},{mountPath:disk})
      expect(noProd).toEqual({skipped:true})
    } finally{await rm(disk,{recursive:true,force:true})}
  })
})
