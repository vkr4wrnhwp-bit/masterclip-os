import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Browser walkthrough of the operator's actual path: sign up → create a project
 * → build a shot → price a matrix → submit → watch the queue → review.
 *
 * One browser context is shared across the file, because the flow is one
 * session: a review grid with nothing to review proves nothing, and re-signing
 * in between steps would test the login form rather than the product.
 */
// Shared with the other spec files: signup closes behind the first account,
// so whichever file runs first bootstraps and the rest sign in with these.
import { E2E_EMAIL as EMAIL, E2E_PASSWORD as PASSWORD } from './credentials.js'

let context: BrowserContext
let page: Page
let projectId = ''
let shotId = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

test('the first account bootstraps the organization', async () => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  await page.getByRole('button', { name: 'First run? Create the org' }).click()
  await page.getByLabel('Your name').fill('E2E Producer')
  await page.getByLabel('Organization').fill('E2E Studio')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel(/^Password/).fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  // The spend posture is visible before anything can be clicked.
  await expect(page.getByText(/SANDBOX MODE/)).toBeVisible()
})

test('provider health and the model catalog are visible', async () => {
  await page.goto('/#/providers')
  await expect(page.getByRole('heading', { name: 'Providers & models' })).toBeVisible()
  await expect(page.getByText('Mock (local ffmpeg sandbox)')).toBeVisible()
  // Unconfigured real providers stay listed as unconfigured rather than hidden.
  await expect(page.getByText('MuAPI').first()).toBeVisible()
  await expect(page.getByText('mock-standard').first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Routing profiles' })).toBeVisible()
})

test('a project and a shot can be created', async () => {
  await page.goto('/#/')
  await page.getByPlaceholder('Neon Rain — single').fill('E2E Project')
  await page.getByRole('button', { name: 'Create project' }).click()

  await expect(page.getByRole('heading', { name: 'E2E Project' })).toBeVisible()
  projectId = page.url().split('/project/')[1] ?? ''
  expect(projectId).toBeTruthy()

  await page.getByRole('button', { name: 'New shot' }).click()
  await expect(page.getByRole('button', { name: 'Save version' })).toBeVisible()
  shotId = (page.url().split('/shot/')[1] ?? '').split('?')[0] ?? ''
  expect(shotId).toBeTruthy()
})

test('the shot builder validates and explains its routing before any spend', async () => {
  await page.goto(`/#/shot/${shotId}`)
  await expect(page.getByRole('button', { name: 'Save version' })).toBeVisible()

  await page.getByLabel('Title').fill('E2E hero shot')
  await page.getByLabel('Duration (s)').fill('4')
  await page.getByLabel('Resolution').selectOption('480p')
  await page.getByRole('button', { name: 'Validate' }).click()
  await page.getByRole('button', { name: 'Save version' }).click()

  // Routing explains itself, including when it is running on priors.
  await expect(page.getByText(/expected \$|price requires a live quote|No model satisfies/).first()).toBeVisible({ timeout: 30_000 })
})

test('the candidate matrix prices the batch before it can be submitted', async () => {
  await page.goto(`/#/shot/${shotId}`)
  await expect(page.locator('select[multiple]')).toBeVisible({ timeout: 20_000 })

  await page.locator('select[multiple]').selectOption(['mock|mock-standard'])
  await page.getByLabel('Seeds / variations per model').fill('3')
  await page.getByRole('button', { name: 'Price this matrix' }).click()

  await expect(page.getByText('candidates', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('estimated total')).toBeVisible()

  await page.getByRole('button', { name: /Submit \d+ renders/ }).click()
  await expect(page.getByText(/queued \d+ render/)).toBeVisible({ timeout: 40_000 })
})

test('the queue reports jobs, their state and their cost', async () => {
  await page.goto(`/#/queue/${projectId}`)
  await expect(page.getByRole('heading', { name: 'Render queue' })).toBeVisible()
  await expect(page.locator('td').filter({ hasText: 'mock/mock-standard' }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('sandbox').first()).toBeVisible()
})

test('a failed poll does not blank the queue that is already on screen', async () => {
  await page.goto(`/#/queue/${projectId}`)
  const row = page.locator('td').filter({ hasText: 'mock/mock-standard' }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })

  // Fail every subsequent queue poll the way a restart, a blip or a rate limit
  // would. Losing the table you were reading because one request out of many
  // failed is worse than reading figures a few seconds stale.
  await page.route('**/api/projects/*/queue', (route) => route.fulfill({
    status: 429,
    contentType: 'application/json',
    body: JSON.stringify({ error: { kind: 'rate_limited', code: 'rate_limited', message: 'too many requests — retry in 4s' } }),
  }))

  await expect(page.getByText('Showing the last good data')).toBeVisible({ timeout: 30_000 })
  // The point of the fix: the data is still there underneath the warning.
  await expect(row).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Render queue' })).toBeVisible()

  await page.unroute('**/api/projects/*/queue')
})

test('the cost lab reports no-data honestly before anything is approved', async () => {
  await page.goto(`/#/costs/${projectId}`)
  await expect(page.getByRole('heading', { name: 'Cost lab' })).toBeVisible()
  await expect(page.getByText('cost per APPROVED second').first()).toBeVisible()
  // With nothing approved yet, a cost-per-approved-second figure would be a lie.
  await expect(page.getByText('no data yet').first()).toBeVisible()
})

test('the strategy simulator compares draft-first against premium-only', async () => {
  await page.goto(`/#/costs/${projectId}`)
  await page.getByRole('button', { name: 'Compare' }).click()
  await expect(page.getByText('draft-first total')).toBeVisible()
  await expect(page.getByText('premium-only total')).toBeVisible()
  await expect(page.getByText(/Assumptions, not measurements/)).toBeVisible()
})

test('the review grid offers synchronised transport controls', async () => {
  await page.goto(`/#/shot/${shotId}/review`)
  await expect(page.getByRole('heading', { name: /^Review/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Play all' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'frame ▶' })).toBeVisible()
})

test('masters states plainly what a delivery is and is not', async () => {
  await page.goto(`/#/masters/${projectId}`)
  await expect(page.getByRole('heading', { name: 'Masters' })).toBeVisible()
  await expect(page.getByText(/No AI upscaling|container and codec conversions/).first()).toBeVisible()
})

// ---------------------------------------------------------------- Live Lab --

test('live lab is in the nav for the entitled org and builds a set', async () => {
  await expect(page.getByRole('link', { name: 'Live Lab' })).toBeVisible()
  await page.goto('/#/live-lab')
  await expect(page.getByRole('heading', { name: 'Live Lab' })).toBeVisible()

  await page.getByRole('button', { name: 'Start from blank set' }).click()
  await page.getByLabel('Set name').fill('E2E Tour Set')
  await page.getByRole('button', { name: 'Create live set' }).click()

  // The workspace: transport, pad grid, setlist.
  await expect(page.getByRole('heading', { name: 'E2E Tour Set' })).toBeVisible()
  await expect(page.getByText('Pad grid')).toBeVisible()
  await expect(page.locator('.pad')).toHaveCount(16)

  // Build the setlist.
  await page.getByLabel('Add item').fill('OPENING')
  await page.getByRole('button', { name: 'Add to set' }).click()
  await expect(page.locator('ol.setlist li')).toHaveCount(1)
  await expect(page.locator('ol.setlist').getByText('OPENING')).toBeVisible()

  // Add a scene to the selected song.
  await page.getByLabel('New scene').fill('DROP')
  await page.getByRole('button', { name: 'Add scene' }).click()
  await expect(page.locator('.scene-row')).toHaveCount(1)
})

test('MIDI Learn maps a control from the mock controller', async () => {
  // Still inside the live project from the previous test.
  await page.getByRole('button', { name: 'MIDI', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^MIDI —/ })).toBeVisible()

  await page.getByRole('button', { name: 'Use mock controller' }).click()
  // Scoped to the Devices card: the controller's name also appears in the
  // keyboard-zone mapper's device picker.
  const devicesCard = page.locator('.card').filter({ hasText: 'Devices' }).first()
  await expect(devicesCard.getByText('Live Lab Mock Controller')).toBeVisible()

  await page.getByRole('button', { name: 'Learn', exact: true }).click()
  await expect(page.getByText('Waiting for MIDI input…')).toBeVisible()

  // Touch a hardware control (the mock sends real MIDI bytes).
  await page.getByRole('button', { name: 'C2', exact: true }).click()
  await expect(page.getByText('Mapped.')).toBeVisible()

  // The mapping persists into the table.
  await expect(page.locator('table').filter({ hasText: 'Device' }).getByText('mock-controller')).toBeVisible()
})

test('Learn refuses a target-less mapping instead of storing a dead one', async () => {
  // A scene/stem mapping with no target saved happily, said "Mapped." and could
  // never fire. Selecting a target type that needs one, with none chosen,
  // must disable Learn rather than persist it.
  await page.getByLabel('Target').selectOption('stem_mute')
  const learn = page.getByRole('button', { name: 'Learn', exact: true })
  await expect(learn).toBeDisabled()

  // A target that stands alone needs nothing, and stays available.
  await page.getByLabel('Target').selectOption('stop')
  await expect(learn).toBeEnabled()
})

test('performance mode shows the stage surface with lock and emergency stop', async () => {
  await page.getByRole('button', { name: 'Back to workspace' }).click()
  await page.getByRole('button', { name: /Performance Mode/ }).click()
  await expect(page.getByRole('button', { name: /EMERGENCY STOP/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'LOCK PERFORMANCE' })).toBeVisible()
  await expect(page.locator('.pad')).toHaveCount(16)

  // Locking blocks the exit until unlocked.
  await page.getByRole('button', { name: 'LOCK PERFORMANCE' }).click()
  await expect(page.getByRole('button', { name: 'Exit' })).toBeDisabled()
  await page.getByRole('button', { name: /LOCKED/ }).click()
  await expect(page.getByRole('button', { name: 'Exit' })).toBeEnabled()
})
