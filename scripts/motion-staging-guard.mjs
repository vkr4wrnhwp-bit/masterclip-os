/**
 * Read-only guard for destructive staging exercise scripts.
 * No database connection, secrets printing, subprocesses or deployment.
 * A pass is only a prerequisite, never authorization to run a crash drill.
 */
import { pathIsAbsolute, normalizePath } from './motion-staging-paths.mjs'

export function inspectStagingEnvironment(config) {
  const errors = []
  const stage = String(config.MOTION_ENVIRONMENT ?? '').toLowerCase()
  const confirmation = String(config.MOTION_ISOLATED_STAGING_ACK ?? '')
  const database = String(config.DATABASE_URL ?? '')
  const disk = String(config.SQLITE_PATH ?? '')
  const storage = String(config.STORAGE_LOCAL_ROOT ?? '')
  const branch = String(config.MOTION_GIT_BRANCH ?? '')
  if (stage !== 'isolated-staging') errors.push('MOTION_ENVIRONMENT must be isolated-staging')
  if (confirmation !== 'I_CONFIRM_DISPOSABLE_TEST_DATA') errors.push('Explicit disposable-data acknowledgement required')
  if (!branch || branch === 'motion-live' || branch === 'main' || branch === 'master') errors.push('Unsafe or unspecified branch')
  if (config.DB_DRIVER !== 'postgres' && config.DB_DRIVER !== 'sqlite') errors.push('Explicit DB_DRIVER required')
  if (config.DB_DRIVER === 'postgres') {
    if (!database || !/^postgres(?:ql)?:\/\//i.test(database)) errors.push('Explicit staging Postgres URL required')
    // No text of the URL or credentials is ever reported.
    else {
      try {
        const host = new URL(database).hostname.toLowerCase()
        if (!host || host.includes('production') || host.includes('prod.') ||
            host.includes('live.') || host === 'localhost' || host === '127.0.0.1') {
          errors.push('Database host must be an independently verified isolated staging host')
        }
      } catch { errors.push('Invalid Postgres connection URL') }
    }
  }
  if (config.DB_DRIVER === 'sqlite' && (!pathIsAbsolute(disk) || !normalizePath(disk).includes('isolated-staging'))) {
    errors.push('SQLite path must be an absolute isolated-staging path')
  }
  if (!pathIsAbsolute(storage) || !normalizePath(storage).includes('isolated-staging') ||
      normalizePath(storage).startsWith('/var/data')) {
    errors.push('Storage must be under an absolute isolated-staging path, never the live persistent disk')
  }
  if (config.PROVIDER_SPENDING_ENABLED === 'true' || config.MASTERCLIP_MODE === 'live') {
    errors.push('Provider spending and live operation must be disabled')
  }
  return { ok: errors.length === 0, errors,
    note:'Passing this configuration guard does not prove isolation or authorize deployment or destructive tests.' }
}

if (process.argv[1]?.endsWith('motion-staging-guard.mjs')) {
  const result = inspectStagingEnvironment(process.env)
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!result.ok) process.exitCode = 1
}
