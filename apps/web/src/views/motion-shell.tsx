import React from 'react'
import { api, type Project, type Shot, type User } from '../api.js'
import { navigate, streetBankerUrl } from '../App.jsx'
import { railItems, searchWorkspace, tabTrap, type RailItem, type SpendReading, type StartMode } from './overview-model.js'

/**
 * The parts of Motion's front door that more than one screen needs.
 *
 * The rail and the start dialog were written for the Overview and lived in it.
 * The film list needs both, and the one thing worse than a second rail is a
 * second rail that drifts, so they moved here whole: same markup, same tokens,
 * same behaviour, with the two things that differ between screens, which rail
 * item is current and what the search field covers, passed in.
 */

/** Ordered the way the owner's prototype ordered them, for the Tab loop. */
const FOCUSABLE = 'button,input,textarea,select,a[href]'

/**
 * The rail: brand, search, sections, spend posture, account, the way out.
 *
 * It owns the search box because the search is over what the screen already
 * loaded and nothing else, which is the only honest search this API supports.
 * `searchLabel` is the screen's own, because only the screen knows what it
 * handed over: the Overview passes its films and the shot list of the film it
 * is showing, the film list passes films alone.
 */
export function MotionRail({
  user,
  onSignOut,
  current,
  spend,
  projects,
  shots,
  shotsProject,
  searchLabel,
}: {
  user: User
  onSignOut: () => void
  /** The `RailItem` key of the screen showing this rail. */
  current: string
  spend: SpendReading
  projects: readonly Project[]
  shots: readonly Shot[]
  /** The film `shots` belong to, or null when no shot list was handed over. */
  shotsProject: Project | null
  searchLabel: string
}) {
  const [query, setQuery] = React.useState('')
  const searchId = `mo-search-${current}`

  const newest = projects[0] ?? null
  const rail: RailItem[] = railItems(newest?.id ?? null, shots[0]?.id ?? null)
  const hits = searchWorkspace(query, projects, shots, shotsProject)

  return (
    <aside className="mo-rail" aria-label="Motion workspace">
      <div className="mo-brand">
        {/* The suite mark itself, a bracket frame around the monogram in
            Motion's own cyan. It is the same mark the strip in Street Banker
            shows, so a person recognises where they have arrived. */}
        <img className="mo-mark" src="/motion-mark.png" alt="" width={128} height={128} />
        <div className="mo-wordmark">MOTION</div>
      </div>

      <form className="mo-search" role="search" onSubmit={(event) => event.preventDefault()}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10" cy="10" r="6.5" />
          <path d="m15 15 6 6" />
        </svg>
        <label className="mo-sr" htmlFor={searchId}>
          {searchLabel}
        </label>
        {/* The placeholder is the design file's own. The longer "Search your
            workspace" overruns the 214px rail at these measurements, so the
            file's value is the one that fits the file's rail. The label above
            carries the full, honest scope of what is searched. */}
        <input
          type="search"
          id={searchId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search workspace"
          autoComplete="off"
        />
      </form>

      {query.trim().length > 0 && (
        <div className="mo-results">
          <p className="mo-results-status" aria-live="polite">
            {hits.length === 0 ? 'Nothing matches that.' : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}.`}
          </p>
          {hits.length > 0 && (
            <ul className="mo-results-list">
              {hits.map((hit) => (
                <li key={`${hit.kind}-${hit.id}`}>
                  <a href={`#${hit.href}`}>
                    <span className="mo-results-label">{hit.label}</span>
                    <span className="mo-results-context">{hit.context}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <nav className="mo-nav" aria-label="Workspace">
        {rail.map((item) =>
          item.href === null ? (
            <span key={item.key} className="mo-nav-item is-unavailable" aria-disabled="true">
              {item.label}
            </span>
          ) : (
            <a key={item.key} className="mo-nav-item" href={`#${item.href}`} aria-current={item.key === current ? 'page' : undefined}>
              {item.label}
            </a>
          ),
        )}
      </nav>
      {/* Outside the <nav> on purpose: on a phone the nav is a horizontally
          scrolling strip, and a sentence inside it ends up parked off the
          right-hand edge where nobody will find it. */}
      {rail.some((item) => item.href === null) && (
        <p className="mo-nav-note">The dimmed sections open once there is a film for them to show.</p>
      )}

      <div className="mo-rail-foot">
        <section className="mo-budget" aria-label="Spend posture">
          <h2>{spend.modeLabel}</h2>
          <p>{spend.line}</p>
          {/* The second line exists for one reason: an unconfigured cap is
              still a cap, and saying only "Cap not set." would read as "spend
              what you like". */}
          {spend.detail !== null && <p className="mo-budget-note">{spend.detail}</p>}
        </section>

        <div className="mo-account">
          <div>
            <strong>{user.displayName}</strong>
            <small title={user.email}>{user.email}</small>
          </div>
          <button
            type="button"
            className="mo-icon-button"
            onClick={onSignOut}
            aria-label="Sign out and return to Street Banker"
            title="Sign out and return to Street Banker"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M13 4H5v16h8m0-8h9m-4-4 4 4-4 4" />
            </svg>
          </button>
        </div>

        <a className="mo-return" href={streetBankerUrl()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m15 4-8 8 8 8" />
          </svg>
          Return to Street Banker.
        </a>

        <p className="mo-motto">
          DIRECTORS
          <br />
          MOVE
          <br />
          DIFFERENTLY.
        </p>
      </div>
    </aside>
  )
}

/**
 * The dialog behind the primary action.
 *
 * A native `<dialog>` opened with `showModal`, as the owner's file has it: the
 * rest of the page goes inert, Escape closes it and the backdrop is the
 * browser's. The explicit role and aria-modal are kept from that file, the
 * opener is refocused on close, and Tab is held inside the panel.
 *
 * It creates the film through `api.createProject` and then goes to it, which is
 * exactly what the form this screen replaced did.
 */
export function StartDialog({ mode, onClose, onCreated }: { mode: StartMode; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = React.useState('')
  const [brief, setBrief] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const dialogRef = React.useRef<HTMLDialogElement | null>(null)
  const nameRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    const element = dialogRef.current
    // Guard the call itself: `showModal` does not exist in a server render and
    // is absent from a few older engines, and the screen behind must not break.
    if (element && typeof element.showModal === 'function' && !element.open) element.showModal()
    nameRef.current?.focus()
    return () => {
      if (element?.open) element.close()
    }
  }, [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (element) => !(element as HTMLInputElement).disabled && element.getClientRects().length > 0,
    )
    const target = tabTrap(event.key, event.shiftKey, controls.indexOf(document.activeElement as HTMLElement), controls.length)
    if (target === null) return
    event.preventDefault()
    controls[target]?.focus()
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.createProject(name.trim(), brief)
      onCreated()
      navigate(`/project/${result.project.id}`)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <dialog
      className="mo-dialog"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="mo-setup-heading"
      aria-describedby="mo-setup-description"
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="mo-dialog-head">
          <span className="mo-eyebrow">{mode.title.toUpperCase()}</span>
          <button type="button" className="mo-icon-button" onClick={onClose} aria-label="Close project setup">
            &#10005;
          </button>
        </div>
        <h2 id="mo-setup-heading">{mode.dialogTitle}</h2>
        <p id="mo-setup-description">Name the film and give it a starting point.</p>

        <label>
          Project name
          <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoComplete="off" />
        </label>
        <label>
          {mode.fieldLabel}
          <textarea value={brief} onChange={(event) => setBrief(event.target.value)} />
        </label>

        <p className="mo-account-note">{mode.next}</p>

        {error !== null && (
          <p className="mo-dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="mo-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="mo-start" type="submit" disabled={busy || name.trim().length === 0}>
            {busy ? 'Creating' : 'Create the film'} <span aria-hidden="true">&rarr;</span>
          </button>
        </div>
      </form>
    </dialog>
  )
}
