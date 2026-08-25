/**
 * One set of credentials for the whole browser suite.
 *
 * Signup closes behind the first account, and all spec files share one server
 * and one throwaway database — so the file that happens to run first performs
 * the bootstrap and every other file signs in with the same credentials
 * instead of testing the login form again.
 */
export const E2E_EMAIL = 'e2e-producer@masterclip.test'
export const E2E_PASSWORD = 'e2e-password-1234'

import type { Page } from '@playwright/test'

/** Signs in, bootstrapping the org first when this file is the first to run. */
export async function ensureSignedIn(page: Page): Promise<void> {
  await page.goto('/')
  // The mode toggle is always on screen, so "is signup open?" can only be
  // answered by trying: log in first, bootstrap only when login is refused.
  await page.getByLabel('Email').fill(E2E_EMAIL)
  await page.getByLabel(/^Password/).fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  const dashboard = page.getByRole('heading', { name: 'Dashboard' })
  const refused = page.getByText(/invalid email or password/i)
  await Promise.race([dashboard.waitFor({ timeout: 15_000 }), refused.waitFor({ timeout: 15_000 })])
  if (await dashboard.isVisible().catch(() => false)) return

  await page.getByRole('button', { name: 'First run? Create the org' }).click()
  await page.getByLabel('Your name').fill('E2E Producer')
  await page.getByLabel('Organization').fill('E2E Studio')
  await page.getByLabel('Email').fill(E2E_EMAIL)
  await page.getByLabel(/^Password/).fill(E2E_PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await dashboard.waitFor({ timeout: 15_000 })
}
