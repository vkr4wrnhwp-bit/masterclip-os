import React from 'react'
import { api, type User } from '../api.js'
import { useAsync } from '../ui.jsx'
import { MotionRail, StartDialog } from './motion-shell.jsx'
import {
  deriveProjectRow,
  deriveSpend,
  modeById,
  orderProjects,
  type ProjectRead,
  type ProjectRow,
  type StartMode,
} from './overview-model.js'

/**
 * Every film in the account, newest first.
 *
 * The old dashboard held the only list, and replacing it with the Overview left
 * the workspace with no way to see a film that was not the newest one. This is
 * that list. It wears the Overview's rail and the Overview's tokens, because it
 * is the same room.
 *
 * What a row claims, and what it will not: the name and the brief come straight
 * from `api.projects()`, so every film gets those. The stage and the counts need
 * three more requests each, so they are read for the newest few and the rest say
 * plainly that they were not read. No row ever shows a number it did not see.
 */

/**
 * How many films are read in full.
 *
 * A row's stage and counts cost three requests: the project (which carries its
 * scenes and its shot list together), its queue and its masters. Eight films is
 * twenty four requests, which is a load; eighty films would be two hundred and
 * forty, which is an outage. The Overview makes the same trade at six shots,
 * for the same reason, and like the Overview the interface says which rows the
 * limit caught rather than filling them with zeroes.
 */
const READ_LIMIT = 8

export function Projects({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const projects = useAsync(() => api.projects(), [])
  const providers = useAsync(() => api.providers(), [])

  const ordered = orderProjects(projects.data?.projects ?? [])
  const read = ordered.slice(0, READ_LIMIT)
  const readKey = read.map((item) => item.id).join(',')

  // One entry per film that was read. A film whose requests fail is simply
  // absent from the map, which is the same as not having been read: the row
  // then says so instead of reporting a film with no shots and no renders.
  const details = useAsync(async () => {
    const entries = await Promise.all(
      read.map(async (item): Promise<[string, ProjectRead] | null> => {
        try {
          const [detail, queue, masters] = await Promise.all([api.project(item.id), api.queue(item.id), api.masters(item.id)])
          return [
            item.id,
            {
              sceneCount: detail.scenes.length,
              shotCount: detail.shots.length,
              jobs: queue.jobs,
              masters: masters.masters,
            },
          ]
        } catch {
          return null
        }
      }),
    )
    const map = new Map<string, ProjectRead>()
    for (const entry of entries) if (entry !== null) map.set(entry[0], entry[1])
    // The rail wants a shot to point Review at, and the newest film is always
    // inside the read limit, so this is the one it can offer.
    const firstShot = read[0] ? await api.shots(read[0].id).then((r) => r.shots).catch(() => []) : []
    return { map, firstShot }
  }, [readKey])

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const openerRef = React.useRef<HTMLElement | null>(null)

  const rows: ProjectRow[] = ordered.map((item) => deriveProjectRow(item, details.data?.map.get(item.id) ?? null))
  const spend = deriveSpend(providers.data, providers.loading)
  const unread = rows.filter((row) => !row.stageKnown).length
  const sampled = rows.some((row) => row.renderedSampled)

  // Before the first detail read answers, every row is unread, and a row that
  // says "not read on this page" while the page is reading it is a lie with a
  // short life. The words that go in the facts while that is true:
  const pending = details.loading && details.data === null
  const fact = (value: string) => (pending ? 'Reading' : value)

  // One primary action, the Overview's own dialog. The Overview picks the mode
  // with its three cards; a list has no room for that question, so it opens on
  // the one mode whose field the app really does use, the brief.
  const mode: StartMode = modeById('idea')

  const start = (event: React.MouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget
    setDialogOpen(true)
  }

  return (
    <div className="mo">
      <a className="mo-skip" href="#mo-main">
        Skip to main content
      </a>

      <MotionRail
        user={user}
        onSignOut={onSignOut}
        current="projects"
        spend={spend}
        projects={ordered}
        shots={details.data?.firstShot ?? []}
        shotsProject={null}
        searchLabel="Search your films by name or brief"
      />

      <div className="mo-shell">
        <main className="mo-main" id="mo-main">
          <section className="mo-list-head" aria-labelledby="mo-list-heading">
            <div>
              <p className="mo-eyebrow">A DIRECTOR&rsquo;S ROOM</p>
              <h1 id="mo-list-heading">Your films.</h1>
              <p className="mo-support">Every film in this account, newest first.</p>
            </div>
            <button type="button" className="mo-start" onClick={start}>
              START A NEW FILM <span aria-hidden="true">&rarr;</span>
            </button>
          </section>

          {projects.error !== null && projects.data === null && (
            <p className="mo-quiet-note" role="status">
              Your films could not be read. {projects.error}
            </p>
          )}

          {projects.loading && projects.data === null ? (
            <p className="mo-quiet-note" role="status">
              Reading your films.
            </p>
          ) : rows.length === 0 ? (
            <p className="mo-list-empty" aria-live="polite">
              No films here yet. Start a new film above and it will be listed here.
            </p>
          ) : (
            <>
              <ul className="mo-list">
                {rows.map((row) => (
                  <li className="mo-list-row" key={row.id}>
                    <div className="mo-list-main">
                      <h2>
                        <a href={`#${row.href}`}>{row.name}</a>
                      </h2>
                      <p className="mo-list-brief">{row.brief ?? 'No brief written yet.'}</p>
                    </div>
                    {/* Three labelled facts rather than three bare numbers.
                        The label is visible, so the row reads the same to
                        somebody who cannot see the column it sits under. */}
                    <dl className="mo-list-facts">
                      <div>
                        <dt>Stage</dt>
                        <dd>{fact(row.stageLabel)}</dd>
                      </div>
                      <div>
                        <dt>Shots</dt>
                        <dd>{fact(row.shotLine)}</dd>
                      </div>
                      <div>
                        <dt>Rendered</dt>
                        <dd>{fact(row.renderedLine)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>

              {pending && (
                <p className="mo-quiet-note" role="status">
                  Reading the stage and counts for the newest {read.length === 1 ? 'film' : `${read.length} films`}.
                </p>
              )}

              {!pending && unread > 0 && (
                <p className="mo-quiet-note">
                  {unread === 1 ? 'One film was' : `${unread} films were`} not read on this page. Open a film for its stage and counts.
                </p>
              )}

              {sampled && (
                <p className="mo-quiet-note">
                  A render count marked &ldquo;at least&rdquo; was counted from the most recent jobs only, because that film has more jobs
                  than one read returns.
                </p>
              )}

              <p className="mo-quiet-note">
                A stage is read from each film&rsquo;s scenes, shots, queue and masters. A take that was approved and never promoted leaves
                nothing to read here, so a film can show one stage behind the one it is really at.
              </p>
            </>
          )}
        </main>
      </div>

      {dialogOpen && (
        <StartDialog
          mode={mode}
          onClose={() => {
            setDialogOpen(false)
            // Focus goes back to the button that opened the dialog.
            openerRef.current?.focus()
          }}
          onCreated={() => {
            projects.reload()
            setDialogOpen(false)
          }}
        />
      )}
    </div>
  )
}
