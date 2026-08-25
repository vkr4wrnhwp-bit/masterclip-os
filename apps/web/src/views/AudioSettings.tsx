import React from 'react'
import { audioApi } from '../audio-api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'

const POLICY_TOGGLES: Array<{ key: string; label: string }> = [
  { key: 'allowAudioUpload', label: 'Audio upload' },
  { key: 'allowMeetingRecording', label: 'Meeting recording' },
  { key: 'allowTranscription', label: 'Transcription' },
  { key: 'allowVoiceGeneration', label: 'Voice generation' },
  { key: 'allowDubbing', label: 'Dubbing' },
  { key: 'allowMusicGeneration', label: 'Music generation' },
  { key: 'allowVoiceCloning', label: 'Voice cloning' },
  { key: 'allowDownload', label: 'Downloads' },
  { key: 'allowExport', label: 'Exports' },
  { key: 'requireRecordingConsent', label: 'Require recording consent' },
  { key: 'requireZeroRetention', label: 'Require zero-retention processing' },
]

export function AudioSettingsView({ isAdmin }: { isAdmin: boolean }) {
  const settings = useAsync(() => audioApi.settings(), [])
  const usage = useAsync(() => audioApi.usage(), [])
  const jobs = useAsync(() => audioApi.jobs(), [])
  const adminProviders = useAsync(async () => (isAdmin ? audioApi.adminProviders().catch(() => null) : null), [isAdmin])
  const adminWebhooks = useAsync(async () => (isAdmin ? audioApi.adminWebhooks().catch(() => null) : null), [isAdmin])
  const [term, setTerm] = React.useState('')
  const [category, setCategory] = React.useState('artist')
  const [sensitivity, setSensitivity] = React.useState('shareable')
  const [error, setError] = React.useState<string | null>(null)

  const togglePolicy = async (key: string, value: boolean) => {
    setError(null)
    try {
      await audioApi.updatePolicy({ [key]: value })
      settings.reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Audio settings</h2>
        <div className="meta">data policy · retention · keyterms · usage {isAdmin ? '· provider administration' : ''}</div>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="grid cols-2" style={{ marginBottom: 18 }}>
        <Card title="Data policy">
          <AsyncBlock state={settings}>
            {(data) => (
              <div style={{ display: 'grid', gap: 6 }}>
                {POLICY_TOGGLES.map((toggle) => (
                  <label key={toggle.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(data.policy[toggle.key])}
                      onChange={(e) => void togglePolicy(toggle.key, e.target.checked)}
                    />
                    {toggle.label}
                  </label>
                ))}
                {Boolean(data.policy.requireZeroRetention) && (
                  <Callout tone="warn" title="Zero retention required">
                    Jobs are rejected before upload unless the configured provider account is verified to support zero-retention
                    processing for that operation. Nothing is silently downgraded.
                  </Callout>
                )}
                <div className="stat-label" style={{ marginTop: 8 }}>
                  Retention (days; blank = keep)
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  source {data.policy.sourceAudioRetentionDays ?? '∞'} · transcripts {data.policy.transcriptRetentionDays ?? '∞'} ·
                  generated {data.policy.generatedAudioRetentionDays ?? '∞'} · conversations{' '}
                  {data.policy.agentConversationRetentionDays ?? '∞'}
                </div>
              </div>
            )}
          </AsyncBlock>
        </Card>

        <Card title="Keyterm dictionary">
          <AsyncBlock state={settings}>
            {(data) => (
              <>
                {data.keyterms.length === 0 ? (
                  <Empty>No keyterms yet.</Empty>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    {data.keyterms.map((keyterm) => (
                      <span key={keyterm.id}>
                        <Badge tone={keyterm.sensitivity === 'private' ? 'warn' : undefined}>
                          {keyterm.term}
                          {keyterm.sensitivity === 'private' ? ' (private)' : ''}
                        </Badge>{' '}
                        <a className="faint" onClick={() => void audioApi.removeKeyterm(keyterm.id).then(() => settings.reload())}>
                          ×
                        </a>
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input style={{ flex: 1 }} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Artist, label, venue, ISRC…" />
                  <select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {['artist', 'manager', 'company', 'label', 'distributor', 'publisher', 'venue', 'city', 'isrc', 'upc', 'release', 'deal_term', 'acronym', 'other'].map(
                      (entry) => (
                        <option key={entry}>{entry}</option>
                      ),
                    )}
                  </select>
                  <select value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
                    <option value="shareable">shareable</option>
                    <option value="private">private (never sent to provider)</option>
                  </select>
                  <button
                    className="small"
                    disabled={!term.trim()}
                    onClick={() => void audioApi.addKeyterm({ term, category, sensitivity }).then(() => (setTerm(''), settings.reload()))}
                  >
                    add
                  </button>
                </div>
              </>
            )}
          </AsyncBlock>
        </Card>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 18 }}>
        <Card title="Usage this month">
          <AsyncBlock state={usage}>
            {(data) => (
              <>
                <div style={{ marginBottom: 8 }}>
                  <span className="stat">${data.summary.monthSpendUsd.toFixed(4)}</span>{' '}
                  <span className="stat-label">estimated + reconciled provider spend</span>
                </div>
                {data.summary.byOperation.length === 0 ? (
                  <Empty>No usage recorded yet.</Empty>
                ) : (
                  <table>
                    <tbody>
                      {data.summary.byOperation.map((row, index) => (
                        <tr key={index}>
                          <td>{row.operation}</td>
                          <td className="muted">{row.provider}</td>
                          <td className="mono">{row.count}×</td>
                          <td className="mono">${row.usd.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </AsyncBlock>
        </Card>

        <Card title="Recent jobs">
          <AsyncBlock state={jobs}>
            {(data) =>
              data.jobs.length === 0 ? (
                <Empty>No jobs.</Empty>
              ) : (
                <table>
                  <tbody>
                    {data.jobs.slice(0, 12).map((job) => (
                      <tr key={job.id}>
                        <td>{job.operation}</td>
                        <td className="muted">{job.provider}</td>
                        <td>
                          <Badge tone={job.status === 'complete' ? 'ok' : job.status === 'failed' ? 'danger' : 'info'}>{job.status}</Badge>
                        </td>
                        <td className="faint" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {job.errorMessage ?? ''}
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

      {isAdmin && (
        <div className="grid cols-2">
          <Card title="Providers (flagship admin)">
            <AsyncBlock state={adminProviders}>
              {(data) =>
                !data ? (
                  <Empty>Provider administration is restricted to the flagship organization.</Empty>
                ) : (
                  <>
                    {data.health.map((entry) => (
                      <div key={entry.providerId} style={{ marginBottom: 6 }}>
                        <Badge tone={entry.status === 'healthy' ? 'ok' : entry.status === 'unconfigured' ? undefined : 'danger'}>
                          {entry.providerId}: {entry.status}
                        </Badge>{' '}
                        <span className="faint">{entry.message}</span>
                      </div>
                    ))}
                    <p className="faint" style={{ fontSize: 12 }}>
                      Credentials are configured via environment (ELEVENLABS_API_KEY etc.) and are never shown here or sent to the
                      browser.
                    </p>
                  </>
                )
              }
            </AsyncBlock>
          </Card>

          <Card title="Webhook events (flagship admin)">
            <AsyncBlock state={adminWebhooks}>
              {(data) =>
                !data || data.events.length === 0 ? (
                  <Empty>No provider webhook events.</Empty>
                ) : (
                  <table>
                    <tbody>
                      {data.events.slice(0, 12).map((event) => (
                        <tr key={event.id}>
                          <td>{event.eventType}</td>
                          <td>
                            <Badge tone={event.signatureValid ? 'ok' : 'danger'}>{event.signatureValid ? 'signed' : 'rejected'}</Badge>
                          </td>
                          <td>
                            <Badge tone={event.status === 'processed' ? 'ok' : event.status === 'failed' ? 'danger' : undefined}>{event.status}</Badge>
                          </td>
                          <td className="faint">{new Date(event.receivedAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </AsyncBlock>
          </Card>
        </div>
      )}
    </>
  )
}
