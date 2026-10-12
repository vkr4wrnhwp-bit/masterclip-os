import { expect, test } from '@playwright/test'

test('authorized WAV upload appears in References and Quick Create', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.locator('.login summary').click()
  const health = await (await page.request.get('/api/health')).json()
  if (health.signupOpen) {
    await page.getByRole('button', { name: 'First run? Create the org' }).click()
    await page.getByLabel('Your name').fill('MOTION QA')
    await page.getByLabel('Organization').fill('MOTION Test')
  }
  await page.getByLabel('Email').fill('qa@example.test')
  await page.getByLabel('Password').fill('temporary-test-credential')
  await page.getByRole('button', { name: health.signupOpen ? 'Create account' : 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Start a new film.' })).toBeVisible()
  await page.getByRole('button', { name: 'Start a film with audio' }).click()
  await page.getByLabel('Project name').fill('QA Recording')
  const wav = Buffer.alloc(44 + 64_000)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(64_000, 40)
  await page.getByLabel('Choose an audio recording').setInputFiles({
    name: 'qa-recording.wav', mimeType: 'audio/wav', buffer: wav,
  })
  await page.getByLabel('Rights owner').fill('QA Rights Holder')
  await page.getByRole('checkbox', { name: /I am authorized/ }).check()
  const count = async () => (await (await page.request.get('/api/projects')).json()).projects.length as number
  const before = await count()
  let failOnce = true
  await page.route('**/api/projects/*/assets', async route => {
    if (route.request().method() === 'POST' && failOnce) {
      failOnce = false
      await route.fulfill({ status: 503, body: JSON.stringify({ error: 'temporary test failure' }),
        contentType: 'application/json' })
    } else await route.continue()
  })
  await page.getByRole('button', { name: /Create the film/ }).click()
  await expect(page.getByRole('alert')).toContainText('Film created, but audio upload failed')
  expect(await count()).toBe(before + 1)
  await page.getByRole('button', { name: /Create the film/ }).click()
  await page.waitForURL(/#\/project\/[^?]+\?tab=assets/)
  expect(await count()).toBe(before + 1)
  await expect(page.getByText('qa-recording.wav')).toBeVisible()
  await page.getByRole('button', { name: 'Continue to Quick Create' }).click()
  await expect(page.getByText('Quick Create — music-first video brief')).toBeVisible()
  await page.getByLabel('Song recording').selectOption({ label: 'qa-recording.wav' })
  await expect(page.getByRole('region', { name: 'Song moment' })).toBeVisible()
  await page.getByLabel('Shot title').fill('QA Music Moment')
  await page.getByLabel('Creative direction').fill('One motivated cyan practical illuminates a singer at the chorus.')
  await page.getByRole('checkbox', { name: /I confirm the selected media is authorized/ }).check()
  await page.getByRole('button', { name: 'Save Quick Create draft' }).click()
  await expect(page.getByText(/Draft saved. No render or audio mix has occurred/)).toBeVisible()
  await page.getByRole('button', { name: 'Music Video Timeline' }).click()
  await expect(page.getByText(/No human-approved master videos/)).toBeVisible()
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})
