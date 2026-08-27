import React from 'react'
import { LocalStorageSnapshotStore, type PerformanceSnapshot } from '@masterclip/live-engine'
import type { MidiMapping } from '@masterclip/performance-project'
import { navigate } from '../App.jsx'
import { AsyncBlock, useAsync } from '../ui.jsx'
import { liveApi } from './api.js'
import { loadShowBundle, useLiveEngine, useMidi } from './engine.js'
import { PadGrid, StemDeckPanel } from './components.jsx'

const snapshotStore = new LocalStorageSnapshotStore()

/** Matches the server's per-request cap (see the events route). */
const EVENT_BATCH_LIMIT = 500
/** Oldest events are dropped past this so a long outage cannot grow forever. */
const EVENT_BUFFER_LIMIT = 5000

/**
 * Performance Mode — the stage surface.
 *
 * Local-first by construction: audio comes from the cached performance
 * package, never the network. The cloud banner reports connectivity, but a
 * dropped connection changes nothing about playback. Locking prevents
 * accidental edits and navigation mid-show.
 */
export function LivePerformance({ projectId }: { projectId: string }) {
  const bundle = useAsync(() => loadShowBundle(projectId), [projectId])
  const live = useLiveEngine(bundle.data, 'cache')
  const [locked, setLocked] = React.useState(false)
  const [online, setOnline] = React.useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [restoreOffer, setRestoreOffer] = React.useState<PerformanceSnapshot | null>(null)
  const eventsRef = React.useRef<Array<{ eventType: string; payload: Record<string, unknown>; localTimestamp: string }>>([])

  React.useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  // Crash recovery: offer, never auto-restore, never auto-play.
  React.useEffect(() => {
    void snapshotStore.load(projectId).then((snapshot) => {
      if (snapshot) setRestoreOffer(snapshot)
    })
  }, [projectId])

  const saveSnapshot = React.useCallback(
    () =>
      snapshotStore.save({
        snapshotVersion: 1,
        projectId,
        packageVersion: bundle.data?.packages[0]?.version ?? null,
        savedAt: new Date().toISOString(),
        currentItemId: live.engine.currentItem?.id ?? null,
        currentSceneId: live.engine.currentSceneId,
        setPosition: 0,
        bpm: live.engine.effectiveBpm,
        clickEnabled: live.engine.isClickEnabled,
        locked,
        stems: live.engine.stems.list().map((s) => ({ id: s.id, gain: s.gain, pan: s.pan, muted: s.muted, solo: s.solo })),
        outputs: [],
        midiDeviceIds: [],
      }),
    [live.engine, projectId, locked, bundle.data],
  )

  // Persist state + record analytics on every engine event.
  React.useEffect(() => {
    const unsubscribe = live.engine.on((event) => {
      const record = (eventType: string, payload: Record<string, unknown>) => {
        eventsRef.current.push({ eventType, payload, localTimestamp: new Date().toISOString() })
        // Capped here rather than only after a failed sync: syncAnalytics
        // returns early while offline, so the cap in its catch never ran
        // during exactly the long offline show it was written for. The oldest
        // events go first — the end of a set is what anyone looks at.
        if (eventsRef.current.length > EVENT_BUFFER_LIMIT) {
          eventsRef.current.splice(0, eventsRef.current.length - EVENT_BUFFER_LIMIT)
        }
      }
      if (event.type === 'scene_launched') record('scene_launched', { sceneId: event.sceneId })
      if (event.type === 'pad_triggered') record('pad_triggered', { index: event.index, mode: event.mode })
      if (event.type === 'song_changed') record('song_started', { itemId: event.itemId })
      if (event.type === 'started') record('set_started', {})
      if (event.type === 'stopped') record('set_ended', {})
      if (event.type === 'error') record('error', { message: event.message })

      void saveSnapshot()
    })
    return unsubscribe
  }, [live.engine, projectId, saveSnapshot])

  // Locking is a decision, not an audio event, so it never reached the
  // snapshot: the saved flag was whatever it had been at the last *sound*.
  // A performer who locked before doors and then crashed came back unlocked —
  // the accidental-navigation risk locking exists to remove, at the moment
  // they are least able to notice it.
  React.useEffect(() => {
    void saveSnapshot()
  }, [locked, saveSnapshot])

  const midi = useMidi(bundle.data?.mappings ?? [], (hit) => {
    void live.arm().then(() => dispatchMidi(live.engine, bundle.data?.project.padMap.length ?? 0, hit))
  })

  const syncAnalytics = React.useCallback(() => {
    if (!online || eventsRef.current.length === 0) return
    // The server accepts at most 500 events per request. A long offline show
    // used to exceed that and then wedge: every retry 400ed and pushed the
    // same oversized batch back. One capped chunk per tick drains instead.
    const batch = eventsRef.current.splice(0, Math.min(EVENT_BATCH_LIMIT, eventsRef.current.length))
    liveApi.syncEvents(projectId, batch).catch(() => {
      // Offline or refused: put them back for the next attempt, bounded so a
      // long outage cannot grow the buffer without limit. The show does not
      // care either way — analytics never block playback.
      eventsRef.current.unshift(...batch)
      if (eventsRef.current.length > EVENT_BUFFER_LIMIT) {
        eventsRef.current.splice(0, eventsRef.current.length - EVENT_BUFFER_LIMIT)
      }
    })
  }, [online, projectId])

  React.useEffect(() => {
    const timer = window.setInterval(syncAnalytics, 15000)
    return () => window.clearInterval(timer)
  }, [syncAnalytics])

  const restore = async () => {
    if (!restoreOffer) return
    // Restores mixer/positional state only. Audio stays silent until the
    // performer triggers something — sound after a crash must be deliberate.
    // The engine holds the recovered levels so they survive the first song
    // change rather than being overwritten by the stored defaults.
    live.engine.restoreStemStates(restoreOffer.stems)
    // Position first, so the stems the deck loads are the ones for the song
    // the performer was actually on. selectSong makes no sound — the comment
    // above promised positional restore and only the mixer was coming back,
    // so after a mid-set crash NEXT SONG jumped to the second song.
    if (restoreOffer.currentItemId) live.engine.selectSong(restoreOffer.currentItemId)
    live.engine.setClickEnabled(restoreOffer.clickEnabled)
    // Locked comes back too. The snapshot has always recorded it and the
    // runbook has always promised it, but nothing applied it — so a performer
    // who locked the surface came back from a crash with it unlocked, which is
    // the accidental-navigation risk locking exists to remove, at the moment
    // they are least able to notice. Unlocking stays one explicit tap away.
    setLocked(restoreOffer.locked)
    eventsRef.current.push({ eventType: 'crash_recovered', payload: {}, localTimestamp: new Date().toISOString() })
    setRestoreOffer(null)
  }

  return (
    <AsyncBlock state={bundle}>
      {(data) => {
        const items = [...data.items].sort((a, b) => a.sortOrder - b.sortOrder)
        const current = items.find((i) => i.id === live.snapshot.currentItemId) ?? null
        const nextIndex = current ? items.findIndex((i) => i.id === current.id) + 1 : 0
        const next = nextIndex < items.length ? items[nextIndex] : null
        const currentScene = data.scenes.find((s) => s.id === live.snapshot.currentSceneId) ?? null
        const pkg = data.packages[0] ?? null
        const cacheReady = pkg?.status === 'ready'

        return (
          <div className="performance">
            {!online && (
              <div className="cloud-offline">
                CLOUD OFFLINE — LIVE PLAYBACK UNAFFECTED — AI GENERATION PAUSED
              </div>
            )}
            {restoreOffer && (
              <div className="restore-banner">
                <span>
                  A previous performance state from {new Date(restoreOffer.savedAt).toLocaleTimeString()} was found. Audio will not restart
                  automatically.
                </span>
                <button className="primary" onClick={() => void restore()}>
                  RESTORE PERFORMANCE
                </button>
                <button
                  onClick={() => {
                    live.engine.clearRestoredStemStates()
                    void snapshotStore.clear(projectId)
                    setRestoreOffer(null)
                  }}
                >
                  Discard
                </button>
              </div>
            )}

            <div className="perf-status">
              <div className="perf-song">
                <div className="perf-label">NOW</div>
                <div className="perf-value">{current?.title ?? '—'}</div>
                <div className="perf-scene">{currentScene ? currentScene.name : ''}</div>
              </div>
              <div className="perf-song">
                <div className="perf-label">NEXT</div>
                <div className="perf-value dim">{next?.title ?? 'end of set'}</div>
              </div>
              <div className="perf-clock mono">
                <div className="perf-position">{live.snapshot.playing ? `${live.snapshot.bar}.${live.snapshot.beat}` : '—.—'}</div>
                <div className="perf-bpm">{Math.round(live.snapshot.bpm)} BPM</div>
              </div>
              <div className="perf-indicators">
                <Indicator ok={cacheReady} label={pkg ? `CACHE ${pkg.status.toUpperCase()}` : 'NO PACKAGE'} />
                <Indicator ok={midi.devices.some((d) => d.connected)} label={midi.supported ? 'MIDI' : 'MIDI N/A'} />
                <Indicator ok={live.audioReady} label="AUDIO" />
                <Indicator ok={live.snapshot.clickEnabled} label="CLICK" neutral />
                <Indicator ok={online} label={online ? 'CLOUD' : 'OFFLINE'} neutral />
              </div>
            </div>

            <div className="perf-main">
              <div className="perf-pads">
                <PadGrid
                  large
                  padMap={data.project.padMap}
                  padStates={live.snapshot.padStates}
                  onTrigger={(index) => void live.arm().then(() => live.engine.triggerPad(index))}
                />
              </div>
              <div className="perf-side">
                <StemDeckPanel
                  snapshot={live.snapshot}
                  onMute={(id) => live.engine.setStemMuted(id, !(live.engine.stems.get(id)?.muted ?? false))}
                  onSolo={(id) => live.engine.setStemSolo(id, !(live.engine.stems.get(id)?.solo ?? false))}
                  onGain={(id, gain) => live.engine.setStemGain(id, gain)}
                  onPan={(id, pan) => live.engine.setStemPan(id, pan)}
                />
              </div>
            </div>

            <div className="perf-footer">
              <button
                className="perf-stop"
                onClick={() => {
                  live.engine.stopAll()
                  syncAnalytics()
                }}
              >
                ■ EMERGENCY STOP
              </button>
              <div className="button-row">
                <button onClick={() => void live.arm().then(() => live.engine.prevSong())}>◀ PREV SONG</button>
                <button onClick={() => void live.arm().then(() => live.engine.nextSong())}>NEXT SONG ▶</button>
                <button className={live.snapshot.clickEnabled ? 'ok' : ''} onClick={() => live.engine.setClickEnabled(!live.snapshot.clickEnabled)}>
                  CLICK
                </button>
              </div>
              <div className="button-row">
                <button className={locked ? 'danger' : ''} onClick={() => setLocked(!locked)}>
                  {locked ? '🔒 LOCKED' : 'LOCK PERFORMANCE'}
                </button>
                <button
                  disabled={locked}
                  title={locked ? 'unlock to leave performance mode' : undefined}
                  onClick={() => {
                    if (!locked) navigate(`/live-lab/projects/${projectId}`)
                  }}
                >
                  Exit
                </button>
              </div>
            </div>

            {!cacheReady && (
              <div className="perf-warning">
                Show package is {pkg ? pkg.status.toUpperCase() : 'NOT READY'} — build and verify the performance package in the workspace
                before going on stage. Pads with uncached audio show ERROR.
              </div>
            )}
          </div>
        )
      }}
    </AsyncBlock>
  )
}

function Indicator({ ok, label, neutral }: { ok: boolean; label: string; neutral?: boolean }) {
  return <span className={`indicator ${ok ? 'on' : neutral ? 'off' : 'bad'}`}>{label}</span>
}

function dispatchMidi(
  engine: ReturnType<typeof useLiveEngine>['engine'],
  _padCount: number,
  hit: { targetType: MidiMapping['targetType']; targetId: string | null; value: number; pressed: boolean },
): void {
  switch (hit.targetType) {
    case 'pad':
      if (hit.pressed && hit.targetId?.startsWith('pad:')) engine.triggerPad(Number(hit.targetId.slice(4)))
      break
    case 'scene':
      if (hit.pressed && hit.targetId) engine.triggerScene(hit.targetId)
      break
    case 'stem_mute':
      if (hit.pressed && hit.targetId) engine.setStemMuted(hit.targetId, !(engine.stems.get(hit.targetId)?.muted ?? false))
      break
    case 'stem_solo':
      if (hit.pressed && hit.targetId) engine.setStemSolo(hit.targetId, !(engine.stems.get(hit.targetId)?.solo ?? false))
      break
    case 'stem_volume':
      if (hit.targetId) engine.setStemGain(hit.targetId, hit.value / 127)
      break
    case 'master_volume':
      engine.setMasterGain(hit.value / 127)
      break
    case 'next_song':
      if (hit.pressed) engine.nextSong()
      break
    case 'prev_song':
      if (hit.pressed) engine.prevSong()
      break
    case 'stop':
      if (hit.pressed) engine.stopAll()
      break
    case 'click':
      if (hit.pressed) engine.setClickEnabled(!engine.isClickEnabled)
      break
    case 'cue':
    case 'macro':
      break
  }
}

export { dispatchMidi }
