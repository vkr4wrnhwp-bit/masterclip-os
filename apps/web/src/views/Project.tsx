import React from 'react'
import { api } from '../api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'

export function ProjectView({ projectId }: { projectId: string }) {
  const project = useAsync(() => api.project(projectId), [projectId])
  const shots = useAsync(() => api.shots(projectId), [projectId])
  const [tab, setTab] = React.useState<'shots' | 'import' | 'assets' | 'bible'>('shots')

  return (
    <>
      <div className="topbar">
        <h2>{project.data?.project.name ?? 'Project'}</h2>
        <div className="meta">{shots.data ? `${shots.data.shots.length} shots` : ''}</div>
      </div>

      <div className="tabs">
        <button className={tab === 'shots' ? 'active' : ''} onClick={() => setTab('shots')}>
          Shots
        </button>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          Import
        </button>
        <button className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>
          References
        </button>
        <button className={tab === 'bible' ? 'active' : ''} onClick={() => setTab('bible')}>
          Brief &amp; style
        </button>
      </div>

      {tab === 'shots' && (
        <Card title="Shot list" action={<NewShotButton projectId={projectId} onCreated={() => shots.reload()} />}>
          <AsyncBlock state={shots}>
            {(data) =>
              data.shots.length === 0 ? (
                <Empty>No shots yet. Create one, or import a CSV shot list from the Import tab.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Shot</th>
                      <th>Title</th>
                      <th>Mode</th>
                      <th>Profile</th>
                      <th className="num">Duration</th>
                      <th>Format</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.shots.map((shot) => {
                      const spec = (shot.spec ?? {}) as Record<string, unknown>
                      return (
                        <tr key={shot.id}>
                          <td className="mono">{shot.shotKey}</td>
                          <td>{shot.title}</td>
                          <td className="faint">{String(spec.generation_mode ?? '')}</td>
                          <td>
                            <Badge tone={spec.routing_profile === 'HERO' ? 'accent' : undefined}>{String(spec.routing_profile ?? '')}</Badge>
                          </td>
                          <td className="num">{String(spec.duration_seconds ?? '')}s</td>
                          <td className="faint">
                            {String(spec.target_resolution ?? '')} {String(spec.aspect_ratio ?? '')}
                          </td>
                          <td>
                            <div className="button-row">
                              <button className="small" onClick={() => navigate(`/shot/${shot.id}`)}>
                                Build
                              </button>
                              <button className="small" onClick={() => navigate(`/shot/${shot.id}/review`)}>
                                Review
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )
            }
          </AsyncBlock>
        </Card>
      )}

      {tab === 'import' && <ImportPanel projectId={projectId} onImported={() => shots.reload()} />}
      {tab === 'assets' && <AssetsPanel projectId={projectId} />}
      {tab === 'bible' && (
        <AsyncBlock state={project}>
          {(data) => (
            <div className="grid cols-2">
              <Card title="Creative brief">
                <div style={{ whiteSpace: 'pre-wrap' }}>{data.project.brief || <span className="faint">no brief recorded</span>}</div>
              </Card>
              <Card title="Style bible">
                <pre className="prompt-box" style={{ maxHeight: 400 }}>
                  {JSON.stringify(data.project.styleBible, null, 2)}
                </pre>
              </Card>
            </div>
          )}
        </AsyncBlock>
      )}
    </>
  )
}

function NewShotButton({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const create = async () => {
    setBusy(true)
    try {
      const blank = await api.blankShot()
      const key = `SH${Math.floor(Math.random() * 900 + 100)}`
      const created = await api.createShot(projectId, {
        ...blank.shot,
        shot_id: key,
        title: 'Untitled shot',
        generation_mode: 'text_to_video',
        action: 'describe the action here',
        camera_position: 'medium shot, eye level',
        lighting: { ...(blank.shot.lighting as object), dominant_source: 'single practical' },
      })
      navigate(`/shot/${created.shot.id}`)
      onCreated()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className="small primary" onClick={create} disabled={busy}>
      {busy ? '…' : 'New shot'}
    </button>
  )
}

function ImportPanel({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const [content, setContent] = React.useState('')
  const [format, setFormat] = React.useState<'csv' | 'json'>('csv')
  const [result, setResult] = React.useState<Record<string, unknown> | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const run = async (dryRun: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const response = await api.importShots(projectId, format, content, dryRun)
      setResult(response)
      if (!dryRun) onImported()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Import shot list">
      <Callout tone="info">
        CSV columns accept dotted paths (<code className="mono">lighting.dominant_source</code>) and pipe-separated lists. Download a template from{' '}
        <a href="/api/schema/shot-template.csv">/api/schema/shot-template.csv</a>. Always dry-run first: the importer reports every rejected row and why.
      </Callout>
      <Field label="Format">
        <select value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'json')}>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
      </Field>
      <Field label="Content">
        <textarea rows={10} value={content} onChange={(e) => setContent(e.target.value)} placeholder="paste your shot list here" />
      </Field>
      <div className="button-row">
        <button onClick={() => void run(true)} disabled={busy || !content}>
          Dry run
        </button>
        <button className="primary" onClick={() => void run(false)} disabled={busy || !content}>
          Import
        </button>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      {result && (
        <pre className="prompt-box" style={{ marginTop: 12, maxHeight: 320 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </Card>
  )
}

function AssetsPanel({ projectId }: { projectId: string }) {
  const assets = useAsync(() => api.assets(projectId), [projectId])
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [authorized, setAuthorized] = React.useState(false)
  const [owner, setOwner] = React.useState('')

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('rights_owner', owner)
      form.append('rights_consent', authorized ? 'authorized' : 'unverified')
      form.append('rights_authorized', authorized ? 'true' : 'false')
      form.append('file', file)
      await api.uploadAsset(projectId, form)
      assets.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  return (
    <>
      <Card title="Upload a reference">
        <Callout tone="warn" title="Rights are recorded at upload, not later">
          Identity-preserving generation only runs against references explicitly marked authorized with recorded consent. An unmarked upload can still be
          used as a general reference, but never as a character identity lock.
        </Callout>
        <div className="field-row">
          <Field label="Rights owner">
            <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="who owns this material" />
          </Field>
          <Field label="Consent">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
              <span className="field-label" style={{ marginBottom: 0 }}>Authorized for identity work</span>
            </label>
          </Field>
        </div>
        <input type="file" onChange={(e) => void upload(e)} disabled={busy} accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/wav,audio/mpeg" />
        {error && <Callout tone="danger">{error}</Callout>}
      </Card>

      <Card title="References">
        <AsyncBlock state={assets}>
          {(data) =>
            data.assets.length === 0 ? (
              <Empty>No references uploaded.</Empty>
            ) : (
              <div className="grid cols-4">
                {data.assets.map((asset) => (
                  <div key={String(asset.id)} className="candidate">
                    {String(asset.mime).startsWith('image/') ? (
                      <img src={asset.url} alt={String(asset.filename)} />
                    ) : String(asset.mime).startsWith('video/') ? (
                      <video src={asset.url} controls muted />
                    ) : null}
                    <div className="body">
                      <div className="row">
                        <span className="mono">{String(asset.filename).slice(0, 22)}</span>
                        <Badge tone={(asset.rights as { authorized?: boolean })?.authorized ? 'ok' : 'warn'}>
                          {(asset.rights as { authorized?: boolean })?.authorized ? 'cleared' : 'unverified'}
                        </Badge>
                      </div>
                      <div className="faint mono" style={{ fontSize: 10 }}>
                        {String(asset.id)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          }
        </AsyncBlock>
      </Card>
    </>
  )
}
