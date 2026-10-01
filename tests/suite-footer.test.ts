import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The suite footer (owner, 2026-09-29): the same links as REACH, Noise Lab, The Room and Tour;
// the suite you are in is text, and it sits under every view via its own root.
const src = readFileSync('apps/web/src/suite-footer.tsx', 'utf8')
const main = readFileSync('apps/web/src/main.tsx', 'utf8')
const html = readFileSync('apps/web/index.html', 'utf8')

describe('suite footer', () => {
  it('links the other five suites and the legal pages through Street Banker', () => {
    for (const label of ['The Room', 'Noise Lab', 'REACH', 'Tour', 'Royalty Sweep']) expect(src).toContain(`label: '${label}'`)
    expect(src).toContain('/terms')
    expect(src).toContain('/privacy')
    expect(src).toContain('Street Banker Inc.')
  })
  it('names Motion as plain text, not a link', () => {
    expect(src).toContain("current = 'motion'")
    expect(src).toContain('aria-current="page"')
  })
  it('is mounted in its own root under the app', () => {
    expect(html).toContain('id="sb-footer"')
    expect(main).toContain("getElementById('sb-footer')")
  })
})

describe('what is in Motion', () => {
  it('lists what the suite does with boxes only the person ticks', () => {
    expect(src).toContain('What&rsquo;s in Motion')
    expect(src).toContain('type="checkbox"')
    expect(src).toContain('Saved on this device')
    expect(src).toContain("sbFeatures:motion")
    expect(src).not.toMatch(/setTicks\(\{[^}]*true/)
  })
})
