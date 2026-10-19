import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AsyncState } from '../apps/web/src/ui.js'
import type { User } from '../apps/web/src/api.js'

/**
 * The "?" on every MOTION section (owner, 2026-10-18: "this question mark
 * should go everywhere"). One small component, apps/web/src/components/Why.tsx,
 * its words in apps/web/src/why-notes.ts and its look in styles.css.
 *
 * Held here: the component toggles and Escape returns the focus (run on a
 * small hand-made DOM, since this repository has no browser DOM library); every
 * covered view renders its "?" with a hidden note of real words; the words say
 * what uses credits; and the look keeps the house rules (MOTION tokens, no hex,
 * a 44px hit area, a 12px floor, no hover, no monospace).
 *
 * Views are rendered to static markup with `useAsync` standing in, the way
 * tests/cost-lab.test.ts drives the cost lab, so a section that waits for data
 * is drawn with data in it.
 */

const done = <T,>(data: T): AsyncState<T> => ({ data, error: null, loading: false, failures: 0, reload: () => undefined })
const idle: AsyncState<unknown> = { data: null, error: null, loading: true, failures: 0, reload: () => undefined }

const COSTS = {
  metrics: { submittedCount: 4, technicallyValidCount: 3, approvedCount: 1, formatted: { costPerApprovedSecond: '$0.1200', costPerApprovedClip: '$0.9600', costPerSubmittedSecond: '$0.0300', rawSpend: '$3.8400' } },
  byProvider: [], daily: [], rejections: [], qcAvoided: { autoRejected: 2, usd: '$1.6000' }, budget: {},
  liveCap: { capUsd: 25, capConfigured: true, spent: '$4.1000' },
}
const MASTER = {
  id: 'm1', name: 'Hero take', status: 'approved', approvedBy: 'A Director', approvedAt: '2026-10-18T10:00:00Z',
  metadata: { provider: 'mock', model: 'mock-v1' }, deliverables: [], finishingJobs: [], captionCount: 0,
  songMoment: { startSeconds: 12, endSeconds: 20 }, vault: { fileId: 'v1', label: 'Hero take.mp4' },
}
/** What each screen's reads answer, by the one call a read makes. Anything else is still loading. */
const ANSWERS: Array<[string, unknown]> = [
  ['musicTimelineSources', { videos: [], audio: [] }],
  ['project', { project: { id: 'film-1', name: 'Night Drive', brief: 'A night drive through the city.', styleBible: { look: 'neon' } }, scenes: [] }],
  ['shots', { shots: [] }],
  ['masters', { masters: [MASTER] }],
  ['costs', COSTS],
  ['providers', { mode: 'sandbox', operatorView: true, providers: [{ providerId: 'mock', displayName: 'Mock', configured: true, keyFingerprint: '', health: null }] }],
]
/** The front door renders with nothing read, as on a first visit; every other view gets its answers. */
let answering = true

vi.mock('../apps/web/src/ui.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/src/ui.js')>()),
  useAsync: (fn: () => unknown) => {
    // A read is `() => api.name(...)`; the test runner may rename the imported
    // `api` (to something like __vi_import_0__.api), so only the call is matched.
    const source = String(fn).replace(/\s+/g, '')
    const call = /^\(\)=>[\w$.]*?api\.(\w+)\(/.exec(source)?.[1]
    const hit = answering ? ANSWERS.find(([name]) => name === call) : undefined
    return hit ? done(hit[1]) : idle
  },
}))

const { WHY } = await import('../apps/web/src/why-notes.js')
const { Why, escapeTarget } = await import('../apps/web/src/components/Why.jsx')
const { Overview } = await import('../apps/web/src/views/Overview.jsx')
const { ProjectView } = await import('../apps/web/src/views/Project.jsx')
const { QueueView } = await import('../apps/web/src/views/Queue.jsx')
const { MastersView } = await import('../apps/web/src/views/Masters.jsx')
const { CostLab } = await import('../apps/web/src/views/CostLab.jsx')
const { ProvidersView } = await import('../apps/web/src/views/Providers.jsx')
const { START_MODES } = await import('../apps/web/src/views/overview-model.js')

const h = React.createElement
const USER: User = { userId: 'u1', orgId: 'o1', email: 'director@example.com', displayName: 'A Director', orgRole: 'owner' }
const css = readFileSync('apps/web/src/styles.css', 'utf8')
const component = readFileSync('apps/web/src/components/Why.tsx', 'utf8')

const decode = (text: string) =>
  text.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

/** Every "?" on a rendered page, with the note it names. */
function questionMarks(markup: string): Array<{ label: string; controls: string; words: string }> {
  const out: Array<{ label: string; controls: string; words: string }> = []
  for (const match of markup.matchAll(/<button type="button" class="mo-why" aria-expanded="false" aria-controls="([^"]+)" aria-label="([^"]+)">\?<\/button>/g)) {
    const controls = match[1]!
    const note = markup.match(new RegExp(`<div class="mo-why-note" id="${controls}" role="note" hidden="">(.*?)</div>`))
    expect(note, `${controls} names no hidden note`).not.toBeNull()
    out.push({ label: decode(match[2]!), controls, words: decode(note![1]!) })
  }
  return out
}

function expectPage(markup: string, labels: string[]) {
  const marks = questionMarks(markup)
  expect(markup.match(/class="mo-why"/g)?.length ?? 0).toBe(marks.length)
  const ids = marks.map((mark) => mark.controls)
  expect(new Set(ids).size).toBe(ids.length)
  expect(markup.match(/class="mo-why-note"/g)?.length ?? 0).toBe(marks.length)
  for (const mark of marks) {
    expect(mark.label.startsWith('What ')).toBe(true)
    expect(mark.words.split(' ').length).toBeGreaterThanOrEqual(12)
  }
  for (const label of labels) expect(marks.map((mark) => mark.label)).toContain(label)
  return marks
}

/* --------------------------------------------------- the covered views ---- */

describe('every covered view carries its "?" with a hidden note of real words', () => {
  it('the front door: each of the four starting points, and the six steps', () => {
    answering = false
    const markup = renderToStaticMarkup(h(Overview, { user: USER, onSignOut: () => undefined }))
    answering = true
    expectPage(markup, [WHY.startAudio.label, WHY.startIdea.label, WHY.startTemplate.label, WHY.startPicture.label, WHY.stages.label])
    // Each card's "?" sits beside that card, in its own cell, never inside the card's button.
    const cells = markup.split('<div class="mo-mode-cell">').slice(1)
    expect(cells).toHaveLength(START_MODES.length)
    const notes = [WHY.startAudio, WHY.startIdea, WHY.startTemplate, WHY.startPicture]
    cells.forEach((cell, index) => {
      const card = cell.slice(0, cell.indexOf('</button>'))
      expect(card).toContain(`aria-label="${START_MODES[index]!.actionLabel}"`)
      expect(card).not.toContain('mo-why')
      expect(cell).toContain(`aria-label="${notes[index]!.label}"`)
    })
    // The steps' "?" is in the stage row, its note under it.
    const row = markup.slice(markup.indexOf('<section class="mo-workflow"'), markup.indexOf('</section>', markup.indexOf('<section class="mo-workflow"')))
    expect(row).toContain(`aria-label="${WHY.stages.label}"`)
    // The first-run screen claims nothing about spend (tests/overview.test.ts).
    expect(markup).not.toContain('authorized')
  })

  const tabs: Array<[string, string[]]> = [
    ['shots', [WHY.shots.label]],
    ['assets', [WHY.references.label, WHY.referencesList.label]],
    ['quick', [WHY.quickCreate.label, WHY.treatments.label, WHY.variations.label]],
    ['timeline', [WHY.timeline.label, WHY.finishVideo.label]],
    ['compare', [WHY.compare.label]],
    ['import', [WHY.importShots.label]],
    ['bible', [WHY.brief.label, WHY.styleBible.label]],
  ]
  for (const [tab, labels] of tabs) {
    it(`a film's ${tab} tab`, () => {
      expectPage(renderToStaticMarkup(h(ProjectView, { projectId: 'film-1', initialTab: tab })), labels)
    })
  }

  it('the render queue, beside its heading, with the credit rule in its words', () => {
    const markup = renderToStaticMarkup(h(QueueView, { projectId: 'film-1' }))
    const [mark] = expectPage(markup, [WHY.queue.label])
    expect(markup.indexOf('Render queue</h2>')).toBeLessThan(markup.indexOf(`aria-label="${WHY.queue.label}"`))
    expect(mark!.words).toContain('for every second of video')
    expect(mark!.words).toContain('nothing is included')
  })

  it('Masters, Send to my Vault and the song-moment finishing on each master', () => {
    const markup = renderToStaticMarkup(h(MastersView, { projectId: 'film-1' }))
    expectPage(markup, [WHY.masters.label, WHY.sendToVault.label, WHY.songFinishing.label])
    const vault = markup.slice(markup.indexOf('<div class="mo-vault-send">'))
    expect(vault.slice(0, vault.indexOf('Already in your Vault'))).toContain(`aria-label="${WHY.sendToVault.label}"`)
  })

  it('the Cost lab: the page and each of its four tables and tools', () => {
    expectPage(renderToStaticMarkup(h(CostLab, { projectId: 'film-1' })), [
      WHY.costLab.label, WHY.spendByModel.label, WHY.rejections.label, WHY.acceptance.label, WHY.simulator.label,
    ])
  })

  it('Providers and models: the page, the providers, the catalog and the routing profiles', () => {
    expectPage(renderToStaticMarkup(h(ProvidersView)), [WHY.providers.label, WHY.connected.label, WHY.catalog.label, WHY.profiles.label])
  })
})

/* ------------------------------------------------------------ the words --- */

describe('the words', () => {
  it('are plain sentences: two to four short ones, a label that starts "What ", no markup', () => {
    for (const [key, note] of Object.entries(WHY)) {
      expect(note.label.startsWith('What '), key).toBe(true)
      expect(note.text.length, key).toBeGreaterThanOrEqual(1)
      expect(note.text.length, key).toBeLessThanOrEqual(3)
      const words = note.text.join(' ')
      expect(words.split(/\s+/).length, key).toBeGreaterThanOrEqual(12)
      expect(words.split(/\s+/).length, key).toBeLessThanOrEqual(90)
      const sentences = words.split(/(?<=\.)\s+/).length
      expect(sentences, key).toBeGreaterThanOrEqual(2)
      expect(sentences, key).toBeLessThanOrEqual(4)
      for (const line of note.text) expect(line.trim().endsWith('.'), key).toBe(true)
      expect(words, key).not.toMatch(/[<>]/)
    }
  })

  it('say what uses credits and what does not', () => {
    expect(WHY.queue.text.join(' ')).toMatch(/credits for every second of video/)
    expect(WHY.shots.text.join(' ')).toContain('Credits are used only when a live render is sent')
    for (const free of [WHY.quickCreate, WHY.timeline, WHY.finishVideo, WHY.variations, WHY.songFinishing, WHY.masters,
      WHY.startAudio, WHY.startIdea, WHY.startTemplate, WHY.startPicture]) {
      expect(free.text.join(' ')).toMatch(/no (render )?credits|spend credits|use no render credits|uses render credits/)
    }
    expect(WHY.sendToVault.text.join(' ')).toContain('Nothing goes to the Vault until you press it')
    expect(WHY.references.text.join(' ')).toContain('stored with this film on the MOTION server')
  })
})

/* -------------------------------------------- the toggle, on a small DOM --- */

/* Enough of a DOM for React's client renderer: elements with attributes and
   children, text nodes, events that capture and bubble, and the focus. */
class FakeNode {
  ownerDocument: FakeDocument | null
  nodeType: number
  nodeName: string
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  nodeValue: string | null = null
  listeners: Record<string, Array<(event: FakeEvent) => void>> = {}
  constructor(doc: FakeDocument | null, nodeType: number, name: string) {
    this.ownerDocument = doc
    this.nodeType = nodeType
    this.nodeName = name
  }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }
  appendChild(child: FakeNode) { child.parentNode?.removeChild(child); child.parentNode = this; this.childNodes.push(child); return child }
  insertBefore(child: FakeNode, ref: FakeNode | null) {
    if (!ref) return this.appendChild(child)
    child.parentNode?.removeChild(child)
    child.parentNode = this
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child)
    return child
  }
  removeChild(child: FakeNode) { const at = this.childNodes.indexOf(child); if (at >= 0) this.childNodes.splice(at, 1); child.parentNode = null; return child }
  addEventListener(type: string, fn: (event: FakeEvent) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'object' ? Boolean(options.capture) : Boolean(options)
    ;(this.listeners[type + (capture ? ':capture' : '')] ??= []).push(fn)
  }
  removeEventListener(type: string, fn: (event: FakeEvent) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'object' ? Boolean(options.capture) : Boolean(options)
    const list = this.listeners[type + (capture ? ':capture' : '')] ?? []
    const at = list.indexOf(fn)
    if (at >= 0) list.splice(at, 1)
  }
  get textContent(): string { return this.nodeType === 3 ? (this.nodeValue ?? '') : this.childNodes.map((child) => child.textContent).join('') }
  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value) this.appendChild(this.document().createTextNode(value))
  }
  document(): FakeDocument { return (this.ownerDocument ?? this) as FakeDocument }
  dispatchEvent(event: FakeEvent) {
    const up: FakeNode[] = []
    for (let node: FakeNode | null = this; node; node = node.parentNode) up.push(node)
    const view = this.document().defaultView
    event.target = this
    for (const node of [view, ...up.slice().reverse()]) {
      if (event.stopped) break
      event.currentTarget = node
      for (const fn of (node.listeners[event.type + ':capture'] ?? []).slice()) fn.call(node, event)
    }
    for (const node of [...up, view]) {
      if (event.stopped) break
      event.currentTarget = node
      for (const fn of (node.listeners[event.type] ?? []).slice()) fn.call(node, event)
    }
    return !event.defaultPrevented
  }
}
class FakeElement extends FakeNode {
  tagName: string
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  attributes: Record<string, string> = {}
  style: Record<string, string> = {}
  constructor(doc: FakeDocument, tag: string) { super(doc, 1, tag.toUpperCase()); this.tagName = tag.toUpperCase() }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value) }
  getAttribute(name: string) { return name in this.attributes ? this.attributes[name]! : null }
  removeAttribute(name: string) { delete this.attributes[name] }
  hasAttribute(name: string) { return name in this.attributes }
  get id() { return this.attributes.id ?? '' }
  get hidden() { return 'hidden' in this.attributes }
  set hidden(on: boolean) { if (on) this.attributes.hidden = ''; else delete this.attributes.hidden }
  focus() { this.document().activeElement = this }
  click() { this.dispatchEvent(new FakeEvent('click')) }
}
class FakeText extends FakeNode {
  constructor(doc: FakeDocument, value: string) { super(doc, 3, '#text'); this.nodeValue = value }
}
class FakeEvent {
  type: string
  bubbles = true
  cancelable = true
  defaultPrevented = false
  stopped = false
  timeStamp = Date.now()
  target: FakeNode | null = null
  currentTarget: FakeNode | null = null
  key?: string
  constructor(type: string, init: Record<string, unknown> = {}) { this.type = type; Object.assign(this, init) }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this.stopped = true }
}
class FakeDocument extends FakeNode {
  documentElement: FakeElement
  body: FakeElement
  activeElement: FakeElement
  defaultView: FakeNode
  constructor() {
    super(null, 9, '#document')
    this.defaultView = new FakeNode(null, 0, '#window')
    this.documentElement = new FakeElement(this, 'html')
    this.appendChild(this.documentElement)
    this.body = this.documentElement.appendChild(new FakeElement(this, 'body')) as FakeElement
    this.activeElement = this.body
  }
  createElement(tag: string) { return new FakeElement(this, tag) }
  createElementNS(_ns: string, tag: string) { return new FakeElement(this, tag) }
  createTextNode(value: string) { return new FakeText(this, value) }
  getElementById(id: string): FakeElement | null {
    const walk = (node: FakeNode): FakeElement | null => {
      if (node instanceof FakeElement && node.id === id) return node
      for (const child of node.childNodes) { const hit = walk(child); if (hit) return hit }
      return null
    }
    return walk(this)
  }
}

/* One document for every mount, made the first time one is needed (the
   static renders above run with no document at all): the component listens
   on the document once. */
const doc = new FakeDocument()
let installed = false

async function mount(element: React.ReactElement) {
  if (!installed) {
    installed = true
    Object.assign(globalThis as Record<string, unknown>, { window: doc.defaultView, document: doc, HTMLElement: FakeElement, HTMLIFrameElement: class {}, Event: FakeEvent, IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(doc.defaultView, { document: doc, HTMLElement: FakeElement, HTMLIFrameElement: class {}, Event: FakeEvent, location: { href: 'http://motion.test/' } })
  }
  const { createRoot } = await import('react-dom/client')
  doc.activeElement = doc.body
  const container = doc.body.appendChild(doc.createElement('div')) as FakeElement
  const root = createRoot(container as unknown as HTMLElement)
  await React.act(async () => { root.render(element) })
  const byLabel = (label: string) => {
    const walk = (node: FakeNode): FakeElement | null => {
      if (node instanceof FakeElement && node.getAttribute('aria-label') === label) return node
      for (const child of node.childNodes) { const hit = walk(child); if (hit) return hit }
      return null
    }
    return walk(doc)!
  }
  const noteOf = (button: FakeElement) => doc.getElementById(button.getAttribute('aria-controls')!)!
  const escape = async () => {
    let event = new FakeEvent('keydown', { key: 'Escape' })
    await React.act(async () => { (doc.activeElement ?? doc.body).dispatchEvent(event) })
    return event
  }
  const click = async (el: FakeElement) => { await React.act(async () => { el.click() }) }
  return { doc, root, byLabel, noteOf, escape, click }
}

const A = { label: 'What A does', text: ['A is the first thing on this test page, and this note says so plainly.'] }
const B = { label: 'What B does', text: ['B is the second thing on this test page.', 'It has two sentences in its note.'] }

describe('the toggle', () => {
  it('a press opens the note under it, a second press closes it, and several may be open', async () => {
    const page = await mount(h('div', null, h(Why, { note: A }), h('section', null, h(Why, { note: B }))))
    const a = page.byLabel(A.label), b = page.byLabel(B.label)
    expect(a.tagName).toBe('BUTTON')
    expect(a.getAttribute('type')).toBe('button')
    expect(a.getAttribute('aria-expanded')).toBe('false')
    expect(page.noteOf(a).hidden).toBe(true)
    expect(page.noteOf(a).getAttribute('role')).toBe('note')
    expect(page.noteOf(b).textContent).toBe(B.text.join(''))
    await page.click(a)
    expect(a.getAttribute('aria-expanded')).toBe('true')
    expect(page.noteOf(a).hidden).toBe(false)
    await page.click(b)
    expect(page.noteOf(a).hidden).toBe(false)
    expect(page.noteOf(b).hidden).toBe(false)
    await page.click(a)
    expect(a.getAttribute('aria-expanded')).toBe('false')
    expect(page.noteOf(a).hidden).toBe(true)
    expect(page.noteOf(b).hidden).toBe(false)
    await React.act(async () => { page.root.unmount() })
  })

  it('Escape closes the note the focus is on or in, or the last one opened, and returns the focus to its "?"', async () => {
    const page = await mount(h('div', null, h(Why, { note: A }), h(Why, { note: B }), h('dialog', null, h('button', { type: 'button', 'aria-label': 'Inside a dialog' }, 'x'))))
    const a = page.byLabel(A.label), b = page.byLabel(B.label), inDialog = page.byLabel('Inside a dialog')
    await page.click(a)
    await page.click(b)
    a.focus()
    let event = await page.escape()
    expect(page.noteOf(a).hidden).toBe(true)
    expect(page.noteOf(b).hidden).toBe(false)
    expect(page.doc.activeElement).toBe(a)
    expect(event.defaultPrevented).toBe(true)
    // On a "?" whose note is shut, Escape closes nothing else.
    event = await page.escape()
    expect(page.noteOf(b).hidden).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    // Inside a note: that note closes and the focus goes back to its "?".
    const words = page.noteOf(b).firstChild as FakeElement
    words.focus()
    await page.escape()
    expect(page.noteOf(b).hidden).toBe(true)
    expect(page.doc.activeElement).toBe(b)
    // Nothing focused: the last one opened closes first.
    await page.click(a)
    await page.click(b)
    page.doc.activeElement = page.doc.body
    await page.escape()
    expect(page.noteOf(b).hidden).toBe(true)
    expect(page.noteOf(a).hidden).toBe(false)
    expect(page.doc.activeElement).toBe(b)
    // Inside a dialog, Escape is the dialog's own.
    inDialog.focus()
    event = await page.escape()
    expect(page.noteOf(a).hidden).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    await React.act(async () => { page.root.unmount() })
  })

  it('reads the order of open notes the same way without a DOM', () => {
    const el = (tag: string, attrs: Record<string, string> = {}, parent: unknown = null) =>
      ({ nodeType: 1, tagName: tag, parentNode: parent, getAttribute: (name: string) => attrs[name] ?? null })
    const body = el('BODY')
    const one = { button: () => null, note: () => null, close: () => undefined }
    const two = { button: () => null, note: () => null, close: () => undefined }
    expect(escapeTarget(body, [one, two], body)).toBe(two)
    expect(escapeTarget(null, [], body)).toBeNull()
    expect(escapeTarget(el('INPUT', {}, el('DIV', { role: 'dialog' }, body)), [one, two], body)).toBeNull()
    expect(escapeTarget(el('BUTTON', { class: 'mo-why' }, body), [one, two], body)).toBeNull()
  })
})

/* ------------------------------------------------------------- the look --- */

describe('the look', () => {
  const start = css.lastIndexOf('/*', css.indexOf('.mo-why {'))
  const block = css.slice(start)

  it('is one block of styles.css on MOTION tokens: no hex, no hover, no monospace, nothing under 12px', () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(block).not.toMatch(/rgba?\(/)
    expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('hover')
    expect(block.toLowerCase()).not.toContain('monospace')
    for (const size of block.matchAll(/font-size: (\d+)px/g)) expect(Number(size[1])).toBeGreaterThanOrEqual(12)
    const colours = [...block.matchAll(/(?:^|[\s;{])(?:color|background|border(?:-left)?(?:-color)?|outline): ([^;]+);/g)].map((m) => m[1]!)
    expect(colours.length).toBeGreaterThan(5)
    for (const value of colours) {
      if (/ButtonText|Highlight|transparent|inherit|^0$|none/.test(value)) continue
      expect(value, value).toMatch(/var\(--mo-[a-z-]+\)/)
    }
  })

  it('draws a 28px round "?" with a 44px hit area, a lit state and a visible focus ring', () => {
    expect(block).toMatch(/\.mo-why \{[^}]*width: 28px !important; height: 28px !important;/)
    expect(block).toMatch(/\.mo-why \{[^}]*border-radius: 50% !important;/)
    expect(block).toMatch(/\.mo-why::before \{[^}]*inset: -8px !important;/)
    expect(block).toMatch(/\.mo-why:focus-visible \{[^}]*outline: 2px solid var\(--mo-paper\)/)
    expect(block).toMatch(/\.mo-why\[aria-expanded="true"\] \{[^}]*background: var\(--mo-cyan\)/)
    expect(block).toMatch(/\.mo-why-note \{[^}]*max-width: 65ch;[^}]*font-size: 14px !important;/)
    expect(block).toContain('.mo-why-note[hidden] { display: none !important; }')
  })

  it('keeps the component a plain button with text only, and no hover handlers', () => {
    expect(component).toContain('type="button"')
    expect(component).toContain('aria-expanded={open}')
    expect(component).toContain('aria-controls={id}')
    expect(component).toContain("'Escape'")
    expect(component).not.toMatch(/dangerouslySetInnerHTML|innerHTML|onMouseEnter|onMouseOver|onPointerEnter|localStorage|fetch\(/)
  })
})
