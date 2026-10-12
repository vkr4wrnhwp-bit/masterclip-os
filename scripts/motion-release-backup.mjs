/**
 * Release rollback safety: verified, consistent SQLite snapshot BEFORE seed,
 * workers and API create the runtime and apply migrations. No public route.
 *
 * The backup stays on Render's attached disk; an independent off-disk copy
 * remains a separate operational release gate. Never claim this protects
 * against losing the entire disk.
 */
import { DatabaseSync, backup } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const RELEASE_ID = 'motion-native-20261012'
const expectedTables = ['schema_migrations', 'orgs', 'users', 'projects', 'assets']
function inside(root, target) {
  const rel = relative(root, target)
  return rel.length > 0 && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function dbCounts(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  const names = new Set(tables.map(row => row.name))
  for (const name of expectedTables) {
    if (!names.has(name)) throw new Error('release database is missing an expected table')
  }
  const counts = {}
  for (const name of expectedTables) {
    counts[name] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + name).get().n)
  }
  return counts
}
function integrity(db) {
  const result = db.prepare('PRAGMA integrity_check').get()
  if (result?.integrity_check !== 'ok') throw new Error('release database failed integrity_check')
}

/**
 * An existing verified release snapshot is reused, never overwritten.
 * A missing/misconfigured database or storage root aborts startup before
 * migrations or seed, preserving the pre-deploy state for a code rollback.
 */
export async function verifyPreMigrationBackup(env, options = {}) {
  if (env.NODE_ENV !== 'production') return { skipped: true }
  const mountPath = options.mountPath ?? '/var/data'
  const releaseId = options.releaseId ?? RELEASE_ID
  if (!/^[a-z0-9-]+$/.test(releaseId)) throw new Error('invalid release snapshot identifier')
  if ((env.DB_DRIVER ?? 'sqlite') !== 'sqlite' || (env.STORAGE_DRIVER ?? 'local') !== 'local') {
    throw new Error('production release requires a separately verified external database/media backup')
  }
  const dbPath = env.SQLITE_PATH ?? 'var/masterclip.sqlite'
  const storagePath = env.STORAGE_LOCAL_ROOT ?? 'var/storage'
  if (!isAbsolute(dbPath) || !isAbsolute(storagePath) || !existsSync(dbPath) || !existsSync(storagePath)) {
    throw new Error('SQLite and media must already exist on the persistent disk, using absolute paths')
  }
  const [mount, database, media] = await Promise.all([
    realpath(mountPath),realpath(dbPath),realpath(storagePath),
  ])
  if (!inside(mount,database) || !inside(mount,media)) {
    throw new Error('SQLite and media must both be on the attached persistent disk')
  }
  const parent = join(mount,'motion-release-rollback')
  await mkdir(parent,{recursive:true,mode:0o700})
  const directory = join(parent,releaseId)
  await mkdir(directory,{recursive:true,mode:0o700})
  const destination = join(directory,'pre-migration.sqlite')
  const manifestPath = join(directory,'verified.json')
  if (existsSync(manifestPath)) {
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
    if (manifest.releaseId !== releaseId || !existsSync(destination) ||
        await sha256File(destination) !== manifest.sha256) {
      throw new Error('previous release backup is missing or changed')
    }
    const saved = new DatabaseSync(destination,{readOnly:true})
    try { integrity(saved); if(JSON.stringify(dbCounts(saved)) !== JSON.stringify(manifest.counts))
      throw new Error('existing backup record counts changed') }
    finally { saved.close() }
    return {verified:true,existing:true,releaseId,databaseFilename:basename(dbPath),
      backupPath:destination,sha256:manifest.sha256}
  }
  if (existsSync(destination)) throw new Error('unverified backup exists: refusing overwrite')
  const sourceStats=await stat(database)
  const space=await statfs(directory)
  const available=Number(space.bavail)*Number(space.bsize)
  if (available < sourceStats.size*1.2 + 32*1024*1024) {
    throw new Error('insufficient free space for verified pre-migration backup')
  }
  const original = new DatabaseSync(database,{readOnly:true})
  const staging = join(directory,'pending-snapshot.sqlite')
  try {
    integrity(original)
    const originalCounts=dbCounts(original)
    await backup(original,staging)
    const saved = new DatabaseSync(staging,{readOnly:true})
    try {
      integrity(saved)
      if(JSON.stringify(dbCounts(saved)) !== JSON.stringify(originalCounts)) {
        throw new Error('backup verification failed: record counts differ')
      }
    } finally { saved.close() }
    const digest=await sha256File(staging)
    await rename(staging,destination)
    await writeFile(manifestPath,JSON.stringify({
      releaseId,sha256:digest,counts:originalCounts,
      createdAt:new Date().toISOString(),databaseFile:basename(database),
      scope:'SQLite only; media files are not independently backed up by this snapshot',
    },null,2),{mode:0o600,flag:'wx'})
    return {verified:true,existing:false,releaseId,databaseFilename:basename(dbPath),
      backupPath:destination,sha256:digest}
  } finally {
    original.close()
    await rm(staging,{force:true})
  }
}
