import { expect, test } from '@playwright/test'

test('MOTION serves the real first-film entrance at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Open Motion' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})
