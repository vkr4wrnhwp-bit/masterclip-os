import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FEATURES, STEPS, MotionChrome, MotionTip, homeUrl, initialGuide, readTicks, saveTicks } from '../apps/web/src/SuiteChrome.js'

describe('Motion suite guidance', () => {
  it('renders a visible header return, walkthrough and tap tip', () => {
    const html = renderToStaticMarkup(React.createElement(MotionChrome))
    expect(html).toContain('Back to Street Banker')
    expect(html).toContain('>Walkthrough</button>')
    expect(html).toContain('https://app.streetbankermusic.com/command-center')
    expect(html).toContain('About Motion')
    expect(html).toContain('>?</summary>')
  })
  it('renders one honest, manual checklist with a count', () => {
    const html = renderToStaticMarkup(React.createElement(MotionChrome, { footer: true }))
    expect(html).toContain('Do you know all the features Motion has? Click here.')
    expect(html.match(/type="checkbox"/g)).toHaveLength(FEATURES.length)
    expect(html).toContain('Needs a key')
    expect(html).toContain('0 of 11 tried')
    expect(html).not.toContain('checked=""')
    const connected = renderToStaticMarkup(React.createElement(MotionChrome, { footer: true, connected: true }))
    expect(connected).not.toContain('motion-feature-tag">Needs a key')
  })
  it('saves only deliberate known ticks and survives blocked or damaged storage', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    expect(readTicks(storage)).toEqual({})
    saveTicks(storage, { projects: true, references: false })
    expect(readTicks(storage).projects).toBe(true)
    expect(readTicks(storage).references).toBe(false)
    values.set('sbFeatures:motion', '{broken')
    expect(readTicks(storage)).toEqual({})
    values.set('sbFeatures:motion', '[true]')
    expect(readTicks(storage)).toEqual({})
    expect(() => saveTicks({ setItem() { throw new Error('blocked') } }, {})).not.toThrow()
  })
  it('keeps the five real steps and never invents a credit price', () => {
    expect(STEPS).toHaveLength(5)
    expect(STEPS.map(s => s[0])).toEqual(['Upload a song','Choose a style','Render a draft','Read the cost','Review and download'])
    expect(STEPS[3][1]).toContain('dollars, not a fixed Street Banker credit price')
    expect(STEPS[2][1]).toContain('Sandbox')
  })
  it('uses a safe home address and a click-open explanation', () => {
    expect(homeUrl('javascript:alert(1)')).toBe('https://app.streetbankermusic.com/command-center')
    expect(homeUrl('https://sb.example/path')).toBe('https://sb.example/command-center')
    const tip = renderToStaticMarkup(React.createElement(MotionTip, { title: 'Upload', children: 'It starts only when you choose it.' }))
    expect(tip).toContain('<details')
    expect(tip).toContain('role="note"')
  })
})

 it('offers once and supports direct chapters and bounded steps without storage', () => {
  expect(initialGuide('', { getItem: () => null })).toEqual({ offer: true, step: null })
  expect(initialGuide('', { getItem: () => '1' })).toEqual({ offer: false, step: null })
  expect(initialGuide('?walkthrough=motion&step=2')).toEqual({ offer: false, step: 2 })
  expect(initialGuide('?walkthrough=motion&step=999').step).toBe(4)
  expect(initialGuide('?walkthrough=motion&step=-9').step).toBe(0)
  expect(initialGuide('', { getItem() { throw new Error('blocked') } }).offer).toBe(true)
 })

it('never opens a modal on its own: the first-visit offer is a panel in the page', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../apps/web/src/SuiteChrome.tsx', import.meta.url), 'utf8')
  expect(src).toContain('motion-guide-offer')
  expect(src).not.toMatch(/if \(offer[^)]*\)[^\n]*showModal/)
})
