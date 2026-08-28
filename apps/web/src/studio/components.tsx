import React from 'react'
import { Badge, Callout } from '../ui.jsx'
import type { MixCurveRow, MixIssue, MixMetricRow, MetricDefinition, Readiness, StudioNote } from './api.js'

export function clock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Formats a measurement.
 *
 * A `null` value renders as "not measured" everywhere, never as 0. The
 * distinction is the whole point of the analysis layer and it would be undone
 * by one careless `?? 0` in a template.
 */
export function formatMetric(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return 'not measured'
  switch (unit) {
    case 'lufs':
      return `${value.toFixed(1)} LUFS`
    case 'lu':
      return `${value.toFixed(1)} LU`
    case 'db':
    case 'dbfs':
      return `${value.toFixed(1)} dB`
    case 'dbtp':
      return `${value.toFixed(2)} dBTP`
    case 'percent':
      return `${value.toFixed(1)}%`
    case 'hz':
      return `${Math.round(value)} Hz`
    case 'count':
      return String(Math.round(value))
    case 'seconds':
      return `${value.toFixed(2)} s`
    case 'index':
      return `${(value * 100).toFixed(0)}%`
    default:
      return value.toFixed(3)
  }
}

// ---------------------------------------------------------------------------
// waveform and transport
// ---------------------------------------------------------------------------

/**
 * The session waveform.
 *
 * Drawn from a *curve the server measured*, not from a client-side decode: the
 * loudness curve is already stored against the analysis, so the picture the
 * artist sees is the same signal the Mix Doctor read. Clicking seeks; markers
 * and issue ranges are drawn over it.
 */
export function Waveform({
  curve,
  durationMs,
  positionMs,
  notes,
  issues,
  onSeek,
}: {
  curve: MixCurveRow | undefined
  durationMs: number | null
  positionMs: number
  notes: StudioNote[]
  issues: MixIssue[]
  onSeek: (ms: number) => void
}) {
  const total = durationMs ?? (curve ? curve.points.length * curve.stepMs : 0)
  const points = curve?.points ?? []
  const measured = points.filter((point): point is number => point !== null)
  const floor = measured.length > 0 ? Math.min(...measured) : -60
  const ceiling = measured.length > 0 ? Math.max(...measured) : 0
  const span = Math.max(1, ceiling - floor)

  const seek = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    onSeek(Math.round(ratio * total))
  }

  if (points.length === 0) {
    return <div className="waveform empty-wave">no measured waveform for this version yet</div>
  }

  return (
    <div className="waveform" onClick={seek} role="presentation">
      <div className="wave-bars">
        {points.map((point, index) => (
          <span
            key={index}
            className={point === null ? 'bar silent' : 'bar'}
            style={{ height: point === null ? '2%' : `${Math.max(2, ((point - floor) / span) * 100)}%` }}
          />
        ))}
      </div>
      {issues.map((issue) => (
        <span
          key={issue.id}
          className={`wave-issue ${issue.severity}`}
          title={`${clock(issue.startMs)} ${issue.headline}`}
          style={{ left: `${(issue.startMs / Math.max(1, total)) * 100}%`, width: `${Math.max(0.4, ((issue.endMs - issue.startMs) / Math.max(1, total)) * 100)}%` }}
        />
      ))}
      {notes
        .filter((note) => note.timestampMs !== null)
        .map((note) => (
          <span
            key={note.id}
            className={`wave-marker ${note.kind}`}
            title={`${clock(note.timestampMs)} ${note.body}`}
            style={{ left: `${((note.timestampMs ?? 0) / Math.max(1, total)) * 100}%` }}
          />
        ))}
      <span className="wave-playhead" style={{ left: `${(positionMs / Math.max(1, total)) * 100}%` }} />
    </div>
  )
}

/**
 * The transport.
 *
 * A/B is a *loudness-matched* switch: `gainDb` is applied to whichever source is
 * selected, so the comparison is fair. When the server could not compute a
 * match gain the control says the comparison is unmatched rather than silently
 * playing the louder file.
 */
export function Transport({
  audioRef,
  playing,
  onToggle,
  positionMs,
  durationMs,
  loop,
  onLoopChange,
}: {
  audioRef: React.RefObject<HTMLAudioElement>
  playing: boolean
  onToggle: () => void
  positionMs: number
  durationMs: number | null
  loop: { startMs: number; endMs: number } | null
  onLoopChange: (loop: { startMs: number; endMs: number } | null) => void
}) {
  return (
    <div className="transport">
      <button className="primary" onClick={onToggle}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <button
        className="small"
        onClick={() => {
          if (audioRef.current) audioRef.current.currentTime = 0
        }}
      >
        Return
      </button>
      <span className="mono transport-clock">
        {clock(positionMs)} / {clock(durationMs)}
      </span>
      {loop ? (
        <button className="small" onClick={() => onLoopChange(null)}>
          Loop {clock(loop.startMs)}–{clock(loop.endMs)} ✕
        </button>
      ) : (
        <span className="faint">click a finding to loop it</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// analysis surfaces
// ---------------------------------------------------------------------------

export function MetricTable({ metrics, definitions, group }: { metrics: MixMetricRow[]; definitions: MetricDefinition[]; group?: string }) {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
  const rows = metrics
    .map((metric) => ({ metric, definition: byKey.get(metric.metricKey) }))
    .filter((row) => row.definition && (!group || row.definition.group === group))
    .sort((a, b) => (a.definition?.label ?? '').localeCompare(b.definition?.label ?? ''))

  if (rows.length === 0) return <div className="empty">nothing measured in this group</div>

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Measurement</th>
          <th className="num">Value</th>
          <th>How it was measured</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ metric, definition }) => (
          <tr key={metric.metricKey} className={metric.value === null ? 'unmeasured' : undefined}>
            <td>
              <div>{definition?.label}</div>
              <div className="faint">{definition?.description}</div>
            </td>
            <td className="num">{formatMetric(metric.value, metric.unit)}</td>
            <td className="faint">
              {/* Provenance is not an expandable detail: a number without its
                  method and confidence is not something to act on. */}
              <span className="mono">{metric.analysisMethod}</span>
              {metric.value !== null && <> · confidence {(metric.confidence * 100).toFixed(0)}%</>}
              {metric.note && <div>{metric.note}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ReadinessPanel({ readiness }: { readiness: Readiness | null }) {
  if (!readiness) return <div className="empty">no analysis for this version yet</div>
  return (
    <>
      <div className="readiness-head">
        <div className="stat">{readiness.score === null ? 'not enough data' : `${readiness.score} / 100`}</div>
        <div className="stat-label">
          Release readiness{readiness.score !== null && <> · {readiness.bandsScored} of 8 bands measured</>}
        </div>
      </div>
      <Callout tone="info">{readiness.caveat}</Callout>
      <div className="readiness-bands">
        {readiness.bands.map((band) => (
          <div key={band.band} className="readiness-band">
            <div className="readiness-band-head">
              <strong>{band.label}</strong>
              <span className={`readiness-score ${band.score === null ? 'none' : band.score >= 75 ? 'ok' : band.score >= 50 ? 'warn' : 'danger'}`}>
                {band.score === null ? 'not measured' : band.score}
              </span>
            </div>
            <div className="faint">Detected — {band.detected}</div>
            <div className="faint">Why it matters — {band.whyItMatters}</div>
            <div>{band.recommendation}</div>
          </div>
        ))}
      </div>
    </>
  )
}

export function IssueList({
  issues,
  onHear,
  onAct,
}: {
  issues: MixIssue[]
  onHear: (issue: MixIssue) => void
  onAct: (issue: MixIssue, action: string) => void
}) {
  if (issues.length === 0) return <div className="empty">no potential issues detected on this version</div>
  const open = issues.filter((issue) => issue.status === 'open')
  return (
    <>
      <div className="issue-count">
        {open.length} POTENTIAL ISSUE{open.length === 1 ? '' : 'S'}
        {issues.length !== open.length && <span className="faint"> · {issues.length - open.length} handled</span>}
      </div>
      {issues.map((issue) => (
        <div key={issue.id} className={`issue ${issue.severity} ${issue.status !== 'open' ? 'handled' : ''}`}>
          <div className="issue-head">
            <span className="mono">{clock(issue.startMs)}</span>
            <strong>{issue.headline}</strong>
            <Badge tone={issue.severity === 'high' ? 'danger' : issue.severity === 'moderate' ? 'warn' : 'info'}>{issue.severity}</Badge>
            <span className="faint">confidence {(issue.confidence * 100).toFixed(0)}%</span>
            {issue.status !== 'open' && <Badge tone="ok">{issue.status.replace(/_/g, ' ')}</Badge>}
          </div>
          <div>{issue.detail}</div>
          <div className="faint">Why it matters — {issue.whyItMatters}</div>
          <div className="faint">{issue.suggestedAction}</div>
          <details>
            <summary className="faint">What this rests on</summary>
            <pre className="mono evidence">{JSON.stringify(issue.evidence, null, 2)}</pre>
          </details>
          <div className="button-row">
            <button className="small" onClick={() => onHear(issue)}>
              Hear section
            </button>
            <button className="small" onClick={() => onAct(issue, 'add_note')}>
              Add note
            </button>
            <button className="small" onClick={() => onAct(issue, 'ignore')}>
              Ignore
            </button>
            <button className="small" onClick={() => onAct(issue, 'mark_fixed')}>
              Mark fixed
            </button>
            <button className="small" onClick={() => onAct(issue, 'send_to_engineer')}>
              Send to engineer
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

export function StageBadge({ stage }: { stage: string }) {
  const tone = stage === 'release' || stage === 'track' ? 'ok' : stage === 'create' ? 'info' : 'accent'
  return <Badge tone={tone}>{stage}</Badge>
}
