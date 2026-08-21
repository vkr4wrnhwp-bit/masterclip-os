import React from 'react'
import { api } from '../api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, Stat, statusTone, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'

export function Dashboard() {
  const projects = useAsync(() => api.projects(), [])
  const providers = useAsync(() => api.providers(), [])
  const [name, setName] = React.useState('')
  const [brief, setBrief] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const result = await api.createProject(name, brief)
      navigate(`/project/${result.project.id}`)
      projects.reload()
      setName('')
      setBrief('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Dashboard</h2>
        <div className="meta">
          {providers.data ? (
            <>
              live spend {providers.data.liveSpentUsd} of ${providers.data.liveSpendCapUsd.toFixed(2)} authorized
            </>
          ) : null}
        </div>
      </div>

      {providers.data && providers.data.mode === 'sandbox' && (
        <Callout tone="ok" title="Sandbox mode">
          Every render runs against the local ffmpeg mock provider, which produces real MP4 files — including deliberately defective ones — so the whole
          pipeline can be exercised at zero cost. Set <code className="mono">MASTERCLIP_MODE=live</code> and configure a provider key to spend.
        </Callout>
      )}

      <div className="grid cols-2" style={{ marginBottom: 18 }}>
        <Card title="Projects">
          <AsyncBlock state={projects}>
            {(data) =>
              data.projects.length === 0 ? (
                <Empty>No projects yet — create one on the right.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.projects.map((project) => (
                      <tr key={project.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/project/${project.id}`)}>
                        <td>{project.name}</td>
                        <td>
                          <Badge tone={statusTone(project.status)}>{project.status}</Badge>
                        </td>
                        <td className="faint">{project.createdAt.slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </AsyncBlock>
        </Card>

        <Card title="New project">
          <form onSubmit={create}>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Neon Rain — single" />
            </Field>
            <Field label="Creative brief" hint="what the piece is about; the style bible starts from the cinematic standard">
              <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} />
            </Field>
            {error && <Callout tone="danger">{error}</Callout>}
            <button className="primary" type="submit" disabled={creating || name.length === 0}>
              {creating ? 'creating…' : 'Create project'}
            </button>
          </form>
        </Card>
      </div>

      <Card title="Provider health">
        <AsyncBlock state={providers}>
          {(data) => (
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Credentials</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map((provider) => {
                  const health = provider.health as { status?: string; message?: string } | null
                  return (
                    <tr key={provider.providerId}>
                      <td>
                        <strong>{provider.displayName}</strong>
                        <div className="faint mono">{provider.providerId}</div>
                      </td>
                      <td className="mono faint">{provider.configured ? provider.keyFingerprint : 'not configured'}</td>
                      <td>
                        <Badge tone={statusTone(health?.status ?? (provider.configured ? 'unknown' : 'unconfigured'))}>
                          {health?.status ?? (provider.configured ? 'unchecked' : 'unconfigured')}
                        </Badge>
                      </td>
                      <td className="faint">{health?.message ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </AsyncBlock>
      </Card>
    </>
  )
}

export { Stat }
