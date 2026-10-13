import React from 'react'
import { api } from '../api.js'
import { AsyncBlock, Callout, Card, Field, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'
import { MeasuredWaveform } from './MeasuredWaveform.jsx'
import { BeatGrid } from './BeatGrid.jsx'

type Media = { id: string; filename: string; kind: string; url: string; durationSeconds: number | null; rights?: { owner?: string; authorized?: boolean; consent?: string; expiresAt?: string | null } }
type Cue = { asset_id: string; start_seconds: number; end_seconds: number; creative_look?: string }
const looks = ['cinematic', 'performance', 'editorial', 'atmosphere'] as const
const aspects = ['9:16', '1:1', '4:5', '16:9'] as const
function cleared(a: Media): boolean {
  const expiration = a.rights?.expiresAt
  return Boolean(a.rights?.authorized && a.rights.consent === 'authorized' && a.rights.owner?.trim() && (!expiration || (Number.isFinite(Date.parse(expiration)) && Date.parse(expiration) > Date.now())))
}
const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function QuickCreate({ projectId, onSaved, onReferences }: { projectId: string; onSaved: () => void; onReferences: () => void }) {
  const assets = useAsync(() => api.assets(projectId), [projectId])
  const shots = useAsync(() => api.shots(projectId), [projectId])
  const savedLooks = useAsync(() => api.creativeTreatments(projectId), [projectId])
  const audio = React.useRef<HTMLAudioElement>(null)
  const [audioId, setAudioId] = React.useState('')
  const [visualId, setVisualId] = React.useState('')
  const [editing, setEditing] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState('Release teaser')
  const [direction, setDirection] = React.useState('')
  const [look, setLook] = React.useState<(typeof looks)[number]>('cinematic')
  const [aspect, setAspect] = React.useState<(typeof aspects)[number]>('9:16')
  const [start, setStart] = React.useState(0)
  const [end, setEnd] = React.useState(15)
  const [position, setPosition] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const [loop, setLoop] = React.useState(true)
  const [attested, setAttested] = React.useState(false)
  const [presetName, setPresetName] = React.useState('Release visual direction')
  const [variantLabel, setVariantLabel] = React.useState('Alternate treatment')
  const [captions, setCaptions] = React.useState<Array<{start_seconds:number;end_seconds:number;text:string}>>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState<string | null>(null)
  // The clip the draft video models can make from this moment, when shorter.
  const [clipNote, setClipNote] = React.useState<string | null>(null)
  const media = (assets.data?.assets ?? []) as Media[]
  const audios = media.filter(a => a.kind === 'audio')
  const visuals = media.filter(a => a.kind === 'reference_image' || a.kind === 'reference_video')
  const selected = audios.find(a => a.id === audioId)
  const max = duration > 0 ? duration : selected?.durationSeconds ?? 0
  const captionsValid = captions.every((caption, index) =>
    caption.text.trim().length > 0 &&
    caption.end_seconds > caption.start_seconds &&
    caption.start_seconds >= 0 &&
    caption.end_seconds <= end - start + 0.05 &&
    (index === 0 || caption.start_seconds >= captions[index - 1]!.end_seconds))
  const captionPreview = captions.find(caption =>
    position - start >= caption.start_seconds && position - start < caption.end_seconds)?.text ?? null
  const valid = Boolean(captionsValid && selected && cleared(selected) && title.trim() && direction.trim().length >= 8 && end > start && end - start >= 0.5 && end - start <= 60 && max > 0 && end <= max + 0.1 && attested && (!visualId || visuals.some(v => v.id === visualId && cleared(v))))

  const chooseAudio = (id: string) => {
    audio.current?.pause()
    setAudioId(id)
    const file = audios.find(a => a.id === id)
    setDuration(file?.durationSeconds ?? 0)
    setStart(0)
    setEnd(Math.min(15, file?.durationSeconds ?? 15))
    setPosition(0)
    setAttested(false)
    setSaved(null)
    setCaptions([])
  }

  const restore = (id: string, spec: Record<string, unknown>) => {
    const cue = spec.music_cue as Cue
    setEditing(id)
    chooseAudio(cue.asset_id)
    setStart(cue.start_seconds)
    setEnd(cue.end_seconds)
    setPosition(cue.start_seconds)
    setTitle(String(spec.title ?? 'Release teaser'))
    setCaptions(Array.isArray(spec.timed_captions) ? spec.timed_captions as typeof captions : [])
    setDirection(String(spec.narrative_purpose ?? ''))
    setLook(looks.find(v => v === cue.creative_look) ?? 'cinematic')
    setAspect(aspects.find(v => v === spec.aspect_ratio) ?? '9:16')
    setVisualId(String(spec.first_frame_asset || (Array.isArray(spec.reference_video_assets) ? spec.reference_video_assets[0] ?? '' : '')))
  }

  const submit = async () => {
    if (!valid || !selected) return
    setBusy(true); setError(null); setSaved(null); setClipNote(null)
    try {
      const result = await api.quickCreate(projectId, {
        title: title.trim(), creativeDirection: direction.trim(),
        audioAssetId: selected.id, visualAssetId: visualId || null,
        startSeconds: start, endSeconds: end, aspectRatio: aspect, look,
        promotionalUseAttested: true, captions, ...(editing ? { shotId: editing } : {}),
      })
      setEditing(result.shotId)
      setSaved(result.shotId)
      setClipNote(result.clipSeconds < result.songMomentSeconds - 0.05
        ? `The song moment is ${result.songMomentSeconds.toFixed(1)} seconds. Video models make clips up to ${result.clipSeconds} seconds, so this shot is ${result.clipSeconds} seconds long. Add more shots on the Music Video Timeline to cover the rest.`
        : null)
      setAttested(false)
      shots.reload()
      onSaved()
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }

  return <div className="mcq">
    <Card title="Quick Create — music-first video brief">
      <p className="muted">Prepare a versioned shot and choose a real song moment. This saves a draft; it does not generate video, embed the song, publish, or spend credits.</p>
      <AsyncBlock state={assets}>{() => <>
        {!audios.some(cleared) && <Callout tone="warn">No rights-cleared audio in this MOTION project. <button type="button" onClick={onReferences}>Open References to add audio</button></Callout>}
        <div className="field-row">
          <Field label="Song recording"><select value={audioId} onChange={e => chooseAudio(e.target.value)}><option value="">Select audio</option>{audios.map(a => <option key={a.id} value={a.id} disabled={!cleared(a)}>{a.filename}{cleared(a) ? '' : ' — not authorized'}</option>)}</select></Field>
          <Field label="Optional footage / image"><select value={visualId} onChange={e => setVisualId(e.target.value)}><option value="">Create from direction only</option>{visuals.map(a => <option key={a.id} value={a.id} disabled={!cleared(a)}>{a.filename}{cleared(a) ? '' : ' — not authorized'}</option>)}</select></Field>
        </div>
        {selected && <section className="mcq-trim" aria-label="Song moment">
          <audio ref={audio} src={selected.url} controls preload="metadata" onLoadedMetadata={e => {
            const d = e.currentTarget.duration
            if (Number.isFinite(d) && d > 0) setDuration(d)
          }} onTimeUpdate={e => {
            const a = e.currentTarget
            setPosition(a.currentTime)
            if (a.currentTime >= end && !a.paused) {
              if (loop) a.currentTime = start
              else a.pause()
            }
          }} />
          <MeasuredWaveform assetId={audioId} duration={max} start={start} end={end} position={position} onSeek={seconds => {
            if (audio.current) audio.current.currentTime = seconds
            setPosition(seconds)
          }} />
          <BeatGrid assetId={audioId} start={start} end={end} duration={max} onTrim={(nextStart,nextEnd)=>{
            setStart(nextStart);setEnd(nextEnd)
          }} />
          <p>Song moment: {time(start)} to {time(end)} ({(end - start).toFixed(1)} seconds). Play the source above; playback is original, unaltered audio.</p>
          <Field label={`Start at ${time(start)}`}><input type="range" min="0" max={Math.max(0.5, max)} step="0.1" value={start} onChange={e => { const v = Number(e.target.value); setStart(v); setEnd(old => Math.min(max, Math.max(v + 0.5, old))); }} /></Field>
          <Field label={`End at ${time(end)}`}><input type="range" min="0.5" max={Math.max(0.5, max)} step="0.1" value={end} onChange={e => setEnd(Number(e.target.value))} /></Field>
          <div className="field-row">
            <Field label="Start (seconds)"><input type="number" min="0" step="0.1" value={start} onChange={e => setStart(Number(e.target.value))} /></Field>
            <Field label="End (seconds)"><input type="number" min="0.5" step="0.1" value={end} onChange={e => setEnd(Number(e.target.value))} /></Field>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => { if (audio.current) { audio.current.currentTime = start; void audio.current.play().catch(() => setError('Audio playback unavailable on this device')) } }}>Play selected moment</button>
            <label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} /> Loop selection</label>
            <span className="faint">Playhead {time(position)}</span>
          </div>
        </section>}
        <Field label="Shot title"><input value={title} maxLength={120} onChange={e => setTitle(e.target.value)} /></Field>
        <Field label="Creative direction"><textarea rows={3} value={direction} onChange={e => setDirection(e.target.value)} placeholder="Describe the scene, subject, action and practical lighting…" /></Field>
        <div className="field-row">
          <Field label="Creative look"><select value={look} onChange={e => setLook(e.target.value as typeof look)}>{looks.map(a => <option key={a} value={a}>{a}</option>)}</select></Field>
          <Field label="Video format"><select value={aspect} onChange={e => setAspect(e.target.value as typeof aspect)}>{aspects.map(a => <option key={a}>{a}</option>)}</select></Field>
        </div>
        <section aria-label="Timed lyrics and captions" className="mcq-trim">
          <h4>Timed captions</h4>
          <p className="muted">Enter approved lyric lines and exact times relative to the selected clip. No automatic transcription or synchronization is implied.</p>
          {captions.map((caption, index) => <div className="field-row" key={index}>
            <Field label="Start (clip seconds)"><input type="number" min="0" step="0.1" value={caption.start_seconds} onChange={e => setCaptions(old => old.map((row,i) => i===index ? {...row,start_seconds:Number(e.target.value)} : row))} /></Field>
            <Field label="End (clip seconds)"><input type="number" min="0" step="0.1" value={caption.end_seconds} onChange={e => setCaptions(old => old.map((row,i) => i===index ? {...row,end_seconds:Number(e.target.value)} : row))} /></Field>
            <Field label="Caption text"><input maxLength={160} value={caption.text} onChange={e => setCaptions(old => old.map((row,i) => i===index ? {...row,text:e.target.value} : row))} /></Field>
            <button type="button" onClick={() => setCaptions(old => old.filter((_,i) => i!==index))}>Remove line</button>
          </div>)}
          <div className="mcq-caption-preview" aria-label="Caption line at current audio playhead">
            <span>{captionPreview || 'No caption at the current playback position'}</span>
          </div>
          {!captionsValid && <p className="faint">Finish each line and place its timing inside the selected clip without overlaps before saving.</p>}
          <button type="button" disabled={captions.length >= 32} onClick={() => {
            const from = captions.length ? captions[captions.length-1]!.end_seconds : 0
            const to = Math.min(Math.max(.5,end-start),from+2)
            if (to>from) setCaptions(old=>[...old,{start_seconds:from,end_seconds:to,text:''}])
          }}>Add caption line</button>
        </section>
        <label className="mcq-consent"><input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} /> I confirm the selected media is authorized for this promotional creative draft.</label>
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="button-row"><button type="button" className="primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? 'Saving…' : editing ? 'Save new draft version' : 'Save Quick Create draft'}</button></div>
        {saved && <Callout tone="ok">Draft saved. No render or audio mix has occurred. <button type="button" onClick={() => navigate(`/shot/${saved}`)}>Open professional Shot Builder</button></Callout>}
        {saved && clipNote && <p className="muted" role="status">{clipNote}</p>}
      </>}</AsyncBlock>
    </Card>
    <Card title="Saved creative treatments">
      <p className="muted">Save reusable directions, format and looks for this film. Existing footage, recordings and source versions are never altered.</p>
      <AsyncBlock state={savedLooks}>{data => <>
        <Field label="Reuse a saved treatment">
          <select defaultValue="" onChange={event => {
            const found = data.treatments.find(t => t.id === event.target.value)
            if (!found) return
            const chosenLook = looks.find(item => item === found.look)
            const chosenAspect = aspects.find(item => item === found.aspect_ratio)
            if (chosenLook) setLook(chosenLook)
            if (chosenAspect) setAspect(chosenAspect)
            setDirection(found.direction)
          }}>
            <option value="">Choose a treatment</option>
            {data.treatments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <p className="faint">{data.treatments.length} of 24 available project treatments saved.</p>
        <Field label="Name the current treatment">
          <input maxLength={80} value={presetName} onChange={e => setPresetName(e.target.value)} />
        </Field>
        <button type="button" className="small" disabled={busy || !presetName.trim() || direction.trim().length < 8 || data.treatments.length >= 24}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await api.saveCreativeTreatment(projectId, { name: presetName.trim(), look, aspect_ratio: aspect, direction: direction.trim() })
              savedLooks.reload()
            } catch (cause) { setError((cause as Error).message) }
            finally { setBusy(false) }
          }}>Save this creative treatment</button>
        <p className="faint">Project editors can save a look; saving does not generate or approve video.</p>
      </>}</AsyncBlock>
    </Card>
    <Card title="Creative variations">
      <p className="muted">Create a separate source-linked shot to compare ideas. No external provider is called and no render charge occurs.</p>
      <Field label="Variation name"><input maxLength={80} value={variantLabel} onChange={e=>setVariantLabel(e.target.value)} /></Field>
      <Field label="Source draft"><select value={editing ?? ''} onChange={e=>{
        const shot=shots.data?.shots.find(x=>x.id===e.target.value)
        if (shot?.spec?.music_cue) restore(shot.id,shot.spec)
      }}><option value="">Choose an existing music draft</option>{(shots.data?.shots ?? []).filter(x=>Boolean(x.spec?.music_cue)).map(x=><option key={x.id} value={x.id}>{x.title}</option>)}</select></Field>
      <button type="button" disabled={!editing || direction.trim().length<8 || !variantLabel.trim() || busy} onClick={async()=>{
        if(!editing)return
        setBusy(true);setError(null)
        try {
          const result=await api.createVariant(projectId,{sourceShotId:editing,label:variantLabel.trim(),direction:direction.trim(),look})
          shots.reload();onSaved();setSaved(result.shotId)
        } catch(cause) {setError((cause as Error).message)} finally{setBusy(false)}
      }}>Save alternative as new shot</button>
      {saved && <p className="muted">Saved shot {saved}. Compare and render variants using the existing Shot Builder and Review Grid.</p>}
    </Card>
    <Card title="Saved music-first drafts">
      <AsyncBlock state={shots}>{data => {
        const drafts = data.shots.filter(shot => Boolean((shot.spec as Record<string, unknown> | undefined)?.music_cue))
        return drafts.length ? <div className="mcq-saved">{drafts.map(shot => <div key={shot.id} className="mcq-saved-row"><span>{shot.title}</span><button type="button" onClick={() => restore(shot.id, shot.spec as Record<string, unknown>)}>Edit song moment</button><button type="button" onClick={() => navigate(`/shot/${shot.id}`)}>Advanced editor</button></div>)}</div> : <p className="muted">No song-moment drafts yet.</p>
      }}</AsyncBlock>
    </Card>
  </div>
}
