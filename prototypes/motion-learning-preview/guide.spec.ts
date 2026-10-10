import { test, expect } from '@playwright/test'

test('three entry links load genuinely different MOTION React screens, not one shared landing',async ({page})=>{
  await page.goto('/#/?walkthrough=start')
  await expect(page.locator('#ml-title')).toHaveText('Start a Film')
  await expect(page.locator('#mo-hero-heading')).toContainText('Start a new film')
  await expect(page.locator('.mode-banner')).toContainText('SANDBOX MODE')
  await expect(page.locator('.mp-review-banner')).toContainText('READ-ONLY REVIEW')
  await page.goto('/#/shot/preview-shot-01?walkthrough=shots')
  await expect(page.locator('#ml-title')).toHaveText('Direct a Shot')
  await expect(page.locator('.topbar h2')).toContainText('Fictional street reflection')
  await expect(page.locator('.grid.cols-2 textarea').first()).toBeVisible()
  await page.goto('/#/shot/preview-shot-01/review?walkthrough=finish')
  await expect(page.locator('#ml-title')).toHaveText('Review & Deliver')
  await expect(page.locator('.topbar h2')).toContainText('Review')
  await expect(page.locator('.review-grid .candidate')).toHaveCount(2)
  await expect(page.locator('.review-grid video')).toHaveCount(0)
})

test('preview rejects all write attempts from actual product page and never creates data',async ({page})=>{
  await page.goto('/#/?walkthrough=start')
  await expect(page.locator('#mo-hero-heading')).toBeVisible()
  const status=await page.evaluate(async ()=>{
    const response=await fetch('/api/shots/preview-shot-01/render',{
      method:'POST',headers:{'content-type':'application/json'},body:'{"models":[]}'
    })
    return {status:response.status,text:await response.text()}
  })
  expect(status.status).toBe(405)
  expect(status.text).toContain('PREVIEW_READ_ONLY')
  const exposed=await page.evaluate(async ()=>{
    const response=await fetch('/api/projects/customer-real-secret')
    return response.status
  })
  expect(exposed).toBe(404)
})

test('four deep chapters remain real, distinct MOTION pages',async ({page})=>{
  const pages=[
    ['/#/project/preview-film-01?walkthrough=1','Treatment & Storyboard','Project'],
    ['/#/queue/preview-film-01?walkthrough=1','Render Operations','Render queue'],
    ['/#/masters/preview-film-01?walkthrough=1','Masters & Delivery','Masters'],
    ['/#/costs/preview-film-01?walkthrough=1','Cost & Approval Economics','Cost lab']
  ] as const
  for(const [path,lesson,heading] of pages){
    await page.goto(path)
    await expect(page.locator('#ml-title')).toHaveText(lesson)
    await expect(page.locator('.topbar h2')).toContainText(heading==='Project'?'PREVIEW':heading)
  }
})

test('iPhone-size lesson footer stays above mobile browser toolbar clearance',async ({browser})=>{
  const context=await browser.newContext({
    viewport:{width:375,height:667},isMobile:true,hasTouch:true,
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1'
  })
  const page=await context.newPage()
  await page.goto('/#/?walkthrough=start')
  await expect(page.locator('#ml-title')).toHaveText('Start a Film')
  await page.getByRole('button',{name:'Start walkthrough'}).click()
  const panel=await page.locator('.ml-panel').boundingBox()
  const next=await page.getByRole('button',{name:'Next'}).boundingBox()
  expect(panel).not.toBeNull()
  expect(next).not.toBeNull()
  expect(panel!.y+panel!.height).toBeLessThanOrEqual(667-85)
  expect(next!.y+next!.height).toBeLessThanOrEqual(667-80)
  await page.keyboard.press('Escape')
  await expect(page.locator('.ml-panel')).toHaveCount(0)
  await context.close()
})
