import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, statusTone, useAsync } from '../ui.jsx'

const BRIEF_TYPES = [
  'daily_scout',
  'weekly_executive',
  'artist_opportunity',
  'release_reaction',
  'rights_health',
  'distribution_change',
  'city_ignition',
  'deal_pipeline',
  'follow_up',
]

export function AudioBriefsView() {
  const briefs = useAsync(() => audioApi.briefs(), [])
  const schedules = useAsync(() => audioApi.briefSchedules(), [])
  const [selected, setSelected] = React.useState<string | null>(null)
  const selectedBrief = useAsync(async () => (selected ? audioApi.brief(selected) : null), [selected, briefs.data])

  const [briefType, setBriefType] = React.useState('daily_scout')
  const [title, setTitle] = React.useState('')
  const [items, setItems] = React.useState<Array<{ statement: string; confidence: string }>>([{ statement: '', confidence: 'confirmed' }])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [schedType, setSchedType] = React.useState('daily_scout')
  const [schedCadence, setSchedCadence] = React.useState('weekdays')
  const [schedHour, setSchedHour] = React.useState(13)

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await audioApi.createBrief({ briefType, title, items: items.filter((i) => i.statement.trim()) })
      setSelected(result.brief.id)
      setTitle('')
      setItems([{ statement: '', confidence: 'confirmed' }])
      briefs.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Signal Audio Briefs</h2>
        <div className="meta">confidence language survives the read-aloud — “needs verification” is said out loud</div>
      </div>

      <div className="grid cols-2">
        <div>
          <Card title="Briefs">
            <AsyncBlock state={briefs}>
              {(data) =>
                data.briefs.length === 0 ? (
                  <Empty>No briefs yet.</Empty>
                ) : (
                  <table>
                    <tbody>
                      {data.briefs.map((brief) => (
                        <tr key={brief.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(brief.id)}>
                          <td>{brief.title}</td>
                          <td className="muted">{brief.briefType.replace(/_/g, ' ')}</td>
                          <td>
                            <Badge tone={statusTone(brief.status)}>{brief.status}</Badge>
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
            <Card title="Brief detail">
              <AsyncBlock state={selectedBrief}>
                {(data) =>
                  !data ? (
                    <Empty>Select a brief.</Empty>
                  ) : (
                    <div style={{ display: 'grid', gap: 10 }}>
                      {data.audioUrl ? (
                        <audio controls src={data.audioUrl} style={{ width: '100%' }} />
                      ) : data.brief.status === 'failed' ? (
                        <Callout tone="danger">{data.brief.errorMessage ?? 'render failed'}</Callout>
                      ) : (
                        <span className="muted">audio {data.brief.status}…</span>
                      )}
                      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{data.brief.script}</div>
                      <div className="faint">engine: {data.brief.engine}</div>
                    </div>
                  )
                }
              </AsyncBlock>
            </Card>
          )}
        </div>

        <div>
          <Card title="New brief">
            <form onSubmit={create}>
              <Field label="Type">
                <select value={briefType} onChange={(e) => setBriefType(e.target.value)}>
                  {BRIEF_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Title">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Daily scout brief" required />
              </Field>
              <Field label="Items" hint="each statement carries its confidence into the audio">
                <div style={{ display: 'grid', gap: 6 }}>
                  {items.map((item, index) => (
                    <div key={index} style={{ display: 'flex', gap: 6 }}>
                      <input
                        style={{ flex: 1 }}
                        value={item.statement}
                        placeholder="What happened"
                        onChange={(e) => setItems(items.map((it, i) => (i === index ? { ...it, statement: e.target.value } : it)))}
                      />
                      <select
                        value={item.confidence}
                        onChange={(e) => setItems(items.map((it, i) => (i === index ? { ...it, confidence: e.target.value } : it)))}
                      >
                        <option value="confirmed">confirmed</option>
                        <option value="likely">likely</option>
                        <option value="needs_verification">needs verification</option>
                      </select>
                    </div>
                  ))}
                  <button type="button" className="small" onClick={() => setItems([...items, { statement: '', confidence: 'confirmed' }])}>
                    + item
                  </button>
                </div>
              </Field>
              {error && <Callout tone="danger">{error}</Callout>}
              <button type="submit" disabled={busy}>
                {busy ? 'Generating…' : 'Generate & render audio'}
              </button>
            </form>
          </Card>

          <Card title="Schedules">
            <AsyncBlock state={schedules}>
              {(data) => (
                <>
                  {data.schedules.length === 0 ? (
                    <Empty>No schedules.</Empty>
                  ) : (
                    <table style={{ marginBottom: 12 }}>
                      <tbody>
                        {data.schedules.map((schedule) => (
                          <tr key={schedule.id}>
                            <td>{schedule.briefType.replace(/_/g, ' ')}</td>
                            <td className="muted">
                              {schedule.cadence} @ {schedule.hourUtc}:00 UTC
                            </td>
                            <td>
                              <button
                                className="small"
                                onClick={() => void audioApi.toggleBriefSchedule(schedule.id, !schedule.enabled).then(() => schedules.reload())}
                              >
                                {schedule.enabled ? 'disable' : 'enable'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <select value={schedType} onChange={(e) => setSchedType(e.target.value)}>
                      {BRIEF_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                    <select value={schedCadence} onChange={(e) => setSchedCadence(e.target.value)}>
                      <option value="daily">daily</option>
                      <option value="weekdays">weekdays</option>
                      <option value="weekly">weekly (Mon)</option>
                    </select>
                    <select value={schedHour} onChange={(e) => setSchedHour(Number(e.target.value))}>
                      {Array.from({ length: 24 }, (_, hour) => (
                        <option key={hour} value={hour}>
                          {hour}:00 UTC
                        </option>
                      ))}
                    </select>
                    <button
                      className="small"
                      onClick={() =>
                        void audioApi
                          .createBriefSchedule({ briefType: schedType, cadence: schedCadence, hourUtc: schedHour, timezone: 'UTC' })
                          .then(() => schedules.reload())
                      }
                    >
                      add
                    </button>
                  </div>
                </>
              )}
            </AsyncBlock>
          </Card>
        </div>
      </div>
    </>
  )
}
