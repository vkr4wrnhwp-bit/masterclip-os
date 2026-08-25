import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, statusTone, useAsync } from '../ui.jsx'

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function extractionTone(type: string): 'ok' | 'warn' | 'danger' {
  if (type === 'explicit') return 'ok'
  if (type === 'inferred') return 'warn'
  return 'danger'
}

export function AudioMeetingDetailView({ meetingId }: { meetingId: string }) {
  const detail = useAsync(() => audioApi.meeting(meetingId), [meetingId])
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null)
    setMessage(null)
    try {
      await fn()
      if (done) setMessage(done)
      detail.reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <AsyncBlock state={detail}>
      {({ meeting, segments, speakers, actionItems, dealVariables, audioUrl }) => (
        <>
          <div className="topbar">
            <h2>{meeting.title}</h2>
            <div className="meta">
              {meeting.meetingType} · <Badge tone={statusTone(meeting.status)}>{meeting.status}</Badge>
            </div>
          </div>

          {message && <Callout tone="ok">{message}</Callout>}
          {error && <Callout tone="danger">{error}</Callout>}

          {meeting.status === 'draft' && (
            <Callout tone="info" title="Draft — review before committing">
              Everything below was extracted by {meeting.engine || 'the extraction engine'} and is a draft. Approve or reject each
              item; only approved items reach Operator Desk, and only when you commit.
            </Callout>
          )}

          <div className="grid cols-2" style={{ marginBottom: 18 }}>
            <Card
              title="Transcript"
              action={audioUrl ? <audio controls src={audioUrl} style={{ height: 28 }} /> : undefined}
            >
              {speakers.length > 0 && (
                <div style={{ marginBottom: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {speakers.map((speaker) => (
                    <span key={speaker.providerSpeakerKey} style={{ fontSize: 12 }}>
                      <span className="faint">{speaker.providerSpeakerKey}:</span>{' '}
                      <a
                        onClick={() => {
                          const name = window.prompt(`Name for ${speaker.providerSpeakerKey}`, speaker.displayName)
                          if (name) void act(() => audioApi.renameSpeaker(meetingId, speaker.providerSpeakerKey, name))
                        }}
                      >
                        {speaker.displayName}
                        {speaker.manuallyConfirmed ? ' ✓' : ''}
                      </a>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ maxHeight: 420, overflowY: 'auto', display: 'grid', gap: 8 }}>
                {segments.length === 0 ? (
                  <Empty>Transcript not ready yet.</Empty>
                ) : (
                  segments.map((segment) => {
                    const speaker = speakers.find((s) => s.providerSpeakerKey === segment.speakerKey)
                    return (
                      <div key={segment.id} style={{ fontSize: 13 }}>
                        <span className="faint mono" style={{ marginRight: 8 }}>
                          {clock(segment.startMs)}
                        </span>
                        <strong style={{ color: 'var(--accent)' }}>{speaker?.displayName ?? segment.speakerKey ?? '·'}</strong>{' '}
                        <span
                          title="Click to correct this line"
                          style={{ cursor: 'text' }}
                          onClick={() => {
                            if (!meeting.transcriptId) return
                            const text = window.prompt('Correct this line', segment.text)
                            if (text && text !== segment.text) {
                              void act(() => audioApi.correctSegment(meeting.transcriptId!, segment.id, text))
                            }
                          }}
                        >
                          {segment.text}
                        </span>
                      </div>
                    )
                  })
                )}
              </div>
            </Card>

            <Card title="Extraction">
              {!meeting.extraction ? (
                <Empty>
                  Not extracted yet.{' '}
                  {meeting.transcriptId && (
                    <button className="small" onClick={() => void act(() => audioApi.extractMeeting(meetingId), 'extraction complete')}>
                      Extract now
                    </button>
                  )}
                </Empty>
              ) : (
                <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
                  <p style={{ margin: 0 }}>{meeting.extraction.summary}</p>
                  {meeting.extraction.risks.length > 0 && (
                    <div>
                      <div className="stat-label">Risks</div>
                      {meeting.extraction.risks.map((risk, index) => (
                        <div key={index} style={{ color: 'var(--warn)' }}>
                          {risk}
                        </div>
                      ))}
                    </div>
                  )}
                  {meeting.extraction.openQuestions.length > 0 && (
                    <div>
                      <div className="stat-label">Open questions</div>
                      {meeting.extraction.openQuestions.map((question, index) => (
                        <div key={index} className="muted">
                          {question}
                        </div>
                      ))}
                    </div>
                  )}
                  {meeting.extraction.dates.length > 0 && (
                    <div>
                      <div className="stat-label">Dates</div>
                      {meeting.extraction.dates.map((date, index) => (
                        <div key={index} className="muted">
                          <Badge tone="info">{date.kind}</Badge> {date.date} — {date.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>

          <div className="grid cols-2" style={{ marginBottom: 18 }}>
            <Card title="Action items (draft until approved)">
              {actionItems.length === 0 ? (
                <Empty>None extracted.</Empty>
              ) : (
                <table>
                  <tbody>
                    {actionItems.map((item) => (
                      <tr key={item.id}>
                        <td style={{ maxWidth: 380 }}>{item.description}</td>
                        <td className="faint">{item.sourceStartMs !== null ? clock(item.sourceStartMs) : ''}</td>
                        <td>
                          <Badge tone={item.approvalStatus === 'approved' ? 'ok' : item.approvalStatus === 'rejected' ? 'danger' : undefined}>
                            {item.approvalStatus}
                          </Badge>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="small" onClick={() => void act(() => audioApi.approveItems(meetingId, [{ kind: 'action', itemId: item.id, status: 'approved' }]))}>
                            approve
                          </button>{' '}
                          <button className="small" onClick={() => void act(() => audioApi.approveItems(meetingId, [{ kind: 'action', itemId: item.id, status: 'rejected' }]))}>
                            reject
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card title="Deal variables — never auto-committed">
              {dealVariables.length === 0 ? (
                <Empty>None extracted.</Empty>
              ) : (
                <table>
                  <tbody>
                    {dealVariables.map((variable) => (
                      <tr key={variable.id}>
                        <td className="muted">{variable.variableType}</td>
                        <td>{variable.value}</td>
                        <td>
                          <Badge tone={extractionTone(variable.extractionType)}>{variable.extractionType.replace(/_/g, ' ')}</Badge>
                        </td>
                        <td>
                          <Badge tone={variable.approvalStatus === 'approved' ? 'ok' : variable.approvalStatus === 'rejected' ? 'danger' : undefined}>
                            {variable.approvalStatus}
                          </Badge>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="small" onClick={() => void act(() => audioApi.approveItems(meetingId, [{ kind: 'deal', itemId: variable.id, status: 'approved' }]))}>
                            approve
                          </button>{' '}
                          <button className="small" onClick={() => void act(() => audioApi.approveItems(meetingId, [{ kind: 'deal', itemId: variable.id, status: 'rejected' }]))}>
                            reject
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          {meeting.status === 'draft' && (
            <Card title="Commit to Operator Desk">
              <p className="muted" style={{ fontSize: 13 }}>
                Committing writes the summary, approved deal-variable notes, and approved action items (as tasks) to the linked
                lead{meeting.operatorLeadId ? '' : ' — attach a lead first'}. Inferred terms stay labelled as inferred.
              </p>
              <button
                disabled={!meeting.operatorLeadId}
                onClick={() =>
                  void act(async () => {
                    const result = await audioApi.commitMeeting(meetingId)
                    setMessage(`committed: ${result.notes} note(s), ${result.tasks} task(s)`)
                  })
                }
              >
                Commit approved items
              </button>
            </Card>
          )}
        </>
      )}
    </AsyncBlock>
  )
}
