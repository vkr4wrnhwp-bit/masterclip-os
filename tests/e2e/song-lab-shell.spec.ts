import { test, expect } from '@playwright/test'
import { createHash, createHmac, randomBytes } from 'node:crypto'

function token(state: string) {
  const secret = process.env.SUITE_SSO_SECRET_SONG_LAB
  if (!secret) throw new Error('Run this suite with a disposable SUITE_SSO_SECRET_SONG_LAB and both Song Lab suite flags set to 1')
  const body = Buffer.from(JSON.stringify({ v: 1, uid: 'phone-fixture', email: 'phone@example.com', name: 'Phone test', plan: 'pro', suite: 'song-lab', nonce: randomBytes(12).toString('hex'), state })).toString('base64url')
  const stamp = Buffer.from(Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'), 'hex').toString('base64url')
  const signed = `${body}.${stamp}`
  const key = createHash('sha1').update(`street-banker-suite-sso-v1signer${secret}`).digest()
  return `${signed}.${createHmac('sha1', key).update(signed).digest('base64url')}`
}

test('Song Lab shell: real session, 375px, steps, disclosures, keyboard and retained screens', async ({ page, request, context, baseURL }) => {
  test.skip(process.env.SONG_LAB_SUITE_ENABLED !== '1', 'Suite flag is off')
  const entry = await request.get('/login', { maxRedirects: 0 })
  const state = new URL(entry.headers().location).searchParams.get('state')!
  const handoff = await request.post('/auth/street-banker', { maxRedirects: 0, headers: { cookie: `song_lab_signin_state=${state}` }, form: { token: token(state) } })
  expect(handoff.status()).toBe(303)
  const cookies = await request.storageState()
  await context.addCookies(cookies.cookies)
  await page.setViewportSize({ width: 375, height: 812 })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  for (const hash of ['/song-lab', '/song-lab/new', '/song-lab/projects', '/studio', '/live-lab', '/live-lab/settings']) {
    await page.goto(baseURL + '/#' + hash)
    await expect(page.locator('.sl-existing')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Song journey' }).getByRole('link')).toHaveCount(6)
    const stageCopy = await page.locator('.sl-suite').evaluate(root => ({
      text: root.textContent?.toLowerCase() ?? '',
      links: Array.from(root.querySelectorAll('a[href]')).map(link => (link as HTMLAnchorElement).getAttribute('href')?.toLowerCase() ?? ''),
    }))
    expect(stageCopy.text, hash + ' rendered copy must keep the Stage route clear').not.toMatch(/\btour\b/)
    expect(stageCopy.links.filter(href => href.includes('/tour')), hash + ' rendered links must keep the Stage route clear').toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const small = await page.locator('.sl-suite').evaluate(root => Array.from(root.querySelectorAll('*')).filter(e => {
      const el = e as HTMLElement, r = el.getBoundingClientRect(), s = getComputedStyle(el)
      return r.width && r.height && s.visibility !== 'hidden' && el.childNodes.length && Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) && parseFloat(s.fontSize) < 12
    }).map(e => ({ tag: e.tagName, text: e.textContent?.slice(0, 50), font: getComputedStyle(e).fontSize })))
    expect(small, hash + ' text below 12px').toEqual([])
    const short = await page.locator('.sl-suite').evaluate(root => Array.from(root.querySelectorAll('button,a,summary,input:not([type=checkbox]),select')).filter(e => {
      const r = e.getBoundingClientRect(); return r.width && r.height && (r.height < 44 || r.width < 44)
    }).map(e => ({ text: e.textContent?.slice(0, 40), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width })))
    expect(short, hash + ' targets below 44px').toEqual([])
  }
  await page.goto(baseURL + '/#/song-lab')
  await page.getByText('Feature checklist', { exact: true }).click()
  await expect(page.locator('.sl-header input[type=checkbox]')).toHaveCount(78)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByText('Feature checklist', { exact: true }).click()
  await page.getByText('Walkthrough', { exact: true }).click()
  await expect(page.locator('.sl-header ol li')).toHaveCount(6)
  await page.getByText('Walkthrough', { exact: true }).click()
  for (const label of ['Choose', 'Understand', 'Decide', 'Finish', 'Approve', 'Deliver']) {
    await page.getByRole('navigation', { name: 'Song journey' }).getByRole('link', { name: new RegExp(label) }).click()
    await expect(page.getByRole('link', { name: new RegExp(label) }).filter({ has: page.locator('.sl-led') })).toHaveAttribute('aria-current', 'step')
    await expect(page.locator('.sl-existing')).toBeVisible()
  }
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true)
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 })
  expect(errors).toEqual([])
})

test('flag off retains the three legacy preview entry points and original sign-in', async ({ page, baseURL }) => {
  test.skip(process.env.SONG_LAB_SUITE_ENABLED === '1', 'Checks the legacy deployment posture')
  for (const hash of ['/song-lab', '/studio', '/live-lab']) {
    await page.goto(baseURL + '/#' + hash)
    await expect(page.locator('.login')).toBeVisible()
    await expect(page.locator('.sl-suite')).toHaveCount(0)
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    expect(page.url()).toContain('#' + hash)
  }
})
