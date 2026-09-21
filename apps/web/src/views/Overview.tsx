import React from 'react'
import { api, type OutputView, type Project, type User } from '../api.js'
import { navigate, streetBankerUrl } from '../App.jsx'
import { useAsync } from '../ui.jsx'
import {
  countJobs,
  countMasters,
  deriveShotCard,
  deriveSpend,
  deriveStage,
  modeById,
  railItems,
  searchWorkspace,
  STAGES,
  START_MODES,
  tabTrap,
  type ShotCard,
  type StartMode,
} from './overview-model.js'

/**
 * Motion's front door, built from the owner's approved design file.
 *
 * The structure, the type, the spacing and the CSS soundstage come from that
 * file. Everything the screen says comes from the API: the stage row reports
 * where the newest film actually stands, a storyboard card is only ever
 * rendered when a real output exists, and the budget card shows the real mode
 * and the real cap. The design file was a prototype with a session-only project
 * and drawn example frames; none of that is here.
 */

/**
 * How many shots the storyboard band reads takes for.
 *
 * There is no project-wide outputs endpoint, so takes are fetched one shot at a
 * time. Six is the row the design draws; firing fifty requests to fill a screen
 * nobody scrolled would be the wrong trade. The stage row is told when the read
 * was partial so it can refuse to claim anything it did not see.
 */
const BAND_LIMIT = 6

/** Ordered the way the owner's prototype ordered them, for the Tab loop. */
const FOCUSABLE = 'button,input,textarea,select,a[href]'

export function Overview({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const projects = useAsync(() => api.projects(), [])
  const providers = useAsync(() => api.providers(), [])

  // The newest film is the one this screen talks about. Sorting on the
  // timestamp rather than trusting list order keeps that true if the API's
  // ordering ever changes.
  const ordered = [...(projects.data?.projects ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const newest: Project | null = ordered[0] ?? null
  const newestId = newest?.id ?? ''

  const film = useAsync(async () => {
    if (newestId.length === 0) return null
    const [detail, shotList, queue, masters] = await Promise.all([
      api.project(newestId),
      api.shots(newestId),
      api.queue(newestId),
      api.masters(newestId),
    ])
    const band = shotList.shots.slice(0, BAND_LIMIT)
    // One take list per card. A shot whose takes cannot be read is shown as
    // unrendered, which is the safe direction to be wrong in.
    const takes = await Promise.all(band.map((shot) => api.outputs(shot.id).then((r) => r.outputs).catch((): OutputView[] => [])))
    return { detail, shots: shotList.shots, band, takes, queue, masters }
  }, [newestId])

  const [modeId, setModeId] = React.useState(START_MODES[0]!.id)
  const [dialogMode, setDialogMode] = React.useState<StartMode | null>(null)
  const [query, setQuery] = React.useState('')
  const openerRef = React.useRef<HTMLElement | null>(null)

  const mode = modeById(modeId)

  const jobs = countJobs(film.data?.queue.jobs ?? [])
  const masterCounts = countMasters(film.data?.masters.masters ?? [])
  const takes = film.data?.takes ?? []
  const stage = deriveStage({
    hasProject: newest !== null,
    briefLength: (newest?.brief ?? '').trim().length,
    sceneCount: film.data?.detail.scenes.length ?? 0,
    shotCount: film.data?.shots.length ?? 0,
    renderJobCount: jobs.renderJobCount,
    completedJobCount: jobs.completedJobCount,
    approvedOutputCount: takes.flat().filter((take) => take.status === 'approved' || take.status === 'promoted').length,
    outputsCoverEveryShot: (film.data?.band.length ?? 0) === (film.data?.shots.length ?? 0),
    masterCount: masterCounts.masterCount,
    deliveredMasterCount: masterCounts.deliveredMasterCount,
  })

  const cards: ShotCard[] = (film.data?.band ?? []).map((shot, index) => deriveShotCard(shot, takes[index] ?? [], index))
  const spend = deriveSpend(providers.data, providers.loading)
  const hits = searchWorkspace(query, ordered, film.data?.shots ?? [], newest)
  const rail = railItems(newestId.length > 0 ? newestId : null, film.data?.shots[0]?.id ?? null)

  return (
    <div className="mo">
      <a className="mo-skip" href="#mo-main">
        Skip to main content
      </a>

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
          <label className="mo-sr" htmlFor="mo-search">
            Search your films and the shots in the film shown here
          </label>
          {/* The placeholder is the design file's own. The longer "Search your
              workspace" overruns the 214px rail at these measurements, so the
              file's value is the one that fits the file's rail. The label above
              carries the full, honest scope of what is searched. */}
          <input
            type="search"
            id="mo-search"
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
              <a
                key={item.key}
                className="mo-nav-item"
                href={`#${item.href}`}
                aria-current={item.key === 'overview' ? 'page' : undefined}
              >
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

      <div className="mo-shell">
        {/* The soundstage is drawn in CSS, because this repository holds no
            photograph and the screen will not ship a binary to get one. To use
            a real photograph instead, set a single custom property and nothing
            else changes:  .mo-scenery { --mo-hero-image: url("/hero.jpg"); }
            It paints over the drawn layers and is already sized to cover. */}
        <div
          className="mo-scenery"
          role="img"
          aria-label="Drawing of an empty soundstage with a lit doorway, road cases and a light stand"
        >
          <div className="mo-wall" />
          <div className="mo-rig" />
          <div className="mo-floor" />
          <div className="mo-light" />
          <div className="mo-door" />
          <div className="mo-roadcase" />
          <div className="mo-roadcase mo-case-two" />
          <div className="mo-stand" />
        </div>

        <main className="mo-main" id="mo-main">
          <p className="mo-topline">Create something extraordinary.</p>

          <section className="mo-hero" aria-labelledby="mo-hero-heading">
            <p className="mo-eyebrow">A DIRECTOR&rsquo;S ROOM</p>
            <h1 id="mo-hero-heading">Start a new film.</h1>
            <p className="mo-support">Ideas in. Films out. A faster, sharper way to make extraordinary music videos.</p>
          </section>

          {/* A real radio group: name-grouped native inputs inside their labels,
              inside a fieldset. Arrow keys, Space and the roving tab stop are
              the platform's, which is stronger than any hand-rolled version. */}
          <fieldset className="mo-modes">
            <legend className="mo-sr">Choose a starting point</legend>
            <div className="mo-cards">
              {START_MODES.map((item) => (
                <label className="mo-mode" key={item.id}>
                  <input
                    type="radio"
                    name="mo-mode"
                    value={item.id}
                    checked={item.id === modeId}
                    onChange={() => setModeId(item.id)}
                  />
                  {/* The selection is a mark as well as a border colour, so it
                      reads on a monochrome screen. */}
                  <span className="mo-selection" aria-hidden="true">
                    &#10003;
                  </span>
                  <ModeIcon id={item.id} />
                  <strong>{item.title}</strong>
                  <small>
                    {item.description[0]}
                    <br />
                    {item.description[1]}
                  </small>
                  <span className="mo-chevron" aria-hidden="true">
                    &rsaquo;
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <section className="mo-workflow" aria-label={`Production sequence, now at ${stage.label}`}>
            <ol className="mo-stages">
              {STAGES.map((item, index) => {
                const position = index + 1
                const state = stage.complete || position < stage.index ? 'done' : position === stage.index ? 'current' : 'ahead'
                return (
                  <li key={item.key} className={`mo-stage is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
                    <span className="mo-circle">{position}</span>
                    <span className="mo-stage-label">
                      {item.label.toUpperCase()}
                      {state === 'current' && <span className="mo-stage-now">{stage.caption}</span>}
                      <span className="mo-sr">
                        {state === 'done' ? ', behind you' : state === 'current' ? ', where the film is now' : ', not started'}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ol>
            <button
              type="button"
              className="mo-start"
              aria-label={mode.actionLabel}
              onClick={() => {
                openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
                setDialogMode(mode)
              }}
            >
              LET&rsquo;S GO <span aria-hidden="true">&rarr;</span>
            </button>
          </section>

          {film.error !== null && film.data === null && (
            <p className="mo-quiet-note" role="status">
              The film on this screen could not be read. {film.error}
            </p>
          )}

          {newest === null ? (
            <section className="mo-opening" aria-labelledby="mo-opening-heading" aria-live="polite">
              <h2 id="mo-opening-heading">No films here yet.</h2>
              <p>Choose a starting point above to create your first brief.</p>
            </section>
          ) : (
            <section className="mo-opening" aria-labelledby="mo-opening-heading">
              <div className="mo-opening-head">
                <div>
                  <h2 id="mo-opening-heading">Your storyboard, before the spend.</h2>
                  <p>Approve the visual story, then render only the shots that earn it.</p>
                </div>
                <a className="mo-opening-link" href={`#/project/${newest.id}`}>
                  Open this film <span aria-hidden="true">&rarr;</span>
                </a>
              </div>

              {cards.length === 0 ? (
                <p className="mo-quiet-note">
                  {film.loading ? 'Reading the shot list.' : `${newest.name} has no shots yet. Open it to build the shot list.`}
                </p>
              ) : (
                <>
                  <div className="mo-shots">
                    {cards.map((card) => (
                      <article className="mo-shot" key={card.shotId}>
                        <div className="mo-shot-frame">
                          <span className="mo-num">{card.number}</span>
                          {card.stillUrl !== null ? (
                            <img className="mo-still" src={card.stillUrl} alt={`Still frame from ${card.title}`} />
                          ) : card.rendered ? (
                            <p className="mo-frame-note">No still frame was kept.</p>
                          ) : null}
                        </div>
                        <div className="mo-shot-info">
                          <div className="mo-shot-heading">
                            <h3>
                              <a href={`#/shot/${card.shotId}`}>{card.title}</a>
                            </h3>
                            <span>{card.durationLabel}</span>
                          </div>
                          <div className="mo-shot-foot">
                            <span>{card.note}</span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                  {film.data !== null && film.data.shots.length > cards.length && (
                    <p className="mo-quiet-note">
                      The first {cards.length} shots of {film.data.shots.length}. Open the film for the whole list.
                    </p>
                  )}
                </>
              )}
              <p className="mo-quiet-note">{stage.reason}</p>
            </section>
          )}
        </main>
      </div>

      {dialogMode !== null && (
        <StartDialog
          mode={dialogMode}
          onClose={() => {
            setDialogMode(null)
            // Focus goes back where it came from, which is the primary button
            // unless a keyboard user reached the dialog some other way.
            openerRef.current?.focus()
          }}
          onCreated={() => {
            projects.reload()
            setDialogMode(null)
          }}
        />
      )}
    </div>
  )
}

function ModeIcon({ id }: { id: StartMode['id'] }) {
  if (id === 'audio') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 9v6m4-10v14m5-17v20m5-17v14m4-10v6" />
      </svg>
    )
  }
  if (id === 'idea') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 3h10l4 4v14H5zm10 0v5h4M8 12h8m-8 4h6" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8h13v13H8zM3 16V3h13v5" />
    </svg>
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
