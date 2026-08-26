import React from 'react'
import { Badge, Callout } from '../ui.jsx'
import {
  clock,
  type BenchmarkResult,
  type Measured,
  type RegisterMetrics,
  type SectionRegisterBand,
  type SongObservation,
  type SongSection,
} from './api.js'

/**
 * Song Lab's shared display pieces.
 *
 * Two rules are enforced here rather than left to each view:
 *   - a measurement with no value renders as "not enough information", never 0;
 *   - a percentile drawn from a small cohort always renders its warning.
 */

/** Neutral chip. Nothing in this palette says "good" or "bad". */
export function ClassificationChip({ label }: { label: string }) {
  const lower = label.toLowerCase()
  const tone = lower.includes('outlier') ? 'accent' : lower.includes('not enough') ? undefined : lower.includes('similar to cohort') ? 'info' : 'warn'
  return <Badge tone={tone}>{label}</Badge>
}

export function ConfidencePill({ measured, confidence }: { measured?: Measured | null; confidence?: number }) {
  const value = measured ? (measured.value === null ? 0 : measured.confidence) : (confidence ?? 0)
  const band = measured?.value === null ? 'insufficient' : value >= 0.75 ? 'high' : value >= 0.5 ? 'moderate' : value >= 0.25 ? 'low' : 'insufficient'
  const text = { high: 'HIGH CONFIDENCE', moderate: 'MODERATE CONFIDENCE', low: 'LOW CONFIDENCE', insufficient: 'NOT ENOUGH INFORMATION' }[band]
  return <span className={`sl-confidence sl-confidence-${band}`}>{text}</span>
}

export function LowSampleWarning({ sampleSize, threshold = 30 }: { sampleSize: number; threshold?: number }) {
  if (sampleSize >= threshold) return null
  return (
    <Callout tone="warn" title="LOW SAMPLE SIZE">
      This cohort holds {sampleSize} songs. Percentiles computed over a group this small describe the group, not the format — read them as a
      hint, not a finding.
    </Callout>
  )
}

/** The section timeline: `0:56  CHORUS`. */
export function StructureTimeline({ sections, onSelect, selectedId }: { sections: SongSection[]; onSelect?: (section: SongSection) => void; selectedId?: string | null }) {
  if (sections.length === 0) return <div className="empty">no sections detected yet</div>
  return (
    <div className="sl-timeline">
      {sections.map((section) => (
        <button
          type="button"
          key={section.id}
          className={`sl-timeline-row${selectedId === section.id ? ' selected' : ''}`}
          onClick={() => onSelect?.(section)}
          disabled={!onSelect}
        >
          <span className="sl-timeline-time">{clock(section.startMs)}</span>
          <span className="sl-timeline-label">{section.label.toUpperCase()}</span>
          <span className="sl-timeline-meta">
            {Math.round((section.endMs - section.startMs) / 1000)}s
            {section.humanConfirmed && <span className="sl-confirmed" title="Confirmed by a person — authoritative"> ✓ confirmed</span>}
            {section.isHook && <span className="sl-hook"> hook</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

/** A horizontal energy bar per section. Normalized within this song only. */
export function EnergyBars({
  sections,
}: {
  sections: Array<{ label: string; energy: number; vocalOccupancy: number | null; arrangementDensity: number }>
}) {
  if (sections.length === 0) return <div className="empty">no energy curve yet</div>
  return (
    <div className="sl-energy">
      {sections.map((section) => (
        <div className="sl-energy-row" key={section.label}>
          <span className="sl-energy-label">{section.label.toUpperCase()}</span>
          <span className="sl-energy-track">
            <span className="sl-energy-fill" style={{ width: `${section.energy}%` }} />
          </span>
          <span className="sl-energy-value">{section.energy}</span>
        </div>
      ))}
    </div>
  )
}

/** Sparkline over the per-frame energy curve. */
export function EnergyCurve({ values, stepSeconds }: { values: number[]; stepSeconds: number }) {
  if (values.length === 0) return null
  const width = 720
  const height = 90
  // Downsample so a five-minute song does not emit 6,000 SVG points.
  const step = Math.max(1, Math.floor(values.length / 320))
  const points: string[] = []
  for (let i = 0; i < values.length; i += step) {
    const x = (i / Math.max(1, values.length - 1)) * width
    const y = height - Math.max(0, Math.min(1, values[i] ?? 0)) * height
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  const totalSeconds = values.length * stepSeconds
  return (
    <div className="sl-curve">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Energy curve across the song">
        <polyline points={points.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      </svg>
      <div className="sl-curve-axis">
        <span>0:00</span>
        <span>{clock((totalSeconds / 2) * 1000)}</span>
        <span>{clock(totalSeconds * 1000)}</span>
      </div>
    </div>
  )
}

/**
 * One benchmark row: the song's value, the cohort's shape, and the percentile.
 *
 * The p25–p75 band is drawn so the reader can see where the middle half of the
 * cohort sits rather than inferring it from two numbers.
 */
export function BenchmarkRow({ result }: { result: BenchmarkResult }) {
  const known = result.songValue !== null && result.percentile !== null
  return (
    <div className="sl-benchmark-row">
      <div className="sl-benchmark-head">
        <strong>{result.metricKey.replace(/_/g, ' ')}</strong>
        <ClassificationChip label={result.classificationLabel} />
      </div>
      <p className="sl-benchmark-summary">{result.summary}</p>
      {known && (
        <div className="sl-distribution" title={`10th ${fmt(result.p10)} · 25th ${fmt(result.p25)} · median ${fmt(result.cohortMedian)} · 75th ${fmt(result.p75)} · 90th ${fmt(result.p90)}`}>
          <span className="sl-distribution-band" style={bandStyle(result)} />
          <span className="sl-distribution-median" style={{ left: `${position(result, result.cohortMedian)}%` }} />
          <span className="sl-distribution-song" style={{ left: `${position(result, result.songValue)}%` }} />
        </div>
      )}
      <div className="sl-benchmark-meta">
        <span>n = {result.sampleSize}</span>
        {result.percentile !== null && <span>{Math.round(result.percentile)}th percentile</span>}
        <ConfidencePill confidence={result.confidence} />
      </div>
    </div>
  )
}

function fmt(value: number | null): string {
  return value === null ? '—' : String(Math.round(value * 100) / 100)
}

/** Positions a value on the p10–p90 axis, clamped to the visible range. */
function position(result: BenchmarkResult, value: number | null): number {
  if (value === null || result.p10 === null || result.p90 === null) return 50
  const span = result.p90 - result.p10
  if (span <= 0) return 50
  return Math.max(0, Math.min(100, ((value - result.p10) / span) * 100))
}

function bandStyle(result: BenchmarkResult): React.CSSProperties {
  const from = position(result, result.p25)
  const to = position(result, result.p75)
  return { left: `${Math.min(from, to)}%`, width: `${Math.abs(to - from)}%` }
}

/** An observation card, in the product's own voice. */
export function ObservationCard({
  observation,
  index,
  onTest,
  busy,
}: {
  observation: SongObservation
  index?: number
  onTest?: (recommendationId: string) => void
  busy?: boolean
}) {
  const renderable = (observation.recommendations ?? []).find((recommendation) => recommendation.experimentSupported)
  return (
    <div className="sl-observation">
      <div className="sl-observation-head">
        {index !== undefined && <span className="sl-observation-index">{String(index + 1).padStart(2, '0')}</span>}
        <strong>{observation.title}</strong>
        <Badge tone={observation.severity === 'worth_testing' ? 'accent' : observation.severity === 'informational' ? 'info' : 'warn'}>
          {observation.severity.replace(/_/g, ' ')}
        </Badge>
      </div>
      <p>{observation.description}</p>
      {(observation.recommendations ?? []).map((recommendation) => (
        <div className="sl-recommendation" key={recommendation.id}>
          <div>
            <strong>{recommendation.title}</strong>
            <p className="faint">{recommendation.description}</p>
          </div>
        </div>
      ))}
      <div className="sl-observation-actions">
        {renderable && onTest ? (
          <button className="primary small" onClick={() => onTest(renderable.id)} disabled={busy}>
            HEAR TEST
          </button>
        ) : (
          // Not every finding can be rendered as audio, and saying so is more
          // useful than a button that would produce nothing.
          <span className="faint">SEE IDEAS — this one is a writing or arrangement note, not an edit</span>
        )}
        <ConfidencePill confidence={observation.confidence} />
      </div>
    </div>
  )
}

/**
 * A/B player.
 *
 * Both sources stay loaded and switching swaps which one is audible while
 * preserving position, so the comparison is between two arrangements rather
 * than between two moments.
 */
export function AbPlayer({ tracks }: { tracks: Array<{ id: string; label: string; url: string | null; note?: string | null }> }) {
  const [active, setActive] = React.useState(tracks[0]?.id ?? '')
  const refs = React.useRef<Record<string, HTMLAudioElement | null>>({})

  const switchTo = (id: string) => {
    const current = refs.current[active]
    const next = refs.current[id]
    const position = current?.currentTime ?? 0
    const playing = current ? !current.paused : false
    if (current) current.pause()
    setActive(id)
    if (next) {
      // Clamp: an edited version can be shorter than where the original was.
      next.currentTime = Number.isFinite(next.duration) ? Math.min(position, Math.max(0, next.duration - 0.05)) : position
      if (playing) void next.play()
    }
  }

  const current = tracks.find((track) => track.id === active) ?? tracks[0]

  return (
    <div className="sl-ab">
      <div className="sl-ab-buttons">
        {tracks.map((track) => (
          <button key={track.id} className={track.id === active ? 'primary small' : 'small'} onClick={() => switchTo(track.id)} disabled={!track.url}>
            {track.label.toUpperCase()}
          </button>
        ))}
      </div>
      {tracks.map((track) => (
        <audio
          key={track.id}
          ref={(element) => {
            refs.current[track.id] = element
          }}
          src={track.url ?? undefined}
          controls={track.id === active}
          hidden={track.id !== active}
          preload="metadata"
          style={{ width: '100%', marginTop: 8 }}
        />
      ))}
      {current && !current.url && <Callout tone="warn">No audio is available for this version.</Callout>}
      {current?.note && <p className="faint" style={{ marginTop: 6 }}>{current.note}</p>}
    </div>
  )
}

/**
 * The register panel.
 *
 * Draws each section's vocal register as a band rather than a single value,
 * because the low-to-high span is the part a producer reads: two sections whose
 * medians differ but whose bands overlap completely are, to a listener, the same
 * part of the voice.
 *
 * Deliberately unlabelled in note names. The measurement is a normalized band
 * derived from the voiced signal, not a transcribed melody, and printing "G5"
 * would claim a precision that is not there.
 */
/**
 * `metrics` is the engine's own `RegisterMetrics`, so every figure here is on
 * the engine's scale: registers and lifts are raw normalized values, and
 * `melodicContourRepetition` is a 0–1 ratio. The feature vector stores that last
 * one pre-scaled to a percentage, so a caller reading it from there converts
 * back rather than handing this component two different scales.
 */
export function RegisterPanel({ bands, metrics }: { bands: SectionRegisterBand[]; metrics: RegisterMetrics }) {
  const measured = bands.filter((band) => band.median !== null)
  if (measured.length === 0) {
    return (
      <div className="empty">
        No lead vocal was detected reliably enough to measure a register. Nothing is estimated in its place.
      </div>
    )
  }

  // Scale to the song's own measured span so the bands fill the panel, with a
  // little headroom so the extremes are not flush against the edges.
  const lows = measured.map((band) => band.low ?? band.median!)
  const highs = measured.map((band) => band.high ?? band.median!)
  const floor = Math.min(...lows)
  const ceiling = Math.max(...highs)
  const span = Math.max(1e-6, ceiling - floor)
  const pct = (value: number) => ((value - floor) / span) * 100

  return (
    <div className="sl-register">
      {bands.map((band) => (
        <div className="sl-register-row" key={`${band.orderIndex}-${band.label}`}>
          <span className="sl-register-label">{band.label.toUpperCase()}</span>
          {band.median === null ? (
            <span className="sl-register-track">
              <span className="sl-register-none">not enough information</span>
            </span>
          ) : (
            <span className="sl-register-track">
              <span
                className={band.isHook ? 'sl-register-band sl-register-hook' : 'sl-register-band'}
                style={{
                  left: `${pct(band.low ?? band.median)}%`,
                  width: `${Math.max(2, pct(band.high ?? band.median) - pct(band.low ?? band.median))}%`,
                }}
              />
              <span className="sl-register-median" style={{ left: `${pct(band.median)}%` }} />
            </span>
          )}
          <span className="sl-register-value">{band.median === null ? '—' : band.median.toFixed(2)}</span>
        </div>
      ))}

      <dl className="sl-register-summary">
        <RegisterFigure label="Verse register" value={metrics.verseRegister} />
        <RegisterFigure label="Chorus register" value={metrics.chorusRegister} />
        <RegisterFigure label="Chorus lift" value={metrics.chorusRegisterLift} signed />
        <RegisterFigure label="Contour repetition" value={metrics.melodicContourRepetition} ratio />
      </dl>
      <p className="faint">
        A normalized register band derived from the voiced signal, not a transcribed melody. Read it as "the same area of the voice",
        not as note names. {metrics.confidence < 0.25 ? "Confidence here is low — treat the bands as indicative." : null}
      </p>
    </div>
  )
}

/** `ratio` renders a 0–1 value as a percentage; everything else is a raw index. */
function RegisterFigure({ label, value, signed, ratio }: { label: string; value: number | null; signed?: boolean; ratio?: boolean }) {
  const display =
    value === null
      ? 'not enough information'
      : ratio
        ? `${Math.round(value * 100)}%`
        : signed && value > 0
          ? `+${value.toFixed(3)}`
          : value.toFixed(3)
  return (
    <div className="sl-register-figure">
      <dt>{label}</dt>
      <dd className={value === null ? 'faint' : undefined}>{display}</dd>
    </div>
  )
}

/** Section tabs shared by every project screen. */
export const PROJECT_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'structure', label: 'Structure' },
  { key: 'hook', label: 'Hook' },
  { key: 'lyrics', label: 'Lyrics' },
  { key: 'energy', label: 'Energy' },
  { key: 'tempo', label: 'Tempo' },
  { key: 'arrangement', label: 'Arrangement' },
  { key: 'benchmark', label: 'Benchmark' },
  { key: 'experiments', label: 'Experiments' },
  { key: 'producer', label: 'Producer' },
  { key: 'versions', label: 'Versions' },
] as const

export function Tabs({ projectId, active, extra }: { projectId: string; active: string; extra?: Array<{ key: string; label: string }> }) {
  const tabs = [...PROJECT_TABS, ...(extra ?? [])]
  return (
    <div className="sl-tabs">
      {tabs.map((tab) => (
        <a key={tab.key} href={`#/song-lab/projects/${projectId}/${tab.key}`} className={active === tab.key ? 'active' : ''}>
          {tab.label.toUpperCase()}
        </a>
      ))}
    </div>
  )
}
