import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, statusTone, useAsync } from '../ui.jsx'

export function AudioGlobalReleaseView() {
  const projects = useAsync(() => audioApi.dubbingProjects(), [])
  const [selected, setSelected] = React.useState<string | null>(null)
  const detail = useAsync(async () => (selected ? audioApi.dubbingProject(selected) : null), [selected, projects.data])
  const [exports, setExports] = React.useState<Array<{ language: string; url: string }> | null>(null)

  const [name, setName] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [sourceLanguage, setSourceLanguage] = React.useState('en')
  const [targets, setTargets] = React.useState('es, de')
  const [voiceStrategy, setVoiceStrategy] = React.useState('approved_narrator')
  const [rights, setRights] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('name', name || file.name)
      form.append('sourceLanguage', sourceLanguage)
      form.append('targetLanguages', targets)
      form.append('voiceStrategy', voiceStrategy)
      form.append('rightsConfirmed', rights ? 'true' : 'false')
      form.append('file', file)
      const result = await audioApi.createDubbing(form)
      setSelected(result.project.id)
      projects.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      detail.reload()
      projects.reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Global Release Pack</h2>
        <div className="meta">localization with a human QA gate — machine translation is never automatically release-ready</div>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="grid cols-2">
        <div>
          <Card title="Projects">
            <AsyncBlock state={projects}>
              {(data) =>
                data.projects.length === 0 ? (
                  <Empty>No localization projects yet.</Empty>
                ) : (
                  <table>
                    <tbody>
                      {data.projects.map((project) => (
                        <tr key={project.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(project.id)}>
                          <td>{project.name}</td>
                          <td className="muted">
                            {project.sourceLanguage} → {project.targets.map((t) => t.language).join(', ')}
                          </td>
                          <td>
                            <Badge tone={statusTone(project.status)}>{project.status.replace(/_/g, ' ')}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </AsyncBlock>
          </Card>

          {selected && (
            <Card title="Project detail">
              <AsyncBlock state={detail}>
                {(data) =>
                  !data ? (
                    <Empty>Select a project.</Empty>
                  ) : (
                    <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
                      <div>
                        {data.project.targets.map((target) => (
                          <div key={target.language}>
                            <Badge tone={target.status === 'ready' ? 'ok' : target.status === 'failed' ? 'danger' : 'info'}>
                              {target.language}: {target.status}
                            </Badge>{' '}
                            {target.error && <span className="faint">{target.error}</span>}
                          </div>
                        ))}
                      </div>

                      {data.project.status === 'transcript_review' && (
                        <>
                          <div className="stat-label">Transcript — click a line to correct names and terminology before dubbing</div>
                          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                            {data.segments.map((segment) => (
                              <div
                                key={segment.id}
                                style={{ cursor: 'text' }}
                                title="Click to correct this line"
                                onClick={() => {
                                  if (!data.project.transcriptId) return
                                  const text = window.prompt('Correct this line', segment.text)
                                  if (text && text !== segment.text) {
                                    void act(() => audioApi.correctSegment(data.project.transcriptId!, segment.id, text))
                                  }
                                }}
                              >
                                {segment.text}
                              </div>
                            ))}
                          </div>
                          <button onClick={() => void act(() => audioApi.approveDubbingTranscript(data.project.id))}>
                            Approve transcript & start dubbing
                          </button>
                        </>
                      )}

                      {data.project.status === 'quality_review' && (
                        <>
                          <Callout tone="warn" title="Human quality review required">
                            Check pronunciation, terminology, translation accuracy, timing and cultural fit before approving.
                          </Callout>
                          <button onClick={() => void act(() => audioApi.approveDubbing(data.project.id, 'reviewed in app'))}>
                            Approve for export
                          </button>
                        </>
                      )}

                      {(data.project.status === 'approved' || data.project.status === 'exported') && (
                        <button
                          onClick={() =>
                            void act(async () => {
                              const result = await audioApi.exportDubbing(data.project.id)
                              setExports(result.exports)
                            })
                          }
                        >
                          Export approved languages
                        </button>
                      )}
                      {exports && (
                        <div>
                          {exports.map((entry) => (
                            <div key={entry.language}>
                              <a href={entry.url} target="_blank" rel="noreferrer">
                                {entry.language} — download
                              </a>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                }
              </AsyncBlock>
            </Card>
          )}
        </div>

        <Card title="New localization project">
          <form onSubmit={create}>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Release trailer — territories" />
            </Field>
            <Field label="Source media">
              <input type="file" accept="audio/*,video/mp4,video/quicktime" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="Source language">
              <input value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} placeholder="en" />
            </Field>
            <Field label="Target languages" hint="comma-separated codes">
              <input value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="es, de, pt" />
            </Field>
            <Field label="Voice strategy">
              <select value={voiceStrategy} onChange={(e) => setVoiceStrategy(e.target.value)}>
                <option value="preserve_source_speaker">Preserve authorized source speaker</option>
                <option value="approved_narrator">Approved narrator voice</option>
                <option value="voice_vault_profile">Verified Voice Vault profile</option>
                <option value="human_recorded">Human-recorded replacement</option>
                <option value="subtitles_only">Text-only subtitles</option>
              </select>
            </Field>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ fontSize: 12 }}>
                I confirm I hold the rights to localize this content — music, speech, and likenesses included — for the selected
                territories.
              </span>
            </label>
            <button type="submit" disabled={!file || busy}>
              {busy ? 'Uploading…' : 'Create project'}
            </button>
          </form>
        </Card>
      </div>
    </>
  )
}
