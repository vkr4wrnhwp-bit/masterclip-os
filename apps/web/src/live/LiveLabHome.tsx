import React from 'react'
import { navigate } from '../App.jsx'
import { api } from '../api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'
import { liveApi } from './api.js'

/**
 * Live Lab home: build a live set from what the artist already has, and get
 * back into recent shows fast.
 */
export function LiveLabHome() {
  const projects = useAsync(() => liveApi.projects(), [])
  const sources = useAsync(() => api.projects(), [])
  const [mode, setMode] = React.useState<'none' | 'blank' | 'import' | 'duplicate'>('none')
  const [name, setName] = React.useState('')
  const [tempo, setTempo] = React.useState('120')
  const [sourceId, setSourceId] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { project } = await liveApi.createProject({
        name: name || 'Untitled Set',
        masterTempo: Number(tempo) || 120,
        ...(mode === 'duplicate' && sourceId ? { duplicateOf: sourceId } : {}),
      })
      if (mode === 'import' && sourceId) {
        await liveApi.importRelease(project.id, sourceId)
      }
      navigate(`/live-lab/projects/${project.id}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="topbar">
        <h2>Live Lab</h2>
        <div className="meta">Turn your releases, stems and generated sections into a stage-ready, MIDI-controlled show.</div>
      </div>

      <Card title="BUILD MY LIVE SET">
        <div className="button-row" style={{ marginBottom: 12 }}>
          <button className={mode === 'import' ? 'primary' : ''} onClick={() => setMode('import')}>
            Import Street Banker release
          </button>
          <button className={mode === 'blank' ? 'primary' : ''} onClick={() => setMode('blank')}>
            Start from blank set
          </button>
          <button className={mode === 'duplicate' ? 'primary' : ''} onClick={() => setMode('duplicate')}>
            Duplicate existing live set
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Owned audio, stems and Remix Lab versions are imported inside the project workspace once the set exists.
        </div>
        {mode !== 'none' && (
          <div>
            <Field label="Set name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fall Tour 2026" />
            </Field>
            <Field label="Master tempo (BPM)">
              <input value={tempo} onChange={(e) => setTempo(e.target.value)} style={{ width: 90 }} />
            </Field>
            {mode === 'import' && (
              <Field label="Source release" hint="audio assets of a project in your organization">
                <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">choose…</option>
                  {sources.data?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {mode === 'duplicate' && (
              <Field label="Live set to duplicate">
                <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  <option value="">choose…</option>
                  {projects.data?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="button-row">
              <button className="primary" disabled={busy || (mode !== 'blank' && !sourceId)} onClick={() => void create()}>
                {busy ? 'creating…' : 'Create live set'}
              </button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Recent live sets">
        <AsyncBlock state={projects}>
          {(data) =>
            data.projects.length === 0 ? (
              <Empty>No live sets yet. Build one above — the demo seed also creates an “Example Artist” set.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Set</th>
                    <th>Songs</th>
                    <th>Tempo</th>
                    <th>Performance package</th>
                    <th>Last edited</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((project) => (
                    <tr key={project.id}>
                      <td>
                        <strong>{project.name}</strong>
                        {project.description && <div className="faint">{project.description}</div>}
                      </td>
                      <td>
                        {project.songCount} songs · {project.itemCount} items
                      </td>
                      <td>{project.masterTempo} BPM</td>
                      <td>
                        {project.latestPackage ? (
                          <Badge tone={project.latestPackage.status === 'ready' ? 'ok' : project.latestPackage.status === 'error' ? 'danger' : 'warn'}>
                            v{project.latestPackage.version} {project.latestPackage.status.toUpperCase()}
                          </Badge>
                        ) : (
                          <Badge>NOT READY</Badge>
                        )}
                      </td>
                      <td className="faint">{new Date(project.updatedAt).toLocaleString()}</td>
                      <td>
                        <button className="small" onClick={() => navigate(`/live-lab/projects/${project.id}`)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </AsyncBlock>
      </Card>
    </div>
  )
}
