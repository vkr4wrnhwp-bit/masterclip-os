import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('apps/web/src/styles.css','utf8')
const rail = readFileSync('apps/web/src/views/motion-shell.tsx','utf8')
const consoleLayout = readFileSync('apps/web/src/App.tsx','utf8')
const footer = readFileSync('apps/web/src/suite-footer.tsx','utf8')
const logo = readFileSync('apps/web/src/motion-logo.tsx','utf8')

describe('MOTION mobile identity and footer layout regression', () => {
  it('lets the full home page determine its document height before the footer', () => {
    expect(css).toMatch(/#root\s*\{[^}]*height:\s*auto;/s)
    expect(css).toMatch(/#sb-footer\s*\{[^}]*position:\s*static;/s)
    expect(css).not.toMatch(/html,\s*body,\s*#root\s*\{\s*height:\s*100%/)
    expect(css).toMatch(/\.sb-suite-footer\s+\.sb-suite-features\s*\{[^}]*position:\s*static;/s)
    expect(footer).not.toContain('scrollIntoView(')
  })
  it('renders the shared bracketed .motion header instead of the monogram', () => {
    expect(rail).toContain('<MotionLogo />')
    expect(consoleLayout).toContain('<MotionLogo />')
    expect(rail).not.toContain('<img className="mo-mark"')
    expect(consoleLayout).not.toContain('<img className="brand-mark"')
    expect(logo).toContain('motion-logo-bracket')
    expect(logo).toContain('motion-logo-dot')
    expect(logo).toContain('motion-logo-type')
  })
  it('keeps enough space in the mobile header for the logo and search', () => {
    expect(css).toMatch(/grid-template-columns:\s*minmax\(128px,\s*1fr\)\s+minmax\(0,\s*1fr\)/)
    expect(css).toContain('.mo-brand .motion-logo')
  })
})
