import React from 'react'
import { api } from '../api.js'
import { navigate } from '../App.jsx'
import { Callout, Field } from '../ui.jsx'

type Planned = Awaited<ReturnType<typeof api.proposeScenePlan>>
type Editor = Planned['shots'][number] & {
  requestId: string
  reviewed: boolean
  promotionalUseAttested: boolean
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:5'
  savedShotId: string | null
}

/**
 * Creator review is the boundary between an advisory plan and a canonical
 * professional Shot Builder draft. Each individual click has its own stable
 * idempotency UUID; nothing is submitted until review+rights are confirmed.
 */
export function SceneHandoff({
  projectId, plan, onCreated,
}: {
  projectId: string
  plan: Planned
  onCreated: () => void
}) {
  const [editors,setEditors] = React.useState<Editor[]>(() => plan.shots.map(shot => ({
    ...shot, requestId: crypto.randomUUID(),
    reviewed: false, promotionalUseAttested: false,
    aspectRatio: '9:16', savedShotId: null,
  })))
  const [busy,setBusy] = React.useState<number|null>(null)
  const [errors,setErrors] = React.useState<Record<number,string>>({})
  const change = (i:number, patch:Partial<Editor>) => {
    const creativeChange = Object.keys(patch).some(key =>
      !['reviewed','promotionalUseAttested','savedShotId'].includes(key))
    setEditors(before => before.map((item,j)=>j===i
      ? {...item,...(creativeChange ? {reviewed:false} : {}),...patch}
      : item))
  }
  const makeDraft = async (i:number) => {
    const editor=editors[i]
    if(!editor||busy!==null||editor.savedShotId||!editor.reviewed||!editor.promotionalUseAttested)return
    setBusy(i)
    setErrors(old=>({...old,[i]:''}))
    try {
      const result=await api.handoffSceneShot(projectId,{
        requestId:editor.requestId,
        reviewed:true,promotionalUseAttested:true,
        audioAssetId:plan.audioAssetId,
        songStartSeconds:editor.songStartSeconds,
        songEndSeconds:editor.songEndSeconds,
        title:editor.title,sectionLabel:editor.sectionLabel,
        narrativePurpose:editor.narrativePurpose,
        cameraDirection:editor.cameraDirection,
        performanceDirection:editor.performanceDirection,
        visualTreatment:editor.visualTreatment,aspectRatio:editor.aspectRatio,
      })
      change(i,{savedShotId:result.shotId})
      onCreated()
    } catch(error) {
      setErrors(old=>({...old,[i]:(error as Error).message}))
    } finally {setBusy(null)}
  }
  return <section className="mc-scene-handoff" aria-label="Reviewed scene-to-shot handoff">
    <h4>Review and send to Shot Builder</h4>
    <p className="muted">These are editable creative suggestions, not generated footage. Review each one, confirm the recording's promotional-use permission, then create its separate canonical draft. Each draft keeps the professional Shot Builder's validation, human review and budget approvals. No render or credit charge is triggered.</p>
    {editors.map((shot,i)=><div className="mc-scene-handoff-card" key={shot.requestId}>
      <h4>Scene {shot.ordinal} · {shot.sectionLabel}</h4>
      <fieldset disabled={Boolean(shot.savedShotId)||busy!==null}>
        <div className="field-row">
          <Field label="Shot title"><input value={shot.title} maxLength={120}
            onChange={event=>change(i,{title:event.target.value})}/></Field>
          <Field label="Aspect ratio"><select value={shot.aspectRatio}
            onChange={event=>change(i,{aspectRatio:event.target.value as Editor['aspectRatio']})}>
            <option value="9:16">Vertical 9:16</option>
            <option value="16:9">Landscape 16:9</option>
            <option value="1:1">Square 1:1</option>
            <option value="4:5">Portrait 4:5</option>
          </select></Field>
        </div>
        <div className="field-row">
          <Field label="Audio in (seconds)"><input type="number" min="0" step=".1"
            value={shot.songStartSeconds} onChange={event=>change(i,{songStartSeconds:Number(event.target.value)})}/></Field>
          <Field label="Audio out (seconds)"><input type="number" min=".5" step=".1"
            value={shot.songEndSeconds} onChange={event=>change(i,{songEndSeconds:Number(event.target.value)})}/></Field>
        </div>
        <Field label="Narrative purpose"><textarea rows={2} maxLength={1400}
          value={shot.narrativePurpose} onChange={event=>change(i,{narrativePurpose:event.target.value})}/></Field>
        <Field label="Camera direction"><textarea rows={2} maxLength={500}
          value={shot.cameraDirection} onChange={event=>change(i,{cameraDirection:event.target.value})}/></Field>
        <Field label="Performance direction"><textarea rows={2} maxLength={500}
          value={shot.performanceDirection} onChange={event=>change(i,{performanceDirection:event.target.value})}/></Field>
        <Field label="Visual treatment"><textarea rows={2} maxLength={500}
          value={shot.visualTreatment} onChange={event=>change(i,{visualTreatment:event.target.value})}/></Field>
        <label className="mc-scene-handoff-confirm">
          <input type="checkbox" checked={shot.reviewed}
            onChange={event=>change(i,{reviewed:event.target.checked})}/>
          I reviewed and approve this shot as an editable creative draft.
        </label>
        <label className="mc-scene-handoff-confirm">
          <input type="checkbox" checked={shot.promotionalUseAttested}
            onChange={event=>change(i,{promotionalUseAttested:event.target.checked})}/>
          I confirm I have permission to use the selected recording for this promotional video draft.
        </label>
      </fieldset>
      {errors[i]&&<Callout tone="danger">{errors[i]}</Callout>}
      <div className="button-row">
        {!shot.savedShotId
          ? <button type="button" className="primary"
              disabled={busy!==null||!shot.reviewed||!shot.promotionalUseAttested||
                !shot.title.trim()||!shot.narrativePurpose.trim()||
                !shot.cameraDirection.trim()||!shot.performanceDirection.trim()||
                !shot.visualTreatment.trim()||
                shot.songEndSeconds-shot.songStartSeconds<.5||
                shot.songEndSeconds-shot.songStartSeconds>60}
              onClick={()=>void makeDraft(i)}>
              {busy===i?'Creating draft…':'Create reviewed draft shot'}
            </button>
          : <button type="button" onClick={()=>navigate('/shot/'+shot.savedShotId)}>
              Open in professional Shot Builder
            </button>}
        {shot.savedShotId&&<span className="faint">Canonical draft saved. No render submitted.</span>}
      </div>
    </div>)}
  </section>
}
