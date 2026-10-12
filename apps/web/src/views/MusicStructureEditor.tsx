import React from 'react'
import { api } from '../api.js'
import { Callout, Field, useAsync } from '../ui.jsx'

type Section={id:string;label:string;kind:string;start_seconds:number;end_seconds:number}
const choices=['intro','verse','pre_chorus','chorus','bridge','outro','instrumental','custom']
let sequence=0

/** Artist-authoritative song annotations, not inferred structure. */
export function MusicStructureEditor({projectId,assetId,duration,onUseStart}:{
  projectId:string;assetId:string;duration:number;onUseStart:(seconds:number)=>void
}){
  const saved=useAsync(()=>api.musicStructure(projectId,assetId),[projectId,assetId])
  const [sections,setSections]=React.useState<Section[]>([])
  const [version,setVersion]=React.useState<number|null>(null)
  const [busy,setBusy]=React.useState(false)
  const [error,setError]=React.useState<string|null>(null)
  const [status,setStatus]=React.useState<string|null>(null)
  React.useEffect(()=>{
    if(!saved.data)return
    setSections(saved.data.sections.map(s=>({...s})))
    setVersion(saved.data.version)
  },[saved.data])
  const update=(i:number,patch:Partial<Section>)=>
    setSections(old=>old.map((s,index)=>index===i?{...s,...patch}:s))
  const add=()=>{
    const from=sections.length?sections[sections.length-1]!.end_seconds:0
    const to=Math.min(duration,from+8)
    if(to<=from)return
    setSections(old=>[...old,{id:'section-'+(++sequence)+'-'+Date.now(),label:'New section',
      kind:'custom',start_seconds:from,end_seconds:to}])
  }
  const save=async()=>{
    if(version===null)return
    setBusy(true);setError(null);setStatus(null)
    try{
      const result=await api.saveMusicStructure(projectId,assetId,version,sections)
      setVersion(result.version)
      setStatus('Song annotations saved. Video edits are unchanged.')
    }catch(cause){setError((cause as Error).message)}
    finally{setBusy(false)}
  }
  return <section className="mc-timeline-structure" aria-label="Artist song section notes">
    <h4>Song structure — artist notes</h4>
    <p className="muted">Mark real verses, choruses and other passages yourself. MOTION does not automatically recognize song sections. These notes help choose starting points and plan shots.</p>
    {saved.loading&&<p role="status">Loading song annotations…</p>}
    {saved.error&&<p role="status">Song annotations unavailable.</p>}
    {sections.map((section,i)=><div className="mc-timeline-structure-row" key={section.id}>
      <div className="field-row">
        <Field label="Section type"><select value={section.kind} onChange={e=>update(i,{kind:e.target.value})}>
          {choices.map(k=><option key={k} value={k}>{k.replace(/_/g,' ')}</option>)}</select></Field>
        <Field label="Name"><input maxLength={60} value={section.label}
          onChange={e=>update(i,{label:e.target.value})}/></Field>
        <Field label="Start (s)"><input type="number" min="0" step=".1" value={section.start_seconds}
          onChange={e=>update(i,{start_seconds:Number(e.target.value)})}/></Field>
        <Field label="End (s)"><input type="number" min=".1" step=".1" value={section.end_seconds}
          onChange={e=>update(i,{end_seconds:Number(e.target.value)})}/></Field>
      </div>
      <div className="button-row">
        <button type="button" onClick={()=>onUseStart(section.start_seconds)}>Start cut here</button>
        <button type="button" onClick={()=>setSections(old=>old.filter((_,index)=>index!==i))}>Remove annotation</button>
      </div>
    </div>)}
    <div className="button-row">
      <button type="button" disabled={sections.length>=32||!duration} onClick={add}>Add section</button>
      <button type="button" className="primary" disabled={busy||version===null} onClick={()=>void save()}>
        {busy?'Saving…':'Save song structure'}
      </button>
      <button type="button" onClick={()=>{saved.reload();setError(null);setStatus(null)}}>Reload notes</button>
    </div>
    {error&&<Callout tone="danger">{error}</Callout>}
    {status&&<Callout tone="ok">{status}</Callout>}
  </section>
}
