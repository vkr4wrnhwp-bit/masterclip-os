import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('Job 45 measured A/B keeps its controls readable at 375px', async ({ page }) => {
  const css = readFileSync(resolve(process.cwd(), 'apps/web/src/song-journey/song-journey.css'), 'utf8')
  await page.setViewportSize({ width: 375, height: 812 })
  await page.setContent(`<style>${css}</style><main style="box-sizing:border-box;max-width:100%;width:100%;background:#000;color:#fff">
    <section class="sl-verified-ab">
      <h3>Listen to two song versions</h3>
      <p>Compare these two versions without changing the original files.</p>
      <div class="sl-ab-choices">
        <label>Version A<select><option>Original take with a long descriptive version name</option></select></label>
        <label>Version B<select><option>Later mix with a long descriptive version name</option></select></label>
      </div>
      <button>Measure and compare</button>
      <div class="sl-ab"><div class="sl-ab-buttons"><button>VERSION A</button><button>VERSION B</button></div>
        <audio controls></audio></div>
      <details open><summary>Measurement evidence</summary>
        <p>A checksum: <code>${'a'.repeat(64)}</code></p>
      </details>
    </section></main>`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const shortControls = await page.locator('.sl-verified-ab button, .sl-verified-ab select, .sl-verified-ab summary').evaluateAll(
    elements => elements.filter(el => {
      const r = el.getBoundingClientRect()
      return r.width < 44 || r.height < 44
    }).map(el => el.tagName),
  )
  expect(shortControls).toEqual([])
  const tinyText = await page.locator('.sl-verified-ab').evaluate(root =>
    Array.from(root.querySelectorAll('h3,p,label,select,button,summary,code'))
      .filter(el => Number.parseFloat(getComputedStyle(el).fontSize) < 12)
      .map(el => el.tagName),
  )
  expect(tinyText).toEqual([])
})
