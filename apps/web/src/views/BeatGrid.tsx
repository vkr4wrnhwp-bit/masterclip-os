import React from 'react'
import { api } from '../api.js'
import { useAsync } from '../ui.jsx'

/** Shows measured onsets, not hand-authored or random timeline markers. */
export function BeatGrid({
  assetId, start, end, duration, onTrim,
}: {
  assetId: string
  start: number
  end: number
  duration: number
  onTrim: (start: number, end: number) => void
}) {
  const result = useAsync(() => api.beats(assetId), [assetId])
  const beats = result.data?.beats ?? []
  const bpm = result.data?.bpm
  const confidence = result.data?.confidence ?? 0
  const low = confidence < 0.3
  const snap = (value: number): number => {
    if (!beats.length) return value
    const closest = beats.reduce((best, candidate) =>
      Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, beats[0]!)
    return Number(closest.toFixed(2))
  }
  const snapStart = () => {
    const next = snap(start)
    if (end - next >= .5 && end - next <= 60) onTrim(next, end)
  }
  const snapEnd = () => {
    const next = snap(end)
    if (next - start >= .5 && next - start <= 60) onTrim(start, next)
  }
  return <section className="mcq-beats" aria-label="Measured beat intelligence">
    {result.loading && !result.data && <p role="status">Analyzing actual audio transients…</p>}
    {result.error && <p role="status">Beat analysis unavailable. Manual trimming still works.</p>}
    {result.data && <>
      <div className="mcq-beats-summary">
        <strong>{bpm !== null ? bpm + ' estimated BPM' : 'No reliable tempo detected'}</strong>
        <span>Confidence: {Math.round(confidence * 100)}%</span>
      </div>
      <div className="mcq-beats-grid" role="img" aria-label={`${beats.length} estimated beat positions on the audio timeline`}>
        {beats.map((position, index) =>
          <span key={index} style={{ left: `${Math.min(100, Math.max(0, position / Math.max(duration, .5) * 100))}%` }} />)}
        <div className="mcq-beats-range" style={{
          left: `${start / Math.max(duration, .5) * 100}%`,
          width: `${Math.max(0,(end-start) / Math.max(duration, .5) * 100)}%`,
        }} />
      </div>
      <div className="button-row">
        <button type="button" disabled={!beats.length || low} onClick={snapStart}>Snap start to beat</button>
        <button type="button" disabled={!beats.length || low} onClick={snapEnd}>Snap end to beat</button>
      </div>
      <p className="faint">
        {low ? 'Low-confidence estimate: beat snapping is disabled.' : 'Snap positions are estimates. Listen before approving the cut.'}
        {' '}{result.data.limitation}
      </p>
    </>}
  </section>
}
