import React from 'react'

/**
 * The "?" on a section, a feature or a group of controls (owner, 2026-10-18:
 * "this question mark should go everywhere"). The main app's Rack and the six
 * V2 suites have the same control; this is MOTION's, in React.
 *
 * A real <button> with aria-expanded and aria-controls. Pressing it (tap,
 * click, Enter or Space) shows a short note in plain words right under the
 * thing it explains, and pressing it again puts the note away. Several notes
 * may be open at once. Escape closes the note the focus is in or on, or, with
 * nothing focused, the last one opened, and puts the focus back on its "?".
 * Escape inside a dialog (the start dialog, the Learn MOTION guide) is the
 * dialog's own. There is no hover anywhere (owner rule). The words are plain
 * text, written in why-notes.ts; React escapes them.
 *
 * The look is `.mo-why` and `.mo-why-note` in styles.css, on the --mo-* tokens.
 */

export interface WhyNote {
  /** The button's accessible name. It starts "What ". */
  label: string
  /** Two to four short sentences, as one to three paragraphs. */
  text: readonly string[]
}

/** One open note, in the order the notes were opened. */
interface OpenNote {
  button: () => HTMLElement | null
  note: () => HTMLElement | null
  close: () => void
}

const opened: OpenNote[] = []
let listening = false

/** The smallest piece of an element Escape needs to look at. */
interface Walkable {
  parentNode: unknown
  nodeType?: number
  tagName?: string
  getAttribute?: (name: string) => string | null
}

function walkUp(start: Walkable | null, test: (node: Walkable) => boolean): boolean {
  let node: Walkable | null = start
  while (node && node.nodeType === 1) {
    if (test(node)) return true
    node = (node.parentNode as Walkable | null) ?? null
  }
  return false
}

function isDialog(node: Walkable): boolean {
  const role = node.getAttribute?.('role') ?? null
  return node.tagName === 'DIALOG' || role === 'dialog' || node.getAttribute?.('aria-modal') === 'true'
}

function isWhyButton(node: unknown): boolean {
  const el = node as Walkable | null
  const cls = el?.getAttribute?.('class') ?? ''
  return el?.tagName === 'BUTTON' && cls.split(/\s+/).includes('mo-why')
}

/**
 * Which open note Escape is about: the one the focus is in, the one whose "?"
 * has the focus, or, with the focus nowhere in particular, the last one
 * opened. A "?" whose note is shut, or a focus inside a dialog, closes nothing.
 */
export function escapeTarget(active: unknown, notes: readonly OpenNote[] = opened, body?: unknown): OpenNote | null {
  const focus = (active ?? null) as Walkable | null
  for (let i = notes.length - 1; i >= 0; i--) {
    const entry = notes[i]!
    const note = entry.note()
    if (note && walkUp(focus, (node) => node === (note as unknown))) return entry
    if (focus !== null && entry.button() === (focus as unknown)) return entry
  }
  if (isWhyButton(focus)) return null
  const resting = focus === null || focus === body || focus.tagName === 'BODY' || focus.tagName === 'HTML'
  if (!resting && walkUp(focus, isDialog)) return null
  return notes.length > 0 ? notes[notes.length - 1]! : null
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' && event.key !== 'Esc') return
  const entry = escapeTarget(document.activeElement, opened, document.body)
  if (!entry) return
  const button = entry.button()
  entry.close()
  button?.focus()
  event.preventDefault()
  event.stopPropagation()
}

function listen(): void {
  if (listening || typeof document === 'undefined') return
  listening = true
  // The capture phase, so the note closes before anything that listens later
  // (a page's own Escape) sees the key.
  document.addEventListener('keydown', onKeyDown, true)
}

/**
 * The "?" and its note as two elements, for a heading whose row cannot hold
 * the note: the button goes beside the heading and the note under the row.
 */
export function useWhy(note: WhyNote): { button: React.ReactElement; panel: React.ReactElement; open: boolean } {
  const [open, setOpen] = React.useState(false)
  const id = 'mo-why-' + React.useId().replace(/[^A-Za-z0-9_-]/g, '')
  const buttonRef = React.useRef<HTMLButtonElement | null>(null)
  const noteRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => { listen() }, [])
  React.useEffect(() => {
    if (!open) return
    const entry: OpenNote = { button: () => buttonRef.current, note: () => noteRef.current, close: () => setOpen(false) }
    opened.push(entry)
    return () => {
      const at = opened.indexOf(entry)
      if (at !== -1) opened.splice(at, 1)
    }
  }, [open])

  const button = (
    <button
      ref={buttonRef}
      type="button"
      className="mo-why"
      aria-expanded={open}
      aria-controls={id}
      aria-label={note.label}
      onClick={() => setOpen((was) => !was)}
    >
      ?
    </button>
  )
  const panel = (
    <div ref={noteRef} className="mo-why-note" id={id} role="note" hidden={!open}>
      {note.text.map((line, index) => (
        <p key={index}>{line}</p>
      ))}
    </div>
  )
  return { button, panel, open }
}

/** The "?" followed by its note, for a row that lets the note drop under it. */
export function Why({ note }: { note: WhyNote }) {
  const why = useWhy(note)
  return (
    <>
      {why.button}
      {why.panel}
    </>
  )
}

/**
 * A heading with its "?" beside it and the note under both. `as` is the
 * heading's own element, so a page keeps its outline.
 */
export function WhyHeading({
  as: Tag = 'h2',
  note,
  className,
  children,
}: {
  as?: 'h1' | 'h2' | 'h3' | 'h4'
  note: WhyNote
  className?: string
  children: React.ReactNode
}) {
  const why = useWhy(note)
  return (
    <div className={`mo-why-row${className ? ` ${className}` : ''}`}>
      <Tag>{children}</Tag>
      {why.button}
      {why.panel}
    </div>
  )
}
