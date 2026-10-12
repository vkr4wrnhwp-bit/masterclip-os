import { expect, test } from '@playwright/test'

test('MOTION serves the real first-film entrance at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open Motion' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

test('first film is cancellable from the authenticated app', async ({ page }) => {
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
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
