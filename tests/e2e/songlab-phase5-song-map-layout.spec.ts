import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('Phase 5 song-map uses its real CSS at 375px without overflow or tiny controls', async ({page})=>{
  const css=readFileSync(resolve(process.cwd(),'apps/web/src/song-journey/song-journey.css'),'utf8')
  await page.setViewportSize({width:375,height:812})
  await page.setContent(`<style>${css}</style><main style="box-sizing:border-box;width:100%;max-width:100%;background:black;color:white"><section class="sl-song-map"><h3>Song Lab</h3><p>This is your song, and these checks use saved records.</p><button>Save map corrections</button><button>Merge next</button></section></main>`)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  const short=await page.locator('.sl-song-map button, .sl-song-map select, .sl-song-map textarea').evaluateAll(elements=>elements.filter(el=>el.getBoundingClientRect().height<44).map(el=>el.tagName))
  expect(short).toEqual([])
  const small=await page.locator('.sl-song-map').evaluate(root=>[...root.querySelectorAll('h3,p,label,button,select,textarea')].filter(el=>parseFloat(getComputedStyle(el).fontSize)<12).map(el=>el.tagName))
  expect(small).toEqual([])
})
