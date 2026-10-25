import React from 'react'
import { AbPlayer } from '../song-lab/components.js'
import { request } from './api.js'

type Measure = {
  assetId: string
  analysisId: string
  sourceChecksum: string
  integratedLufs: number
  truePeakDbtp: number
  method: string
  audioUrl: string
}
type Result = {
  state: 'ready' | 'unavailable'
  leftVersionId: string
  rightVersionId: string
  measurements: null | { left: Measure; right: Measure; method: string }
  proposal: { available: false; reason: string } |
    { available: true; leftGainDb: number; rightGainDb: number; limited: boolean }
  note: string
}

/** Real, explicit A/B listening of two verified Song Lab source versions.
 * Studio remains the ONLY final approval authority. Nothing is written here.
 */
export function SongVersionAB({
  linkId, versions,
}: {
  linkId: string
  versions: Array<{ id: string; label: string }>
}) {
  const [left, setLeft] = React.useState('')
  const [right, setRight] = React.useState('')
  const [result, setResult] = React.useState<Result | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const serial = React.useRef(0)

  React.useEffect(() => {
    serial.current += 1
    setLeft('')
    setRight('')
    setResult(null)
    setError('')
  }, [linkId])

  const measure = async () => {
    if (!left || !right || left === right) return
    const sequence = ++serial.current
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const data = await request<Result>(
        `/api/song-journey/links/${encodeURIComponent(linkId)}/version-pair-loudness?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`,
      )
      if (sequence === serial.current) {
        if (data.leftVersionId !== left || data.rightVersionId !== right) throw new Error('Version selection changed. Measure again.')
        setResult(data)
      }
    } catch (err) {
      if (sequence === serial.current) setError((err as Error).message || 'The files could not be measured.')
    } finally {
      if (sequence === serial.current) setBusy(false)
    }
  }

  const choose = (side: 'left' | 'right', value: string) => {
    ++serial.current
    setBusy(false)
    setResult(null)
    setError('')
    if (side === 'left') setLeft(value)
    else setRight(value)
  }
  const ready = result?.state === 'ready' && result.proposal.available && result.measurements
  const measurements = ready ? result.measurements : null
  const plan = ready && result.proposal.available ? result.proposal : null
  const leftLabel = versions.find(row => row.id === left)?.label ?? 'Version A'
  const rightLabel = versions.find(row => row.id === right)?.label ?? 'Version B'

  return <section className="sl-verified-ab" aria-label="Measured version A/B comparison">
    <h3>Listen to two song versions</h3>
    <p>Choose two different versions of this song. Compare at the quieter version's loudness without changing either source file. This is listening, not final approval.</p>
    <div className="sl-ab-choices">
      <label>Version A
        <select value={left} onChange={event => choose('left', event.target.value)}>
          <option value="">Choose first version</option>
          {versions.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      </label>
      <label>Version B
        <select value={right} onChange={event => choose('right', event.target.value)}>
          <option value="">Choose second version</option>
          {versions.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
      </label>
    </div>
    <button type="button" onClick={() => void measure()}
      disabled={busy || !left || !right || left === right}>
      {busy ? 'Measuring both audio files…' : 'Measure and compare'}
    </button>
    {left && right && left === right && <p role="status">Choose two different versions.</p>}
    {error && <p role="alert">{error}</p>}
    {result && !ready && <p role="status">Level-matched listening unavailable: {result.note}</p>}
    {measurements && plan && <div role="status">
      <p><strong>Measured A: {measurements.left.integratedLufs.toFixed(1)} LUFS</strong> · True peak: {measurements.left.truePeakDbtp.toFixed(1)} dBTP · Listening change: {plan.leftGainDb.toFixed(1)} dB</p>
      <p><strong>Measured B: {measurements.right.integratedLufs.toFixed(1)} LUFS</strong> · True peak: {measurements.right.truePeakDbtp.toFixed(1)} dBTP · Listening change: {plan.rightGainDb.toFixed(1)} dB</p>
      <p>{plan.limited
        ? 'The difference is greater than 6 dB. This is a safer partial match; these files are still at different levels.'
        : 'Both playback levels are matched using a measured, attenuation-only adjustment.'}</p>
      <AbPlayer tracks={[
        { id: 'a', label: `A: ${leftLabel}`, url: measurements.left.audioUrl, gainDb: plan.leftGainDb },
        { id: 'b', label: `B: ${rightLabel}`, url: measurements.right.audioUrl, gainDb: plan.rightGainDb },
      ]} />
      <p>Press Play, then A or B to switch at the same position. No audio changes are saved. Your device's sound output is not a certified loudness meter.</p>
      <details><summary>Measurement evidence</summary>
        <p>Method: {measurements.method} (K-weighted, gated BS.1770 loudness and oversampled true peak).</p>
        <p>A checksum: <code>{measurements.left.sourceChecksum}</code></p>
        <p>B checksum: <code>{measurements.right.sourceChecksum}</code></p>
      </details>
    </div>}
  </section>
}
