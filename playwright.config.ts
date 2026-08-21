import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 4399)

/**
 * This sandbox ships a pinned Chromium whose build number will not always match
 * the @playwright/test release, and it cannot download the matching one. Point
 * at the pinned binary when it is really there; otherwise fall back to
 * Playwright's own resolution so the suite works on a normal machine after
 * `pnpm exec playwright install chromium`.
 */
const PINNED_CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const executablePath = existsSync(PINNED_CHROMIUM) ? PINNED_CHROMIUM : undefined

/**
 * Browser tests run against the real API serving the real production web build,
 * with a throwaway SQLite database and the mock provider — so the flow under
 * test is the flow that ships, and nothing is billable.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // Screenshot capture renders a real batch through ffmpeg; run it on demand
  // with `pnpm screenshots`, not as part of the default suite.
  testIgnore: process.env.CAPTURE_SCREENSHOTS ? [] : ['**/screenshots.spec.ts'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Without an explicit action timeout, a click on an element that never
    // appears blocks until the whole test times out with no useful message.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath },
      },
    },
  ],
  webServer: {
    command: `node scripts/e2e-server.mjs`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
})
