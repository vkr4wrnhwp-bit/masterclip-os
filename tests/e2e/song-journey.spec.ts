import { test, expect } from '@playwright/test'
import { createHash, createHmac, randomBytes } from 'node:crypto'

function token(state: string) {
  const secret = process.env.SUITE_SSO_SECRET_SONG_LAB
  if (!secret) throw new Error('Run this suite with SUITE_SSO_SECRET_SONG_LAB and SONG_LAB_SUITE_ENABLED=1')
  const body = Buffer.from(JSON.stringify({ v: 1, uid: 'journey-fixture', email: 'journey@example.com', name: 'Journey test', plan: 'pro', suite: 'song-lab', nonce: randomBytes(12).toString('hex'), state })).toString('base64url')
  const stamp = Buffer.from(Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'), 'hex').toString('base64url')
  const signed = `${body}.${stamp}`
  const key = createHash('sha1').update(`street-banker-suite-sso-v1signer${secret}`).digest()
  return `${signed}.${createHmac('sha1', key).update(signed).digest('base64url')}`
}

test('one song journey stepper is usable at desktop and phone widths', async ({ page, request, context, baseURL }) => {
  test.skip(process.env.SONG_LAB_SUITE_ENABLED !== '1' || process.env.SONG_LAB_SUITE_LINKED_RECORDS_ENABLED !== '1', 'Both Song Lab journey flags must be enabled')
  const entry = await request.get('/login', { maxRedirects: 0 })
  const state = new URL(entry.headers().location).searchParams.get('state')!
  const handoff = await request.post('/auth/street-banker', { maxRedirects: 0, headers: { cookie: `song_lab_signin_state=${state}` }, form: { token: token(state) } })
  expect(handoff.status()).toBe(303)
  await context.addCookies((await request.storageState()).cookies)

  const record = {
    link: { id: 'sjl_fixture', songLabProjectId: 'song_fixture', studioProjectId: 'studio_fixture', sourceKind: 'song_lab', selectedSongVersionId: null, selectedStudioVersionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), unlinkedAt: null },
    song: { id: 'song_fixture', title: 'Fixture Song', artistName: 'Fixture Artist', status: 'draft' },
    studio: { id: 'studio_fixture', title: 'Fixture Mix', artistName: 'Fixture Artist', stage: 'mix' },
    songVersions: [], studioVersions: [],
  }
  await page.route('**/api/song-journey/links', route => route.fulfill({ json: { links: [record] } }))
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 })
    await page.goto(`${baseURL}/#/song-journey/sjl_fixture?step=0`)
    await expect(page.getByRole('heading', { name: 'One song. One journey.' })).toBeVisible()
    const nav = page.getByRole('navigation', { name: 'Song journey steps' })
    await expect(nav.getByRole('button')).toHaveCount(6)
    for (const name of ['Choose', 'Understand', 'Decide', 'Finish', 'Approve', 'Deliver']) {
      const step = nav.getByRole('button', { name: new RegExp(name) })
      await step.focus()
      await page.keyboard.press('Enter')
      await expect(step).toHaveAttribute('aria-current', 'step')
      expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const shortTargets = await nav.locator('button').evaluateAll(buttons => buttons.filter(button => {
      const rect = button.getBoundingClientRect()
      return rect.width < 44 || rect.height < 44
    }).map(button => button.textContent))
    expect(shortTargets).toEqual([])
    const smallText = await page.locator('.sl-journey-page').evaluate(root => Array.from(root.querySelectorAll('*')).filter(element => {
      const node = element as HTMLElement
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && Array.from(node.childNodes).some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) && parseFloat(style.fontSize) < 12
    }).map(element => ({ text: element.textContent?.slice(0, 50), font: getComputedStyle(element).fontSize })))
    expect(smallText).toEqual([])
    const smallControls = await page.locator('.sl-journey-page button, .sl-journey-page a, .sl-journey-page select, .sl-journey-page summary').evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)
    }).map(element => ({ text: element.textContent?.slice(0, 40), height: element.getBoundingClientRect().height })))
    expect(smallControls).toEqual([])
  }
})
