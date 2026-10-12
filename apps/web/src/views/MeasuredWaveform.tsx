import React from 'react'
import { api } from '../api.js'
import { useAsync } from '../ui.jsx'

/**
 * Pure presentation of actual, server-decoded PCM peaks.
 * Selection and playhead are independent: this never alters or fabricates audio.
 * The native range slider gives iOS/Android touch and keyboard scrubbing.
 */
export function MeasuredWaveform({
  assetId, duration, start, end, position, onSeek,
}: {
  assetId: string
  duration: number
  start: number
  end: number
  position: number
  onSeek: (seconds: number) => void
}) {
  const signal = useAsync(() => api.waveform(assetId), [assetId])
  if (signal.loading && !signal.data) return <p className="faint" role="status">Reading actual audio waveform…</p>
  if (!signal.data) {
    return <p className="faint" role="status">
      {signal.error ? `Waveform unavailable: ${signal.error}` : 'Waveform is unavailable.'} Precise time controls remain usable.
    </p>
  }
  const { peaks, durationSeconds } = signal.data
  const timeline = duration > 0 ? duration : durationSeconds
  const pct = (seconds: number) => `${Math.max(0, Math.min(100, (seconds / timeline) * 100))}%`
  return <div className="mcq-waveform" aria-label="Actual decoded audio waveform">
    <div className="mcq-waveform-track" role="img" aria-label={`Measured audio waveform with ${peaks.length} peak samples`}>
      <div className="mcq-waveform-bars">
        {peaks.map((peak, index) => <span key={index} style={{ height: `${Math.max(2, peak * 100)}%` }} />)}
      </div>
      <div className="mcq-waveform-selection" style={{ left: pct(start), width: `${Math.max(0, Math.min(100, end / timeline * 100) - Math.max(0, start / timeline * 100))}%` }} aria-hidden="true" />
      <div className="mcq-waveform-playhead" style={{ left: pct(position) }} aria-hidden="true" />
    </div>
    <label className="field">
      <span className="field-label">Scrub audio at {position.toFixed(1)} seconds</span>
      <input aria-label="Scrub audio waveform" type="range" min="0" max={Math.max(0.5, timeline)} step="0.1"
        value={Math.max(0, Math.min(timeline, position))} onChange={e => onSeek(Number(e.target.value))} />
    </label>
    <p className="faint">Measured from decoded source audio. The highlighted area is the selected song moment.</p>
  </div>
}
