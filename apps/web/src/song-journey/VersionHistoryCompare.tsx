import React from 'react'
import { request } from './api.js'

type Version = { id: string; label: string; createdAt: string }
type Pair = {
  left: { id: string; versionLabel: string; versionType: string; createdAt: string; parentVersionId: string | null }
  right: { id: string; versionLabel: string; versionType: string; createdAt: string; parentVersionId: string | null }
  sameAsset: boolean
  playback: { available: false; reason: string }
  approval: { available: false; reason: string }
}

/** Read-only version history. A/B playback and approval remain unavailable until verified. */
export function VersionHistoryCompare({ linkId, versions }: { linkId: string; versions: Version[] }) {
  const [left, setLeft] = React.useState('')
  const [right, setRight] = React.useState('')
  const [pair, setPair] = React.useState<Pair | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  React.useEffect(() => { setLeft(''); setRight(''); setPair(null); setError('') }, [linkId])
  const compare = async () => {
    if (!left || !right || left === right) return
    setBusy(true); setError(''); setPair(null)
    try {
      const query = new URLSearchParams({ left, right })
      const result = await request<Pair>(`/api/song-journey/links/${encodeURIComponent(linkId)}/version-pair?${query.toString()}`)
      setPair(result)
    } catch {
      setError('These versions could not be compared. The original files and approvals are unchanged.')
    } finally { setBusy(false) }
  }
  return <section className="sl-version-compare" aria-label="Song version history and comparison">
    <h3>Version history / A–B</h3>
    <p>Inspect two saved Song Lab versions. This view does not play, normalize, approve, or alter audio.</p>
    <ol className="sl-version-history">{versions.map(version =>
      <li key={version.id}><strong>{version.label}</strong><span>{new Date(version.createdAt).toLocaleString()}</span></li>
    )}</ol>
    {versions.length < 2 ? <p role="status">Two saved versions are required to compare.</p> :
      <div className="sl-version-compare-controls">
        <label>Version A<select value={left} onChange={event => { setLeft(event.target.value); setPair(null) }}>
          <option value="">Choose a version</option>{versions.map(v => <option value={v.id} key={v.id}>{v.label}</option>)}
        </select></label>
        <label>Version B<select value={right} onChange={event => { setRight(event.target.value); setPair(null) }}>
          <option value="">Choose a different version</option>{versions.filter(v => v.id !== left).map(v => <option value={v.id} key={v.id}>{v.label}</option>)}
        </select></label>
        <button type="button" disabled={busy || !left || !right || left === right} onClick={() => void compare()}>
          {busy ? 'Reading history…' : 'Inspect selected versions'}
        </button>
      </div>}
    {error && <p role="alert">{error}</p>}
    {pair && <div className="sl-version-compare-result" role="status">
      <p><strong>A:</strong> {pair.left.versionLabel} · {pair.left.versionType}</p>
      <p><strong>B:</strong> {pair.right.versionLabel} · {pair.right.versionType}</p>
      {pair.sameAsset && <p>Both records point to the same source asset; this is not an independent audio revision.</p>}
      <p><strong>Listening unavailable:</strong> {pair.playback.reason}</p>
      <p><strong>Approval unavailable:</strong> {pair.approval.reason}</p>
    </div>}
  </section>
}
