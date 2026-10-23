import React from 'react'
import { useAsync } from '../ui.jsx'
import { request } from './api.js'

interface Receipt { id: string; state: 'pending' | 'failed' | 'completed'; versionId: string; brief: string; error: string; rackUrl: string; result?: { fileId: string; versionId: string; sha256: string; bytes: number } }
export function SuiteHandoffs({ linkId, versionId }: { linkId: string; versionId: string }) {
  const config = useAsync(() => request<{ vault: boolean; rack: boolean }>('/api/song-journey/handoffs/config'), [])
  const rows = useAsync(() => request<{ handoffs: Receipt[] }>(`/api/song-journey/links/${linkId}/handoffs`), [linkId])
  const [brief, setBrief] = React.useState('')
  const [approved, setApproved] = React.useState(false)
  const [consent, setConsent] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  React.useEffect(() => { setApproved(false); setConsent(false); setMessage('') }, [versionId, brief])
  const action = async (path: string, body = {}) => {
    setBusy(true); setMessage('')
    try { const result = await request<{ fileId?: string; sha256?: string }>(path, { method: 'POST', body: JSON.stringify({ versionId, ...body }) }); await rows.reload(); setMessage(result.fileId ? `Saved to Street Banker Vault. Checksum verified: ${result.sha256}` : 'Request acknowledged. Follow its receipt below.') }
    catch (error) { setMessage((error as Error).message); await rows.reload() } finally { setBusy(false) }
  }
  return <section className="sl-handoffs" aria-labelledby="handoff-heading">
    <div className="sl-handoff-head"><div><p className="sl-kicker">APPROVED WORK · VERIFIED RETURN</p><h3 id="handoff-heading">The Rack and your Vault</h3></div><span className="sl-cost">MANUAL RACK · $0</span></div>
    {!config.data?.rack ? <p>Send to The Rack: coming next</p> : <form onSubmit={event => { event.preventDefault(); void action(`/api/song-journey/links/${linkId}/rack`, { brief, approved, costConsent: consent, maxCostCents: 0 }) }}>
      <p>The exact selected Song Lab version opens in the existing Street Banker Rack. Shape and bounce it there; its actual Vault file returns with a verified receipt.</p>
      <label>Approved brief<textarea value={brief} maxLength={4000} required onChange={event => setBrief(event.target.value)} placeholder="What should this version become? Name what to preserve and what to change." /></label>
      <label className="sl-consent"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /> I approve this brief for the selected version.</label>
      <label className="sl-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /> I authorize the $0 manual Rack hand-off. No paid processing is authorized.</label>
      <button className="primary" disabled={busy || !approved || !consent || !brief.trim()}>Send selected version to The Rack</button>
    </form>}
    {config.data?.vault ? <button disabled={busy} onClick={() => void action(`/api/song-journey/links/${linkId}/vault`)}>Save selected version to Street Banker Vault</button> : <p>Vault hand-off is off. No suite file has been sent through this control.</p>}
    <p role="status" className="sl-handoff-message">{message}</p>
    <div className="sl-receipt-grid">{(['pending', 'failed', 'completed'] as const).map(state => <section key={state} className={`sl-receipts sl-receipts-${state}`}><h4>{state === 'pending' ? 'Pending return' : state === 'failed' ? 'Needs attention' : 'Completed · verified'}</h4>{(rows.data?.handoffs ?? []).filter(row => row.state === state).map(row => <article key={row.id}><p>{row.brief}</p><small>{row.versionId === versionId ? 'Selected version' : 'Earlier version · retained receipt'}</small>{row.error && <p>{row.error}</p>}{row.result && <p>Vault file saved · {row.result.bytes.toLocaleString()} bytes<br /><span className="sl-checksum">{row.result.sha256}</span><audio controls preload="none" src={`/api/song-journey/handoffs/${row.id}/result`} aria-label="Verified Rack result" /><a href={`/api/song-journey/handoffs/${row.id}/result`} download>Download verified result</a></p>}<a href={row.rackUrl} target="_blank" rel="noreferrer">Open existing Rack</a><button disabled={busy} onClick={() => void action(`/api/song-journey/handoffs/${row.id}/refresh`)}>Refresh receipt</button></article>)}</section>)}</div>
  </section>
}
