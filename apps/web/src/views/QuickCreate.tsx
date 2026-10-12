import React from 'react'
import { api } from '../api.js'
import { AsyncBlock, Callout, Card, Field, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'

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
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState<string | null>(null)
  const media = (assets.data?.assets ?? []) as Media[]
  const audios = media.filter(a => a.kind === 'audio')
  const visuals = media.filter(a => a.kind === 'reference_image' || a.kind === 'reference_video')
  const selected = audios.find(a => a.id === audioId)
  const max = duration > 0 ? duration : selected?.durationSeconds ?? 0
  const valid = Boolean(selected && cleared(selected) && title.trim() && direction.trim().length >= 8 && end > start && end - start >= 0.5 && end - start <= 60 && max > 0 && end <= max + 0.1 && attested && (!visualId || visuals.some(v => v.id === visualId && cleared(v))))

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
  }

  const restore = (id: string, spec: Record<string, unknown>) => {
    const cue = spec.music_cue as Cue
    setEditing(id)
    chooseAudio(cue.asset_id)
    setStart(cue.start_seconds)
    setEnd(cue.end_seconds)
    setPosition(cue.start_seconds)
    setTitle(String(spec.title ?? 'Release teaser'))
    setDirection(String(spec.narrative_purpose ?? ''))
    setLook(looks.find(v => v === cue.creative_look) ?? 'cinematic')
    setAspect(aspects.find(v => v === spec.aspect_ratio) ?? '9:16')
    setVisualId(String(spec.first_frame_asset || (Array.isArray(spec.reference_video_assets) ? spec.reference_video_assets[0] ?? '' : '')))
  }

  const submit = async () => {
    if (!valid || !selected) return
    setBusy(true); setError(null); setSaved(null)
    try {
      const result = await api.quickCreate(projectId, {
        title: title.trim(), creativeDirection: direction.trim(),
        audioAssetId: selected.id, visualAssetId: visualId || null,
        startSeconds: start, endSeconds: end, aspectRatio: aspect, look,
        promotionalUseAttested: true, ...(editing ? { shotId: editing } : {}),
      })
      setEditing(result.shotId)
      setSaved(result.shotId)
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
        <label className="mcq-consent"><input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} /> I confirm the selected media is authorized for this promotional creative draft.</label>
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="button-row"><button type="button" className="primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? 'Saving…' : editing ? 'Save new draft version' : 'Save Quick Create draft'}</button></div>
        {saved && <Callout tone="ok">Draft saved. No render or audio mix has occurred. <button type="button" onClick={() => navigate(`/shot/${saved}`)}>Open professional Shot Builder</button></Callout>}
      </>}</AsyncBlock>
    </Card>
    <Card title="Saved music-first drafts">
      <AsyncBlock state={shots}>{data => {
        const drafts = data.shots.filter(shot => Boolean((shot.spec as Record<string, unknown> | undefined)?.music_cue))
        return drafts.length ? <div className="mcq-saved">{drafts.map(shot => <div key={shot.id} className="mcq-saved-row"><span>{shot.title}</span><button type="button" onClick={() => restore(shot.id, shot.spec as Record<string, unknown>)}>Edit song moment</button><button type="button" onClick={() => navigate(`/shot/${shot.id}`)}>Advanced editor</button></div>)}</div> : <p className="muted">No song-moment drafts yet.</p>
      }}</AsyncBlock>
    </Card>
  </div>
}
