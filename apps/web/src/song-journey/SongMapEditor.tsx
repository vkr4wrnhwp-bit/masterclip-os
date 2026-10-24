import React from 'react'
import { request } from './api.js'
type Section = { id:string; label:string; startMs:number; endMs:number; confidence:number|null }
type Edit = {kind:'rename';id:string;label:string}|{kind:'boundary';id:string;endMs:number}|
 {kind:'merge';leftId:string;rightId:string;label:string}|{kind:'split';id:string;atMs:number;newId:string;label:string}
type MapData = {state:string;message:string;sections:Section[];edits:Edit[];
 tempo:{value:number|null;confidence:number|null;analysisVersion:string|null;note:string};
 key:{value:string|null;confidence:number|null;analysisVersion:string|null;note:string};
 nextActions:Array<{text:string;source:string}>}
export function SongMapEditor({linkId}:{linkId:string}) {
  const [data,setData]=React.useState<MapData|null>(null)
  const [edits,setEdits]=React.useState<Edit[]>([])
  const [notice,setNotice]=React.useState('')
  const [busy,setBusy]=React.useState(false)
  const url=`/api/song-journey/links/${encodeURIComponent(linkId)}/song-map`
  const load=React.useCallback(async()=>{
    try{
      const found=await request<MapData>(url)
      setData(found);setEdits(found.edits||[]);setNotice('')
    }catch {setData(null);setNotice('Not enough information: the chosen song needs a completed analysis.')}
  },[url])
  React.useEffect(()=>{void load()},[load])
  const add=(edit:Edit)=>setEdits(current=>current.length<200?[...current,edit]:current)
  const save=async()=>{
    setBusy(true);setNotice('')
    try{await request(url,{method:'POST',body:JSON.stringify({edits})});await load();setNotice('Your map corrections were saved separately from the original analysis.')}
    catch{setNotice('Could not save map edits. The original analysis has not changed.')}
    finally{setBusy(false)}
  }
  const ask=(message:string,defaultValue:string)=>window.prompt(message,defaultValue)?.trim()
  return <section className="sl-song-map" aria-label="Editable song map">
    <h3>One song map</h3>
    <p>These are your changes beside the original analysis. Your audio and measured analysis are never overwritten.</p>
    {notice&&<p role="status">{notice}</p>}
    {data&&<>
      <div className="sl-song-map-facts"><p>Tempo: {data.tempo.value==null?'Not enough information':`${data.tempo.value} BPM`} · {data.tempo.note||`confidence ${data.tempo.confidence}`} · analyzer {data.tempo.analysisVersion}</p>
      <p>Key: {data.key.value??'Not enough information'} · {data.key.note||`confidence ${data.key.confidence}`} · analyzer {data.key.analysisVersion}</p></div>
      <div className="sl-song-map-sections">{data.sections.map((section,index)=><article key={section.id}>
        <h4>{section.label}</h4>
        <p>{(section.startMs/1000).toFixed(1)}s – {(section.endMs/1000).toFixed(1)}s</p>
        <div className="sl-song-map-actions">
          <button type="button" onClick={()=>{const label=ask('Section name',section.label);if(label)add({kind:'rename',id:section.id,label})}}>Rename</button>
          {index<data.sections.length-1&&<button type="button" onClick={()=>{const value=ask('New end time in seconds',(section.endMs/1000).toFixed(1));if(value)add({kind:'boundary',id:section.id,endMs:Math.round(Number(value)*1000)})}}>Move boundary</button>}
          {index<data.sections.length-1&&<button type="button" onClick={()=>{const label=ask('Merged section name',section.label);if(label)add({kind:'merge',leftId:section.id,rightId:data.sections[index+1]!.id,label})}}>Merge next</button>}
          <button type="button" onClick={()=>{const value=ask('Split time in seconds',((section.startMs+section.endMs)/2000).toFixed(1));const label=ask('New section name','New section');if(value&&label)add({kind:'split',id:section.id,atMs:Math.round(Number(value)*1000),newId:`part_${Date.now()}_${index}`,label})}}>Split</button>
        </div>
      </article>)}</div>
      <p>{edits.length} unsent or saved corrections in this sequence.</p>
      <button type="button" disabled={busy||!edits.length} onClick={()=>void save()}>{busy?'Saving…':'Save map corrections'}</button>
      <button type="button" onClick={()=>setEdits(data.edits||[])}>Discard unsaved edits</button>
      {data.nextActions.length>0&&<div><h4>Worth listening to next</h4>{data.nextActions.slice(0,3).map((a,i)=><p key={i}>{a.text} — {a.source}</p>)}</div>}
    </>}
  </section>
}
