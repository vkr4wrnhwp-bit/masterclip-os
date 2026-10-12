import { expect, test } from '@playwright/test'

// MOTION first-film browser smoke gate. Tests run in a disposable sandbox.
test('homepage loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open Motion' })).toBeVisible()
})
