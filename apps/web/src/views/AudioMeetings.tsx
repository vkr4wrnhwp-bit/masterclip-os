import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, statusTone, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'

const MEETING_TYPES = [
  'A&R Call',
  'Artist Onboarding',
  'Manager Meeting',
  'Distribution Discussion',
  'Deal Discussion',
  'Catalog Review',
  'Royalty Review',
  'Release Strategy',
  'Show Debrief',
  'Partner Meeting',
  'Internal Team Meeting',
  'Voice Note',
  'Other',
]

export function AudioMeetingsView() {
  const meetings = useAsync(() => audioApi.meetings(), [])
  const leads = useAsync(() => audioApi.leads(), [])
  const [title, setTitle] = React.useState('')
  const [meetingType, setMeetingType] = React.useState('A&R Call')
  const [leadId, setLeadId] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [consent, setConsent] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('title', title || file.name)
      form.append('meetingType', meetingType)
      form.append('operatorLeadId', leadId)
      form.append('consentAccepted', consent ? 'true' : 'false')
      form.append('file', file)
      const result = await audioApi.createMeeting(form)
      navigate(`/audio/meetings/${result.meeting.id}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Meeting Intelligence</h2>
        <div className="meta">authorized recordings in · reviewed intelligence out</div>
      </div>

      <div className="grid cols-2">
        <Card title="Meetings">
          <AsyncBlock state={meetings}>
            {(data) =>
              data.meetings.length === 0 ? (
                <Empty>No meetings yet — upload one on the right.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Engine</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.meetings.map((meeting) => (
                      <tr key={meeting.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/audio/meetings/${meeting.id}`)}>
                        <td>{meeting.title}</td>
                        <td className="muted">{meeting.meetingType}</td>
                        <td>
                          <Badge tone={statusTone(meeting.status)}>{meeting.status}</Badge>
                        </td>
                        <td className="faint">{meeting.engine || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </AsyncBlock>
        </Card>

        <Card title="New meeting">
          <form onSubmit={submit}>
            <Field label="Title">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A&R call — artist name" />
            </Field>
            <Field label="Meeting type">
              <select value={meetingType} onChange={(e) => setMeetingType(e.target.value)}>
                {MEETING_TYPES.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </Field>
            <Field label="Operator Desk lead" hint="approved notes and tasks commit here">
              <select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                <option value="">— none yet —</option>
                {leads.data?.leads.map((lead) => (
                  <option key={lead.id} value={lead.id}>
                    {lead.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Recording" hint="WAV, MP3, M4A, FLAC, OGG, MP4, MOV">
              <input type="file" accept="audio/*,video/mp4,video/quicktime" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
              <span style={{ fontSize: 12 }}>
                I confirm I am authorized to upload this recording and that any consent required from its participants has been
                obtained. This acknowledgment is stored with the meeting.
              </span>
            </label>
            {error && <Callout tone="danger">{error}</Callout>}
            <button type="submit" disabled={!file || busy}>
              {busy ? 'Uploading…' : 'Upload & transcribe'}
            </button>
          </form>
        </Card>
      </div>
    </>
  )
}
