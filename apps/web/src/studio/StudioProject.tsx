import React from 'react'
import { navigate } from '../App.jsx'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'
import { studioApi, type MixIssue, type RoomExchange, type SessionPayload, type StudioVersion } from './api.js'
import { IssueList, MetricTable, ReadinessPanel, StageBadge, Transport, Waveform, clock, formatMetric } from './components.jsx'
import { StudioMaster, StudioVersions, StudioCollaborate, StudioDeliver } from './StudioWorkflow.jsx'

export const STUDIO_TABS = ['session', 'rack', 'mix', 'master', 'versions', 'collaborate', 'deliver'] as const
export type StudioTab = (typeof STUDIO_TABS)[number]

/**
 * The Studio workspace.
 *
 * One project, one contextual navigation. The global nav stays a single Studio
 * entry — the seven areas below belong to a record, not to the application, and
 * putting them in the sidebar would make the platform's top level about
 * features rather than about work.
 */
export function StudioProject({ projectId, tab, at }: { projectId: string; tab: StudioTab; at?: string }) {
  const [versionId, setVersionId] = React.useState<string | null>(null)
  const session = useAsync(() => studioApi.session(projectId, versionId ?? undefined), [projectId, versionId])

  return (
    <AsyncBlock state={session}>
      {(data) => (
        <>
          <div className="topbar">
            <div>
              <div className="project-artist">{data.project.artistName}</div>
              <h2>{data.project.title}</h2>
              <div className="meta">
                <StageBadge stage={data.project.stage} />{' '}
                {data.version ? (
                  <>
                    {data.version.label} · {clock(data.version.durationMs)} · {data.version.sampleRate ?? '—'} Hz · {data.version.bitDepth ?? '—'}-bit ·{' '}
                    {data.version.channels === 1 ? 'mono' : data.version.channels === 2 ? 'stereo' : `${data.version.channels ?? '—'} ch`}
                  </>
                ) : (
                  'no audio yet'
                )}
                {' · '}updated {new Date(data.project.updatedAt).toLocaleDateString()}
              </div>
            </div>
            <button className="small" onClick={() => navigate('/studio')}>
              All projects
            </button>
          </div>

          <div className="tabs">
            {STUDIO_TABS.map((name) => (
              <button key={name} className={tab === name ? 'active' : ''} onClick={() => navigate(`/studio/${projectId}/${name}`)}>
                {name}
              </button>
            ))}
          </div>

          {tab === 'session' && <Session data={data} projectId={projectId} onVersion={setVersionId} reload={session.reload} at={at} />}
          {tab === 'rack' && <StudioRack projectId={projectId} versionId={data.version?.id ?? null} />}
          {tab === 'mix' && <StudioMix data={data} projectId={projectId} reload={session.reload} />}
          {tab === 'master' && <StudioMaster projectId={projectId} data={data} reload={session.reload} />}
          {tab === 'versions' && <StudioVersions projectId={projectId} versions={data.versions} onOpen={setVersionId} />}
          {tab === 'collaborate' && <StudioCollaborate projectId={projectId} data={data} reload={session.reload} />}
          {tab === 'deliver' && <StudioDeliver projectId={projectId} data={data} reload={session.reload} />}
        </>
      )}
    </AsyncBlock>
  )
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

function Session({
  data,
  projectId,
  onVersion,
  reload,
  at,
}: {
  data: SessionPayload
  projectId: string
  onVersion: (id: string) => void
  reload: () => void
  /** A deep link from Mix Doctor: `?at=<startMs>&to=<endMs>`. */
  at?: string
}) {
  const audioRef = React.useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = React.useState(false)
  const [positionMs, setPositionMs] = React.useState(0)
  const [loop, setLoop] = React.useState<{ startMs: number; endMs: number } | null>(null)
  const loudness = data.curves.find((curve) => curve.curveKey === 'short_term_loudness')

  React.useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => {
      setPositionMs(audio.currentTime * 1000)
      // A loop is a range, not a marker: leaving it means jumping back to the
      // start of the section rather than to the start of the record.
      if (loop && audio.currentTime * 1000 > loop.endMs) audio.currentTime = loop.startMs / 1000
    }
    audio.addEventListener('timeupdate', onTime)
    return () => audio.removeEventListener('timeupdate', onTime)
  }, [loop])

  const seek = (ms: number) => {
    if (audioRef.current) audioRef.current.currentTime = ms / 1000
    setPositionMs(ms)
  }

  // HEAR SECTION, arriving from the Mix tab. The player lives here, so the
  // finding hands over a time range and this is where it lands: the transport
  // seeks to it and loops it, which is what "hear this" means when the thing
  // being heard is two seconds long.
  const [applied, setApplied] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!at || applied === at || !data.audioUrl) return
    const startMs = Number(at)
    if (!Number.isFinite(startMs)) return
    const issue = data.issues.find((candidate) => candidate.startMs === startMs)
    seek(startMs)
    if (issue) setLoop({ startMs: issue.startMs, endMs: Math.max(issue.endMs, issue.startMs + 2000) })
    setApplied(at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, data.audioUrl, data.issues])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
    } else {
      void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    }
  }

  return (
    <>
      {data.analysis?.status === 'unsupported' && (
        <Callout tone="warn" title="This file could not be analysed">
          {data.analysis.failureReason} — nothing about this version has been measured, so no figures are shown for it.
        </Callout>
      )}
      {data.analysis?.status === 'failed' && (
        <Callout tone="danger" title="Analysis failed">
          {data.analysis.failureReason}
        </Callout>
      )}

      <Card title="Session">
        {data.audioUrl ? <audio ref={audioRef} src={data.audioUrl} preload="metadata" onEnded={() => setPlaying(false)} /> : null}
        <Waveform
          curve={loudness}
          durationMs={data.version?.durationMs ?? null}
          positionMs={positionMs}
          notes={data.notes}
          issues={data.issues}
          onSeek={seek}
        />
        <Transport audioRef={audioRef} playing={playing} onToggle={toggle} positionMs={positionMs} durationMs={data.version?.durationMs ?? null} loop={loop} onLoopChange={setLoop} />
        <div className="version-strip">
          {data.versions.map((version) => (
            <button
              key={version.id}
              className={`small ${data.version?.id === version.id ? 'active' : ''}`}
              onClick={() => onVersion(version.id)}
              title={version.notes}
            >
              {version.label}
              {version.approved ? ' ✓' : ''}
            </button>
          ))}
        </div>
        <UploadVersion projectId={projectId} onDone={reload} />
      </Card>

      <div className="grid cols-2">
        <Card title="Notes and markers">
          <NoteComposer projectId={projectId} versionId={data.version?.id ?? null} positionMs={positionMs} onDone={reload} />
          {data.notes.length === 0 ? (
            <Empty>no notes on this record yet</Empty>
          ) : (
            data.notes.map((note) => (
              <div key={note.id} className={`note ${note.status}`}>
                <div className="note-head">
                  <button className="small" onClick={() => seek(note.timestampMs ?? 0)} disabled={note.timestampMs === null}>
                    {note.timestampMs === null ? 'record' : clock(note.timestampMs)}
                  </button>
                  <Badge tone="info">{note.category}</Badge>
                  {/* A machine-drafted note stays labelled for its whole life. */}
                  {note.origin !== 'human' && <Badge tone="accent">{note.origin.replace(/_/g, ' ')}</Badge>}
                  <span className="faint">{note.authorLabel}</span>
                  <span className="faint">{new Date(note.createdAt).toLocaleDateString()}</span>
                </div>
                <div>{note.body}</div>
                <div className="button-row">
                  {note.status !== 'resolved' ? (
                    <button className="small" onClick={() => void studioApi.updateNote(projectId, note.id, { status: 'resolved' }).then(reload)}>
                      Resolve
                    </button>
                  ) : (
                    <Badge tone="ok">resolved</Badge>
                  )}
                </div>
              </div>
            ))
          )}
        </Card>

        <Card title="Ask the Room">
          <AskTheRoom projectId={projectId} onSeek={seek} />
        </Card>
      </div>

      <Card title="Activity">
        {data.activity.length === 0 ? (
          <Empty>nothing has happened on this record yet</Empty>
        ) : (
          <ul className="activity">
            {data.activity.map((entry) => (
              <li key={entry.id}>
                <span className="mono faint">{new Date(entry.createdAt).toLocaleString()}</span> <strong>{entry.actorLabel}</strong> {entry.action.replace(/[._]/g, ' ')}
                {entry.detail && <span className="faint"> — {entry.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}

function UploadVersion({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [file, setFile] = React.useState<File | null>(null)
  const [versionType, setVersionType] = React.useState('mix')
  const [rights, setRights] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.append('file', file)
    form.append('versionType', versionType)
    form.append('rightsConfirmed', String(rights))
    try {
      await studioApi.uploadVersion(projectId, form)
      setFile(null)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="upload-row">
      <input type="file" accept="audio/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} aria-label="Audio file" />
      <select value={versionType} onChange={(event) => setVersionType(event.target.value)} aria-label="Version type">
        {['mix', 'demo', 'rough', 'master', 'clean', 'instrumental', 'acapella', 'tv_track', 'performance_track', 'stems'].map((type) => (
          <option key={type} value={type}>
            {type.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      <label className="checkbox inline">
        <input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)} />
        <span className="faint">rights confirmed</span>
      </label>
      <button className="primary" type="submit" disabled={!file || !rights || busy}>
        {busy ? 'uploading…' : 'Add version'}
      </button>
      {error && <span className="danger-text">{error}</span>}
    </form>
  )
}

function NoteComposer({ projectId, versionId, positionMs, onDone }: { projectId: string; versionId: string | null; positionMs: number; onDone: () => void }) {
  const [body, setBody] = React.useState('')
  const [category, setCategory] = React.useState('mix')
  const [atTime, setAtTime] = React.useState(true)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!body.trim()) return
    await studioApi.addNote(projectId, {
      body,
      category,
      timestampMs: atTime ? Math.round(positionMs) : null,
      ...(versionId ? { studioVersionId: versionId } : {}),
    })
    setBody('')
    onDone()
  }

  return (
    <form onSubmit={submit} className="note-composer">
      <input value={body} onChange={(event) => setBody(event.target.value)} placeholder="A note about this moment…" aria-label="Note" />
      <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Category">
        {['mix', 'master', 'arrangement', 'vocal', 'production', 'technical', 'other'].map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <label className="checkbox inline">
        <input type="checkbox" checked={atTime} onChange={(event) => setAtTime(event.target.checked)} />
        <span className="faint">at {clock(positionMs)}</span>
      </label>
      <button className="small" type="submit">
        Add
      </button>
    </form>
  )
}

function AskTheRoom({ projectId, onSeek }: { projectId: string; onSeek: (ms: number) => void }) {
  const history = useAsync(() => studioApi.askHistory(projectId), [projectId])
  const [question, setQuestion] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [latest, setLatest] = React.useState<RoomExchange | null>(null)

  const ask = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!question.trim()) return
    setBusy(true)
    try {
      const result = await studioApi.ask(projectId, question)
      setLatest(result.exchange)
      setQuestion('')
      history.reload()
    } finally {
      setBusy(false)
    }
  }

  const exchanges = latest ? [latest, ...(history.data?.exchanges ?? []).filter((entry) => entry.id !== latest.id)] : (history.data?.exchanges ?? [])

  return (
    <>
      <form onSubmit={ask} className="ask-form">
        <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Why does my vocal disappear?" aria-label="Ask the Room" />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'asking…' : 'Ask'}
        </button>
      </form>
      <div className="faint ask-hint">
        Advisory. Every answer is built from this record's own measurements and says what it looked at — it is not a replacement for a producer or an engineer.
      </div>
      {exchanges.length === 0 ? (
        <Empty>no questions asked about this record yet</Empty>
      ) : (
        exchanges.slice(0, 6).map((exchange) => (
          <div key={exchange.id} className="exchange">
            <div className="exchange-q">{exchange.question}</div>
            <div>{exchange.answer}</div>
            <div className="button-row">
              <Badge tone={exchange.confidence === 'high' ? 'ok' : exchange.confidence === 'insufficient' ? 'danger' : 'warn'}>{exchange.confidence}</Badge>
              {exchange.actions.map((action, index) => (
                <button
                  key={index}
                  className="small"
                  onClick={() => {
                    if (typeof action.target.startMs === 'number') onSeek(action.target.startMs)
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
            {exchange.contextUsed.length > 0 && <div className="faint mono">read: {exchange.contextUsed.join(', ')}</div>}
          </div>
        ))
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// mix station
// ---------------------------------------------------------------------------

function StudioMix({ data, projectId, reload }: { data: SessionPayload; projectId: string; reload: () => void }) {
  const catalogue = useAsync(() => studioApi.metricCatalogue(), [])
  const references = useAsync(() => studioApi.referenceComparison(projectId, data.version?.id), [projectId, data.version?.id])
  const translation = useAsync(() => studioApi.translation(projectId, data.version?.id), [projectId, data.version?.id])
  const [group, setGroup] = React.useState('loudness')

  const act = async (issue: MixIssue, action: string) => {
    await studioApi.actOnIssue(projectId, issue.id, action)
    reload()
  }

  if (!data.analysis) {
    return (
      <Card title="Mix Station">
        <Empty>
          This version has not been analysed yet.{' '}
          <button className="small" onClick={() => void studioApi.reanalyze(projectId, data.version?.id).then(reload)}>
            Analyse now
          </button>
        </Empty>
      </Card>
    )
  }

  return (
    <>
      <Card title="Mix Doctor">
        <IssueList issues={data.issues} onHear={(issue) => navigate(`/studio/${projectId}/session?at=${issue.startMs}`)} onAct={act} />
      </Card>

      <div className="grid cols-2">
        <Card title="Release readiness">
          <ReadinessPanel readiness={data.readiness} />
        </Card>

        <Card title="Measurements">
          <div className="tabs small-tabs">
            {['loudness', 'level', 'dynamics', 'spectrum', 'stereo', 'low_end', 'midrange', 'high_frequency', 'vocal', 'defects'].map((name) => (
              <button key={name} className={group === name ? 'active' : ''} onClick={() => setGroup(name)}>
                {name.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <AsyncBlock state={catalogue}>{(cat) => <MetricTable metrics={data.metrics} definitions={cat.metrics} group={group} />}</AsyncBlock>
        </Card>
      </div>

      <Card title="Your record vs your references">
        <ReferenceManager projectId={projectId} onChanged={references.reload} />
        <AsyncBlock state={references}>
          {(payload) =>
            !payload.comparison || payload.comparison.cohortSize === 0 ? (
              <Empty>No measured references yet. Street Banker measures references and does not copy, keep or reproduce them.</Empty>
            ) : (
              <>
                <Callout tone="info">{payload.comparison.caveat}</Callout>
                <ul className="headlines">
                  {payload.comparison.headlines.map((headline, index) => (
                    <li key={index}>{headline}</li>
                  ))}
                </ul>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Measurement</th>
                      <th className="num">Yours</th>
                      <th className="num">Reference median</th>
                      <th>Observation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.comparison.rows.map((row) => (
                      <tr key={row.metricKey} className={row.delta === null ? 'unmeasured' : undefined}>
                        <td>{row.label}</td>
                        <td className="num">{formatMetric(row.yours, row.unit)}</td>
                        <td className="num">{formatMetric(row.referenceMedian, row.unit)}</td>
                        <td className="faint">{row.observation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          }
        </AsyncBlock>
      </Card>

      <Card title="Translation Lab">
        <AsyncBlock state={translation}>
          {(payload) => (
            <>
              <Callout tone="warn" title="Analytical estimates, not device simulations">
                These are estimated from published bandwidth and playback characteristics. Nothing here models a specific speaker, and no result should replace
                actually listening on the thing.
              </Callout>
              <div className="grid cols-3">
                {payload.estimates.map((estimate) => (
                  <div key={estimate.target} className="translation">
                    <div className="translation-head">
                      <strong>{estimate.label}</strong>
                      <span className="mono">{estimate.survival === null ? 'not estimated' : `${estimate.survival}%`}</span>
                    </div>
                    {estimate.observations.map((observation, index) => (
                      <div key={index} className="faint">
                        {observation}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </AsyncBlock>
      </Card>
    </>
  )
}

function ReferenceManager({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const references = useAsync(() => studioApi.references(projectId), [projectId])
  const [file, setFile] = React.useState<File | null>(null)
  const [artistName, setArtistName] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [rightsBasis, setRightsBasis] = React.useState('authorized_private_reference')
  const [rights, setRights] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.append('file', file)
    form.append('label', `${artistName} — ${title}`)
    form.append('artistName', artistName)
    form.append('title', title)
    form.append('rightsBasis', rightsBasis)
    form.append('rightsConfirmed', String(rights))
    try {
      await studioApi.addReference(projectId, form)
      setFile(null)
      references.reload()
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {references.data && references.data.references.length > 0 && (
        <div className="reference-list">
          {references.data.references.map((reference) => (
            <div key={reference.id} className="reference">
              <div>
                <strong>{reference.artistName}</strong> — {reference.title}
              </div>
              <div className="faint">
                {reference.rightsBasis.replace(/_/g, ' ')} ·{' '}
                {reference.audioDiscardedAt ? 'audio discarded, measurements kept' : reference.derivedOnly ? 'audio will be discarded after measurement' : 'audio retained'}
              </div>
              <button
                className="small"
                onClick={() =>
                  void studioApi.deleteReference(projectId, reference.id).then(() => {
                    references.reload()
                    onChanged()
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="upload-row">
        <input type="file" accept="audio/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} aria-label="Reference audio" />
        <input value={artistName} onChange={(event) => setArtistName(event.target.value)} placeholder="Artist" aria-label="Reference artist" />
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" aria-label="Reference title" />
        <select value={rightsBasis} onChange={(event) => setRightsBasis(event.target.value)} aria-label="Rights basis">
          <option value="authorized_private_reference">authorized private reference</option>
          <option value="licensed">licensed</option>
          <option value="owned">owned</option>
        </select>
        <label className="checkbox inline">
          <input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)} />
          <span className="faint">{references.data?.rightsStatement ? 'rights confirmed' : 'rights confirmed'}</span>
        </label>
        <button className="small" type="submit" disabled={!file || !rights || busy}>
          {busy ? 'measuring…' : 'Add reference'}
        </button>
        {error && <span className="danger-text">{error}</span>}
      </form>
      {references.data?.rightsStatement && <div className="faint">{references.data.rightsStatement}</div>}
    </>
  )
}

// ---------------------------------------------------------------------------
// rack
// ---------------------------------------------------------------------------

function StudioRack({ projectId, versionId }: { projectId: string; versionId: string | null }) {
  const catalogue = useAsync(() => studioApi.rackCatalogue(), [])
  const racks = useAsync(() => studioApi.racks(projectId), [projectId])
  const [selected, setSelected] = React.useState<string | null>(null)

  const active = racks.data?.racks.find((entry) => entry.chain.id === selected) ?? racks.data?.racks[0] ?? null

  return (
    <AsyncBlock state={catalogue}>
      {(cat) => (
        <>
          <Card
            title="Racks"
            action={
              <div className="button-row">
                {cat.rackTypes.map((type) => (
                  <button
                    key={type}
                    className="small"
                    onClick={() =>
                      void studioApi.createRack(projectId, { rackType: type, ...(versionId ? { versionId } : {}) }).then((created) => {
                        setSelected(created.chain.id)
                        racks.reload()
                      })
                    }
                  >
                    + {type.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            }
          >
            <div className="faint">
              A rack is a stored signal chain — five stages in a fixed order, so a reverb can never sit before a de-esser. It travels with the project to whoever
              renders it.
            </div>
            {racks.data && racks.data.racks.length > 0 ? (
              <div className="version-strip">
                {racks.data.racks.map((entry) => (
                  <button key={entry.chain.id} className={`small ${active?.chain.id === entry.chain.id ? 'active' : ''}`} onClick={() => setSelected(entry.chain.id)}>
                    {entry.chain.name} ({entry.chain.abSlot.toUpperCase()})
                  </button>
                ))}
              </div>
            ) : (
              <Empty>no racks on this project yet</Empty>
            )}
          </Card>

          {active && (
            <Card
              title={active.chain.name}
              action={
                <div className="button-row">
                  <button className="small" onClick={() => void studioApi.rackStep(projectId, active.chain.id, 'undo').then(racks.reload)}>
                    Undo
                  </button>
                  <button className="small" onClick={() => void studioApi.rackStep(projectId, active.chain.id, 'redo').then(racks.reload)}>
                    Redo
                  </button>
                  <button className="small" onClick={() => void studioApi.rackAlternative(projectId, active.chain.id).then(racks.reload)}>
                    Create A/B
                  </button>
                  <button
                    className="small"
                    onClick={() => {
                      const name = window.prompt('Preset name')
                      if (name) void studioApi.saveRackPreset(projectId, active.chain.id, name, 'artist').then(racks.reload)
                    }}
                  >
                    Save artist preset
                  </button>
                </div>
              }
            >
              <div className="chain">
                <div className="chain-node">INPUT</div>
                {cat.stages.map((stage) => {
                  const modules = active.modules.filter((module) => module.stage === stage.key)
                  return (
                    <React.Fragment key={stage.key}>
                      <div className="chain-arrow">↓</div>
                      <div className="chain-stage">
                        <div className="chain-stage-head">
                          <strong>{stage.label.toUpperCase()}</strong>
                          <span className="faint">{stage.description}</span>
                        </div>
                        {modules.map((module) => {
                          const definition = cat.modules.find((candidate) => candidate.key === module.moduleType)
                          return (
                            <div key={`${module.moduleType}-${module.orderIndex}`} className={`module ${module.bypassed ? 'bypassed' : ''}`}>
                              <div>
                                <strong>{definition?.label ?? module.moduleType}</strong>
                                <div className="faint">{definition?.description}</div>
                              </div>
                              <div className="button-row">
                                <button
                                  className="small"
                                  onClick={() => {
                                    const next = active.modules.map((entry) =>
                                      entry.moduleType === module.moduleType && entry.orderIndex === module.orderIndex ? { ...entry, bypassed: !entry.bypassed } : entry,
                                    )
                                    void studioApi.setRackModules(projectId, active.chain.id, next, module.bypassed ? 'un-bypassed a module' : 'bypassed a module').then(racks.reload)
                                  }}
                                >
                                  {module.bypassed ? 'Enable' : 'Bypass'}
                                </button>
                                <button
                                  className="small"
                                  onClick={() => {
                                    const next = active.modules.filter((entry) => !(entry.moduleType === module.moduleType && entry.orderIndex === module.orderIndex))
                                    void studioApi.setRackModules(projectId, active.chain.id, next, 'removed a module').then(racks.reload)
                                  }}
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          )
                        })}
                        <select
                          value=""
                          aria-label={`Add a ${stage.label} module`}
                          onChange={(event) => {
                            if (!event.target.value) return
                            const definition = cat.modules.find((candidate) => candidate.key === event.target.value)
                            if (!definition) return
                            const next = [
                              ...active.modules,
                              { stage: definition.stage, moduleType: definition.key, orderIndex: active.modules.length, bypassed: false, params: { ...definition.defaults } },
                            ]
                            void studioApi.setRackModules(projectId, active.chain.id, next, `added ${definition.label}`).then(racks.reload)
                          }}
                        >
                          <option value="">add a module…</option>
                          {cat.modules
                            .filter((module) => module.stage === stage.key)
                            .map((module) => (
                              <option key={module.key} value={module.key}>
                                {module.label}
                              </option>
                            ))}
                        </select>
                      </div>
                    </React.Fragment>
                  )
                })}
                <div className="chain-arrow">↓</div>
                <div className="chain-node">OUTPUT</div>
              </div>
            </Card>
          )}
        </>
      )}
    </AsyncBlock>
  )
}

export type { StudioVersion }
