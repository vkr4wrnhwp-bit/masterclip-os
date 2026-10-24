import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('Phase 5 owned-compare uses its real CSS at 375px without overflow or tiny controls', async ({page})=>{
  const css=readFileSync(resolve(process.cwd(),'apps/web/src/song-journey/song-journey.css'),'utf8')
  await page.setViewportSize({width:375,height:812})
  await page.setContent(`<style>${css}</style><main style="box-sizing:border-box;width:100%;max-width:100%;background:black;color:white"><section class="sl-owned-compare"><h3>Song Lab</h3><p>This is your song, and these checks use saved records.</p><label>Reference song <select><option>Song</option></select></label><button>Compare measurements</button></section></main>`)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  const short=await page.locator('.sl-owned-compare button, .sl-owned-compare select, .sl-owned-compare textarea').evaluateAll(elements=>elements.filter(el=>el.getBoundingClientRect().height<44).map(el=>el.tagName))
  expect(short).toEqual([])
  const small=await page.locator('.sl-owned-compare').evaluate(root=>[...root.querySelectorAll('h3,p,label,button,select,textarea')].filter(el=>parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.tagName))
  expect(small).toEqual([])
})
