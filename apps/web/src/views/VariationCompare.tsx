import React from 'react'
import { api, type Shot } from '../api.js'
import { AsyncBlock, Badge, Card, Empty, Field, useAsync } from '../ui.jsx'
import { navigate } from '../App.jsx'
import { areRelatedVariants, variationRoot } from './variant-model.js'
import { WHY } from '../why-notes.js'

type Side = 'left' | 'right'

function RenderedSide({
  shot, side, register,
}: {
  shot: Shot
  side: Side
  register: (side: Side, video: HTMLVideoElement | null) => void
}) {
  const outputs = useAsync(() => api.outputs(shot.id), [shot.id])
  const [chosen, setChosen] = React.useState('')
  const candidates = outputs.data?.outputs ?? []
  const selected = candidates.find(output => output.id === chosen) ?? candidates[0] ?? null
  const movie = selected?.urls.proxy ?? selected?.urls.source ?? null
  const qc = (selected?.qcDetail ?? {}) as Record<string, unknown>

  return <section className="mcq-comparison-side">
    <h4>{shot.title}</h4>
    <p className="faint">Shot {shot.shotKey}</p>
    <AsyncBlock state={outputs}>{data => data.outputs.length === 0
      ? <Empty>No rendered candidates for this shot. Create a render in its Shot Builder before comparing.</Empty>
      : <>
          <Field label="Actual rendered candidate">
            <select value={selected?.id ?? ''} onChange={event => setChosen(event.target.value)}>
              {data.outputs.map((output, index) =>
                <option key={output.id} value={output.id}>Candidate {index + 1} — {output.providerId}/{output.modelId} ({output.status})</option>)}
            </select>
          </Field>
          {selected && <>
            {movie
              ? <video key={selected.id} ref={element => register(side, element)} src={movie}
                  controls playsInline muted preload="metadata"
                  poster={selected.urls.thumbnail ?? undefined}
                  aria-label={`Actual rendered video for ${shot.title}`} />
              : <p className="muted">This candidate has no available video URL. No preview is simulated.</p>}
            <dl className="mcq-comparison-facts">
              <div><dt>Result</dt><dd>{selected.status}</dd></div>
              <div><dt>Review</dt><dd>{selected.review?.decision ?? 'not reviewed'}</dd></div>
              <div><dt>Provider</dt><dd>{selected.providerId}/{selected.modelId}</dd></div>
              <div><dt>Duration</dt><dd>{selected.durationSeconds !== null ? selected.durationSeconds.toFixed(2) + 's' : 'unavailable'}</dd></div>
              <div><dt>Format</dt><dd>{selected.width && selected.height ? `${selected.width}×${selected.height}` : 'unavailable'}</dd></div>
              <div><dt>Actual cost</dt><dd>{selected.actualUsd || 'unavailable'}</dd></div>
              <div><dt>QC action</dt><dd>{String(qc.recommended_action ?? 'not available')}</dd></div>
            </dl>
            <p className="faint">These values describe only this actual render. A comparison is not an automatic quality verdict.</p>
            <button type="button" onClick={() => navigate(`/shot/${shot.id}/review`)}>Open human Review Grid</button>
          </>}
        </>}
    </AsyncBlock>
  </section>
}

/** Compares outputs across two source-linked shots, rather than duplicating
 * the existing Review Grid's same-shot candidate comparison.
 */
export function VariationCompare({ projectId }: { projectId: string }) {
  const shots = useAsync(() => api.shots(projectId), [projectId])
  const [leftId, setLeftId] = React.useState('')
  const [rightId, setRightId] = React.useState('')
  const videos = React.useRef<Partial<Record<Side, HTMLVideoElement>>>({})
  const all = shots.data?.shots ?? []
  const creative = all.filter(shot => Boolean((shot.spec as Record<string, unknown> | undefined)?.music_cue))
  const roots = new Set(creative.map(shot => variationRoot(shot.id, creative)))
  const left = creative.find(shot => shot.id === leftId)
  const right = creative.find(shot => shot.id === rightId)
  const options = left ? creative.filter(shot => areRelatedVariants(left.id, shot.id, creative)) : []
  const linked = left && right && areRelatedVariants(left.id, right.id, creative)

  const register = (side: Side, node: HTMLVideoElement | null) => {
    if (node) videos.current[side] = node
    else delete videos.current[side]
  }
  const eachVideo = (action: (video: HTMLVideoElement) => void) => {
    for (const video of Object.values(videos.current)) if (video) action(video)
  }

  return <Card title="Compare creative variations" why={WHY.compare}>
    <p className="muted">Compare actual renders of a shot and its saved creative alternatives. This view does not submit render jobs or choose a winner.</p>
    <AsyncBlock state={shots}>{() => creative.length < 2 || roots.size === creative.length
      ? <Empty>No source-linked variation pair is available. Create alternatives in Quick Create, render both shots, then compare their real outputs.</Empty>
      : <>
          <div className="field-row">
            <Field label="Primary treatment">
              <select value={leftId} onChange={event => { setLeftId(event.target.value); setRightId(''); videos.current = {} }}>
                <option value="">Choose a music shot</option>
                {creative.map(shot => <option key={shot.id} value={shot.id}>{shot.title}</option>)}
              </select>
            </Field>
            <Field label="Related alternative">
              <select value={rightId} disabled={!left} onChange={event => { setRightId(event.target.value); videos.current = {} }}>
                <option value="">Choose a related variant</option>
                {options.map(shot => <option key={shot.id} value={shot.id}>{shot.title}</option>)}
              </select>
            </Field>
          </div>
          {linked && left && right && <>
            <div className="button-row mcq-comparison-transport">
              <button type="button" onClick={() => eachVideo(video => { video.currentTime = 0; void video.play().catch(() => undefined) })}>Play both</button>
              <button type="button" onClick={() => eachVideo(video => video.pause())}>Pause both</button>
              <button type="button" onClick={() => eachVideo(video => { video.pause(); video.currentTime = 0 })}>Restart both</button>
              <Badge tone="info">Real video only</Badge>
            </div>
            <div className="mcq-comparison-grid">
              <RenderedSide key={left.id} shot={left} side="left" register={register} />
              <RenderedSide key={right.id} shot={right} side="right" register={register} />
            </div>
          </>}
        </>}
    </AsyncBlock>
  </Card>
}
