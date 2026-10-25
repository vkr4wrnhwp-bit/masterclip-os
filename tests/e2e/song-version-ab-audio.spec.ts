import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'

/** Exercise the real shipped AbPlayer + browser AudioContext, not a UI mock.
 * Chrome coverage does not replace physical iPhone Safari listening QA.
 */
const here = dirname(fileURLToPath(import.meta.url))
let browserCode = ''

test.beforeAll(async () => {
  const built = await build({
    entryPoints: [join(here, 'fixtures/song-version-ab-browser.tsx')],
    bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false,
  })
  browserCode = built.outputFiles[0]?.text ?? ''
  expect(browserCode.length).toBeGreaterThan(0)
})

function syntheticWav(): Buffer {
  const sampleRate = 44_100
  const sampleCount = sampleRate * 2
  const out = Buffer.alloc(44 + sampleCount * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(out.length - 8, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(sampleCount * 2, 40)
  for (let i = 0; i < sampleCount; i++) {
    out.writeInt16LE(Math.round(2500 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), 44 + i * 2)
  }
  return out
}

async function mountPlayer(page: Page): Promise<void> {
  const audio = syntheticWav()
  await page.route('**/__song-ab-*.wav', route => route.fulfill({
    status: 200,
    contentType: 'audio/wav',
    body: audio,
    headers: { 'cache-control': 'no-store', 'accept-ranges': 'bytes' },
  }))
  await page.goto('/')
  await page.setContent('<!doctype html><html><body><main><h1>Audio comparison test</h1></main></body></html>')
  await page.addScriptTag({ content: browserCode })
  await page.evaluate(() => {
    window.__songABTest.mount([
      { id: 'first', label: 'Original', url: '/__song-ab-a.wav', gainDb: -4 },
      { id: 'second', label: 'New take', url: '/__song-ab-b.wav', gainDb: 0 },
    ])
  })
}

test('real Web Audio gain graph is constructed from a user gesture and uses measured attenuation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await mountPlayer(page)
  await page.evaluate(() => {
    const nodes: GainNode[] = []
    ;(window as Window & { __testGainNodes: GainNode[] }).__testGainNodes = nodes
    const old = AudioContext.prototype.createGain
    AudioContext.prototype.createGain = function () {
      const node = old.call(this)
      nodes.push(node)
      return node
    }
  })
  const enable = page.getByRole('button', { name: 'Enable matched listening' })
  await expect(enable).toBeVisible()
  await expect(page.locator('#ab-actual-player audio')).toHaveCount(2)
  await enable.click()
  await expect(page.getByRole('button', { name: 'ORIGINAL' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'NEW TAKE' })).toBeEnabled()
  const gains = await page.evaluate(() =>
    (window as Window & { __testGainNodes: GainNode[] }).__testGainNodes.map(node => node.gain.value),
  )
  expect(gains).toHaveLength(2)
  expect(gains[0]).toBeCloseTo(Math.pow(10, -4 / 20), 4)
  expect(gains[1]).toBeCloseTo(1, 4)
  await expect(page.locator('#ab-actual-player [role="alert"]')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('no compatible Web Audio means no false claim or unadjusted A/B playback', async ({ page }) => {
  await mountPlayer(page)
  await page.evaluate(() => {
    Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true })
  })
  await page.getByRole('button', { name: 'Enable matched listening' }).click()
  await expect(page.getByRole('alert')).toContainText('cannot apply the level match')
  await expect(page.getByRole('button', { name: 'ORIGINAL' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'NEW TAKE' })).toBeDisabled()
  await expect(page.locator('#ab-actual-player audio[controls]')).toHaveCount(0)
})
