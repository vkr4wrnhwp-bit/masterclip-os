import React from 'react'
import { api, type OutputView, type Project, type User } from '../api.js'
import { useAsync } from '../ui.jsx'
import { MotionRail, StartDialog } from './motion-shell.jsx'
import {
  countJobs,
  countMasters,
  deriveShotCard,
  deriveSpend,
  deriveStage,
  modeById,
  orderProjects,
  STAGES,
  START_MODES,
  type ShotCard,
  type StartMode,
} from './overview-model.js'

// The rail and the dialog are shared with the film list and live in
// motion-shell now. The dialog is re-exported because this module was its
// address first and everything that imported it from here still can.
export { StartDialog }

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

export function Overview({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const projects = useAsync(() => api.projects(), [])
  const providers = useAsync(() => api.providers(), [])

  // The newest film is the one this screen talks about. Sorting on the
  // timestamp rather than trusting list order keeps that true if the API's
  // ordering ever changes.
  const ordered = orderProjects(projects.data?.projects ?? [])
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

  return (
    <div className="mo">
      <a className="mo-skip" href="#mo-main">
        Skip to main content
      </a>

      <MotionRail
        user={user}
        onSignOut={onSignOut}
        current="overview"
        spend={spend}
        projects={ordered}
        shots={film.data?.shots ?? []}
        shotsProject={newest}
        searchLabel="Search your films and the shots in the film shown here"
      />

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
              {/* The heading names the film. The band only ever shows the
                  newest one, and a storyboard with no name on it invites the
                  reader to take it for the whole workspace. The name is also
                  the way into that film.

                  Nothing else sits beside the heading. The owner's design fills
                  this slot with a label, not a control, and the second link
                  that stood here went to the film list, which the rail's own
                  Projects item already reaches from this screen and every
                  other one. */}
              <h2 id="mo-opening-heading">
                Your storyboard for <a href={`#/project/${newest.id}`}>{newest.name}</a>, before the spend.
              </h2>
              <p>Approve the visual story, then render only the shots that earn it.</p>

              {cards.length === 0 ? (
                <p className="mo-quiet-note">
                  {film.loading ? (
                    'Reading the shot list.'
                  ) : (
                    <>
                      {newest.name} has no shots yet. <a href={`#/project/${newest.id}`}>Open the film</a> to build the shot list.
                    </>
                  )}
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
