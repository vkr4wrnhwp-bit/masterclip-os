import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { LESSONS, DEEP_LINKS } from '../apps/web/src/learning/motion-lessons.js'

describe('MOTION October 2026 learning refresh', () => {
  it('covers music-first source, creative and finishing tools with actual deep links', () => {
    for (const name of ['references','quick','timeline','compare'] as const) {
      expect(LESSONS[name].steps.length).toBeGreaterThanOrEqual(3)
    }
    const routes=DEEP_LINKS.map(x=>x.path)
    for(const tab of ['assets','quick','timeline','compare']) {
      expect(routes.some(url=>url.includes('?tab='+tab+'&walkthrough=1'))).toBe(true)
    }
    expect(LESSONS.project.intro).toContain('film')
    expect(LESSONS.quick.intro).toContain('draft')
    expect(LESSONS.timeline.intro).toContain('MP4')
  })
  it('mounts the read-only guided layer in the real suite with current branding', () => {
    const main=readFileSync('apps/web/src/main.tsx','utf8')
    const guide=readFileSync('apps/web/src/learning/MotionGuide.tsx','utf8')
    expect(main).toContain('<MotionGuide />')
    expect(guide).toContain('/motion-official-logo.png')
    expect(guide).toContain("route.params.tab")
    expect(guide).not.toContain('api.render(')
    expect(guide).not.toContain('api.promote(')
  })
  it('preserves prior seven checklist ticks by stable feature IDs', () => {
    const footer=readFileSync('apps/web/src/suite-footer.tsx','utf8')
    expect(footer).toContain("sbFeatures:motion:v2")
    expect(footer).toContain('LEGACY_KEY')
    expect(footer).toContain('OLD_IDS.forEach')
    expect(footer).toContain("id: 'timeline'")
    expect(footer).toContain("id: 'captions'")
    expect(footer).toContain("id: 'beats'")
    expect(footer).toContain("id: 'assemble'")
    expect(footer).toContain("id: 'export'")
  })
})
