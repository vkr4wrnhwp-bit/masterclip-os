import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The suite footer (owner, 2026-09-29): the same links as REACH, Noise Lab, The Room and Tour;
// the suite you are in is text, and it sits under every view via its own root.
const src = readFileSync('apps/web/src/suite-footer.tsx', 'utf8')
const main = readFileSync('apps/web/src/main.tsx', 'utf8')
const html = readFileSync('apps/web/index.html', 'utf8')

describe('suite footer', () => {
  it('links the legal pages through Street Banker and no other suite', () => {
    for (const label of ['The Room', 'Noise Lab', 'REACH', 'Tour', 'Royalty Sweep']) expect(src).not.toContain(`label: '${label}'`)
    expect(src).toContain('/terms')
    expect(src).toContain('/privacy')
    expect(src).toContain('Street Banker Inc.')
  })
  it('shows the Motion checklist only under Motion', () => {
    expect(src).toContain("current = 'motion'")
    expect(src).toContain("current === 'motion'")
  })
  it('is mounted in its own root under the app', () => {
    expect(html).toContain('id="sb-footer"')
    expect(main).toContain("getElementById('sb-footer')")
  })
})

describe('what is in Motion', () => {
  it('lists what the suite does with boxes only the person ticks', () => {
    expect(src).toContain('Do you know all the features Motion has? Click here.')
    expect(src).toContain('type="checkbox"')
    expect(src).toContain('Saved on this device')
    expect(src).toContain("sbFeatures:motion")
    expect(src).not.toMatch(/setTicks\(\{[^}]*true/)
  })
})
