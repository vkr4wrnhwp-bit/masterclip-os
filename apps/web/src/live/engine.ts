import React from 'react'
import {
  LiveAudioEngine,
  WebAudioBackend,
  barBeat,
  type EngineEvent,
  type EngineProject,
} from '@masterclip/live-engine'
import {
  MidiLearn,
  MockMidiSource,
  WebMidiSource,
  matchMappings,
  type MappingCandidate,
  type MidiDeviceInfo,
  type MidiSource,
  type ParsedMidiMessage,
} from '@masterclip/midi-engine'
import { IndexedDbCacheStore, requestPersistentStorage, sha256HexOf } from '@masterclip/performance-cache'
import type { MidiMapping, PadState } from '@masterclip/performance-project'
import { liveApi, type LiveProjectBundle } from './api.js'

/**
 * React glue for the Live Engine.
 *
 * The engine and its AudioContext are module singletons: navigating between
 * the workspace and Performance Mode must not tear the audio graph down. The
 * views subscribe to a cheap snapshot refreshed on a UI interval — the audio
 * clock itself never depends on React.
 */

let shared: { backend: WebAudioBackend; engine: LiveAudioEngine } | null = null

/** Per-device audio preferences (sink, bus gains) — conveniences, never show-critical. */
export const AUDIO_PREFS = {
  sink: 'livelab.audio.sink',
  cueGain: 'livelab.audio.cue-gain',
  clickGain: 'livelab.audio.click-gain',
} as const

export function readAudioPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeAudioPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // best-effort
  }
}

function applyStoredAudioPrefs(backend: WebAudioBackend): void {
  const cue = Number(readAudioPref(AUDIO_PREFS.cueGain))
  if (Number.isFinite(cue) && cue > 0) backend.setBusGain('cue', cue)
  const click = Number(readAudioPref(AUDIO_PREFS.clickGain))
  if (Number.isFinite(click) && click > 0) backend.setBusGain('click', click)
  const sink = readAudioPref(AUDIO_PREFS.sink)
  if (sink) void backend.setOutputDevice(sink).catch(() => undefined)
}

export function getEngine(): { backend: WebAudioBackend; engine: LiveAudioEngine } {
  if (!shared) {
    const backend = new WebAudioBackend()
    applyStoredAudioPrefs(backend)
    shared = { backend, engine: new LiveAudioEngine(backend) }
  }
  return shared
}

export function bundleToEngineProject(bundle: LiveProjectBundle): EngineProject {
  return {
    projectId: bundle.project.id,
    masterTempo: bundle.project.masterTempo,
    timeSignature: bundle.project.timeSignature,
    items: bundle.items,
    scenes: bundle.scenes,
    clips: bundle.clips,
    stems: bundle.stems,
    padMap: bundle.project.padMap,
  }
}

export interface EngineSnapshot {
  playing: boolean
  currentItemId: string | null
  currentSceneId: string | null
  queuedSceneId: string | null
  bar: number
  beat: number
  bpm: number
  clickEnabled: boolean
  padStates: PadState[]
  stems: Array<{ id: string; label: string; stemType: string; gain: number; pan: number; muted: boolean; solo: boolean; level: number }>
}

export function snapshotOf(engine: LiveAudioEngine): EngineSnapshot {
  const position = barBeat(engine.beatNow(), engine.timeSignature)
  return {
    playing: engine.isPlaying,
    currentItemId: engine.currentItem?.id ?? null,
    currentSceneId: engine.currentSceneId,
    queuedSceneId: engine.queuedSceneId,
    bar: position.bar,
    beat: position.beat,
    bpm: engine.effectiveBpm,
    clickEnabled: engine.isClickEnabled,
    padStates: Array.from({ length: 16 }, (_, index) => engine.padState(index)),
    stems: engine.stems.list().map((s) => ({
      id: s.id,
      label: s.label,
      stemType: s.stemType,
      gain: s.gain,
      pan: s.pan,
      muted: s.muted,
      solo: s.solo,
      level: engine.stemLevel(s.id),
    })),
  }
}

export interface UseLiveEngineResult {
  engine: LiveAudioEngine
  backend: WebAudioBackend
  snapshot: EngineSnapshot
  audioReady: boolean
  loadedAssets: number
  totalAssets: number
  loadError: string | null
  /** Must be invoked from a user gesture before the first sound. */
  arm: () => Promise<void>
}

/**
 * Loads a project into the shared engine and keeps a UI snapshot fresh.
 *
 * `source: 'cloud'` fetches audio over signed URLs (the editing workspace);
 * `source: 'cache'` reads exclusively from the local performance package —
 * the mode a show runs in, where the network is allowed to not exist.
 */
export function useLiveEngine(bundle: LiveProjectBundle | null, source: 'cloud' | 'cache'): UseLiveEngineResult {
  const { backend, engine } = getEngine()
  const [snapshot, setSnapshot] = React.useState<EngineSnapshot>(() => snapshotOf(engine))
  const [loaded, setLoaded] = React.useState(0)
  const [total, setTotal] = React.useState(0)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [armed, setArmed] = React.useState(false)

  // Scheduler tick — cheap, and separate from the UI refresh below.
  React.useEffect(() => {
    const tick = window.setInterval(() => engine.tick(), 25)
    return () => window.clearInterval(tick)
  }, [engine])

  React.useEffect(() => {
    const refresh = window.setInterval(() => setSnapshot(snapshotOf(engine)), 120)
    const unsubscribe = engine.on(() => setSnapshot(snapshotOf(engine)))
    return () => {
      window.clearInterval(refresh)
      unsubscribe()
    }
  }, [engine])

  /**
   * Fingerprint of everything the engine actually schedules from. Lengths
   * alone were not enough: assigning a pad, renaming a scene, or changing
   * quantization keeps every count identical while changing what a trigger
   * does, which used to leave the engine running a stale project.
   */
  const structureKey = React.useMemo(() => {
    if (!bundle) return ''
    const project = bundleToEngineProject(bundle)
    return JSON.stringify([
      project.projectId,
      project.masterTempo,
      project.timeSignature,
      project.padMap.map((p) => [p.index, p.mode, p.targetId, p.label]),
      project.items.map((i) => [i.id, i.sortOrder, i.bpm, i.title, i.type]),
      project.scenes.map((s) => [s.id, s.liveSetItemId, s.sortOrder, s.name, s.bars, s.quantization, s.loopEnabled, s.followAction, s.followTargetSceneId, s.bpm]),
      project.clips.map((c) => [c.id, c.liveSceneId, c.sourceAssetId, c.startMs, c.endMs, c.loopStartMs, c.loopEndMs, c.oneShot, c.gain, c.pan, c.outputId]),
      project.stems.map((s) => [s.id, s.liveSetItemId, s.sourceAssetId, s.stemType, s.label, s.outputId]),
    ])
  }, [bundle])

  // Structural changes swap the engine's project in place — the show keeps
  // playing through an edit unless what is playing was itself deleted.
  React.useEffect(() => {
    if (!bundle || !structureKey) return
    engine.updateProject(bundleToEngineProject(bundle))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, structureKey])

  const audioKey = React.useMemo(() => {
    if (!bundle) return ''
    const ids = new Set<string>()
    for (const clip of bundle.clips) ids.add(clip.sourceAssetId)
    for (const stem of bundle.stems) ids.add(stem.sourceAssetId)
    return [...ids].sort().join(',')
  }, [bundle])

  React.useEffect(() => {
    if (!bundle) return
    let cancelled = false
    setLoadError(null)

    const assetIds = new Set<string>()
    for (const clip of bundle.clips) assetIds.add(clip.sourceAssetId)
    for (const stem of bundle.stems) assetIds.add(stem.sourceAssetId)
    setTotal(assetIds.size)
    setLoaded(0)

    const load = async () => {
      const manifest = bundle.packages[0]?.manifest ?? null
      const cache = source === 'cache' ? await IndexedDbCacheStore.open(bundle.project.id) : null
      let count = 0
      for (const assetId of assetIds) {
        if (cancelled) return
        try {
          if (engine.isAudioLoaded(assetId)) {
            count++
            setLoaded(count)
            continue
          }
          let bytes: Uint8Array | null = null
          if (cache && manifest) {
            const file = manifest.requiredFiles.find((f) => f.assetId === assetId)
            if (file) bytes = await cache.get(file.path)
          }
          if (!bytes && source === 'cloud') {
            const { url } = await liveApi.assetUrl(assetId)
            const response = await fetch(url)
            if (!response.ok) throw new Error(`fetch failed: ${response.status}`)
            bytes = new Uint8Array(await response.arrayBuffer())
          }
          if (!bytes) {
            // Cache-only mode with a missing file: the pad shows ERROR rather
            // than the engine quietly reaching for the network mid-show.
            continue
          }
          const copy = new Uint8Array(bytes)
          await engine.loadAudio(assetId, copy.buffer as ArrayBuffer)
          count++
          setLoaded(count)
        } catch (err) {
          setLoadError((err as Error).message)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // Keyed on the exact asset set, so swapping a clip's audio reloads it
    // while cosmetic edits do not re-download a whole show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, bundle?.project.id, audioKey, source])

  const arm = React.useCallback(async () => {
    await backend.resume()
    setArmed(true)
  }, [backend])

  return {
    engine,
    backend,
    snapshot,
    audioReady: armed,
    loadedAssets: loaded,
    totalAssets: total,
    loadError,
    arm,
  }
}

// ------------------------------------------------------------------- MIDI ----

export interface UseMidiResult {
  devices: MidiDeviceInfo[]
  supported: boolean
  learn: MidiLearn
  learning: boolean
  lastMessage: { deviceId: string; message: ParsedMidiMessage } | null
  startLearn: (targetType: MidiMapping['targetType'], targetId: string | null) => void
  cancelLearn: () => void
  mock: MockMidiSource | null
  useMock: () => void
}

/** Connects Web MIDI (or an on-screen mock controller) to the engine via stored mappings. */
export function useMidi(
  mappings: MidiMapping[],
  onAction: (hit: { targetType: MidiMapping['targetType']; targetId: string | null; value: number; pressed: boolean }) => void,
  onCaptured?: (candidate: MappingCandidate) => void,
): UseMidiResult {
  const [devices, setDevices] = React.useState<MidiDeviceInfo[]>([])
  const [supported, setSupported] = React.useState(true)
  const [learning, setLearning] = React.useState(false)
  const [lastMessage, setLastMessage] = React.useState<{ deviceId: string; message: ParsedMidiMessage } | null>(null)
  const [mock, setMock] = React.useState<MockMidiSource | null>(null)
  const sourceRef = React.useRef<MidiSource | null>(null)
  const learnRef = React.useRef(new MidiLearn())
  const mappingsRef = React.useRef(mappings)
  mappingsRef.current = mappings
  const onActionRef = React.useRef(onAction)
  onActionRef.current = onAction
  const onCapturedRef = React.useRef(onCaptured)
  onCapturedRef.current = onCaptured

  const attach = React.useCallback((midiSource: MidiSource) => {
    sourceRef.current?.close()
    sourceRef.current = midiSource
    setDevices(midiSource.devices())
    midiSource.onDeviceChange(() => setDevices(midiSource.devices()))
    midiSource.onMessage((deviceId, message) => {
      setLastMessage({ deviceId, message })
      const captured = learnRef.current.onMessage(deviceId, message)
      if (captured) {
        setLearning(false)
        onCapturedRef.current?.(captured)
        return
      }
      for (const hit of matchMappings(mappingsRef.current, deviceId, message)) {
        onActionRef.current({ targetType: hit.mapping.targetType, targetId: hit.mapping.targetId, value: hit.value, pressed: hit.pressed })
      }
    })
  }, [])

  React.useEffect(() => {
    let disposed = false
    WebMidiSource.create()
      .then((midiSource) => {
        if (disposed) {
          midiSource.close()
          return
        }
        attach(midiSource)
      })
      .catch(() => setSupported(false))
    return () => {
      disposed = true
      sourceRef.current?.close()
      sourceRef.current = null
    }
  }, [attach])

  return {
    devices,
    supported,
    learn: learnRef.current,
    learning,
    lastMessage,
    startLearn: (targetType, targetId) => {
      learnRef.current.start({ targetType, targetId })
      setLearning(true)
    },
    cancelLearn: () => {
      learnRef.current.cancel()
      setLearning(false)
    },
    mock,
    useMock: () => {
      const mockSource = new MockMidiSource()
      mockSource.connectDevice('mock-controller', 'Live Lab Mock Controller')
      attach(mockSource)
      setMock(mockSource)
      setSupported(true)
    },
  }
}

// ------------------------------------------------------------ show caching ----

export interface CacheProgress {
  phase: 'idle' | 'building' | 'caching' | 'verifying' | 'ready' | 'error'
  cachedFiles: number
  totalFiles: number
  message: string
}

const SHOW_BUNDLE_KEY = 'masterclip.live.show'

/**
 * The show's own data, kept on the device beside its audio.
 *
 * Caching the audio was never enough on its own: Performance Mode loads the
 * setlist, scenes, pad map and manifest over the network, so at a venue with no
 * connection it rendered "Request failed" and the verified cache was never
 * reached. The bundle is small metadata, so localStorage is the right home for
 * it — the audio stays in IndexedDB where it belongs.
 */
export function storeShowBundle(projectId: string, bundle: LiveProjectBundle): void {
  try {
    window.localStorage.setItem(`${SHOW_BUNDLE_KEY}.${projectId}`, JSON.stringify(bundle))
  } catch {
    // A full or disabled store is not a reason to fail the packaging run; the
    // show still works online, and verification already reported the cache.
  }
}

export function loadStoredShowBundle(projectId: string): LiveProjectBundle | null {
  try {
    const raw = window.localStorage.getItem(`${SHOW_BUNDLE_KEY}.${projectId}`)
    return raw ? (JSON.parse(raw) as LiveProjectBundle) : null
  } catch {
    return null
  }
}

/**
 * The bundle Performance Mode should run on: current when the network is
 * there, the packaged copy when it is not.
 *
 * Deliberately not cache-first — a set edited since the last package should be
 * picked up when there is a connection to pick it up from. The stored copy is
 * the floor, not the default.
 */
/**
 * How long the network gets before the stored show wins.
 *
 * A venue's wifi does not usually fail cleanly: a captive portal accepts the
 * connection and then never answers. Only an instant failure reached the
 * fallback below, so that case hung Performance Mode on a spinner with a
 * verified show sitting on the device.
 */
const BUNDLE_NETWORK_TIMEOUT_MS = 4000

export async function loadShowBundle(projectId: string): Promise<LiveProjectBundle> {
  const stored = loadStoredShowBundle(projectId)
  try {
    const fresh = await (stored
      ? Promise.race([
          liveApi.project(projectId),
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error('network timed out; using the packaged show')), BUNDLE_NETWORK_TIMEOUT_MS),
          ),
        ])
      : // With nothing stored there is nothing to fall back to, so waiting is
        // strictly better than failing early.
        liveApi.project(projectId))
    storeShowBundle(projectId, fresh)
    return fresh
  } catch (err) {
    if (stored) return stored
    throw err
  }
}

/**
 * Builds the offline performance package end to end: manifest on the server,
 * bytes into IndexedDB, checksums verified on this device, READY reported back.
 */
export async function cacheShow(projectId: string, onProgress: (progress: CacheProgress) => void): Promise<void> {
  onProgress({ phase: 'building', cachedFiles: 0, totalFiles: 0, message: 'Building manifest…' })
  const { package: record, report } = await liveApi.buildPackage(projectId)
  if (report.status !== 'ready') {
    onProgress({
      phase: 'error',
      cachedFiles: 0,
      totalFiles: 0,
      message: `Package cannot be built: ${report.issues.map((i) => i.message).join('; ')}`,
    })
    return
  }
  const { files } = await liveApi.packageFiles(record.id)
  // Ask for persistent storage before filling the cache: an evictable show is
  // one the browser may reclaim under pressure, and the first anyone would
  // know is a pad reading ERROR at the venue.
  const persisted = await requestPersistentStorage()
  const cache = await IndexedDbCacheStore.open(projectId)
  let cached = 0
  onProgress({ phase: 'caching', cachedFiles: 0, totalFiles: files.length, message: 'Caching audio locally…' })
  for (const file of files) {
    if (!file.url) continue
    const response = await fetch(file.url)
    if (!response.ok) {
      onProgress({ phase: 'error', cachedFiles: cached, totalFiles: files.length, message: `Download failed for ${file.path}` })
      return
    }
    await cache.put(file.path, new Uint8Array(await response.arrayBuffer()))
    cached++
    onProgress({ phase: 'caching', cachedFiles: cached, totalFiles: files.length, message: `Cached ${cached}/${files.length}` })
  }

  onProgress({ phase: 'verifying', cachedFiles: cached, totalFiles: files.length, message: 'Verifying checksums…' })
  const verified: Array<{ path: string; sha256: string; bytes: number; decodable: boolean }> = []
  for (const file of files) {
    const bytes = await cache.get(file.path)
    verified.push({
      path: file.path,
      sha256: bytes ? await sha256HexOf(bytes) : '',
      bytes: bytes?.length ?? 0,
      decodable: bytes ? await cache.decodable(file.path) : false,
    })
  }
  const result = await liveApi.verifyPackage(record.id, verified)
  if (result.status === 'ready') {
    // Store the show itself, not just its audio, while the network is still
    // here. Fetched fresh so the stored copy carries the manifest just built.
    try {
      storeShowBundle(projectId, await liveApi.project(projectId))
    } catch {
      // Reported below as READY regardless: the cache is verified either way,
      // and an unstorable bundle only costs the offline-start path.
    }
    onProgress({
      phase: 'ready',
      cachedFiles: cached,
      totalFiles: files.length,
      // Say plainly when the cache is still evictable rather than implying a
      // guarantee the browser did not give.
      message:
        persisted === false
          ? 'SHOW READY — verified on this device. Storage is not persistent: re-verify at soundcheck.'
          : 'SHOW READY — verified on this device',
    })
  } else {
    onProgress({
      phase: 'error',
      cachedFiles: cached,
      totalFiles: files.length,
      message: result.issues.map((i) => i.message).join('; ') || 'verification failed',
    })
  }
}

export type { EngineEvent }
