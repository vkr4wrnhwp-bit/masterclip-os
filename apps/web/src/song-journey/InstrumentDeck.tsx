import { AsyncBlock, Card, useAsync } from '../ui.jsx'
import { songLabApi } from '../song-lab/api.js'
import { studioApi } from '../studio/api.js'

const TONAL_KEYS = ['sub_energy_pct', 'low_energy_pct', 'low_mid_energy_pct', 'mid_energy_pct', 'high_mid_energy_pct', 'high_energy_pct']
const TONAL_LABELS = ['Sub', 'Low', 'Low-mid', 'Mid', 'High-mid', 'High']

export function InstrumentDeck({ songId, songVersionId, studioId, studioVersionId }: { songId: string; songVersionId: string; studioId: string; studioVersionId: string }) {
  const song = useAsync(() => songLabApi.project(songId, songVersionId), [songId, songVersionId])
  const studio = useAsync(() => studioApi.session(studioId, studioVersionId), [studioId, studioVersionId])
  const tonal = useAsync(() => studioApi.referenceComparison(studioId, studioVersionId), [studioId, studioVersionId])

  return <div className="sl-instrument-deck" aria-label="Measured instruments for selected versions">
    <AsyncBlock state={song}>{songData => <AsyncBlock state={studio}>{studioData => {
      const measuredCurve = studioData.curves.find(curve => curve.curveKey === 'waveform_peaks')
      const sameAudio = !!(songData.analysis?.sourceChecksum && studioData.version?.assetChecksum && songData.analysis.sourceChecksum === studioData.version.assetChecksum)
      const loudness = metricValue(studioData.metrics, ['integrated_lufs', 'momentary_lufs', 'short_term_lufs'])
      const peak = metricValue(studioData.metrics, ['true_peak_dbtp', 'true_peak_dbfs', 'peak_dbfs'])
      const correlation = metricValue(studioData.metrics, ['phase_correlation'])
      const energy = songData.analysis?.energyCurve.values ?? []
      const energyState = songData.analysis?.status === 'complete' && energy.length > 0 ? 'measured' : 'missing'
      const selectedLabel = songData.versions.find(version => version.id === songVersionId)?.versionLabel ?? 'selected Song Lab version'
      const studioLabel = studioData.version?.label ?? 'selected Studio version'
      return <>
        <div className="sl-instrument-heading"><span>LIVE READOUT · REAL SOURCE DATA</span><strong>{selectedLabel} <i>×</i> {studioLabel}</strong></div>
        <Card title="Waveform · selected Studio version">
          {measuredCurve && measuredCurve.points.some(point => point !== null) ? <>
            <svg className="sl-waveform" viewBox="0 0 1000 160" preserveAspectRatio="none" role="img" aria-label={`Measured waveform for ${studioLabel}`}>
              {sameAudio && songData.sections.map(section => <rect key={section.id} x={percent(section.startMs, songData.analysis?.durationMs)} y="0" width={Math.max(0, percent(section.endMs - section.startMs, songData.analysis?.durationMs))} height="160" className="sl-section-band" />)}
              <line x1="0" x2="1000" y1="80" y2="80" className="sl-wave-center" />
              {measuredCurve.points.map((point, index) => point === null ? null : <line key={index} x1={index / Math.max(1, measuredCurve.points.length - 1) * 1000} x2={index / Math.max(1, measuredCurve.points.length - 1) * 1000} y1={80 - amplitude(point) * 70} y2={80 + amplitude(point) * 70} className="sl-wave-bar" />)}
            </svg>
            {sameAudio ? <div className="sl-section-legend">{songData.sections.map(section => <span key={section.id}><i />{section.label}</span>)}</div> : <p className="sl-measurement-note">The two selected versions have different source checksums. Section bands are withheld so the map cannot be attached to the wrong audio.</p>}
          </> : <NotMeasured title="Waveform" next="Run analysis on the selected Studio version in Finish. The source file stays unchanged." />}
        </Card>

        <div className="sl-instrument-grid">
          <Card title="Energy through the song">
            {energyState === 'measured' ? <>
              <svg className="sl-line-chart" viewBox="0 0 1000 180" preserveAspectRatio="none" role="img" aria-label="Measured energy curve for the selected Song Lab version">
                <line x1="0" x2="1000" y1="160" y2="160" className="sl-chart-axis" />
                <polyline points={polyline(energy)} className="sl-energy-line" />
                {songData.sections.map(section => <line key={section.id} x1={percent(section.startMs, songData.analysis?.durationMs)} x2={percent(section.startMs, songData.analysis?.durationMs)} y1="8" y2="160" className="sl-chart-section" />)}
              </svg>
              <p className="sl-measurement-note">Analysis {songData.analysis?.engineVersion} · confidence {asPercent(songData.analysis?.structureConfidence)}</p>
            </> : <NotMeasured title="Energy curve" next={analysisNext(songData.analysis?.status, songData.analysis?.failureReason)} />}
          </Card>
          <Card title="Key and tempo">
            <div className="sl-readout-pair"><Readout label="Tempo" value={songData.analysis?.bpm ? `${songData.analysis.bpm.toFixed(1)} BPM` : null} confidence={songData.analysis?.bpmConfidence} /><Readout label="Key" value={songData.analysis?.key ?? null} confidence={songData.analysis?.keyConfidence} /></div>
            {songData.analysis?.status !== 'complete' && <NotMeasured title="Tempo and key" next={analysisNext(songData.analysis?.status, songData.analysis?.failureReason)} compact />}
          </Card>
          <Card title="Loudness, peak and correlation">
            <div className="sl-readout-pair"><Readout label="Integrated loudness" value={loudness?.value != null ? `${loudness.value.toFixed(1)} ${loudness.unit}` : null} confidence={loudness?.confidence} /><Readout label="True peak" value={peak?.value != null ? `${peak.value.toFixed(1)} ${peak.unit}` : null} confidence={peak?.confidence} /><Readout label="Phase correlation" value={correlation?.value != null ? correlation.value.toFixed(2) : null} confidence={correlation?.confidence} /></div>
            {(!loudness || !peak || !correlation) && <NotMeasured title="Missing Studio meters" next="Run analysis on this exact Studio version in Finish. Missing readings remain blank." compact />}
          </Card>
        </div>

        <Card title="Tonal balance against your reference">
          <AsyncBlock state={tonal}>{payload => {
            const rows = TONAL_KEYS.map(key => payload.comparison?.rows.find(row => row.metricKey === key) ?? null)
            const hasReference = rows.some(row => row?.yours !== null && row?.yours !== undefined && row.referenceMedian !== null)
            return hasReference ? <>
              <svg className="sl-line-chart" viewBox="0 0 1000 180" preserveAspectRatio="none" role="img" aria-label="Measured tonal balance compared with authorized reference median">
                <line x1="0" x2="1000" y1="160" y2="160" className="sl-chart-axis" />
                <polyline points={polyline(rows.map(row => row?.yours ?? null))} className="sl-energy-line" />
                <polyline points={polyline(rows.map(row => row?.referenceMedian ?? null))} className="sl-reference-line" />
              </svg>
              <div className="sl-section-legend">{TONAL_LABELS.map((label, index) => <span key={label}>{label}: {formatPct(rows[index]?.yours)} / reference {formatPct(rows[index]?.referenceMedian)}</span>)}</div>
              {payload.comparison?.caveat && <p className="sl-measurement-note">{payload.comparison.caveat}</p>}
            </> : <NotMeasured title="Reference curve" next="Add an authorized reference in Finish, then measure this version against it. No reference values are invented." />
          }}</AsyncBlock>
        </Card>
        {songData.analysis?.status === 'failed' && <p className="sl-analysis-failure" role="status">Song analysis failed: {songData.analysis.failureReason ?? 'The analyzer returned no reason.'} Your source recording is unchanged.</p>}
        {studioData.analysis?.status === 'failed' && <p className="sl-analysis-failure" role="status">Studio analysis failed: {studioData.analysis.failureReason ?? 'The analyzer returned no reason.'} Your source recording is unchanged.</p>}
      </>
    }}</AsyncBlock>}</AsyncBlock>
  </div>
}

function Readout({ label, value, confidence }: { label: string; value: string | null; confidence?: number | null }) {
  return <div className="sl-readout"><span>{label}</span><strong>{measurementValueText(value)}</strong>{confidence !== null && confidence !== undefined && <small>{asPercent(confidence)} confidence</small>}</div>
}

export function measurementValueText(value: string | number | null | undefined) {
  return value === null || value === undefined ? 'Not measured yet' : String(value)
}

function NotMeasured({ title, next, compact = false }: { title: string; next: string; compact?: boolean }) {
  return <div className={`sl-not-measured${compact ? ' compact' : ''}`}><strong>{title} · Not measured yet</strong><p>{next}</p></div>
}

function metricValue(metrics: Array<{ metricKey: string; value: number | null; unit: string; confidence: number }>, keys: string[]) {
  return metrics.find(metric => keys.includes(metric.metricKey) && metric.value !== null) ?? null
}

function percent(ms: number, duration: number | null | undefined) { return duration && duration > 0 ? Math.max(0, Math.min(1000, ms / duration * 1000)) : 0 }
function amplitude(value: number) { return Math.max(0.03, Math.min(1, Math.abs(value))) }
function polyline(values: Array<number | null>) {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (finite.length < 2) return ''
  const low = Math.min(...finite), high = Math.max(...finite), range = high - low || 1
  return values.map((value, index) => value === null ? null : `${index / (values.length - 1) * 1000},${160 - ((value - low) / range) * 142}`).filter(Boolean).join(' ')
}
function asPercent(value: number | null | undefined) { return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%` }
function formatPct(value: number | null | undefined) { return value === null || value === undefined ? '—' : `${value.toFixed(1)}%` }
export function analysisNext(status?: string, failure?: string | null) {
  if (status === 'failed') return `Analysis failed${failure ? `: ${failure}` : ''}. Re-run analysis for the selected version in Understand.`
  if (status === 'queued' || status === 'running') return 'Analysis is still running for this exact version. Wait for it to finish; the screen will show the stored result.'
  return 'Run analysis for the selected version in Understand. No sample or fallback values are displayed.'
}
