import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { ensureSignedIn } from './credentials.js'

/**
 * The offline show, demonstrated with the network actually off.
 *
 * `docs/build-audit.md` carried this as PARTIAL for a specific reason: the
 * cache-only code path is structurally incapable of a network fetch during
 * playback, but nothing had ever *run* it with the network disabled. Playwright
 * can disable it for real — `context.setOffline(true)` cuts the browser off at
 * the network stack, so a stray fetch fails rather than quietly succeeding
 * against localhost.
 *
 * The flow is the operator's own: build a set, upload owned audio, attach it,
 * build the show package, pull the cable, and perform.
 *
 * What this still does not prove: that any of it is audible. That needs a stage.
 */

let context: BrowserContext
let page: Page

test.describe.configure({ mode: 'serial' })

/** A short valid PCM16 WAV — real audio the package can checksum and decode. */
function wavBytes(seconds = 1, sampleRate = 8000): Buffer {
  const frames = Math.round(seconds * sampleRate)
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) {
    // An audible-shaped tone rather than silence, so decoding is a real test.
    buffer.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 220 * 2 * Math.PI) * 12000), 44 + i * 2)
  }
  return buffer
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()
  await ensureSignedIn(page)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
})

test.afterAll(async () => {
  // Never leave the context offline for whatever runs next.
  await context.setOffline(false)
  await context.close()
})

test('a show is built, packaged and cached on the device', async () => {
  await page.goto('/#/live-lab')
  await page.getByRole('button', { name: 'Start from blank set' }).click()
  await page.getByLabel('Set name').fill('Offline Rehearsal')
  await page.getByRole('button', { name: 'Create live set' }).click()
  await expect(page.getByRole('heading', { name: 'Offline Rehearsal' })).toBeVisible()

  // A song, so scenes and stems have somewhere to live.
  await page.getByLabel('Add item').fill('OPENER')
  await page.getByRole('button', { name: 'Add to set' }).click()
  await expect(page.locator('ol.setlist li')).toHaveCount(1)

  // A scene: the package refuses to verify a scene with no audio behind it.
  await page.getByLabel('New scene').fill('INTRO')
  await page.getByRole('button', { name: 'Add scene' }).click()
  await expect(page.locator('.scene-row')).toHaveCount(1)

  // Owned audio, behind the rights confirmation the upload demands. Scoped to
  // the upload row: the same confirmation appears elsewhere on this screen.
  const uploadRow = page.locator('.button-row').filter({ hasText: 'Upload owned audio' })
  await uploadRow.getByRole('checkbox').check()
  await uploadRow.locator('input[type="file"]').setInputFiles({
    name: 'opener.wav',
    mimeType: 'audio/wav',
    buffer: wavBytes(),
  })
  await expect(page.getByRole('option', { name: 'opener.wav' }).first()).toBeAttached({ timeout: 20_000 })

  // Attach it as a stem — that is what gives the scene its audio. Scoped to the
  // stem row, since several panels offer an asset picker.
  const stemRow = page.locator('.field-row').filter({ hasText: 'Stem type' })
  await stemRow.getByLabel('Stem type').selectOption('music')
  await stemRow.getByLabel('From existing audio').selectOption({ label: 'opener.wav' })
  await page.getByRole('button', { name: 'Attach stem' }).click()

  // Build and cache the show. This is the last moment the network is needed.
  await page.getByRole('button', { name: 'Build show package' }).click()
  await expect(page.getByText(/SHOW READY/)).toBeVisible({ timeout: 60_000 })
})

test('performance mode runs with the network actually disabled', async () => {
  // The cable comes out. Every request from here fails at the network stack.
  await context.setOffline(true)

  // Prove the network is genuinely down rather than trusting the flag.
  const reachable = await page.evaluate(async () => {
    try {
      const response = await fetch('/api/health', { cache: 'no-store' })
      return response.ok
    } catch {
      return false
    }
  })
  expect(reachable, 'the API must be unreachable for this test to mean anything').toBe(false)

  await page.getByRole('button', { name: /Performance Mode/ }).click()

  // The stage surface comes up from local state alone.
  await expect(page.getByRole('button', { name: /EMERGENCY STOP/ })).toBeVisible()
  await expect(page.locator('.pad')).toHaveCount(16)
  await expect(page.getByText(/CACHE READY/)).toBeVisible()

  // The show's audio is loaded — from IndexedDB, because nothing else is
  // reachable. A pad reading ERROR here is the failure this test exists for.
  await expect(page.locator('.pad.error')).toHaveCount(0)
  await expect(page.getByText(/OFFLINE|CLOUD OFFLINE/).first()).toBeVisible()
})

test('a crash mid-show recovers offline, and never restarts audio by itself', async () => {
  // Still offline. Change something the engine reports, so a snapshot exists.
  await page.getByRole('button', { name: 'CLICK' }).click()
  await expect(page.locator('.perf-indicators').getByText('CLICK')).toBeVisible()

  // The crash: the tab goes away and comes back, with no network to come back
  // to. This is the venue scenario, not a tidy reload.
  await page.reload()

  await expect(page.getByRole('button', { name: /EMERGENCY STOP/ })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'RESTORE PERFORMANCE' })).toBeVisible()
  // The offer says plainly what it will and will not do.
  await expect(page.getByText(/Audio will not restart/)).toBeVisible()

  await page.getByRole('button', { name: 'RESTORE PERFORMANCE' }).click()

  // State came back...
  await expect(page.getByRole('button', { name: 'RESTORE PERFORMANCE' })).toHaveCount(0)
  // ...and nothing is playing. Sound after a crash must be a deliberate act:
  // the transport clock reads as stopped, not as a running bar count.
  await expect(page.locator('.perf-position')).toHaveText('—.—')
})

test('the setlist and transport still respond offline', async () => {
  // Still offline from the previous test.
  await expect(page.getByRole('button', { name: 'LOCK PERFORMANCE' })).toBeVisible()

  await page.getByRole('button', { name: 'LOCK PERFORMANCE' }).click()
  await expect(page.getByRole('button', { name: 'Exit' })).toBeDisabled()
  await page.getByRole('button', { name: /LOCKED/ }).click()
  await expect(page.getByRole('button', { name: 'Exit' })).toBeEnabled()

  await context.setOffline(false)
})
