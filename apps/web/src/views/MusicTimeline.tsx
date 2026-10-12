import React from 'react'
import { api } from '../api.js'
import { SceneHandoff } from './SceneHandoff.jsx'
import { MusicStructureEditor } from './MusicStructureEditor.jsx'
import { AsyncBlock, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'

type Clip = { master_id:string;source_start_seconds:number;source_end_seconds:number }
type SourceVideo = { masterId:string;name:string;durationSeconds:number;videoUrl:string }
type SourceAudio = { id:string;filename:string;durationSeconds:number;audioUrl:string }
type TimelineDraft = { name:string;audio_asset_id:string;song_start_seconds:number;clips:Clip[] }

const duration = (clip:Clip) => clip.source_end_seconds - clip.source_start_seconds
const total = (clips:Clip[]) => clips.reduce((sum,item)=>sum+duration(item),0)
const seconds = (n:number) => (Number.isFinite(n) ? n.toFixed(2) : '0.00')
const blank:TimelineDraft = {name:'New music-video cut',audio_asset_id:'',song_start_seconds:0,clips:[]}

/**
 * Timing preview uses genuine approved media, not a synthetic "export".
 * Browser seeking/network buffering may add delay between shots; final
 * frame-accurate MP4 assembly is a separate finishing operation.
 */
function CutPreview({draft,videos,audio}:{draft:TimelineDraft;videos:SourceVideo[];audio:SourceAudio[]}) {
  const video=React.useRef<HTMLVideoElement>(null)
  const song=React.useRef<HTMLAudioElement>(null)
  const [index,setIndex]=React.useState(0)
  const [playing,setPlaying]=React.useState(false)
  const clip=draft.clips[index]
  const movie=videos.find(item=>item.masterId===clip?.master_id)
  const recording=audio.find(item=>item.id===draft.audio_asset_id)
  const playAll=async()=>{
    if(!clip||!movie||!recording)return
    setIndex(0)
    const first=draft.clips[0]!
    if(song.current){song.current.currentTime=draft.song_start_seconds;void song.current.play().catch(()=>setPlaying(false))}
    if(video.current){
      if(index===0){video.current.currentTime=first.source_start_seconds;void video.current.play().catch(()=>setPlaying(false))}
    }
    setPlaying(true)
  }
  const stop=()=>{
    song.current?.pause();video.current?.pause();setPlaying(false)
  }
  React.useEffect(()=>{
    if(!playing||!clip||!video.current)return
    video.current.currentTime=clip.source_start_seconds
    void video.current.play().catch(()=>setPlaying(false))
  },[index,clip?.master_id,playing])
  return <section className="mc-timeline-preview" aria-label="Non-destructive timeline preview">
    <p className="muted">Browser sequence preview only. Cuts depend on seek/buffer timing; no MP4 has been assembled or published.</p>
    {recording && <audio ref={song} src={recording.audioUrl} preload="metadata" />}
    {clip&&movie ? <video key={movie.masterId+'-'+index} ref={video} src={movie.videoUrl}
      poster={undefined} playsInline muted preload="metadata"
      onTimeUpdate={event=>{
        const player=event.currentTarget
        if(!playing||player.currentTime<clip.source_end_seconds-.035)return
        if(index+1>=draft.clips.length){stop();return}
        setIndex(current=>current+1)
      }}
      onLoadedMetadata={event=>{event.currentTarget.currentTime=clip.source_start_seconds;
        if(playing)void event.currentTarget.play().catch(()=>setPlaying(false))}}
    /> : <div className="mc-timeline-placeholder">Add a human-approved video master to preview.</div>}
    <div className="button-row">
      <button type="button" onClick={()=>void playAll()} disabled={!recording||!clip||!movie}>Play selected cut</button>
      <button type="button" onClick={stop}>Stop</button>
      <span className="faint">Clip {clip?index+1:0} of {draft.clips.length}</span>
    </div>
  </section>
}

/** Pure explicit human edit decision list: one audio bed, cut-only sequence. */
export function MusicTimeline({projectId,onCreated}:{projectId:string;onCreated:()=>void}){
  const sources=useAsync(()=>api.musicTimelineSources(projectId),[projectId])
  const saved=useAsync(()=>api.musicTimelines(projectId),[projectId])
  const [timelineId,setTimelineId]=React.useState<string|null>(null)
  const exportsData=useAsync(()=>timelineId
    ?api.musicTimelineExports(projectId,timelineId)
    :Promise.resolve({exports:[] as Array<{id:string;assetId:string;version:number;durationSeconds:number|null;url:string|null;createdAt:string}>,latestJob:null as {id:string;status:string}|null}),
    [projectId,timelineId])
  const persistedBusy=Boolean(exportsData.data?.latestJob &&
    ['pending','active'].includes(exportsData.data.latestJob.status))
  React.useEffect(()=>{
    if(!persistedBusy)return
    const timer=window.setInterval(()=>exportsData.reload(),5000)
    return()=>window.clearInterval(timer)
  },[persistedBusy,timelineId])
  const [draft,setDraft]=React.useState<TimelineDraft>(blank)
  const [version,setVersion]=React.useState(0)
  const [adding,setAdding]=React.useState('')
  const [snapshot,setSnapshot]=React.useState<string|null>(null)
  const [renderJob,setRenderJob]=React.useState<string|null>(null)
  const [renderStatus,setRenderStatus]=React.useState<string|null>(null)
  const [pacing,setPacing]=React.useState<'measured'|'balanced'|'energetic'>('balanced')
  const [targetSeconds,setTargetSeconds]=React.useState(20)
  const [sceneDirection,setSceneDirection]=React.useState('')
  const [sceneCount,setSceneCount]=React.useState(6)
  const [scenePlan,setScenePlan]=React.useState<Awaited<ReturnType<typeof api.proposeScenePlan>>|null>(null)

  const [proposal,setProposal]=React.useState<{spec:TimelineDraft;confidence:number;beatAligned:boolean;structureUsed:boolean;structureNotes:string|null;warnings:string[]}|null>(null)
  const [busy,setBusy]=React.useState(false)
  const [error,setError]=React.useState<string|null>(null)
  const [message,setMessage]=React.useState<string|null>(null)
  const [beatInfo,setBeatInfo]=React.useState<{beats:number[];confidence:number;bpm:number|null}|null>(null)
  const videos=sources.data?.videos??[]
  const audio=sources.data?.audio??[]
  const selectedAudio=audio.find(item=>item.id===draft.audio_asset_id)
  const cleanSaved=Boolean(timelineId&&snapshot===JSON.stringify(draft))
  const cutLength=total(draft.clips)
  const valid=Boolean(draft.name.trim()&&selectedAudio&&draft.clips.length>=1&&cutLength<=60&&
    cutLength>=.5&&draft.song_start_seconds>=0&&
    draft.song_start_seconds+cutLength<=selectedAudio.durationSeconds+.05&&draft.clips.every(clip=>{
      const source=videos.find(video=>video.masterId===clip.master_id)
      return source&&clip.source_start_seconds>=0&&duration(clip)>=.5&&clip.source_end_seconds<=source.durationSeconds+.05
    }))

  React.useEffect(()=>{
    let active=true
    setBeatInfo(null)
    if(!draft.audio_asset_id)return
    void api.beats(draft.audio_asset_id).then(data=>{
      if(active)setBeatInfo({beats:data.beats,confidence:data.confidence,bpm:data.bpm})
    }).catch(()=>{if(active)setBeatInfo(null)})
    return()=>{active=false}
  },[draft.audio_asset_id])

  const edit=(index:number,patch:Partial<Clip>)=>{
    setDraft(old=>({...old,clips:old.clips.map((clip,i)=>i===index?{...clip,...patch}:clip)}))
    setMessage(null)
  }
  const move=(index:number,shift:number)=>{
    setDraft(old=>{
      const items=[...old.clips]
      const to=index+shift
      if(to<0||to>=items.length)return old
      const [item]=items.splice(index,1);items.splice(to,0,item!)
      return {...old,clips:items}
    })
  }
  const snapCut=(index:number)=>{
    if(!beatInfo||beatInfo.confidence<.3||index<0||index>=draft.clips.length-1)return
    const prefix=draft.clips.slice(0,index).reduce((n,c)=>n+duration(c),0)
    const clip=draft.clips[index]!
    const previous=draft.song_start_seconds+prefix+duration(clip)
    const next=beatInfo.beats.reduce((best,candidate)=>
      Math.abs(candidate-previous)<Math.abs(best-previous)?candidate:best,beatInfo.beats[0]??previous)
    const newDuration=next-draft.song_start_seconds-prefix
    const source=videos.find(video=>video.masterId===clip.master_id)
    if(!source||newDuration<.5||clip.source_start_seconds+newDuration>source.durationSeconds||
      total(draft.clips)-duration(clip)+newDuration>60)return
    edit(index,{source_end_seconds:Number((clip.source_start_seconds+newDuration).toFixed(2))})
  }
  React.useEffect(()=>{
    if(!timelineId||!renderJob)return
    let active=true
    const poll=async()=>{
      try{
        const state=await api.musicTimelineJob(projectId,timelineId,renderJob)
        if(!active)return
        setRenderStatus(state.status)
        if(state.status==='completed'){
          exportsData.reload()
          setRenderJob(null)
          setMessage('A real finished MP4 is now available below.')
        }else if(['dead','failed','cancelled'].includes(state.status)){
          setRenderJob(null)
          setError(state.error||'Timeline assembly did not complete.')
        }
      }catch(error){if(active){setError((error as Error).message);setRenderJob(null)}}
    }
    void poll()
    const timer=window.setInterval(()=>void poll(),3000)
    return()=>{active=false;window.clearInterval(timer)}
  },[projectId,timelineId,renderJob])

  const assemble=async()=>{
    if(!timelineId||!cleanSaved||busy)return
    setBusy(true);setError(null);setMessage(null)
    try{
      const job=await api.assembleMusicTimeline(projectId,timelineId)
      setRenderJob(job.jobId)
      setRenderStatus('queued')
      setMessage(job.deduped?'An existing assembly job will be checked.':'Real MP4 assembly queued; no result has been claimed yet.')
    }catch(error){setError((error as Error).message)}
    finally{setBusy(false)}
  }

  const planScenes=async()=>{
    if(!draft.audio_asset_id||!sceneDirection.trim()||busy)return
    setBusy(true);setError(null);setScenePlan(null)
    try {
      setScenePlan(await api.proposeScenePlan(projectId,{
        audio_asset_id:draft.audio_asset_id,
        song_start_seconds:draft.song_start_seconds,
        target_seconds:targetSeconds,direction:sceneDirection.trim(),shot_count:sceneCount,
      }))
    } catch(err){setError((err as Error).message)}
    finally{setBusy(false)}
  }

  const propose=async()=>{
    if(!draft.audio_asset_id||busy)return
    setBusy(true);setError(null);setMessage(null);setProposal(null)
    try{
      const result=await api.proposeMusicFirstCut(projectId,{
        name:draft.name||'Suggested first cut',
        audio_asset_id:draft.audio_asset_id,
        song_start_seconds:draft.song_start_seconds,
        target_seconds:targetSeconds,pacing,
      })
      setProposal({spec:result.spec,confidence:result.confidence,
        beatAligned:result.beatAligned,structureUsed:result.structureUsed,structureNotes:result.structureNotes,warnings:result.warnings})
    }catch(error){setError((error as Error).message)}
    finally{setBusy(false)}
  }

  const save=async()=>{
    if(!valid||busy)return
    setBusy(true);setError(null);setMessage(null)
    try{
      const result=timelineId
        ?await api.updateMusicTimeline(projectId,timelineId,version,draft)
        :await api.createMusicTimeline(projectId,draft)
      setTimelineId(result.timelineId);setVersion(result.version)
      setSnapshot(JSON.stringify(draft))
      saved.reload()
      setMessage('Cut decisions saved as timeline version '+result.version+'. No video rendered or credits spent.')
    }catch(err){setError((err as Error).message)}
    finally{setBusy(false)}
  }
  return <div className="mc-timeline">
    <Card title="Music Video Timeline — approved clips">
      <p className="muted">Sequence and trim up to 16 human-approved masters against an authorized song. This is a cut-only editing workspace; originals remain unchanged.</p>
      <AsyncBlock state={sources}>{data=><>
        {data.videos.length===0&&<Callout tone="warn">No human-approved master videos in this film. Render, approve and promote shots before creating a cut.</Callout>}
        {data.audio.length===0&&<Callout tone="warn">No currently authorized recording in this film. Add and clear an audio source in References.</Callout>}
        <div className="field-row">
          <Field label="Timeline name"><input value={draft.name} maxLength={120} onChange={e=>setDraft(old=>({...old,name:e.target.value}))}/></Field>
          <Field label="Soundtrack"><select value={draft.audio_asset_id} onChange={e=>setDraft(old=>({...old,audio_asset_id:e.target.value}))}>
            <option value="">Select an authorized track</option>
            {data.audio.map(item=><option key={item.id} value={item.id}>{item.filename}</option>)}
          </select></Field>
          <Field label="Song start (seconds)"><input type="number" min="0" step=".1" value={draft.song_start_seconds} onChange={e=>setDraft(old=>({...old,song_start_seconds:Number(e.target.value)}))}/></Field>
        </div>
        {selectedAudio&&<MusicStructureEditor key={selectedAudio.id}
          projectId={projectId} assetId={selectedAudio.id} duration={selectedAudio.durationSeconds}
          onUseStart={seconds=>setDraft(old=>({...old,song_start_seconds:seconds}))}/>}
        {beatInfo&&<p className="faint">Beat estimate: {beatInfo.bpm??'unavailable'} BPM · {Math.round(beatInfo.confidence*100)}% confidence. Snap unavailable if confidence is low.</p>}
        <section className="mc-timeline-auto" aria-label="Scene Planning Intelligence">
          <h4>Scene Planning Intelligence</h4>
          <p className="muted">Draft shot ideas from your own creative direction and saved song-section labels. Review each suggestion before creating any actual shot.</p>
          <div className="field-row">
            <Field label="Visual story direction"><textarea rows={3} maxLength={800} value={sceneDirection}
              onChange={e=>setSceneDirection(e.target.value)} placeholder="Describe performance, world, mood, character and visual progression…" /></Field>
            <Field label="Suggested shots"><input type="number" min="1" max="12" value={sceneCount}
              onChange={e=>setSceneCount(Number(e.target.value))}/></Field>
          </div>
          <button type="button" disabled={!selectedAudio||!sceneDirection.trim()||busy||
            sceneCount<1||sceneCount>12||targetSeconds<2||targetSeconds>60||
            draft.song_start_seconds+targetSeconds>selectedAudio.durationSeconds}
            onClick={()=>void planScenes()}>{busy?'Planning…':'Propose scene plan'}</button>
          {scenePlan&&<div className="mc-timeline-proposal">
            <strong>{scenePlan.shots.length} suggested shots — review required</strong>
            <p className="faint">{scenePlan.warning}</p>
            {scenePlan.shots.map(shot=><div key={shot.ordinal} className="mc-timeline-clip">
              <strong>{shot.title}</strong>
              <p className="faint">{shot.songStartSeconds.toFixed(1)}–{shot.songEndSeconds.toFixed(1)}s · {shot.sectionKind}</p>
              <p><b>Camera:</b> {shot.cameraDirection}</p>
              <p><b>Performance:</b> {shot.performanceDirection}</p>
              <p><b>Treatment:</b> {shot.visualTreatment}</p>
              <p className="faint">{shot.narrativePurpose}</p>
            </div>)}
            <SceneHandoff key={scenePlan.audioAssetId+'-'+scenePlan.shots.map(item=>item.title+item.songStartSeconds).join('|')} projectId={projectId} plan={scenePlan} onCreated={onCreated}/>
            <button type="button" onClick={()=>setScenePlan(null)}>Dismiss scene plan</button>
          </div>}
        </section>
        <section className="mc-timeline-auto" aria-label="Auto-Assembly Director">
          <h4>Auto-Assembly Director</h4>
          <p className="muted">Suggest a reversible first cut using your authorized song, real beat estimates and approved master videos. No clips are changed until you apply the suggestion.</p>
          <div className="field-row">
            <Field label="Editing pace"><select value={pacing} onChange={e=>setPacing(e.target.value as typeof pacing)}>
              <option value="measured">Measured</option>
              <option value="balanced">Balanced</option>
              <option value="energetic">Energetic</option>
            </select></Field>
            <Field label="Target duration (seconds)"><input type="number" min="2" max="60" step=".5"
              value={targetSeconds} onChange={e=>setTargetSeconds(Number(e.target.value))}/></Field>
          </div>
          <button type="button" disabled={!selectedAudio||videos.length===0||busy||
            targetSeconds<2||targetSeconds>60||
            draft.song_start_seconds+targetSeconds>selectedAudio.durationSeconds}
            onClick={()=>void propose()}>{busy?'Analyzing…':'Propose first cut'}</button>
          {proposal&&<div className="mc-timeline-proposal">
            <strong>Proposed {proposal.spec.clips.length} clips · {seconds(total(proposal.spec.clips))}s</strong>
            <p className="faint">Beat aligned: {proposal.beatAligned?'Estimated beats':'No reliable beat grid'} · Confidence {Math.round(proposal.confidence*100)}%</p>
            <p className="faint">Song structure: {proposal.structureUsed?'Uses saved artist-labelled sections':'Not annotated; even pacing fallback'}{proposal.structureNotes?' · '+proposal.structureNotes:''}</p>
            <ol>{proposal.spec.clips.map((item,i)=><li key={i}>
              {videos.find(v=>v.masterId===item.master_id)?.name??'Approved master'} · {seconds(duration(item))}s
            </li>)}</ol>
            {proposal.warnings.map((warning,i)=><p className="faint" key={i}>{warning}</p>)}
            <div className="button-row">
              <button type="button" className="primary" onClick={()=>{
                setDraft(proposal.spec);setTimelineId(null);setVersion(0);
                setSnapshot(null);setRenderJob(null);setRenderStatus(null);
                setProposal(null);setMessage('Suggestion applied locally. Review every cut and save the timeline when ready.')
              }}>Apply editable proposal</button>
              <button type="button" onClick={()=>setProposal(null)}>Discard suggestion</button>
            </div>
          </div>}
        </section>
        <div className="mc-timeline-assemble">
          <Field label="Approved source clip"><select value={adding} onChange={e=>setAdding(e.target.value)}>
            <option value="">Choose a video master</option>
            {data.videos.map(item=><option key={item.masterId} value={item.masterId}>{item.name} ({seconds(item.durationSeconds)}s)</option>)}
          </select></Field>
          <button type="button" disabled={!adding||draft.clips.length>=16} onClick={()=>{
            const source=videos.find(item=>item.masterId===adding)
            if(!source)return
            setDraft(old=>({...old,clips:[...old.clips,{master_id:adding,source_start_seconds:0,source_end_seconds:Math.min(4,source.durationSeconds)}]}))
          }}>Add clip to timeline</button>
        </div>
        {draft.clips.length>0&&<div className="mc-timeline-clips">
          {draft.clips.map((clip,index)=>{
            const source=videos.find(item=>item.masterId===clip.master_id)
            const offset=draft.clips.slice(0,index).reduce((n,item)=>n+duration(item),0)
            return <div key={index} className="mc-timeline-clip">
              <div className="mc-timeline-clip-head"><strong>{index+1}. {source?.name??'Missing approved source'}</strong>
                <span className="faint">Cut at song {seconds(draft.song_start_seconds+offset)}s</span></div>
              <div className="field-row">
                <Field label="Video in (s)"><input type="number" min="0" step=".1" value={clip.source_start_seconds}
                  onChange={e=>edit(index,{source_start_seconds:Number(e.target.value)})}/></Field>
                <Field label="Video out (s)"><input type="number" min=".5" step=".1" value={clip.source_end_seconds}
                  onChange={e=>edit(index,{source_end_seconds:Number(e.target.value)})}/></Field>
                <span className="faint">{seconds(duration(clip))}s duration</span>
              </div>
              <div className="button-row">
                <button type="button" disabled={index===0} onClick={()=>move(index,-1)}>Move earlier</button>
                <button type="button" disabled={index===draft.clips.length-1} onClick={()=>move(index,1)}>Move later</button>
                <button type="button" disabled={index===draft.clips.length-1||!beatInfo||beatInfo.confidence<.3}
                  onClick={()=>snapCut(index)}>Snap cut to beat</button>
                <button type="button" className="danger" onClick={()=>setDraft(old=>({...old,clips:old.clips.filter((_,i)=>i!==index)}))}>Remove</button>
              </div>
            </div>
          })}
        </div>}
        <div className="mc-timeline-duration"><strong>Total {seconds(cutLength)}s</strong>
          <span> · Max 60 seconds · {draft.clips.length}/16 clips</span></div>
        {!valid&&draft.clips.length>0&&<p className="faint">Each clip must fit inside its approved master; the combined cut must fit inside the selected song and remain at most 60 seconds.</p>}
        <div className="button-row">
          <button className="primary" disabled={!valid||busy} onClick={()=>void save()}>{busy?'Saving…':timelineId?'Save new timeline version':'Save timeline'}</button>
          <button type="button" onClick={()=>{setDraft(blank);setTimelineId(null);setVersion(0);setSnapshot(null);setRenderJob(null);setMessage(null);setError(null)}}>Start new cut</button>
        </div>
        <section className="mc-timeline-render" aria-label="Real MP4 finishing">
          <h4>Finish a real video</h4>
          <p className="muted">Build a straight-cut MP4 from approved video masters and the original track. Source aspect ratios are preserved with padding; nothing is cropped or published automatically. No AI render credits are used.</p>
          <button type="button" className="primary" disabled={!valid||!cleanSaved||busy||!!renderJob||persistedBusy}
            onClick={()=>void assemble()}>
            {renderJob||persistedBusy?'Assembly in progress…':'Assemble MP4 from saved cut'}
          </button>
          {!cleanSaved&&timelineId&&<p className="faint">Save the current edit before assembling this version.</p>}
          {(renderStatus||exportsData.data?.latestJob?.status)&&<p role="status" className="faint">Assembly status: {renderStatus||exportsData.data?.latestJob?.status}</p>}
          <AsyncBlock state={exportsData}>{data=>data.exports.length===0
            ?<p className="faint">No completed MP4 assemblies for this timeline yet.</p>
            :<div className="mc-timeline-exports">{data.exports.map(item=><div key={item.id}>
              <strong>MP4 · version {item.version}</strong>
              <span className="faint"> · {seconds(item.durationSeconds??0)}s</span>
              {item.url?<><video controls playsInline preload="metadata" src={item.url} aria-label="Real assembled timeline MP4" />
                <a href={item.url} target="_blank" rel="noopener noreferrer">Open finished MP4</a></>
                :<p className="faint">This export is no longer cleared for playback.</p>}
            </div>)}</div>}</AsyncBlock>
        </section>
        {error&&<Callout tone="danger">{error}</Callout>}
        {message&&<Callout tone="ok">{message}</Callout>}
        <CutPreview key={draft.audio_asset_id+draft.clips.map(c=>c.master_id).join(':')}
          draft={draft} videos={videos} audio={audio}/>
      </>}</AsyncBlock>
    </Card>
    <Card title="Saved timeline drafts">
      <AsyncBlock state={saved}>{data=>data.timelines.length===0?<Empty>No cuts saved yet.</Empty>:
        <div className="mc-timeline-saved">{data.timelines.map(item=>
          <div key={item.id} className="mc-timeline-saved-row">
            <span><strong>{item.name}</strong> · version {item.version} · {item.spec.clips.length} clips</span>
            <button type="button" onClick={()=>{setDraft({...item.spec,clips:item.spec.clips.map(c=>({...c}))});setTimelineId(item.id);setVersion(item.version);setSnapshot(JSON.stringify(item.spec));setRenderJob(null);setRenderStatus(null);setMessage(null)}}>Edit cut</button>
          </div>)}</div>}</AsyncBlock>
    </Card>
  </div>
}
