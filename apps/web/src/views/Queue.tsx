import React from 'react'
import { api } from '../api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, statusTone, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'

export function QueueView({ projectId }: { projectId: string }) {
  const queue = useAsync(() => api.queue(projectId), [projectId])
  const [filter, setFilter] = React.useState<string>('all')
  const [busy, setBusy] = React.useState<string | null>(null)

  // The queue is the one screen where staleness is actively misleading, so it
  // polls — but a fixed 4s forever is wrong in two ways. A tab left open in the
  // background polls all night for nobody, and a poll that is failing (a
  // restart, a blip, a rate limit) is the worst moment to keep asking at full
  // speed: retrying into a 429 spends the budget that would let it recover.
  // So: back off on consecutive failures, and stop entirely while hidden.
  const failures = queue.failures
  React.useEffect(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    const delay = failures === 0 ? 4000 : Math.min(60_000, 4000 * 2 ** failures)
    const timer = setTimeout(() => queue.reload(), delay)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, failures, queue.data, queue.error])

  // Coming back to the tab should show current state immediately, not whatever
  // was on screen when it was hidden.
  React.useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) queue.reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const act = async (jobId: string, action: 'retry' | 'cancel') => {
    setBusy(jobId)
    try {
      if (action === 'retry') await api.retryJob(jobId)
      else await api.cancelJob(jobId)
      queue.reload()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Render queue</h2>
        <div className="button-row">
          {['all', 'queued', 'processing', 'completed', 'failed', 'blocked'].map((option) => (
            <button key={option} className={`small${filter === option ? ' primary' : ''}`} onClick={() => setFilter(option)}>
              {option}
            </button>
          ))}
        </div>
      </div>

      <AsyncBlock state={queue}>
        {(data) => {
          const jobs = data.jobs.filter((job) => filter === 'all' || job.status === filter)
          const blocked = data.jobs.filter((job) => job.status === 'blocked')
          return (
            <>
              <div className="grid cols-4" style={{ marginBottom: 16 }}>
                {Object.entries(data.stats).map(([key, value]) => (
                  <Card key={key}>
                    <div className="stat small">{value}</div>
                    <div className="stat-label">{key.replace(/_/g, ' ')}</div>
                  </Card>
                ))}
              </div>

              {blocked.length > 0 && (
                <Callout tone="warn" title={`${blocked.length} render(s) blocked by the cost controller`}>
                  These were authorized at plan time but denied at submission — budgets move while jobs wait. Raise the budget or approve the spend, then
                  retry. Nothing was billed.
                </Callout>
              )}

              <Card title="Jobs">
                {jobs.length === 0 ? (
                  <Empty>Nothing in this state.</Empty>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Provider / model</th>
                        <th className="num">Est.</th>
                        <th className="num">Actual</th>
                        <th className="num">Attempts</th>
                        <th className="num">Age</th>
                        <th>Detail</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map((job) => (
                        <tr key={job.id}>
                          <td>
                            <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                            {job.sandbox && (
                              <div style={{ marginTop: 3 }}>
                                <Badge>sandbox</Badge>
                              </div>
                            )}
                          </td>
                          <td>
                            <div className="mono" style={{ fontSize: 12 }}>
                              {job.provider}/{job.model}
                            </div>
                            <a href={`#/shot/${job.shotId}/review`} style={{ fontSize: 11 }}>
                              review shot
                            </a>
                          </td>
                          <td className="num">{job.estimatedUsd}</td>
                          <td className="num">{job.actualUsd}</td>
                          <td className="num">{job.attempts}</td>
                          <td className="num">{formatAge(job.ageSeconds)}</td>
                          <td className="faint" style={{ maxWidth: 320, fontSize: 11 }}>
                            {job.error ? String((job.error as { message?: string }).message ?? JSON.stringify(job.error)).slice(0, 220) : '—'}
                          </td>
                          <td>
                            <div className="button-row">
                              {(job.status === 'failed' || job.status === 'blocked') && (
                                <button className="small" disabled={busy === job.id} onClick={() => void act(job.id, 'retry')}>
                                  Retry
                                </button>
                              )}
                              {(job.status === 'queued' || job.status === 'submitted' || job.status === 'processing') && (
                                <button className="small danger" disabled={busy === job.id} onClick={() => void act(job.id, 'cancel')}>
                                  Cancel
                                </button>
                              )}
                              {job.status === 'completed' && (
                                <button className="small" onClick={() => navigate(`/shot/${job.shotId}/review`)}>
                                  View
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          )
        }}
      </AsyncBlock>
    </>
  )
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
