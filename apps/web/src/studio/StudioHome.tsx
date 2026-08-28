import React from 'react'
import { navigate } from '../App.jsx'
import { AsyncBlock, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'
import { studioApi } from './api.js'
import { StageBadge, clock } from './components.jsx'

/**
 * Studio home: the project browser.
 *
 * A record, not a row in a SaaS table. Every project shows where it is in its
 * life, what is waiting on somebody, and what the last thing to happen to it
 * was — the questions a person actually opens this screen to answer.
 */
export function StudioHome() {
  const projects = useAsync(() => studioApi.projects(), [])
  const [creating, setCreating] = React.useState(false)

  return (
    <>
      <div className="topbar">
        <div>
          <h2>Studio</h2>
          <div className="meta">The control room for a record — create, analyze, mix, master, approve, package, release.</div>
        </div>
        <button className="primary" onClick={() => setCreating((value) => !value)}>
          {creating ? 'Cancel' : 'New project'}
        </button>
      </div>

      {creating && <NewProject onCreated={() => { setCreating(false); projects.reload() }} />}

      <AsyncBlock state={projects}>
        {(data) =>
          data.projects.length === 0 ? (
            <Empty>No projects yet. A Studio project is the canonical record for one song — everything else in Street Banker points at it.</Empty>
          ) : (
            <div className="grid cols-2">
              {data.projects.map((row) => (
                <div key={row.project.id} className="card project-card" onClick={() => navigate(`/studio/${row.project.id}`)} role="presentation">
                  <div className="project-head">
                    <div>
                      <div className="project-artist">{row.project.artistName}</div>
                      <h3 className="project-title">{row.project.title}</h3>
                    </div>
                    <StageBadge stage={row.project.stage} />
                  </div>

                  <div className="project-facts">
                    <span>{row.currentVersion ? row.currentVersion.label : 'no audio yet'}</span>
                    <span>{row.versionCount} version{row.versionCount === 1 ? '' : 's'}</span>
                    {row.currentVersion?.durationMs ? <span>{clock(row.currentVersion.durationMs)}</span> : null}
                    {row.project.releaseDate ? <span>release {row.project.releaseDate}</span> : null}
                  </div>

                  <div className="project-facts">
                    {/* A readiness figure with no bands behind it is not a
                        figure; the browser says so rather than printing 0. */}
                    <span>
                      readiness{' '}
                      <strong>{row.readiness?.score === null || row.readiness === null ? 'not enough data' : `${row.readiness.score}/100`}</strong>
                    </span>
                    {row.approvals.length > 0 && <span className="ok-text">approved: {row.approvals.join(', ')}</span>}
                  </div>

                  {row.collaborators.length > 0 && (
                    <div className="faint">{row.collaborators.map((collaborator) => `${collaborator.displayName} (${collaborator.role})`).join(' · ')}</div>
                  )}

                  {row.pendingActions.length > 0 && (
                    <ul className="pending">
                      {row.pendingActions.map((action) => (
                        <li key={action}>{action}</li>
                      ))}
                    </ul>
                  )}
                  <div className="faint">last modified {new Date(row.project.updatedAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )
        }
      </AsyncBlock>
    </>
  )
}

function NewProject({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = React.useState('')
  const [artistName, setArtistName] = React.useState('')
  const [genre, setGenre] = React.useState('')
  const [releaseDate, setReleaseDate] = React.useState('')
  const [rights, setRights] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const capabilities = useAsync(() => studioApi.capabilities(), [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await studioApi.createProject({ title, artistName, genre, rightsConfirmed: rights, ...(releaseDate ? { releaseDate } : {}) })
      onCreated()
      navigate(`/studio/${result.project.id}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="New project">
      <form onSubmit={submit}>
        <div className="field-row">
          <Field label="Artist">
            <input value={artistName} onChange={(event) => setArtistName(event.target.value)} required />
          </Field>
          <Field label="Song title">
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Genre">
            <input value={genre} onChange={(event) => setGenre(event.target.value)} required />
          </Field>
          <Field label="Release date" hint="optional">
            <input type="date" value={releaseDate} onChange={(event) => setReleaseDate(event.target.value)} />
          </Field>
        </div>
        {/* The rights confirmation is not a formality: it writes a consent
            record that every later processing step points back at. */}
        <label className="field checkbox">
          <input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)} />
          <span>{capabilities.data?.rightsStatement ?? 'I confirm I own this recording or am authorized to use it.'}</span>
        </label>
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="button-row">
          <button className="primary" type="submit" disabled={busy || !rights}>
            {busy ? 'creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Card>
  )
}
