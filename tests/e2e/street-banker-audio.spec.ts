import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { ensureSignedIn } from './credentials.js'

/**
 * Browser walkthrough of Street Banker Audio Intelligence.
 *
 * The e2e server runs the API without a worker, so these tests exercise the
 * synchronous surface: gates, consent enforcement, the operator conversation
 * (which is served entirely server-side), brief script generation, and the
 * honest "queued, not done" states the UI must show while jobs wait.
 */

let context: BrowserContext
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
  await ensureSignedIn(page)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})

test.afterAll(async () => {
  await context.close()
})

/** A minimal valid RIFF/WAVE file, built in-memory for uploads. */
function wavFixture(): Buffer {
  const samples = 2000
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(22050, 24)
  buffer.writeUInt32LE(44100, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / 6) * 9000), 44 + i * 2)
  return buffer
}

test('the audio intelligence hub lists every workspace', async () => {
  await page.goto('/#/audio')
  await expect(page.getByRole('heading', { name: 'Audio Intelligence' })).toBeVisible()
  await expect(page.getByText('Meeting Intelligence — calls and voice notes into structured drafts')).toBeVisible()
  await expect(page.getByText('Artist Voice Vault — verified, revocable voice permissions')).toBeVisible()
})

test('a meeting upload is refused without the consent acknowledgment', async () => {
  await page.goto('/#/audio/meetings')
  await expect(page.getByRole('heading', { name: 'Meeting Intelligence' })).toBeVisible()
  await page.getByLabel('Title').fill('Consentless upload')
  await page.getByLabel(/Recording/).setInputFiles({ name: 'call.wav', mimeType: 'audio/wav', buffer: wavFixture() })
  await page.getByRole('button', { name: 'Upload & transcribe' }).click()
  await expect(page.getByText(/authorization must be acknowledged/i)).toBeVisible()
})

test('a consented upload lands in the honest transcribing state', async () => {
  await page.goto('/#/audio/meetings')
  await page.getByLabel('Title').fill('A&R call — E2E Artist')
  await page.getByLabel(/Recording/).setInputFiles({ name: 'call.wav', mimeType: 'audio/wav', buffer: wavFixture() })
  await page.getByText(/I confirm I am authorized to upload/).click()
  await page.getByRole('button', { name: 'Upload & transcribe' }).click()
  // Navigates to the meeting detail; with no worker running the state shown
  // is the queued truth, not a pretend completion.
  await expect(page.getByRole('heading', { name: 'A&R call — E2E Artist' })).toBeVisible()
  await expect(page.getByText('transcribing')).toBeVisible()
  await expect(page.getByText('Transcript not ready yet.')).toBeVisible()
})

test('a signal brief preserves confidence language in the generated script', async () => {
  await page.goto('/#/audio/briefs')
  await expect(page.getByRole('heading', { name: 'Signal Audio Briefs' })).toBeVisible()
  await page.getByLabel('Title').fill('Rights health — e2e')
  await page.locator('select').first().selectOption('rights_health')
  await page.getByPlaceholder('What happened').fill('Two tracks still carry an unresolved distributor claim.')
  await page.locator('.field select').last().selectOption('needs_verification')
  await page.getByRole('button', { name: 'Generate & render audio' }).click()
  await expect(page.getByText(/Needs verification: Two tracks/)).toBeVisible()
})

test('the operator agent discloses itself and refuses to promise outcomes', async () => {
  await page.goto('/#/audio/operator')
  await page.getByRole('button', { name: 'create defaults' }).click()
  await expect(page.getByText('intake orchestrator')).toBeVisible()
  await page.getByRole('button', { name: 'activate' }).first().click()
  await page.getByRole('button', { name: 'test conversation' }).click()

  await expect(page.getByText(/AI-powered Street Banker assistant/)).toBeVisible()
  const input = page.getByPlaceholder('Say something…')
  await input.fill('Can you guarantee me playlist placement and promise funding?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/decisions about deals, approvals, and outcomes are made by/i)).toBeVisible()
})

test('the operator agent hands over to a human on request', async () => {
  const input = page.getByPlaceholder('Say something…')
  await input.fill('I want to speak to a human please')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(/Let me get you to a Street Banker operator/)).toBeVisible()
  await expect(page.getByText('Conversation ended — it has been classified and routed to Operator Desk.')).toBeVisible()
})

test('remix lab requires both rights confirmations before accepting audio', async () => {
  await page.goto('/#/audio/remix')
  await expect(page.getByRole('heading', { name: 'Remix Lab — Audio Engine' })).toBeVisible()
  await page.getByPlaceholder('Title track — versions').fill('E2E title track')
  await page.getByLabel(/Source audio/).setInputFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: wavFixture() })
  // Only the ownership box checked — the no-imitation acknowledgment is
  // independently required.
  await page.getByText(/I confirm that I own or control the audio/).click()
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByText(/you must acknowledge/i)).toBeVisible()

  await page.getByText(/I understand that Remix Lab will not imitate/).click()
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('button', { name: 'separate stems' })).toBeVisible()
})

test('audio settings show the data policy and record keyterms', async () => {
  await page.goto('/#/audio/settings')
  await expect(page.getByRole('heading', { name: 'Audio settings' })).toBeVisible()
  await expect(page.getByText('Require zero-retention processing')).toBeVisible()
  await page.getByPlaceholder('Artist, label, venue, ISRC…').fill('E2E Artist')
  await page.getByRole('button', { name: 'add', exact: true }).click()
  await expect(page.getByText('E2E Artist', { exact: true })).toBeVisible()
})

// Grant/revoke against a partner org is covered in the integration suite —
// the e2e database has only the bootstrap (flagship) org, so what the browser
// can honestly assert is the flagship presentation and budget editing.
test('partner entitlements console shows flagship access and edits budgets', async () => {
  await page.goto('/#/audio/admin')
  await expect(page.getByRole('heading', { name: 'Partner OS — audio entitlements' })).toBeVisible()

  // The bootstrap org is the flagship: implicit access, no grant rows, and the
  // console must say so rather than showing it as unentitled.
  await expect(page.getByText('flagship').first()).toBeVisible()
  await expect(page.getByText('Holds every audio capability implicitly')).toBeVisible()
  await expect(page.getByText('implicit').first()).toBeVisible()

  // Budgets are settable for the selected org and read back.
  await page.getByLabel('Monthly cap (USD)').fill('250')
  await page.getByRole('button', { name: 'save budget' }).click()
  await expect(page.getByText('budget saved')).toBeVisible()
  await expect(page.getByText('$250.00/mo')).toBeVisible()
  await expect(page.getByText('hard stop').first()).toBeVisible()
})
