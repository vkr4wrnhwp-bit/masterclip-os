import React from 'react'
import { api, type OutputView } from '../api.js'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, qcTone, statusTone, useAsync } from '../ui.jsx'

const REJECTION_REASONS = [
  'character_drift',
  'wrong_face',
  'wrong_wardrobe',
  'wrong_camera',
  'too_static',
  'too_much_motion',
  'artificial_lighting',
  'ai_appearance',
  'bad_hands',
  'bad_physics',
  'weak_narrative',
  'wrong_environment',
  'poor_framing',
  'texture_flicker',
  'not_commercially_usable',
  'other',
]

/**
 * Review grid.
 *
 * Synchronised playback is the point: candidates for the same shot are only
 * comparable when they are at the same frame. One transport drives all of them.
 */
export function ReviewGrid({ shotId }: { shotId: string }) {
  const outputs = useAsync(() => api.outputs(shotId), [shotId])
  const shot = useAsync(() => api.shot(shotId), [shotId])
  const [loop, setLoop] = React.useState(true)
  const [muted, setMuted] = React.useState(true)
  const [compare, setCompare] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const videos = React.useRef(new Map<string, HTMLVideoElement>())

  const controlAll = (fn: (video: HTMLVideoElement) => void) => {
    for (const video of videos.current.values()) fn(video)
  }

  const decide = async (outputId: string, decision: string, reasons: string[] = []) => {
    setBusy(outputId)
    setError(null)
    try {
      await api.review(outputId, { decision, rejectionReasons: reasons })
      outputs.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const promote = async (output: OutputView) => {
    setBusy(output.id)
    setError(null)
    try {
      await api.promote(output.id, `${shot.data?.shot.shotKey ?? 'shot'} master`)
      outputs.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="topbar">
        <h2>Review — {shot.data?.shot.title ?? shotId}</h2>
        <div className="button-row">
          <button className="small" onClick={() => controlAll((v) => void v.play())}>
            Play all
          </button>
          <button className="small" onClick={() => controlAll((v) => v.pause())}>
            Pause
          </button>
          <button className="small" onClick={() => controlAll((v) => (v.currentTime = 0))}>
            Restart
          </button>
          <button className="small" onClick={() => controlAll((v) => (v.currentTime = Math.max(0, v.currentTime - 1 / 24)))}>
            ◀ frame
          </button>
          <button className="small" onClick={() => controlAll((v) => (v.currentTime = v.currentTime + 1 / 24))}>
            frame ▶
          </button>
          <button className={`small${loop ? ' primary' : ''}`} onClick={() => setLoop(!loop)}>
            Loop
          </button>
          <button className={`small${muted ? '' : ' primary'}`} onClick={() => setMuted(!muted)}>
            {muted ? 'Muted' : 'Sound'}
          </button>
          <button className="small" onClick={() => outputs.reload()}>
            Refresh
          </button>
        </div>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <AsyncBlock state={outputs}>
        {(data) =>
          data.outputs.length === 0 ? (
            <Empty>No candidates yet. Submit a batch from the Shot Builder, then watch the render queue.</Empty>
          ) : (
            <>
              {compare.length === 2 && <ComparePanel outputs={data.outputs.filter((o) => compare.includes(o.id))} onClose={() => setCompare([])} />}
              <div className="review-grid">
                {data.outputs.map((output) => {
                  const qc = (output.qcDetail ?? {}) as Record<string, unknown>
                  const action = String(qc.recommended_action ?? '')
                  const rejected = output.review?.decision === 'reject'
                  const raw = (typeof qc.raw === 'string' ? safeParse(qc.raw) : qc.raw) as Record<string, unknown> | null
                  return (
                    <div key={output.id} className={`candidate${rejected ? ' rejected' : ''}${compare.includes(output.id) ? ' selected' : ''}`}>
                      {output.urls.proxy || output.urls.source ? (
                        <video
                          ref={(element) => {
                            if (element) videos.current.set(output.id, element)
                            else videos.current.delete(output.id)
                          }}
                          src={output.urls.proxy ?? output.urls.source ?? ''}
                          poster={output.urls.thumbnail ?? undefined}
                          controls
                          loop={loop}
                          muted={muted}
                          playsInline
                        />
                      ) : (
                        <div style={{ aspectRatio: '16/9', background: '#000' }} />
                      )}
                      <div className="body">
                        <div className="row">
                          <span className="mono">
                            {output.providerId}/{output.modelId}
                          </span>
                          <Badge tone={statusTone(output.status)}>{output.status}</Badge>
                        </div>
                        <div className="row">
                          <span>
                            {output.durationSeconds?.toFixed(1) ?? '?'}s · {output.width}×{output.height} · {output.fps ?? '?'}fps
                          </span>
                          <span>{output.actualUsd !== '$0.0000' ? output.actualUsd : output.estimatedUsd}</span>
                        </div>

                        {action && (
                          <div style={{ margin: '7px 0' }}>
                            <Badge tone={qcTone(action)}>{action.replace(/_/g, ' ')}</Badge>{' '}
                            <span className="faint" style={{ fontSize: 11 }}>
                              confidence {Math.round(Number(qc.confidence ?? 0) * 100)}%
                            </span>
                          </div>
                        )}

                        <div className="scores">
                          <span>
                            creative <b>{String(qc.creative_score ?? '—')}</b>
                          </span>
                          <span>
                            identity <b>{String(qc.identity_score ?? '—')}</b>
                          </span>
                          <span>
                            motion <b>{String(qc.motion_score ?? '—')}</b>
                          </span>
                          <span>
                            realism <b>{String(qc.realism_score ?? '—')}</b>
                          </span>
                        </div>

                        {raw?.rationale ? (
                          <div className="faint" style={{ fontSize: 11, marginBottom: 7 }}>
                            {String(raw.rationale)}
                          </div>
                        ) : null}

                        {Array.isArray(raw?.hard_failures) && (raw.hard_failures as string[]).length > 0 && (
                          <Callout tone="danger">
                            {(raw.hard_failures as string[]).slice(0, 3).map((failure, index) => (
                              <div key={index} style={{ fontSize: 11 }}>
                                {failure}
                              </div>
                            ))}
                          </Callout>
                        )}

                        <details>
                          <summary>Prompt &amp; settings</summary>
                          <div className="prompt-box">{output.prompt}</div>
                          <div className="faint mono" style={{ fontSize: 10, marginTop: 6 }}>
                            profile {output.routingProfile} · seed {output.seed ?? 'none'} · job {output.jobId}
                          </div>
                        </details>

                        <ReviewActions
                          output={output}
                          busy={busy === output.id}
                          onDecide={decide}
                          onPromote={promote}
                          onCompare={() =>
                            setCompare((current) =>
                              current.includes(output.id) ? current.filter((id) => id !== output.id) : [...current, output.id].slice(-2),
                            )
                          }
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )
        }
      </AsyncBlock>
    </>
  )
}

function ReviewActions({
  output,
  busy,
  onDecide,
  onPromote,
  onCompare,
}: {
  output: OutputView
  busy: boolean
  onDecide: (id: string, decision: string, reasons?: string[]) => Promise<void>
  onPromote: (output: OutputView) => Promise<void>
  onCompare: () => void
}) {
  const [rejecting, setRejecting] = React.useState(false)
  const [reasons, setReasons] = React.useState<string[]>([])

  if (rejecting) {
    return (
      <div style={{ marginTop: 8 }}>
        <Field label="Why is this rejected?" hint="drives future routing">
          <select multiple size={5} value={reasons} onChange={(e) => setReasons(Array.from(e.target.selectedOptions).map((o) => o.value))}>
            {REJECTION_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <div className="button-row">
          <button
            className="small danger"
            disabled={busy || reasons.length === 0}
            onClick={() => {
              void onDecide(output.id, 'reject', reasons).then(() => setRejecting(false))
            }}
          >
            Confirm reject
          </button>
          <button className="small" onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="button-row" style={{ marginTop: 8 }}>
      <button className="small ok" disabled={busy} onClick={() => void onDecide(output.id, 'approve')}>
        Approve
      </button>
      <button className="small danger" disabled={busy} onClick={() => setRejecting(true)}>
        Reject
      </button>
      <button
        className="small"
        disabled={busy || output.review?.decision !== 'approve'}
        title={output.review?.decision === 'approve' ? 'promote to master' : 'approve it first — masters need a human decision'}
        onClick={() => void onPromote(output)}
      >
        Promote
      </button>
      <button className="small" onClick={onCompare}>
        Compare
      </button>
    </div>
  )
}

function ComparePanel({ outputs, onClose }: { outputs: OutputView[]; onClose: () => void }) {
  const [a, b] = outputs
  if (!a || !b) return null
  const rows: Array<[string, string, string]> = [
    ['Model', `${a.providerId}/${a.modelId}`, `${b.providerId}/${b.modelId}`],
    ['Cost', a.actualUsd, b.actualUsd],
    ['Duration', `${a.durationSeconds?.toFixed(2) ?? '?'}s`, `${b.durationSeconds?.toFixed(2) ?? '?'}s`],
    ['Resolution', `${a.width}×${a.height}`, `${b.width}×${b.height}`],
    ['Seed', a.seed ?? 'none', b.seed ?? 'none'],
    ['QC action', String((a.qcDetail as Record<string, unknown>)?.recommended_action ?? '—'), String((b.qcDetail as Record<string, unknown>)?.recommended_action ?? '—')],
    ['Creative', String((a.qcDetail as Record<string, unknown>)?.creative_score ?? '—'), String((b.qcDetail as Record<string, unknown>)?.creative_score ?? '—')],
    ['Prompt', a.prompt, b.prompt],
  ]
  return (
    <Card title="Side-by-side" action={<button className="small" onClick={onClose}>Close</button>}>
      <table>
        <tbody>
          {rows.map(([label, left, right]) => (
            <tr key={label}>
              <th style={{ width: 110 }}>{label}</th>
              <td style={{ fontSize: 12 }}>{left}</td>
              <td style={{ fontSize: 12 }}>{right}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
