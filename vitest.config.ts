import { defineConfig, type Plugin } from 'vitest/config'

/**
 * `node:sqlite` is newer than Vite's built-in module list, so Vite tries to
 * bundle it and fails to resolve. Marking it external hands it back to Node.
 */
function externalizeNodeSqlite(): Plugin {
  return {
    name: 'externalize-node-sqlite',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'node:sqlite' || source === 'sqlite') return { id: 'node:sqlite', external: true }
      return null
    },
  }
}

export default defineConfig({
  plugins: [externalizeNodeSqlite()],
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    // Media-heavy tests shell out to ffmpeg; the default 5s is not enough.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    reporters: ['default'],
    env: {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      SQLITE_PATH: ':memory:',
      ASSET_SIGNING_SECRET: 'test-asset-signing-secret-value',
      SESSION_SECRET: 'test-session-secret-value',
      WEBHOOK_SECRET: 'test-webhook-secret-value',
    },
  },
})
