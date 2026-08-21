import { mkdir } from 'node:fs/promises'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Captures the major workflows against the running app.
 *
 * Run with `pnpm screenshots`. Kept out of the default e2e run because it
 * renders a real batch through the mock provider, which takes ffmpeg time.
 * Everything shown is genuine output from the pipeline — no mock-ups.
 */
const SHOTS = 'docs/screenshots'
const EMAIL = `shots-${Date.now()}@masterclip.test`
const PASSWORD = 'screenshot-password-1234'

let context: BrowserContext
let page: Page
let projectId = ''
let shotId = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  await mkdir(SHOTS, { recursive: true })
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

const shot = async (name: string) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
}

test('capture the operator workflow', async () => {
  test.setTimeout(600_000)

  // --- sign up -------------------------------------------------------------
  await page.goto('/')
  await page.getByRole('button', { name: 'First run? Create the org' }).click()
  await page.getByLabel('Your name').fill('Screenshot Producer')
  await page.getByLabel('Organization').fill('Summit Arts')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel(/^Password/).fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  // --- project -------------------------------------------------------------
  await page.getByPlaceholder('Neon Rain — single').fill('Neon Rain')
  await page
    .getByPlaceholder('')
    .nth(1)
    .fill('A late-night performance piece. One artist, one street, one neon sign. The camera is a witness, never a participant.')
    .catch(() => undefined)
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'Neon Rain' })).toBeVisible()
  projectId = page.url().split('/project/')[1] ?? ''

  await page.goto('/#/')
  await shot('01-dashboard')

  // --- providers -----------------------------------------------------------
  await page.goto('/#/providers')
  await expect(page.getByRole('heading', { name: 'Providers & models' })).toBeVisible()
  await shot('02-providers-and-models')

  // --- shot builder --------------------------------------------------------
  await page.goto(`/#/project/${projectId}`)
  await page.getByRole('button', { name: 'New shot' }).click()
  await expect(page.getByRole('button', { name: 'Save version' })).toBeVisible()
  shotId = (page.url().split('/shot/')[1] ?? '').split('?')[0] ?? ''

  await page.getByLabel('Title').fill('Nova under the sign')
  await page.getByLabel('Duration (s)').fill('4')
  await page.getByLabel('Resolution').selectOption('480p')
  await page.getByRole('button', { name: 'Save version' }).click()
  await page.waitForTimeout(1500)
  await shot('03-shot-builder')

  // --- matrix --------------------------------------------------------------
  await page.locator('select[multiple]').selectOption(['mock|mock-standard'])
  await page.getByLabel('Seeds / variations per model').fill('4')
  await page.getByRole('button', { name: 'Price this matrix' }).click()
  await expect(page.getByText('candidates', { exact: true })).toBeVisible({ timeout: 20_000 })
  await shot('04-candidate-matrix-priced')

  await page.getByRole('button', { name: /Submit \d+ renders/ }).click()
  await expect(page.getByText(/queued \d+ render/)).toBeVisible({ timeout: 40_000 })

  // --- queue ---------------------------------------------------------------
  await page.goto(`/#/queue/${projectId}`)
  await expect(page.getByRole('heading', { name: 'Render queue' })).toBeVisible()
  await page.waitForTimeout(2000)
  await shot('05-render-queue')

  // --- wait for the worker to finish the batch -----------------------------
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/shots/${shotId}/outputs`)
        const body = (await response.json()) as { outputs: unknown[] }
        return body.outputs.length
      },
      { timeout: 420_000, intervals: [4000] },
    )
    .toBeGreaterThan(0)

  // Give QC and derivative building a moment to land.
  await page.waitForTimeout(15_000)

  // --- review grid ---------------------------------------------------------
  await page.goto(`/#/shot/${shotId}/review`)
  await expect(page.getByRole('heading', { name: /^Review/ })).toBeVisible()
  await page.waitForTimeout(2500)
  await shot('06-review-grid')

  // Approve one candidate so the cost lab has an approved second to report.
  const approve = page.getByRole('button', { name: 'Approve' }).first()
  if (await approve.isVisible().catch(() => false)) {
    await approve.click()
    await page.waitForTimeout(1500)
  }

  // --- cost lab ------------------------------------------------------------
  await page.goto(`/#/costs/${projectId}`)
  await expect(page.getByRole('heading', { name: 'Cost lab' })).toBeVisible()
  await page.getByRole('button', { name: 'Compare' }).click()
  await page.waitForTimeout(1200)
  await shot('07-cost-lab')

  // --- masters -------------------------------------------------------------
  const promote = page.getByRole('button', { name: 'Promote' }).first()
  await page.goto(`/#/shot/${shotId}/review`)
  await page.waitForTimeout(1500)
  if (await promote.isVisible().catch(() => false)) {
    await promote.click().catch(() => undefined)
    await page.waitForTimeout(2000)
  }
  await page.goto(`/#/masters/${projectId}`)
  await expect(page.getByRole('heading', { name: 'Masters' })).toBeVisible()
  await page.waitForTimeout(1200)
  await shot('08-masters')
})
