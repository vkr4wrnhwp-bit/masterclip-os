import React from 'react'
import { request } from './api.js'

type ApprovalEvidence = {
  state: 'not_selected' | 'not_approved' | 'approved'
  studioVersionId: string | null
  studioChecksum?: string | null
  audioAssetVerified?: boolean
  songLabEvidenceVersionId: string | null
  approval: null | {
    id: string; type: 'mix' | 'master'; approvedBy: string
    approvedAt: string; versionChecksum: string
  }
}

/** Read-only status from Studio's existing checksum-bound approval ledger. */
export function StudioFinalApproval({ linkId, studioVersionId }: { linkId: string; studioVersionId: string }) {
  const [record, setRecord] = React.useState<ApprovalEvidence | null>(null)
  const [error, setError] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  React.useEffect(() => {
    let active = true
    setRecord(null); setError('')
    request<ApprovalEvidence>(`/api/song-journey/links/${encodeURIComponent(linkId)}/final-approval`)
      .then(data => { if (active) setRecord(data) })
      .catch(() => { if (active) setError('Final approval could not be verified. No approval is implied.') })
    return () => { active = false }
  }, [linkId, studioVersionId, refresh])
  return <section className="sl-final-approval" aria-label="Authoritative Studio final approval">
    <h3>Final audio approval — Studio</h3>
    <p>Studio's exact mix or master is the final authority. Song Lab history remains supporting evidence, not a second sign-off.</p>
    <button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh approval evidence</button>
    {error && <p role="alert">{error}</p>}
    {!error && !record && <p role="status">Checking the Studio approval record…</p>}
    {record && <div role="status">
      {record.state === 'approved' && record.approval
        ? <><strong>Approved Studio {record.approval.type}</strong>
          <p>Version: <code>{record.studioVersionId}</code></p>
          <p>Receipt: <code>{record.approval.id}</code> · {record.approval.approvedAt}</p>
          <p>Approved by: <code>{record.approval.approvedBy}</code></p>
          <p>Approved audio checksum: <code>{record.approval.versionChecksum}</code></p>
          <p>Song Lab supporting version: <code>{record.songLabEvidenceVersionId ?? 'Not selected'}</code></p></>
        : <><strong>Not approved</strong><p>{record.audioAssetVerified === false ? 'The selected Studio audio asset is missing or its checksum cannot be verified. Approval is unavailable.' : 'No current checksum-matched Studio mix/master approval exists for the selected version.'}</p></>}
    </div>}
  </section>
}
