import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, statusTone, useAsync } from '../ui.jsx'

const LANES = ['stems', 'alternate_sections', 'social_versions', 'dj_edit_brief', 'producer_handoff', 'inpainting', 'instrumental_concept']

export function AudioRemixView() {
  const projects = useAsync(() => audioApi.remixProjects(), [])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [refresh, setRefresh] = React.useState(0)
  const detail = useAsync(async () => (selected ? audioApi.remixProject(selected) : null), [selected, refresh])

  const [name, setName] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [lane, setLane] = React.useState('stems')
  const [rights, setRights] = React.useState(false)
  const [noImitation, setNoImitation] = React.useState(false)
  const [prompt, setPrompt] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('name', name || file.name)
      form.append('remixLane', lane)
      form.append('targetUse', 'social_versions')
      form.append('rightsConfirmed', rights ? 'true' : 'false')
      form.append('noImitationConfirmed', noImitation ? 'true' : 'false')
      form.append('file', file)
      const result = await audioApi.createRemix(form)
      setSelected(result.project.id)
      projects.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const act = async (fn: () => Promise<unknown>, note: string) => {
    setError(null)
    setMessage(null)
    try {
      await fn()
      setMessage(note)
      setTimeout(() => setRefresh((n) => n + 1), 800)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Remix Lab — Audio Engine</h2>
        <div className="meta">your audio into stems, concepts, and producer-ready material — never an imitation machine</div>
      </div>

      {message && <Callout tone="ok">{message}</Callout>}
      {error && <Callout tone="danger">{error}</Callout>}

      <div className="grid cols-2">
        <div>
          <Card title="Projects">
            <AsyncBlock state={projects}>
              {(data) =>
                data.projects.length === 0 ? (
                  <Empty>No remix projects yet.</Empty>
                ) : (
                  <table>
                    <tbody>
                      {data.projects.map((project) => (
                        <tr key={project.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(project.id)}>
                          <td>{project.name}</td>
                          <td className="muted">{project.remixLane.replace(/_/g, ' ')}</td>
                          <td>
                            {project.providerScreening === 'rights_review_required' ? (
                              <Badge tone="warn">provider rights review</Badge>
                            ) : (
                              <Badge tone={statusTone(project.status)}>{project.finalApprovalStatus === 'none' ? project.status : project.finalApprovalStatus.replace(/_/g, ' ')}</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </AsyncBlock>
          </Card>

          <Card title="New project — owned audio only">
            <form onSubmit={create}>
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Title track — versions" />
              </Field>
              <Field label="Source audio">
                <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </Field>
              <Field label="Lane">
                <select value={lane} onChange={(e) => setLane(e.target.value)}>
                  {LANES.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} style={{ marginTop: 3 }} />
                <span style={{ fontSize: 12 }}>
                  I confirm that I own or control the audio I am uploading, or have authorization from the rights holder to use it.
                </span>
              </label>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                <input type="checkbox" checked={noImitation} onChange={(e) => setNoImitation(e.target.checked)} style={{ marginTop: 3 }} />
                <span style={{ fontSize: 12 }}>
                  I understand that Remix Lab will not imitate another artist’s name, voice, likeness, protected style, lyrics,
                  song, album, label, or recording.
                </span>
              </label>
              <button type="submit" disabled={!file || busy}>
                {busy ? 'Uploading…' : 'Create project'}
              </button>
            </form>
          </Card>
        </div>

        <div>
          {selected && (
            <AsyncBlock state={detail}>
              {(data) =>
                !data ? (
                  <Empty>Select a project.</Empty>
                ) : (
                  <>
                    {data.project.providerScreening === 'rights_review_required' && (
                      <Callout tone="warn" title="Provider rights review required">
                        The audio provider declined to process this upload automatically. Your rights confirmation is on record; a
                        Street Banker reviewer will look at it, and you can attach ownership documentation. Nothing about this
                        result is a finding about your rights.
                      </Callout>
                    )}
                    <Card title="Workflows">
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                        <button className="small" onClick={() => void act(() => audioApi.remixStems(data.project.id), 'stem separation queued')}>
                          separate stems
                        </button>
                        <button className="small" onClick={() => void act(() => audioApi.remixUploadScreen(data.project.id), 'owned-audio upload queued')}>
                          provider upload screen
                        </button>
                        <button className="small" onClick={() => void act(() => audioApi.remixPlan(data.project.id), 'composition plan queued')}>
                          composition plan
                        </button>
                      </div>
                      <Field label="Concept prompt" hint="neutral descriptors only — tempo, energy, instrumentation, mood, era, texture">
                        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="slow tempo, warm analog texture, sparse drums, late-night mood" />
                      </Field>
                      <button
                        className="small"
                        disabled={!prompt.trim()}
                        onClick={() => void act(() => audioApi.remixConcept(data.project.id, prompt), 'concept generation queued')}
                      >
                        generate concept
                      </button>
                    </Card>

                    <Card title="Versions & lineage" action={<button className="small" onClick={() => setRefresh((n) => n + 1)}>refresh</button>}>
                      {data.versions.length === 0 ? (
                        <Empty>No versions yet.</Empty>
                      ) : (
                        <div style={{ display: 'grid', gap: 8 }}>
                          {data.versions.map((version) => (
                            <div key={version.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                              <Badge>{version.versionType}</Badge>
                              <span style={{ flex: 1 }}>{version.prompt || version.model}</span>
                              <Badge tone={version.reviewStatus === 'producer_reviewed' ? 'ok' : version.reviewStatus === 'rejected' ? 'danger' : undefined}>
                                {version.reviewStatus.replace(/_/g, ' ')}
                              </Badge>
                              {version.url && <audio controls src={version.url} style={{ height: 26 }} />}
                              {version.reviewStatus === 'draft' && (
                                <>
                                  <button className="small" onClick={() => void act(() => audioApi.remixReview(data.project.id, version.id, 'producer_reviewed'), 'version reviewed')}>
                                    producer ok
                                  </button>
                                  <button className="small" onClick={() => void act(() => audioApi.remixReview(data.project.id, version.id, 'rejected'), 'version rejected')}>
                                    reject
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>

                    <Card title="Human release gate">
                      <p className="muted" style={{ fontSize: 12 }}>
                        Release-ready requires, in order: producer review of a version, rights review, then release authorization.
                        No generated version skips the line.
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          className="small"
                          disabled={data.project.finalApprovalStatus !== 'none' || !data.versions.some((v) => v.reviewStatus === 'producer_reviewed')}
                          onClick={() => void act(() => audioApi.remixApprove(data.project.id, 'producer_approved'), 'producer approved')}
                        >
                          producer approval
                        </button>
                        <button
                          className="small"
                          disabled={data.project.finalApprovalStatus !== 'producer_approved'}
                          onClick={() => void act(() => audioApi.remixApprove(data.project.id, 'release_ready'), 'marked release ready')}
                        >
                          mark release ready
                        </button>
                      </div>
                    </Card>
                  </>
                )
              }
            </AsyncBlock>
          )}
        </div>
      </div>
    </>
  )
}
