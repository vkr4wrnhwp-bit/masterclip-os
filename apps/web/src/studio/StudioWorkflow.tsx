import React from 'react'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'
import { studioApi, type SessionPayload, type StudioVersion } from './api.js'
import { clock, formatMetric } from './components.jsx'

/**
 * Master Station.
 *
 * The A/B is the point of this screen, and the one rule it enforces is that
 * every comparison is level-matched: the gain the server computed is applied to
 * whichever source is playing, so a louder master does not win by being louder.
 * Where the match gain could not be computed the control says the comparison is
 * unmatched instead of quietly playing them at different levels.
 */
export function StudioMaster({ projectId, data, reload }: { projectId: string; data: SessionPayload; reload: () => void }) {
  const versionId = data.project.approvedMixVersionId ?? data.version?.id
  const master = useAsync(() => studioApi.master(projectId, versionId), [projectId, versionId])
  const [selected, setSelected] = React.useState<string>('original')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const audioRef = React.useRef<HTMLAudioElement>(null)

  const request = async (direction: string) => {
    if (!versionId) return
    setBusy(true)
    setError(null)
    try {
      await studioApi.requestMaster(projectId, { versionId, direction })
      master.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AsyncBlock state={master}>
      {(payload) => {
        const comparison = payload.comparison
        const entry = comparison?.renditions.find((candidate) => candidate.rendition.id === selected)
        const source = selected === 'original' ? comparison?.original.url : entry?.url
        // The match gain turns into playback gain. Applying it in the element
        // rather than in a caller means every path through this screen is
        // matched, including the keyboard one.
        const gainDb = selected === 'original' ? 0 : (entry?.matchGainDb ?? null)
        const volume = gainDb === null ? 1 : Math.max(0, Math.min(1, Math.pow(10, gainDb / 20)))

        return (
          <>
            <Card title="Master directions">
              {!versionId ? (
                <Empty>Upload or approve a mix first — Master Station needs something to master.</Empty>
              ) : (
                <>
                  <div className="grid cols-3">
                    {payload.directions.map((direction) => (
                      <div key={direction.key} className="direction">
                        <strong>{direction.label.toUpperCase()}</strong>
                        <div>{direction.summary}</div>
                        <div className="faint">{direction.intent}</div>
                        <div className="faint mono">
                          target {direction.targetLufs} LUFS · ceiling {direction.targetTruePeakDbtp} dBTP
                        </div>
                        <button className="small" disabled={busy || direction.key === 'custom'} onClick={() => void request(direction.key)}>
                          Generate
                        </button>
                      </div>
                    ))}
                  </div>
                  {error && <Callout tone="danger">{error}</Callout>}
                </>
              )}
            </Card>

            {comparison && (
              <Card title="A/B">
                <Callout tone="info">{comparison.note}</Callout>
                {source ? <audio ref={audioRef} src={source} controls preload="metadata" onLoadedMetadata={() => { if (audioRef.current) audioRef.current.volume = volume }} /> : null}
                <div className="version-strip">
                  <button className={`small ${selected === 'original' ? 'active' : ''}`} onClick={() => setSelected('original')}>
                    ORIGINAL
                  </button>
                  {comparison.renditions.map((candidate) => (
                    <button
                      key={candidate.rendition.id}
                      className={`small ${selected === candidate.rendition.id ? 'active' : ''}`}
                      onClick={() => setSelected(candidate.rendition.id)}
                    >
                      MASTER {candidate.rendition.slot.toUpperCase()} · {candidate.rendition.direction}
                    </button>
                  ))}
                </div>
                {selected !== 'original' && (
                  <div className={gainDb === null ? 'danger-text' : 'faint'}>
                    {gainDb === null
                      ? 'This comparison is NOT loudness-matched — the loudness of one side could not be measured. Judge it accordingly.'
                      : `Loudness-matched: ${gainDb.toFixed(2)} dB applied so this plays at the same level as the original.`}
                  </div>
                )}

                {comparison.renditions.map((candidate) => (
                  <div key={candidate.rendition.id} className="rendition">
                    <div className="rendition-head">
                      <strong>
                        MASTER {candidate.rendition.slot.toUpperCase()} — {candidate.direction.label}
                      </strong>
                      <Badge tone={candidate.rendition.status === 'ready' ? 'ok' : candidate.rendition.status === 'pending' ? 'info' : 'warn'}>
                        {candidate.rendition.status}
                      </Badge>
                      {candidate.rendition.approved && <Badge tone="ok">chosen</Badge>}
                    </div>
                    {candidate.rendition.placeholder && (
                      <Callout tone="warn" title="No audio was produced">
                        {/* The renderer's own note already explains what the
                            audio is; repeating it here said the same sentence
                            twice on screen. */}
                        {candidate.rendition.failureReason ?? 'Audio rendering is unavailable on this deployment, so no processing was applied.'}
                      </Callout>
                    )}
                    {candidate.rendition.renderPlan?.expectation && <div className="faint">{candidate.rendition.renderPlan.expectation}</div>}
                    {/* The chain is readable data, not a black box: a master
                        nobody can read back is a master nobody can reason about. */}
                    <ol className="chain-list">
                      {(candidate.rendition.renderPlan?.stages ?? []).map((stage, index) => (
                        <li key={index}>
                          <span className="mono">{stage.stage}</span> {stage.description}
                        </li>
                      ))}
                    </ol>
                    {(candidate.rendition.renderPlan?.restraint ?? []).map((line, index) => (
                      <div key={index} className="faint">
                        Held back — {line}
                      </div>
                    ))}
                    {candidate.changes.filter((change) => change.meaningful).length > 0 && (
                      <table className="table">
                        <thead>
                          <tr>
                            <th>What changed</th>
                            <th className="num">Before</th>
                            <th className="num">After</th>
                          </tr>
                        </thead>
                        <tbody>
                          {candidate.changes
                            .filter((change) => change.meaningful)
                            .map((change) => (
                              <tr key={change.metricKey}>
                                <td>{change.label}</td>
                                <td className="num">{formatMetric(change.before, change.unit)}</td>
                                <td className="num">{formatMetric(change.after, change.unit)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    )}
                    {candidate.rendition.status === 'ready' && !candidate.rendition.approved && (
                      <button className="primary" onClick={() => void studioApi.chooseMaster(projectId, candidate.rendition.id).then(() => { master.reload(); reload() })}>
                        Choose this master
                      </button>
                    )}
                  </div>
                ))}
              </Card>
            )}
          </>
        )
      }}
    </AsyncBlock>
  )
}

/** Version Vault and the difference engine. */
export function StudioVersions({ projectId, versions, onOpen }: { projectId: string; versions: StudioVersion[]; onOpen: (id: string) => void }) {
  const [a, setA] = React.useState<string>(versions[0]?.id ?? '')
  const [b, setB] = React.useState<string>(versions.at(-1)?.id ?? '')
  const comparison = useAsync(() => (a && b && a !== b ? studioApi.compareVersions(projectId, a, b) : Promise.resolve(null)), [projectId, a, b])

  return (
    <>
      <Card title="Version Vault">
        <div className="faint">Nothing here is ever replaced. A new mix creates a new version; every earlier one stays exactly as it was, and stays playable.</div>
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Type</th>
              <th>Source</th>
              <th className="num">Length</th>
              <th className="num">Format</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr key={version.id} className={version.supersededAt ? 'superseded' : undefined}>
                <td>
                  {version.label}
                  {version.approved && <> <Badge tone="ok">approved</Badge></>}
                </td>
                <td className="faint">{version.versionType.replace(/_/g, ' ')}</td>
                <td className="faint">{version.sourceKind.replace(/_/g, ' ')}</td>
                <td className="num">{clock(version.durationMs)}</td>
                <td className="num faint">
                  {version.sampleRate ?? '—'} Hz / {version.bitDepth ?? '—'}-bit
                </td>
                <td className="faint">{new Date(version.createdAt).toLocaleDateString()}</td>
                <td>
                  <button className="small" onClick={() => onOpen(version.id)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="What changed">
        <div className="field-row">
          <Field label="From">
            <select value={a} onChange={(event) => setA(event.target.value)}>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To">
            <select value={b} onChange={(event) => setB(event.target.value)}>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <AsyncBlock state={comparison}>
          {(payload) =>
            !payload ? (
              <Empty>pick two different versions</Empty>
            ) : !payload.comparable ? (
              <Callout tone="warn" title="These versions cannot be compared">
                {payload.incomparableReason}
              </Callout>
            ) : payload.differences.length === 0 ? (
              <Empty>nothing measurable changed between these two versions</Empty>
            ) : (
              <ul className="differences">
                {payload.differences.map((difference) => (
                  <li key={difference.metricKey}>
                    {difference.statement}
                    {/* An inferred claim translates a measurement into a musical
                        statement; the label says which kind of claim it is. */}
                    <span className="faint"> · {difference.confidence === 'inferred' ? 'inferred from a proxy measurement' : 'measured directly'}</span>
                  </li>
                ))}
              </ul>
            )
          }
        </AsyncBlock>
      </Card>
    </>
  )
}

/** The collaborative control room and formal approval. */
export function StudioCollaborate({ projectId, data, reload }: { projectId: string; data: SessionPayload; reload: () => void }) {
  const collaborate = useAsync(() => studioApi.collaborate(projectId), [projectId])
  const [email, setEmail] = React.useState('')
  const [displayName, setDisplayName] = React.useState('')
  const [role, setRole] = React.useState('mix_engineer')
  const [comment, setComment] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  const approve = async (approvalType: string) => {
    if (!data.version) return
    setError(null)
    try {
      await studioApi.approve(projectId, { versionId: data.version.id, approvalType })
      collaborate.reload()
      reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <AsyncBlock state={collaborate}>
      {(payload) => (
        <>
          <Card title="Approvals">
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="grid cols-3">
              {(['mix', 'master', 'delivery'] as const).map((type) => {
                const state = payload.approvals.state[type]
                return (
                  <div key={type} className="approval">
                    <strong>{type.toUpperCase()} APPROVED</strong>
                    {state?.approval ? (
                      <>
                        <div>{state.approval.approvedByLabel}</div>
                        <div className="faint">{new Date(state.approval.approvedAt).toLocaleString()}</div>
                        {/* The checksum is the point: an approval is about
                            specific bytes, not about a version label. */}
                        <div className="faint mono">{state.approval.versionChecksum.slice(0, 16)}…</div>
                        {state.supersededByDraft && (
                          <Callout tone="warn">A newer draft exists. The approved file is still the approved file — this session is looking at something else.</Callout>
                        )}
                        <button
                          className="small"
                          onClick={() => {
                            const reason = window.prompt('Why is this approval being withdrawn?')
                            if (reason) void studioApi.revokeApproval(projectId, state.approval!.id, reason).then(() => { collaborate.reload(); reload() })
                          }}
                        >
                          Revoke
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="faint">not approved</div>
                        <button className="small" onClick={() => void approve(type)} disabled={!data.version}>
                          Approve {data.version?.label ?? ''}
                        </button>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>

          <div className="grid cols-2">
            <Card title="Collaborators">
              <table className="table">
                <tbody>
                  {payload.collaborators.map((collaborator) => (
                    <tr key={collaborator.id} className={collaborator.revokedAt ? 'superseded' : undefined}>
                      <td>
                        {collaborator.displayName}
                        <div className="faint">{collaborator.email}</div>
                      </td>
                      <td className="faint">{collaborator.collaboratorRole.replace(/_/g, ' ')}</td>
                      <td className="faint">{collaborator.permissions.join(', ')}</td>
                      <td>
                        {collaborator.revokedAt ? (
                          <Badge tone="danger">revoked</Badge>
                        ) : (
                          <button className="small" onClick={() => void studioApi.revokeCollaborator(projectId, collaborator.id).then(collaborate.reload)}>
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <form
                className="upload-row"
                onSubmit={(event) => {
                  event.preventDefault()
                  void studioApi.invite(projectId, { email, displayName, role }).then(() => {
                    setEmail('')
                    setDisplayName('')
                    collaborate.reload()
                  })
                }}
              >
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Name" aria-label="Collaborator name" required />
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" aria-label="Collaborator email" required />
                <select value={role} onChange={(event) => setRole(event.target.value)} aria-label="Role">
                  {payload.roles.map((option) => (
                    <option key={option} value={option}>
                      {option.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                <button className="small" type="submit">
                  Invite
                </button>
              </form>
            </Card>

            <Card title="Comments">
              <form
                className="note-composer"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!comment.trim()) return
                  void studioApi.comment(projectId, { body: comment }).then(() => {
                    setComment('')
                    collaborate.reload()
                  })
                }}
              >
                <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a comment…" aria-label="Comment" />
                <button className="small" type="submit">
                  Post
                </button>
              </form>
              {payload.threads.length === 0 ? (
                <Empty>no comments yet</Empty>
              ) : (
                payload.threads.map((thread) => (
                  <div key={thread.id} className={`note ${thread.status}`}>
                    <div className="note-head">
                      {thread.timestampMs !== null && <span className="mono">{clock(thread.timestampMs)}</span>}
                      <strong>{thread.authorLabel}</strong>
                      <span className="faint">{new Date(thread.createdAt).toLocaleString()}</span>
                      {thread.status === 'resolved' && <Badge tone="ok">resolved</Badge>}
                    </div>
                    <div>{thread.body}</div>
                    {thread.replies.map((reply) => (
                      <div key={reply.id} className="reply">
                        <strong>{reply.authorLabel}</strong> {reply.body}
                      </div>
                    ))}
                    {thread.status !== 'resolved' && (
                      <button className="small" onClick={() => void studioApi.resolveComment(projectId, thread.id).then(collaborate.reload)}>
                        Resolve
                      </button>
                    )}
                  </div>
                ))
              )}
            </Card>
          </div>
        </>
      )}
    </AsyncBlock>
  )
}

/** Delivery Centre, plus the passport and rights surfaces that gate it. */
export function StudioDeliver({ projectId, data, reload }: { projectId: string; data: SessionPayload; reload: () => void }) {
  const deliver = useAsync(() => studioApi.deliver(projectId), [projectId])
  const passport = useAsync(() => studioApi.passport(projectId), [projectId])
  const rights = useAsync(() => studioApi.rights(projectId), [projectId])
  const dna = useAsync(() => studioApi.sonicDna(projectId), [projectId])
  const [kind, setKind] = React.useState('dsp_master')
  const [error, setError] = React.useState<string | null>(null)

  return (
    <>
      <Card title="Delivery Centre">
        {error && <Callout tone="danger">{error}</Callout>}
        <AsyncBlock state={deliver}>
          {(payload) => (
            <>
              <div className="upload-row">
                <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Deliverable kind">
                  {payload.kinds.map((option) => (
                    <option key={option} value={option}>
                      {option.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                <button
                  className="small"
                  disabled={!data.version}
                  onClick={() => {
                    if (!data.version) return
                    void studioApi.createDeliverable(projectId, { versionId: data.version.id, assetKind: kind }).then(deliver.reload)
                  }}
                >
                  Prepare from {data.version?.label ?? 'current version'}
                </button>
              </div>

              {payload.deliverables.length === 0 ? (
                <Empty>no deliverables prepared yet</Empty>
              ) : (
                payload.deliverables.map(({ deliverable, checks }) => (
                  <div key={deliverable.id} className="deliverable">
                    <div className="rendition-head">
                      <strong>{deliverable.assetKind.replace(/_/g, ' ').toUpperCase()}</strong>
                      <span className="mono faint">{deliverable.fileName}</span>
                      <Badge tone={deliverable.status === 'sent' ? 'ok' : deliverable.status === 'checks_failed' ? 'danger' : 'info'}>
                        {deliverable.status.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                    <table className="table">
                      <tbody>
                        {checks.map((check) => (
                          <tr key={check.id}>
                            <td>
                              <Badge tone={check.outcome === 'pass' ? 'ok' : check.outcome === 'fail' ? 'danger' : check.outcome === 'warn' ? 'warn' : 'info'}>
                                {check.outcome}
                              </Badge>
                            </td>
                            <td>{check.checkKey.replace(/_/g, ' ')}</td>
                            <td className="faint">{check.detail}</td>
                            <td className="num faint">{check.measured ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="button-row">
                      <button className="small" onClick={() => void studioApi.runChecks(projectId, deliverable.id).then(deliver.reload)}>
                        Re-run checks
                      </button>
                      <button
                        className="primary"
                        disabled={deliverable.status === 'sent'}
                        onClick={() => {
                          const releaseId = window.prompt('Release id to hand this to')
                          if (!releaseId) return
                          setError(null)
                          void studioApi
                            .sendToRelease(projectId, deliverable.id, releaseId)
                            .then(() => {
                              deliver.reload()
                              reload()
                            })
                            .catch((err: Error) => setError(err.message))
                        }}
                      >
                        Send to release
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div className="faint">
                Sending requires zero failing checks and a delivery approval. Warnings never block — a product that refuses to ship over a warning teaches people
                to ignore warnings.
              </div>
            </>
          )}
        </AsyncBlock>
      </Card>

      <div className="grid cols-2">
        <Card
          title="Record Passport"
          action={<button className="small" onClick={() => void studioApi.buildPassport(projectId).then(passport.reload)}>Rebuild</button>}
        >
          <AsyncBlock state={passport}>
            {(payload) =>
              !payload.passport ? (
                <Empty>no passport built for this record yet</Empty>
              ) : (
                <>
                  <div className="faint mono">{payload.passport.documentHash.slice(0, 32)}…</div>
                  <div>
                    <Badge tone={payload.passport.status === 'finalized' ? 'ok' : 'info'}>{payload.passport.status}</Badge>{' '}
                    <Badge tone={payload.verification?.valid ? 'ok' : 'danger'}>{payload.verification?.valid ? 'verified' : 'verification failed'}</Badge>
                  </div>
                  {payload.verification?.asset.checked && <div className="faint">{payload.verification.asset.detail}</div>}
                  <h4>Contributions</h4>
                  {payload.contributions.length === 0 ? (
                    <Empty>no contributions declared</Empty>
                  ) : (
                    <ul className="differences">
                      {payload.contributions.map((contribution) => (
                        <li key={contribution.id}>
                          <strong>{contribution.performedBy}</strong> — {contribution.contributionType}
                          {/* Human and AI-assisted contributions are recorded
                              separately and never merged into one claim. */}
                          {contribution.human ? <Badge tone="ok">human</Badge> : <Badge tone="warn">AI-assisted</Badge>}
                          {contribution.aiRole && <span className="faint"> {contribution.aiRole}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
            }
          </AsyncBlock>
        </Card>

        <Card title="Rights">
          <AsyncBlock state={rights}>
            {(payload) => (
              <>
                <h4>AI use</h4>
                {payload.permissions.length === 0 ? (
                  <div className="faint">
                    No AI permissions recorded. Nothing is permitted by default — an absent permission is a refusal, not an omission.
                  </div>
                ) : (
                  <ul className="differences">
                    {payload.permissions.map(({ permission }) => (
                      <li key={permission.id}>
                        <Badge tone={permission.granted && !permission.revokedAt ? 'ok' : 'danger'}>{permission.granted && !permission.revokedAt ? 'granted' : 'withheld'}</Badge>{' '}
                        {permission.permission.replace(/_/g, ' ')} on {permission.assetScope}
                        {permission.conditions && <div className="faint">{permission.conditions}</div>}
                      </li>
                    ))}
                  </ul>
                )}
                <h4>Identity Vault</h4>
                <ul className="differences">
                  {payload.identity.entries.map(({ entry }) => (
                    <li key={entry.id}>
                      <Badge tone={entry.control === 'permitted' ? 'ok' : entry.control === 'prohibited' ? 'danger' : 'warn'}>{entry.control.replace(/_/g, ' ')}</Badge> {entry.subject}
                      {entry.control === 'permitted' && !entry.verified && <span className="faint"> — consent not verified, so this reads as consent required</span>}
                    </li>
                  ))}
                  {payload.identity.implicit.map((entry) => (
                    <li key={entry.subject}>
                      <Badge tone="danger">prohibited</Badge> {entry.subject} <span className="faint">— {entry.reason}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </AsyncBlock>
        </Card>
      </div>

      <Card
        title="Artist Sonic DNA"
        action={
          <button
            className="small"
            onClick={() => {
              if (window.confirm('Erase everything Street Banker has derived about this artist’s preferences?')) void studioApi.resetSonicDna(projectId).then(dna.reload)
            }}
          >
            Reset
          </button>
        }
      >
        <AsyncBlock state={dna}>
          {(payload) => (
            <>
              <div className="faint">
                Derived only from masters a person approved — never from what you audition, render or compare. Everything here is visible, attributed to the
                approvals behind it, and can be erased.
              </div>
              {payload.entries.length === 0 ? (
                <Empty>nothing derived yet — approve a master and Street Banker starts to learn</Empty>
              ) : (
                <table className="table">
                  <tbody>
                    {payload.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.attribute.replace(/_/g, ' ')}</td>
                        <td>{entry.valueText ?? '—'}</td>
                        <td className="faint">
                          {entry.source} · {entry.sampleSize} record{entry.sampleSize === 1 ? '' : 's'} · confidence {(entry.confidence * 100).toFixed(0)}%
                        </td>
                        <td>
                          <Badge tone={entry.status === 'active' ? 'ok' : entry.status === 'dismissed' ? 'danger' : 'info'}>{entry.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </AsyncBlock>
      </Card>
    </>
  )
}
