import React from 'react'
import { request } from './api.js'
type Candidate = { linkId: string; title: string; studioVersionId: string }
type Reading = { metricKey:string; label:string; yours:number|null; referenceMedian:number|null; unit:string; observation:string }
type Comparison = { state:string; message?:string; title?:string; warning?:string; caveat?:string; rows?: Reading[];
  provenance?: {current: Record<string,string|number|null>; reference: Record<string,string|number|null>} }
export function OwnedReferenceCompare({ linkId }: {linkId:string}) {
  const [candidates,setCandidates]=React.useState<Candidate[]>([])
  const [selected,setSelected]=React.useState('')
  const [comparison,setComparison]=React.useState<Comparison|null>(null)
  const [error,setError]=React.useState('')
  const [loading,setLoading]=React.useState(false)
  React.useEffect(()=>{
    let active=true
    setCandidates([]);setSelected('');setComparison(null)
    request<{candidates:Candidate[]}>(`/api/song-journey/links/${encodeURIComponent(linkId)}/reference-candidates`)
      .then(r=>{if(active)setCandidates(r.candidates)})
      .catch(()=>{if(active)setError('Could not load songs from your account.')})
    return ()=>{active=false}
  },[linkId])
  const compare=async()=>{
    if(!selected)return
    setLoading(true);setError('')
    try{
      const result=await request<Comparison>(`/api/song-journey/links/${encodeURIComponent(linkId)}/reference-compare?with=${encodeURIComponent(selected)}`)
      setComparison(result)
    }catch{setError('The comparison could not be loaded. Your songs were not changed.')}
    finally{setLoading(false)}
  }
  return <section className="sl-owned-compare">
    <h3>Compare with your earlier song</h3>
    <p>Choose another song saved in your own Song Lab. Differences are measurements, not grades or targets.</p>
    <label>Reference song <select value={selected} onChange={e=>setSelected(e.target.value)}>
      <option value="">Choose a saved song</option>
      {candidates.map(c=><option value={c.linkId} key={c.linkId}>{c.title}</option>)}
    </select></label>
    <button type="button" disabled={!selected||loading} onClick={()=>void compare()}>{loading?'Loading…':'Compare measurements'}</button>
    {error&&<p role="alert">{error}</p>}
    {comparison?.message&&<p>{comparison.message}</p>}
    {comparison?.warning&&<p role="status">{comparison.warning}</p>}
    {comparison?.caveat&&<p>{comparison.caveat}</p>}
    {comparison?.provenance&&<div className="sl-owned-compare-provenance">{(['current','reference'] as const).map(key=>
      <p key={key}>{key==='current'?'Your song':'Earlier song'}: version {comparison.provenance?.[key]?.versionId}; source {comparison.provenance?.[key]?.sourceAssetId}; analysis {comparison.provenance?.[key]?.analysisId}; analyzer {comparison.provenance?.[key]?.analyzerVersion}; sample rate {comparison.provenance?.[key]?.sampleRate}; measured {comparison.provenance?.[key]?.measuredAt}</p>
    )}</div>}
    <div className="sl-owned-compare-grid">{comparison?.rows?.map(row=><article key={row.metricKey}>
      <h4>{row.label}</h4><p>{row.yours==null||row.referenceMedian==null?'Not enough information':row.observation}</p>
    </article>)}</div>
  </section>
}
