import React from 'react'
import type { LiveScene, PadAssignment } from '@masterclip/performance-project'
import { navigate } from '../App.jsx'
import { AsyncBlock, Badge, Callout, Card, Empty, Field, useAsync } from '../ui.jsx'
import { liveApi, type LiveProjectBundle, type SetSuggestion } from './api.js'
import { cacheShow, useLiveEngine, type CacheProgress } from './engine.js'
import { PadGrid, StemDeckPanel, TransportBar } from './components.jsx'

const SCENE_TYPES = ['intro', 'verse', 'pre_chorus', 'chorus', 'break', 'build', 'drop', 'bridge', 'interlude', 'outro', 'custom'] as const
const QUANTIZATIONS = ['none', '1/4', '1/2', '1bar', '2bars', '4bars', 'scene_end'] as const
const ITEM_TYPES = ['song', 'interlude', 'walk_on', 'encore', 'outro'] as const

/**
 * The Live Lab project workspace: SETLIST · SCENES · PAD GRID · STEM DECK ·
 * AI SCENE BUILDER. Deliberately not a DAW — this is show construction.
 */
export function LiveProject({ projectId }: { projectId: string }) {
  const bundle = useAsync(() => liveApi.project(projectId), [projectId])
  const [selectedItemId, setSelectedItemId] = React.useState<string | null>(null)
  const [cacheProgress, setCacheProgress] = React.useState<CacheProgress | null>(null)

  // Poll while an AI job is cooking so NEW SCENE READY appears on its own.
  const hasActiveJob = bundle.data?.aiJobs.some((job) => job.status === 'queued' || job.status === 'generating') ?? false
  React.useEffect(() => {
    if (!hasActiveJob) return
    const poll = window.setInterval(() => bundle.reload(), 2500)
    return () => window.clearInterval(poll)
  }, [hasActiveJob, bundle.reload])

  const live = useLiveEngine(bundle.data, 'cloud')

  const items = React.useMemo(() => [...(bundle.data?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder), [bundle.data])
  const selectedItem = items.find((i) => i.id === selectedItemId) ?? items[0] ?? null

  const buildPackage = async () => {
    await cacheShow(projectId, setCacheProgress)
    bundle.reload()
  }

  const exportStageControl = async () => {
    const { handoff } = await liveApi.stageControl(projectId)
    const blob = new Blob([JSON.stringify(handoff, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `stage-control-${projectId}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <AsyncBlock state={bundle}>
      {(data) => {
        const latestPackage = data.packages[0] ?? null
        return (
          <div className="live-workspace">
            <div className="topbar">
              <div>
                <h2>{data.project.name}</h2>
                <div className="meta">
                  {data.project.masterTempo} BPM · {data.project.timeSignature} · {items.length} items ·{' '}
                  {latestPackage ? (
                    <Badge tone={latestPackage.status === 'ready' ? 'ok' : latestPackage.status === 'error' ? 'danger' : 'warn'}>
                      package v{latestPackage.version} {latestPackage.status.toUpperCase()}
                    </Badge>
                  ) : (
                    <Badge>NOT READY</Badge>
                  )}
                </div>
              </div>
              <div className="button-row">
                <button className="small" onClick={() => navigate(`/live-lab/projects/${projectId}/midi`)}>
                  MIDI
                </button>
                <button className="small" onClick={() => void exportStageControl()}>
                  Stage Control export
                </button>
                <button className="small" onClick={() => void buildPackage()}>
                  Build show package
                </button>
                <button className="primary" onClick={() => navigate(`/live-lab/projects/${projectId}/performance`)}>
                  ▶ Performance Mode
                </button>
              </div>
            </div>

            {cacheProgress && cacheProgress.phase !== 'idle' && (
              <Callout tone={cacheProgress.phase === 'error' ? 'danger' : cacheProgress.phase === 'ready' ? 'ok' : 'info'}>
                <strong>{cacheProgress.phase.toUpperCase()}</strong> {cacheProgress.message}
              </Callout>
            )}
            {live.loadError && <Callout tone="warn">Audio load: {live.loadError}</Callout>}

            <TransportBar
              snapshot={live.snapshot}
              songTitle={items.find((i) => i.id === live.snapshot.currentItemId)?.title ?? null}
              nextTitle={nextTitleAfter(items, live.snapshot.currentItemId)}
              onStop={() => live.engine.stopAll()}
              onNext={() => void live.arm().then(() => live.engine.nextSong())}
              onPrev={() => void live.arm().then(() => live.engine.prevSong())}
              onToggleClick={() => live.engine.setClickEnabled(!live.snapshot.clickEnabled)}
            />

            <div className="live-columns">
              <Setlist
                data={data}
                items={items}
                selectedItemId={selectedItem?.id ?? null}
                onSelect={setSelectedItemId}
                onChanged={bundle.reload}
              />
              <div className="live-center">
                <Card title="Pad grid" action={<span className="faint" style={{ fontSize: 11 }}>click = trigger · right-click = assign selected scene</span>}>
                  <PadEditor data={data} live={live} onChanged={bundle.reload} selectedItemId={selectedItem?.id ?? null} />
                </Card>
                <Card title={`Scenes — ${selectedItem?.title ?? 'no song selected'}`}>
                  {selectedItem ? (
                    <SceneEditor data={data} itemId={selectedItem.id} live={live} onChanged={bundle.reload} />
                  ) : (
                    <Empty>Add a song to the setlist first.</Empty>
                  )}
                </Card>
                <Card title="Stem deck">
                  {selectedItem ? <StemEditor data={data} itemId={selectedItem.id} live={live} onChanged={bundle.reload} /> : <Empty>—</Empty>}
                </Card>
              </div>
              <AiSceneBuilder data={data} selectedItemId={selectedItem?.id ?? null} onChanged={bundle.reload} />
            </div>
          </div>
        )
      }}
    </AsyncBlock>
  )
}

function nextTitleAfter(items: LiveProjectBundle['items'], currentId: string | null): string | null {
  if (!currentId) return null
  const index = items.findIndex((i) => i.id === currentId)
  return index >= 0 && index + 1 < items.length ? items[index + 1]!.title : null
}

// ------------------------------------------------------------------ setlist ----

function Setlist({
  data,
  items,
  selectedItemId,
  onSelect,
  onChanged,
}: {
  data: LiveProjectBundle
  items: LiveProjectBundle['items']
  selectedItemId: string | null
  onSelect: (id: string) => void
  onChanged: () => void
}) {
  const [title, setTitle] = React.useState('')
  const [type, setType] = React.useState<string>('song')

  const move = async (id: string, direction: -1 | 1) => {
    const index = items.findIndex((i) => i.id === id)
    const target = index + direction
    if (target < 0 || target >= items.length) return
    const order = items.map((i) => i.id)
    ;[order[index], order[target]] = [order[target]!, order[index]!]
    await liveApi.reorder(data.project.id, order)
    onChanged()
  }

  const add = async () => {
    if (!title.trim()) return
    await liveApi.createItem(data.project.id, { type, title: title.trim().toUpperCase() })
    setTitle('')
    onChanged()
  }

  return (
    <div className="live-setlist">
      <Card title="Setlist">
        {items.length === 0 && <Empty>Empty set.</Empty>}
        <ol className="setlist">
          {items.map((item, index) => {
            const stems = data.stems.filter((s) => s.liveSetItemId === item.id)
            const scenes = data.scenes.filter((s) => s.liveSetItemId === item.id)
            return (
              <li key={item.id} className={item.id === selectedItemId ? 'active' : ''} onClick={() => onSelect(item.id)}>
                <span className="setlist-num mono">{String(index + 1).padStart(2, '0')}</span>
                <span className="setlist-title">
                  {item.title}
                  <span className="faint setlist-meta">
                    {item.type !== 'song' ? `${item.type} · ` : ''}
                    {item.bpm ? `${item.bpm} BPM · ` : ''}
                    {item.key ? `${item.key} · ` : ''}
                    {scenes.length} scenes · {stems.length} stems
                  </span>
                </span>
                <span className="setlist-actions">
                  <button className="small" onClick={(e) => (e.stopPropagation(), void move(item.id, -1))} title="move up">
                    ↑
                  </button>
                  <button className="small" onClick={(e) => (e.stopPropagation(), void move(item.id, 1))} title="move down">
                    ↓
                  </button>
                  <button
                    className="small danger"
                    onClick={(e) => (e.stopPropagation(), void liveApi.deleteItem(item.id).then(onChanged))}
                    title="remove"
                  >
                    ×
                  </button>
                </span>
              </li>
            )
          })}
        </ol>
        <div className="field-row" style={{ marginTop: 10 }}>
          <Field label="Add item">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title" />
          </Field>
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <button className="small primary" onClick={() => void add()}>
          Add to set
        </button>
      </Card>
      <SetBuilderPanel projectId={data.project.id} onChanged={onChanged} />
    </div>
  )
}

/**
 * BUILD MY LIVE SET: server-computed suggestions (walk-on, interlude, encore,
 * outro, click tracks, default pad map). Every one requires explicit approval;
 * applying adds placeholder material and never touches existing items.
 */
function SetBuilderPanel({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [suggestions, setSuggestions] = React.useState<SetSuggestion[] | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      const plan = await liveApi.buildSetPlan(projectId)
      setSuggestions(plan.suggestions)
      setSelected(new Set(plan.suggestions.filter((s) => s.kind !== 'needs_bpm').map((s) => s.id)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      await liveApi.applySetPlan(projectId, [...selected])
      setSuggestions(null)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Build my live set">
      {suggestions === null ? (
        <>
          <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
            Suggest walk-on, interlude, encore, outro, click tracks and a pad mapping for this set. Nothing is added without your approval.
          </div>
          <button className="small" disabled={busy} onClick={() => void load()}>
            {busy ? 'analyzing…' : 'Suggest additions'}
          </button>
        </>
      ) : suggestions.length === 0 ? (
        <Empty>Nothing to suggest — the set already has its structure, clicks and pads.</Empty>
      ) : (
        <>
          {suggestions.map((suggestion) => (
            <label key={suggestion.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, fontSize: 12 }}>
              {suggestion.kind === 'needs_bpm' ? (
                <Badge tone="warn">info</Badge>
              ) : (
                <input
                  type="checkbox"
                  style={{ width: 'auto', marginTop: 2 }}
                  checked={selected.has(suggestion.id)}
                  onChange={(e) => {
                    const next = new Set(selected)
                    if (e.target.checked) next.add(suggestion.id)
                    else next.delete(suggestion.id)
                    setSelected(next)
                  }}
                />
              )}
              <span>
                <strong>{suggestion.title}</strong>
                <span className="faint" style={{ display: 'block' }}>
                  {suggestion.description}
                </span>
              </span>
            </label>
          ))}
          <div className="button-row">
            <button className="small primary" disabled={busy || selected.size === 0} onClick={() => void apply()}>
              {busy ? 'applying…' : `Apply ${selected.size} approved`}
            </button>
            <button className="small" onClick={() => setSuggestions(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
    </Card>
  )
}

// -------------------------------------------------------------------- pads ----

function PadEditor({
  data,
  live,
  onChanged,
  selectedItemId,
}: {
  data: LiveProjectBundle
  live: ReturnType<typeof useLiveEngine>
  onChanged: () => void
  selectedItemId: string | null
}) {
  const [assignSceneId, setAssignSceneId] = React.useState<string>('')
  const scenes = data.scenes.filter((s) => !selectedItemId || s.liveSetItemId === selectedItemId)

  const assign = async (index: number) => {
    const padMap: PadAssignment[] = data.project.padMap.map((p) => ({ ...p }))
    const scene = data.scenes.find((s) => s.id === assignSceneId)
    padMap[index] = scene
      ? { index, mode: 'scene', label: scene.name.slice(0, 12), targetId: scene.id, color: scene.color }
      : { index, mode: 'empty', label: '', targetId: null, color: '' }
    await liveApi.updatePads(data.project.id, padMap)
    onChanged()
  }

  return (
    <div>
      <div className="button-row" style={{ marginBottom: 8 }}>
        <select value={assignSceneId} onChange={(e) => setAssignSceneId(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">assign: clear pad</option>
          {scenes.map((scene) => (
            <option key={scene.id} value={scene.id}>
              {data.items.find((i) => i.id === scene.liveSetItemId)?.title} — {scene.name}
            </option>
          ))}
        </select>
        <span className="faint" style={{ fontSize: 11 }}>
          audio {live.loadedAssets}/{live.totalAssets} loaded
        </span>
      </div>
      <PadGrid
        padMap={data.project.padMap}
        padStates={live.snapshot.padStates}
        onTrigger={(index) => void live.arm().then(() => live.engine.triggerPad(index))}
        onSelect={(index) => void assign(index)}
      />
    </div>
  )
}

// ------------------------------------------------------------------- scenes ----

function SceneEditor({
  data,
  itemId,
  live,
  onChanged,
}: {
  data: LiveProjectBundle
  itemId: string
  live: ReturnType<typeof useLiveEngine>
  onChanged: () => void
}) {
  const scenes = data.scenes.filter((s) => s.liveSetItemId === itemId).sort((a, b) => a.sortOrder - b.sortOrder)
  const [name, setName] = React.useState('')
  const [sceneType, setSceneType] = React.useState<string>('custom')
  const [clipAssetId, setClipAssetId] = React.useState('')

  const add = async () => {
    if (!name.trim()) return
    await liveApi.createScene(data.project.id, {
      liveSetItemId: itemId,
      name: name.trim().toUpperCase(),
      sceneType,
      ...(clipAssetId ? { clipAssetId } : {}),
    })
    setName('')
    onChanged()
  }

  const patchScene = async (scene: LiveScene, patch: Record<string, unknown>) => {
    await liveApi.updateScene(scene.id, patch)
    onChanged()
  }

  return (
    <div>
      {scenes.length === 0 && <Empty>No scenes yet — add one, or accept a generated option from the AI Scene Builder.</Empty>}
      {scenes.map((scene) => {
        const clips = data.clips.filter((c) => c.liveSceneId === scene.id)
        const state =
          live.snapshot.queuedSceneId === scene.id ? 'QUEUED' : live.snapshot.currentSceneId === scene.id ? 'PLAYING' : ''
        return (
          <div key={scene.id} className={`scene-row${state ? ` ${state.toLowerCase()}` : ''}`}>
            <button className="small primary" onClick={() => void live.arm().then(() => live.engine.triggerScene(scene.id))}>
              ▶
            </button>
            <span className="scene-name">
              {scene.name} {state && <Badge tone={state === 'QUEUED' ? 'warn' : 'ok'}>{state}</Badge>}
              <span className="faint scene-meta">
                {scene.sceneType} · {clips.length} clip{clips.length === 1 ? '' : 's'}
              </span>
            </span>
            <select value={scene.quantization} onChange={(e) => void patchScene(scene, { quantization: e.target.value })} title="launch quantization">
              {QUANTIZATIONS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
            <input
              className="scene-bars"
              value={scene.bars ?? ''}
              placeholder="bars"
              onChange={(e) => void patchScene(scene, { bars: e.target.value ? Number(e.target.value) : null })}
              title="length in bars"
            />
            <button
              className={`small${scene.loopEnabled ? ' ok' : ''}`}
              onClick={() => void patchScene(scene, { loopEnabled: !scene.loopEnabled })}
              title="loop"
            >
              loop
            </button>
            <select
              value={scene.followAction}
              onChange={(e) => void patchScene(scene, { followAction: e.target.value })}
              title="follow action at scene end"
            >
              {['stop', 'loop', 'next_scene', 'target'].map((f) => (
                <option key={f} value={f}>
                  {f.replace('_', ' ')}
                </option>
              ))}
            </select>
            <button className="small danger" onClick={() => void liveApi.deleteScene(scene.id).then(onChanged)}>
              ×
            </button>
          </div>
        )
      })}

      <div className="field-row" style={{ marginTop: 10 }}>
        <Field label="New scene">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DROP" />
        </Field>
        <Field label="Type">
          <select value={sceneType} onChange={(e) => setSceneType(e.target.value)}>
            {SCENE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Clip audio" hint="optional">
          <select value={clipAssetId} onChange={(e) => setClipAssetId(e.target.value)}>
            <option value="">none</option>
            {data.assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.filename}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <button className="small primary" onClick={() => void add()}>
        Add scene
      </button>
    </div>
  )
}

// -------------------------------------------------------------------- stems ----

function StemEditor({
  data,
  itemId,
  live,
  onChanged,
}: {
  data: LiveProjectBundle
  itemId: string
  live: ReturnType<typeof useLiveEngine>
  onChanged: () => void
}) {
  const stems = data.stems.filter((s) => s.liveSetItemId === itemId)
  const [stemType, setStemType] = React.useState('drums')
  const [assetId, setAssetId] = React.useState('')
  const [uploading, setUploading] = React.useState(false)
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const [rightsChecked, setRightsChecked] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const persistStem = async (stemId: string, patch: Record<string, unknown>) => {
    await liveApi.updateStem(stemId, patch)
    onChanged()
  }

  const addStem = async () => {
    if (!assetId) return
    await liveApi.createStem(data.project.id, { liveSetItemId: itemId, stemType, sourceAssetId: assetId })
    onChanged()
  }

  const upload = async (file: File) => {
    setUploading(true)
    setUploadError(null)
    try {
      const form = new FormData()
      form.set('file', file)
      form.set('rightsConfirmed', 'true')
      form.set('kind', 'stem')
      form.set('stemType', stemType)
      await liveApi.upload(data.project.id, form)
      onChanged()
    } catch (err) {
      setUploadError((err as Error).message)
    } finally {
      setUploading(false)
    }
  }

  // The engine's deck holds the *current song's* stems once it is started;
  // before that we render from the project data so mute/solo still edit state.
  const deckLoaded = live.snapshot.stems.length > 0 && live.snapshot.currentItemId === itemId

  return (
    <div>
      {deckLoaded ? (
        <StemDeckPanel
          snapshot={live.snapshot}
          onMute={(id) => {
            live.engine.setStemMuted(id, !(live.engine.stems.get(id)?.muted ?? false))
            void persistStem(id, { muted: live.engine.stems.get(id)?.muted ?? false })
          }}
          onSolo={(id) => {
            live.engine.setStemSolo(id, !(live.engine.stems.get(id)?.solo ?? false))
            void persistStem(id, { solo: live.engine.stems.get(id)?.solo ?? false })
          }}
          onGain={(id, gain) => {
            live.engine.setStemGain(id, gain)
            void liveApi.updateStem(id, { gain })
          }}
          onPan={(id, pan) => {
            live.engine.setStemPan(id, pan)
            void liveApi.updateStem(id, { pan })
          }}
        />
      ) : stems.length === 0 ? (
        <Empty>No stems for this song yet.</Empty>
      ) : (
        <div className="stem-deck">
          {stems.map((stem) => (
            <div key={stem.id} className={`stem${stem.muted ? ' muted' : ''}`}>
              <div className="stem-name">
                <span className="stem-type">{stem.stemType.toUpperCase()}</span>
              </div>
              <div className="stem-controls">
                <button className={`small${stem.muted ? ' danger' : ''}`} onClick={() => void persistStem(stem.id, { muted: !stem.muted })}>
                  M
                </button>
                <button className={`small${stem.solo ? ' ok' : ''}`} onClick={() => void persistStem(stem.id, { solo: !stem.solo })}>
                  S
                </button>
                <span className="faint" style={{ fontSize: 11 }}>
                  start the song to mix live
                </span>
                <button className="small danger" onClick={() => void liveApi.deleteStem(stem.id).then(onChanged)}>
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="field-row" style={{ marginTop: 12 }}>
        <Field label="Stem type">
          <select value={stemType} onChange={(e) => setStemType(e.target.value)}>
            {['vocal', 'drums', 'bass', 'music', 'fx', 'click', 'custom'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From existing audio">
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">choose asset…</option>
            {data.assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.filename}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="button-row">
        <button className="small" disabled={!assetId} onClick={() => void addStem()}>
          Attach stem
        </button>
        <label className="button-like">
          <input
            ref={fileRef}
            type="file"
            accept=".wav,.mp3,audio/wav,audio/mpeg"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file && rightsChecked) void upload(file)
              else if (file) setUploadError('Confirm rights before uploading.')
              e.target.value = ''
            }}
          />
          <button className="small" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? 'uploading…' : 'Upload owned audio'}
          </button>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }} className="muted">
          <input type="checkbox" style={{ width: 'auto' }} checked={rightsChecked} onChange={(e) => setRightsChecked(e.target.checked)} />
          I confirm that I own or control the audio I am uploading, or have authorization from the rights holder to use it.
        </label>
      </div>
      {uploadError && <Callout tone="danger">{uploadError}</Callout>}
    </div>
  )
}

// -------------------------------------------------------------- AI builder ----

function AiSceneBuilder({
  data,
  selectedItemId,
  onChanged,
}: {
  data: LiveProjectBundle
  selectedItemId: string | null
  onChanged: () => void
}) {
  const capabilities = useAsync(() => liveApi.capabilities(), [])
  const [prompt, setPrompt] = React.useState('')
  const [bars, setBars] = React.useState('8')
  const [energy, setEnergy] = React.useState('medium')
  const [tempoBehavior, setTempoBehavior] = React.useState('keep')
  const [instrumentation, setInstrumentation] = React.useState('')
  const [transition, setTransition] = React.useState('')
  const [sourceAssetId, setSourceAssetId] = React.useState('')
  const [rights, setRights] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const entitled = capabilities.data?.capabilities.includes('live_lab.ai_scene_builder') ?? true

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await liveApi.createAiScene(data.project.id, {
        liveSetItemId: selectedItemId,
        sourceAssetId: sourceAssetId || null,
        request: {
          prompt,
          bars: Number(bars) || 8,
          tempoBehavior,
          keyBehavior: 'keep',
          energy,
          instrumentation: instrumentation
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          intendedTransition: transition,
          rightsConfirmed: rights,
        },
      })
      setPrompt('')
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="live-ai">
      <Card title="AI Scene Builder">
        {!entitled && <Callout tone="warn">This organization is not entitled to the AI Scene Builder.</Callout>}
        <Field label="Describe the scene">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Create a 16-bar dark walk-on intro. Start sparse. Bring the drums in after eight bars."
          />
        </Field>
        <div className="field-row">
          <Field label="Bars">
            <input value={bars} onChange={(e) => setBars(e.target.value)} />
          </Field>
          <Field label="Energy">
            <select value={energy} onChange={(e) => setEnergy(e.target.value)}>
              {['sparse', 'low', 'medium', 'high', 'peak'].map((e2) => (
                <option key={e2}>{e2}</option>
              ))}
            </select>
          </Field>
          <Field label="Tempo">
            <select value={tempoBehavior} onChange={(e) => setTempoBehavior(e.target.value)}>
              <option value="keep">keep song tempo</option>
              <option value="half">half time</option>
              <option value="double">double time</option>
            </select>
          </Field>
        </div>
        <Field label="Instrumentation" hint="comma separated">
          <input value={instrumentation} onChange={(e) => setInstrumentation(e.target.value)} placeholder="drums, bass, pad" />
        </Field>
        <Field label="Intended transition">
          <input value={transition} onChange={(e) => setTransition(e.target.value)} placeholder="e.g. builds directly into the chorus" />
        </Field>
        <Field label="Source audio" hint="optional — owned material to reference">
          <select value={sourceAssetId} onChange={(e) => setSourceAssetId(e.target.value)}>
            <option value="">none</option>
            {data.assets
              .filter((a) => a.rightsConfirmed)
              .map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.filename}
                </option>
              ))}
          </select>
        </Field>
        <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11 }} className="muted">
          <input type="checkbox" style={{ width: 'auto' }} checked={rights} onChange={(e) => setRights(e.target.checked)} />
          <span>{capabilities.data?.rightsStatement ?? 'I confirm that I own or control the audio being processed.'}</span>
        </label>
        {error && <Callout tone="danger">{error}</Callout>}
        <div className="button-row" style={{ marginTop: 8 }}>
          <button className="primary" disabled={busy || !prompt.trim() || !rights || !entitled} onClick={() => void submit()}>
            {busy ? 'submitting…' : 'Generate scene'}
          </button>
        </div>
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
          Generation runs in the background — keep rehearsing. Nothing replaces live audio until you accept an option.
        </div>
      </Card>

      <Card title="Generated scenes">
        {data.aiJobs.length === 0 && <Empty>No generation jobs yet.</Empty>}
        {data.aiJobs.map((job) => (
          <AiJobRow key={job.id} jobId={job.id} status={job.status} prompt={job.prompt} selectedItemId={selectedItemId} onChanged={onChanged} />
        ))}
      </Card>
    </div>
  )
}

function AiJobRow({
  jobId,
  status,
  prompt,
  selectedItemId,
  onChanged,
}: {
  jobId: string
  status: string
  prompt: string
  selectedItemId: string | null
  onChanged: () => void
}) {
  const [expanded, setExpanded] = React.useState(false)
  const detail = useAsync(() => (expanded ? liveApi.aiJob(jobId) : Promise.resolve(null)), [jobId, expanded, status])
  const tone = status === 'ready' ? 'ok' : status === 'failed' ? 'danger' : status === 'accepted' ? 'accent' : 'warn'

  return (
    <div className="ai-job">
      <div className="ai-job-head" onClick={() => setExpanded(!expanded)}>
        <Badge tone={tone as 'ok'}>{status === 'ready' ? 'NEW SCENE READY' : status.toUpperCase()}</Badge>
        <span className="ai-job-prompt">{prompt}</span>
      </div>
      {expanded && detail.data && (
        <div className="ai-job-options">
          {detail.data.options.map(({ asset, url }) => (
            <div key={asset.id} className="ai-option">
              <strong>{String(asset.metadata.label ?? asset.filename)}</strong>
              <span className="faint"> {String(asset.metadata.description ?? '')}</span>
              <audio controls src={url} preload="none" />
              <div className="button-row">
                <button
                  className="small primary"
                  disabled={!selectedItemId}
                  onClick={() =>
                    void liveApi.acceptAiJob(jobId, { assetId: asset.id, mode: 'add_scene', liveSetItemId: selectedItemId }).then(onChanged)
                  }
                >
                  Add to song
                </button>
                <button className="small danger" onClick={() => void liveApi.rejectAiJob(jobId).then(onChanged)}>
                  Discard
                </button>
              </div>
            </div>
          ))}
          {detail.data.options.length === 0 && <div className="faint">no options yet</div>}
        </div>
      )}
    </div>
  )
}
