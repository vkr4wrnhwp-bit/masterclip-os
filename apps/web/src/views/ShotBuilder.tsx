import React from 'react'
import { api, type RoutingCandidate } from '../api.js'
import { AsyncBlock, Badge, Callout, Card, Field, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'

/**
 * Shot Builder.
 *
 * Progressive disclosure by design: the fields that decide whether a shot works
 * (subject, action, camera, light) are above the fold; format, routing, and
 * constraints are behind disclosures. The candidate matrix always shows the
 * total cost before anything can be submitted.
 */
export function ShotBuilder({ shotId }: { shotId: string }) {
  const shot = useAsync(() => api.shot(shotId), [shotId])
  const routing = useAsync(() => api.routing(shotId), [shotId])
  const [spec, setSpec] = React.useState<Record<string, unknown> | null>(null)
  const [issues, setIssues] = React.useState<Array<{ path: string; message: string; severity: string }>>([])
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (shot.data && !spec) setSpec(shot.data.version.spec)
  }, [shot.data, spec])

  const update = (patch: Record<string, unknown>) => setSpec((current) => ({ ...(current ?? {}), ...patch }))
  const updateLighting = (patch: Record<string, unknown>) =>
    setSpec((current) => ({ ...(current ?? {}), lighting: { ...((current?.lighting as object) ?? {}), ...patch } }))

  const validate = async () => {
    if (!spec) return
    const result = await api.validateShot(spec)
    setIssues(result.issues)
  }

  const save = async () => {
    if (!spec) return
    setSaving(true)
    setError(null)
    try {
      const result = await api.validateShot(spec)
      setIssues(result.issues)
      if (!result.ok) {
        setError('fix the errors above before saving a new version')
        return
      }
      await api.saveShotVersion(shotId, spec, 'edited in shot builder')
      shot.reload()
      routing.reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!spec) return <AsyncBlock state={shot}>{() => <div className="spinner">loading…</div>}</AsyncBlock>

  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  return (
    <>
      <div className="topbar">
        <h2>{String(spec.title || spec.shot_id || 'Shot')}</h2>
        <div className="button-row">
          <button onClick={() => void validate()}>Validate</button>
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'saving…' : 'Save version'}
          </button>
          <button onClick={() => navigate(`/shot/${shotId}/review`)}>Review grid</button>
        </div>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}
      {errors.length > 0 && (
        <Callout tone="danger" title={`${errors.length} error${errors.length === 1 ? '' : 's'}`}>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {errors.map((issue, index) => (
              <li key={index}>
                <code className="mono">{issue.path}</code> — {issue.message}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {warnings.length > 0 && (
        <Callout tone="warn" title={`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {warnings.map((issue, index) => (
              <li key={index}>
                <code className="mono">{issue.path}</code> — {issue.message}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="grid cols-2">
        <div>
          <Card title="The shot">
            <div className="field-row">
              <Field label="Shot id">
                <input value={String(spec.shot_id ?? '')} onChange={(e) => update({ shot_id: e.target.value })} />
              </Field>
              <Field label="Title">
                <input value={String(spec.title ?? '')} onChange={(e) => update({ title: e.target.value })} />
              </Field>
            </div>
            <Field label="Narrative purpose" hint="why this shot exists in the piece">
              <textarea rows={2} value={String(spec.narrative_purpose ?? '')} onChange={(e) => update({ narrative_purpose: e.target.value })} />
            </Field>
            <Field label="Action" hint="what physically happens">
              <textarea rows={2} value={String(spec.action ?? '')} onChange={(e) => update({ action: e.target.value })} />
            </Field>
            <Field label="Performance direction">
              <textarea rows={2} value={String(spec.performance_direction ?? '')} onChange={(e) => update({ performance_direction: e.target.value })} />
            </Field>
            <Field label="Blocking">
              <input value={String(spec.blocking ?? '')} onChange={(e) => update({ blocking: e.target.value })} />
            </Field>
          </Card>

          <Card title="Camera">
            <Field label="Camera position">
              <input value={String(spec.camera_position ?? '')} onChange={(e) => update({ camera_position: e.target.value })} placeholder="low medium, 3/4 to camera left" />
            </Field>
            <Field label="Camera movement" hint="must be physically possible">
              <input value={String(spec.camera_movement ?? '')} onChange={(e) => update({ camera_movement: e.target.value })} placeholder="slow dolly in" />
            </Field>
            <div className="field-row">
              <Field label="Lens (mm)">
                <input type="number" value={Number(spec.lens_mm ?? 50)} onChange={(e) => update({ lens_mm: Number(e.target.value) })} />
              </Field>
              <Field label="Aperture (f/)">
                <input type="number" step="0.1" value={Number(spec.aperture ?? 2)} onChange={(e) => update({ aperture: Number(e.target.value) })} />
              </Field>
              <Field label="Focus behaviour">
                <input value={String(spec.focus_behavior ?? '')} onChange={(e) => update({ focus_behavior: e.target.value })} />
              </Field>
            </div>
          </Card>

          <Card title="Light">
            <Field label="Dominant motivated source" hint="one source; the standard rejects flat global illumination">
              <input
                value={String((spec.lighting as Record<string, unknown>)?.dominant_source ?? '')}
                onChange={(e) => updateLighting({ dominant_source: e.target.value })}
                placeholder="magenta neon sign, camera left"
              />
            </Field>
            <div className="field-row">
              <Field label="Source position">
                <input value={String((spec.lighting as Record<string, unknown>)?.source_position ?? '')} onChange={(e) => updateLighting({ source_position: e.target.value })} />
              </Field>
              <Field label="Colour temperature">
                <input value={String((spec.lighting as Record<string, unknown>)?.color_temperature ?? '')} onChange={(e) => updateLighting({ color_temperature: e.target.value })} />
              </Field>
            </div>
            <div className="field-row">
              <Field label="Falloff">
                <input value={String((spec.lighting as Record<string, unknown>)?.falloff ?? '')} onChange={(e) => updateLighting({ falloff: e.target.value })} />
              </Field>
              <Field label="Shadow behaviour">
                <input value={String((spec.lighting as Record<string, unknown>)?.shadow_behavior ?? '')} onChange={(e) => updateLighting({ shadow_behavior: e.target.value })} />
              </Field>
            </div>
          </Card>
        </div>

        <div>
          <Card title="Format &amp; routing">
            <div className="field-row">
              <Field label="Generation mode">
                <select value={String(spec.generation_mode ?? '')} onChange={(e) => update({ generation_mode: e.target.value })}>
                  {['text_to_video', 'image_to_video', 'first_last_frame', 'reference_to_video', 'video_to_video', 'video_extend'].map((mode) => (
                    <option key={mode}>{mode}</option>
                  ))}
                </select>
              </Field>
              <Field label="Routing profile">
                <select value={String(spec.routing_profile ?? '')} onChange={(e) => update({ routing_profile: e.target.value })}>
                  {['STORYBOARD', 'DRAFT_MOTION', 'BALANCED', 'HERO', 'CONTINUITY', 'NATIVE_AUDIO', 'VIDEO_EDIT', 'SELF_HOSTED_DRAFT'].map((profile) => (
                    <option key={profile}>{profile}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="field-row">
              <Field label="Duration (s)">
                <input type="number" step="0.5" value={Number(spec.duration_seconds ?? 8)} onChange={(e) => update({ duration_seconds: Number(e.target.value) })} />
              </Field>
              <Field label="Resolution">
                <select value={String(spec.target_resolution ?? '')} onChange={(e) => update({ target_resolution: e.target.value })}>
                  {['480p', '540p', '720p', '1080p', '1440p', '2160p'].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>
              <Field label="Aspect">
                <select value={String(spec.aspect_ratio ?? '')} onChange={(e) => update({ aspect_ratio: e.target.value })}>
                  {['16:9', '9:16', '1:1', '4:5', '4:3', '3:4', '21:9', '2.39:1'].map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="field-row">
              <Field label="Candidates">
                <input type="number" value={Number(spec.candidate_count ?? 6)} onChange={(e) => update({ candidate_count: Number(e.target.value) })} />
              </Field>
              <Field label="Max cost (USD)" hint="hard ceiling for this shot">
                <input type="number" step="0.1" value={Number(spec.max_cost_usd ?? 2)} onChange={(e) => update({ max_cost_usd: Number(e.target.value) })} />
              </Field>
              <Field label="Category">
                <select value={String(spec.shot_category ?? '')} onChange={(e) => update({ shot_category: e.target.value })}>
                  {['performance', 'portrait', 'action', 'product', 'environment', 'insert_detail', 'transition', 'crowd', 'vehicle', 'abstract'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>

          <RoutingPanel routing={routing} />
          <MatrixPanel shotId={shotId} spec={spec} />

          <details>
            <summary>Constraints &amp; locks (advanced)</summary>
            <Field label="Negative constraints" hint="one per line; the cinematic standard's list is added automatically">
              <textarea
                rows={4}
                value={((spec.negative_constraints as string[]) ?? []).join('\n')}
                onChange={(e) => update({ negative_constraints: e.target.value.split('\n').filter(Boolean) })}
              />
            </Field>
            <Field label="Identity locks" hint="character keys, one per line — requires cleared references">
              <textarea
                rows={2}
                value={((spec.identity_locks as Array<{ character_key?: string }>) ?? []).map((l) => l.character_key ?? '').join('\n')}
                onChange={(e) =>
                  update({
                    identity_locks: e.target.value
                      .split('\n')
                      .filter(Boolean)
                      .map((key) => ({ character_key: key, character_version: 0, strength: 'strict', must_match: [] })),
                  })
                }
              />
            </Field>
            <Field label="Source assets" hint="asset ids, one per line">
              <textarea
                rows={2}
                value={((spec.source_assets as string[]) ?? []).join('\n')}
                onChange={(e) => update({ source_assets: e.target.value.split('\n').filter(Boolean) })}
              />
            </Field>
          </details>
        </div>
      </div>
    </>
  )
}

function RoutingPanel({ routing }: { routing: ReturnType<typeof useAsync<Awaited<ReturnType<typeof api.routing>>>> }) {
  return (
    <Card title="Model routing" action={<button className="small" onClick={() => routing.reload()}>Refresh</button>}>
      <AsyncBlock state={routing}>
        {(data) => (
          <>
            <div className="muted" style={{ marginBottom: 10 }}>
              {data.explanation}
            </div>
            {data.lowConfidence && (
              <Callout tone="warn" title="Low confidence">
                This ranking rests mostly on conservative priors rather than measured acceptance for this project. Approve a few candidates and it will
                start reflecting what actually works here.
              </Callout>
            )}
            {data.candidates.length === 0 ? (
              <Callout tone="danger" title="No compatible model">
                {data.rejected.slice(0, 4).map((row, index) => (
                  <div key={index} className="mono" style={{ fontSize: 11 }}>
                    {row.providerId}/{row.modelId}: {row.reasons[0]}
                  </div>
                ))}
              </Callout>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Est.</th>
                    <th className="num">Approval</th>
                    <th className="num">Per approved s</th>
                  </tr>
                </thead>
                <tbody>
                  {data.candidates.slice(0, 6).map((candidate: RoutingCandidate) => (
                    <tr key={`${candidate.providerId}/${candidate.modelId}`}>
                      <td>
                        <div>
                          {candidate.providerId}/<strong>{candidate.modelId}</strong>
                        </div>
                        <div className="faint" style={{ fontSize: 11 }}>
                          {candidate.reasons[0]}
                        </div>
                      </td>
                      <td className="num">{candidate.estimatedUsd ?? 'quote'}</td>
                      <td className="num">
                        {(candidate.predictedApprovalRate * 100).toFixed(0)}%
                        <div className="faint" style={{ fontSize: 10 }}>
                          conf {(candidate.confidence * 100).toFixed(0)}%
                        </div>
                      </td>
                      <td className="num">{candidate.expectedApprovedPerSecondUsd ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </AsyncBlock>
    </Card>
  )
}

function MatrixPanel({ shotId, spec }: { shotId: string; spec: Record<string, unknown> }) {
  const models = useAsync(() => api.models(), [])
  const [selected, setSelected] = React.useState<string[]>([])
  const [seeds, setSeeds] = React.useState('1')
  const [preview, setPreview] = React.useState<Awaited<ReturnType<typeof api.matrix>> | null>(null)
  const [result, setResult] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const chosen = selected.map((key) => {
    const [providerId, ...rest] = key.split('|')
    return { providerId: providerId ?? '', modelId: rest.join('|') }
  })

  const seedList = React.useMemo(() => {
    const count = Math.max(1, Number(seeds) || 1)
    return Array.from({ length: count }, (_, index) => (index === 0 ? null : String(1000 + index)))
  }, [seeds])

  const runPreview = async () => {
    setBusy(true)
    setError(null)
    try {
      setPreview(await api.matrix(shotId, { models: chosen, seeds: seedList }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const response = await api.render(shotId, {
        batchName: `${String(spec.shot_id ?? 'shot')} batch`,
        candidates: preview.cells.map((cell) => ({
          providerId: String(cell.providerId),
          modelId: String(cell.modelId),
          seed: (cell.seed as string | null) ?? null,
          variationLabel: String(cell.variationLabel),
          variationInstruction: String(cell.variationInstruction),
          resolution: String(cell.resolution),
          aspectRatio: String(cell.aspectRatio),
          durationSeconds: Number(cell.durationSeconds),
        })),
      })
      setResult(
        `queued ${response.queued} render(s), estimated ${response.estimatedUsd}` +
          (response.skipped.length > 0 ? ` — ${response.skipped.length} skipped: ${response.skipped[0]?.reason}` : ''),
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Candidate matrix">
      <AsyncBlock state={models}>
        {(data) => (
          <>
            <Field label="Models" hint="ctrl/cmd-click for several">
              <select
                multiple
                size={6}
                value={selected}
                onChange={(e) => setSelected(Array.from(e.target.selectedOptions).map((option) => option.value))}
              >
                {data.models.map((model) => (
                  <option key={`${model.providerId}|${model.modelId}`} value={`${model.providerId}|${model.modelId}`}>
                    [{model.tier}] {model.providerId}/{model.modelId}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Seeds / variations per model">
              <input type="number" min={1} max={16} value={seeds} onChange={(e) => setSeeds(e.target.value)} />
            </Field>
            <div className="button-row">
              <button onClick={() => void runPreview()} disabled={busy || chosen.length === 0}>
                Price this matrix
              </button>
              <button className="primary" onClick={() => void submit()} disabled={busy || !preview || preview.candidateCount === 0}>
                Submit {preview ? `${preview.candidateCount} renders` : ''}
              </button>
            </div>

            {preview && (
              <div style={{ marginTop: 12 }}>
                {/* Cost is shown before submission, always. */}
                <div className="field-row">
                  <div>
                    <div className="stat small">{preview.candidateCount}</div>
                    <div className="stat-label">candidates</div>
                  </div>
                  <div>
                    <div className="stat small">{preview.estimatedTotalUsd ?? 'quote required'}</div>
                    <div className="stat-label">estimated total</div>
                  </div>
                  <div>
                    <div className="stat small">{String((preview.budget as Record<string, unknown>).perShotCapUsd ?? '—')}</div>
                    <div className="stat-label">per-shot cap</div>
                  </div>
                </div>
                {preview.unpricedCount > 0 && (
                  <Callout tone="warn">
                    {preview.unpricedCount} candidate(s) have no published rate — a live provider quote is fetched before each of those is submitted.
                  </Callout>
                )}
                {preview.warnings.map((warning, index) => (
                  <Callout key={index} tone="warn">
                    {warning}
                  </Callout>
                ))}
              </div>
            )}
            {result && <Callout tone="ok">{result}</Callout>}
            {error && <Callout tone="danger">{error}</Callout>}
          </>
        )}
      </AsyncBlock>
    </Card>
  )
}
