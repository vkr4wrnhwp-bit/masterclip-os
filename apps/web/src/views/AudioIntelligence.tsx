import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Stat, statusTone, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'

/** Audio Intelligence hub: what exists, what needs review, where to go. */
export function AudioIntelligenceView() {
  const meetings = useAsync(() => audioApi.meetings(), [])
  const briefs = useAsync(() => audioApi.briefs(), [])
  const conversations = useAsync(() => audioApi.conversations(), [])
  const leads = useAsync(() => audioApi.leads(), [])

  const drafts = meetings.data?.meetings.filter((m) => m.status === 'draft').length ?? 0

  return (
    <>
      <div className="topbar">
        <h2>Audio Intelligence</h2>
        <div className="meta">transcription · briefs · operator · localization · remix — humans approve, machines draft</div>
      </div>

      {drafts > 0 && (
        <Callout tone="warn" title={`${drafts} meeting draft${drafts === 1 ? '' : 's'} awaiting review`}>
          Extracted intelligence stays a draft until a person approves it. Nothing reaches Operator Desk on its own.
        </Callout>
      )}

      <div className="grid cols-2" style={{ marginBottom: 18 }}>
        <Card title="At a glance">
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <Stat value={meetings.data ? meetings.data.meetings.length : null} label="meetings" />
            <Stat value={briefs.data ? briefs.data.briefs.length : null} label="signal briefs" />
            <Stat value={conversations.data ? conversations.data.conversations.length : null} label="operator conversations" />
            <Stat value={leads.data ? leads.data.leads.length : null} label="operator desk leads" />
          </div>
        </Card>
        <Card title="Workspaces">
          <div style={{ display: 'grid', gap: 6 }}>
            <a onClick={() => navigate('/audio/meetings')}>Meeting Intelligence — calls and voice notes into structured drafts</a>
            <a onClick={() => navigate('/audio/briefs')}>Signal Audio Briefs — intelligence you can listen to</a>
            <a onClick={() => navigate('/audio/operator')}>Street Banker Operator — intake agent, human always reachable</a>
            <a onClick={() => navigate('/audio/global-release')}>Global Release Pack — localization with human QA</a>
            <a onClick={() => navigate('/audio/campaigns')}>Campaign Audio Toolkit — voiceovers, drops, sound design</a>
            <a onClick={() => navigate('/audio/remix')}>Remix Lab — owned audio into producer-ready material</a>
            <a onClick={() => navigate('/audio/voice-vault')}>Artist Voice Vault — verified, revocable voice permissions</a>
            <a onClick={() => navigate('/audio/settings')}>Settings — policy, retention, keyterms, usage</a>
          </div>
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Recent meetings" action={<a onClick={() => navigate('/audio/meetings')}>all →</a>}>
          <AsyncBlock state={meetings}>
            {(data) =>
              data.meetings.length === 0 ? (
                <Empty>No meetings yet.</Empty>
              ) : (
                <table>
                  <tbody>
                    {data.meetings.slice(0, 6).map((meeting) => (
                      <tr key={meeting.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/audio/meetings/${meeting.id}`)}>
                        <td>{meeting.title}</td>
                        <td className="muted">{meeting.meetingType}</td>
                        <td>
                          <Badge tone={statusTone(meeting.status)}>{meeting.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </AsyncBlock>
        </Card>
        <Card title="Recent briefs" action={<a onClick={() => navigate('/audio/briefs')}>all →</a>}>
          <AsyncBlock state={briefs}>
            {(data) =>
              data.briefs.length === 0 ? (
                <Empty>No briefs yet.</Empty>
              ) : (
                <table>
                  <tbody>
                    {data.briefs.slice(0, 6).map((brief) => (
                      <tr key={brief.id}>
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
      </div>
    </>
  )
}
