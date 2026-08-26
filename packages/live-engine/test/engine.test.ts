import { beforeEach, describe, expect, it } from 'vitest'
import type { LiveScene, LiveSetItem, LiveStem, LiveClip } from '@masterclip/performance-project'
import { defaultPadMap } from '@masterclip/performance-project'
import { TestAudioBackend } from '../src/backend.js'
import { LiveAudioEngine, type EngineEvent, type EngineProject } from '../src/engine.js'
import { MemorySnapshotStore, PerformanceSnapshot } from '../src/recovery.js'

/**
 * Engine behavior under a manual clock. The backend records exactly what was
 * scheduled and when — the assertions are about the audio timeline, not the UI.
 */

const item = (id: string, over: Partial<LiveSetItem> = {}): LiveSetItem => ({
  id,
  organizationId: 'org',
  liveProjectId: 'proj',
  sortOrder: 0,
  type: 'song',
  title: id.toUpperCase(),
  sourceReleaseId: null,
  sourceTrackId: null,
  bpm: 120,
  key: null,
  durationMs: null,
  notes: '',
  ...over,
})

const scene = (id: string, itemId: string, over: Partial<LiveScene> = {}): LiveScene => ({
  id,
  organizationId: 'org',
  liveProjectId: 'proj',
  liveSetItemId: itemId,
  name: id.toUpperCase(),
  sceneType: 'custom',
  sortOrder: 0,
  color: '',
  bpm: null,
  key: null,
  bars: null,
  quantization: '1bar',
  loopEnabled: false,
  followAction: 'stop',
  followTargetSceneId: null,
  ...over,
})

const clip = (id: string, sceneId: string, assetId: string, over: Partial<LiveClip> = {}): LiveClip => ({
  id,
  organizationId: 'org',
  liveProjectId: 'proj',
  liveSceneId: sceneId,
  name: id,
  sourceAssetId: assetId,
  startMs: 0,
  endMs: null,
  loopStartMs: null,
  loopEndMs: null,
  oneShot: false,
  gain: 1,
  pan: 0,
  outputId: null,
  ...over,
})

const stem = (id: string, itemId: string, assetId: string, over: Partial<LiveStem> = {}): LiveStem => ({
  id,
  organizationId: 'org',
  liveProjectId: 'proj',
  liveSetItemId: itemId,
  stemType: 'drums',
  label: id,
  sourceAssetId: assetId,
  gain: 1,
  pan: 0,
  muted: false,
  solo: false,
  outputId: null,
  ...over,
})

function project(over: Partial<EngineProject> = {}): EngineProject {
  return {
    projectId: 'proj',
    masterTempo: 120,
    timeSignature: '4/4',
    items: [item('song1')],
    scenes: [scene('intro', 'song1', { quantization: 'none' }), scene('verse', 'song1', { quantization: '1bar', sortOrder: 1 })],
    clips: [clip('c1', 'intro', 'audio1'), clip('c2', 'verse', 'audio2')],
    stems: [],
    padMap: defaultPadMap(),
    ...over,
  }
}

let backend: TestAudioBackend
let engine: LiveAudioEngine
let events: EngineEvent[]

beforeEach(() => {
  backend = new TestAudioBackend()
  backend.preload('audio1', 30)
  backend.preload('audio2', 30)
  backend.preload('stemA', 60)
  backend.preload('stemB', 60)
  engine = new LiveAudioEngine(backend)
  events = []
  engine.on((event) => events.push(event))
})

describe('clip launching', () => {
  it('launches immediately with quantization none', () => {
    engine.loadProject(project())
    const result = engine.triggerScene('intro')
    expect(result.launchBeat).toBe(0)
    expect(backend.plays.length).toBe(1)
    expect(backend.plays[0]!.sampleId).toBe('audio1')
  })

  it('queues an early trigger until the quantization boundary', () => {
    engine.loadProject(project())
    engine.triggerScene('intro')
    // Advance 1.5 beats (0.75s at 120 BPM) into the song, then trigger a
    // 1-bar-quantized scene: it must land on beat 4, not now.
    backend.advance(0.05 + 0.75)
    const result = engine.triggerScene('verse')
    expect(result.queued).toBe(true)
    expect(result.launchBeat).toBe(4)
    expect(engine.queuedSceneId).toBe('verse')
    expect(engine.padState).toBeDefined()

    // Not yet within lookahead: nothing scheduled for audio2.
    expect(backend.plays.filter((p) => p.sampleId === 'audio2').length).toBe(0)

    // Walk the clock into the lookahead window before the boundary; the tick
    // schedules it at exactly the boundary time on the backend clock.
    backend.advance(1.2) // now at beat 3.9, boundary within the 0.12s lookahead
    engine.tick()
    const scheduled = backend.plays.find((p) => p.sampleId === 'audio2')
    expect(scheduled).toBeDefined()
    expect(scheduled!.when).toBeCloseTo(0.05 + 4 * 0.5, 5)

    // Crossing the boundary promotes QUEUED → PLAYING and emits the event.
    backend.advance(0.3)
    engine.tick()
    expect(engine.queuedSceneId).toBeNull()
    expect(engine.currentSceneId).toBe('verse')
    expect(events.some((e) => e.type === 'scene_launched' && e.sceneId === 'verse')).toBe(true)
  })

  it('stops the outgoing scene exactly at the incoming launch time', () => {
    engine.loadProject(project())
    engine.triggerScene('intro')
    backend.advance(0.05 + 0.75)
    engine.triggerScene('verse')
    backend.advance(1.2)
    engine.tick()
    const intro = backend.plays.find((p) => p.sampleId === 'audio1')
    expect(intro!.stoppedAt).toBeCloseTo(0.05 + 4 * 0.5, 5)
  })

  it('loops when the scene says so', () => {
    const p = project()
    p.scenes[1] = scene('verse', 'song1', { loopEnabled: true, quantization: 'none' })
    engine.loadProject(p)
    engine.triggerScene('verse')
    const played = backend.plays.find((pl) => pl.sampleId === 'audio2')
    expect(played!.loop).not.toBeNull()
  })
})

describe('stems', () => {
  function stemProject(): EngineProject {
    return project({
      stems: [stem('sA', 'song1', 'stemA'), stem('sB', 'song1', 'stemB')],
    })
  }

  it('starts all stems in sync when the song starts', () => {
    engine.loadProject(stemProject())
    engine.startSong('song1')
    const started = backend.plays.map((p) => p.sampleId)
    expect(started).toContain('stemA')
    expect(started).toContain('stemB')
    const whens = backend.plays.map((p) => p.when)
    expect(new Set(whens).size).toBe(1)
  })

  it('mute drops the stem gain to zero without stopping playback', () => {
    engine.loadProject(stemProject())
    engine.startSong('song1')
    engine.setStemMuted('sA', true)
    const handle = backend.plays.find((p) => p.sampleId === 'stemA')
    expect(handle!.gainChanges.at(-1)).toBe(0)
    expect(handle!.stoppedAt).toBeNull()
  })

  it('volume changes reach the playing handle', () => {
    engine.loadProject(stemProject())
    engine.startSong('song1')
    engine.setStemGain('sB', 0.3)
    const handle = backend.plays.find((p) => p.sampleId === 'stemB')
    expect(handle!.gainChanges.at(-1)).toBeCloseTo(0.3)
  })

  it('stem meters read the playing handle level and go silent on stop', () => {
    engine.loadProject(stemProject())
    engine.startSong('song1')
    const play = backend.plays.find((p) => p.sampleId === 'stemA')!
    play.meterLevel = 0.62
    expect(engine.stemLevel('sA')).toBeCloseTo(0.62)
    engine.stopAll()
    expect(engine.stemLevel('sA')).toBe(0)
  })
})

describe('follow actions', () => {
  it('chains to the next scene at the bar the current one ends', () => {
    const p = project()
    p.scenes = [
      scene('build', 'song1', { quantization: 'none', bars: 1, followAction: 'next_scene', sortOrder: 0 }),
      scene('drop', 'song1', { quantization: 'none', sortOrder: 1 }),
    ]
    p.clips = [clip('c1', 'build', 'audio1'), clip('c2', 'drop', 'audio2')]
    engine.loadProject(p)
    engine.triggerScene('build')
    // One bar at 120 BPM = 2s. Tick close to the end so the follow schedules.
    backend.advance(0.05 + 1.95)
    engine.tick()
    const drop = backend.plays.find((pl) => pl.sampleId === 'audio2')
    expect(drop).toBeDefined()
    expect(drop!.when).toBeCloseTo(0.05 + 2.0, 5)
  })
})

describe('click', () => {
  it('schedules accented downbeats on the tempo grid', () => {
    engine.loadProject(project())
    engine.triggerScene('intro')
    engine.setClickEnabled(true)
    backend.advance(0.02)
    engine.tick()
    expect(backend.clicks.length).toBeGreaterThan(0)
    const first = backend.clicks[0]!
    expect(first.accent).toBe(true)
    // Beats are 0.5s apart at 120 BPM.
    if (backend.clicks.length > 1) {
      expect(backend.clicks[1]!.when - first.when).toBeCloseTo(0.5, 5)
    }
  })
})

describe('emergency stop and pads', () => {
  it('stopAll stops every handle', () => {
    engine.loadProject(project({ stems: [stem('sA', 'song1', 'stemA')] }))
    engine.startSong('song1')
    engine.triggerScene('intro')
    engine.stopAll()
    for (const play of backend.plays) expect(play.stoppedAt).not.toBeNull()
    expect(engine.isPlaying).toBe(false)
  })

  it('pad states reflect queue/play/stop', () => {
    const p = project()
    p.padMap[0] = { index: 0, mode: 'scene', label: 'INTRO', targetId: 'intro', color: '' }
    engine.loadProject(p)
    expect(engine.padState(0)).toBe('loaded')
    engine.triggerPad(0)
    expect(['playing', 'queued']).toContain(engine.padState(0))
    expect(engine.padState(15)).toBe('loaded') // STOP pad
    expect(engine.padState(3)).toBe('empty')
  })

  it('a pad pointing at uncached audio reports error, not silence', () => {
    const p = project()
    p.clips[0] = clip('c1', 'intro', 'missing-asset')
    p.padMap[0] = { index: 0, mode: 'scene', label: 'INTRO', targetId: 'intro', color: '' }
    engine.loadProject(p)
    expect(engine.padState(0)).toBe('error')
  })
})

describe('editing a project while it plays', () => {
  function stemProject(): EngineProject {
    return project({ stems: [stem('sA', 'song1', 'stemA'), stem('sB', 'song1', 'stemB')] })
  }

  it('picks up structural edits without stopping the show', () => {
    const p = stemProject()
    engine.loadProject(p)
    engine.startSong('song1')
    engine.triggerScene('intro')
    const playingBefore = backend.plays.filter((pl) => pl.stoppedAt === null).length

    // Rename a scene and repoint a pad — counts identical, meaning identical.
    const edited = stemProject()
    edited.scenes = edited.scenes.map((s) => (s.id === 'verse' ? { ...s, name: 'HOOK' } : s))
    edited.padMap[0] = { index: 0, mode: 'scene', label: 'HOOK', targetId: 'verse', color: '' }
    engine.updateProject(edited)

    expect(engine.isPlaying).toBe(true)
    expect(engine.currentSceneId).toBe('intro')
    expect(backend.plays.filter((pl) => pl.stoppedAt === null).length).toBe(playingBefore)
    // The pad now resolves to the newly assigned scene rather than the stale one.
    engine.triggerPad(0)
    expect(engine.queuedSceneId === 'verse' || engine.currentSceneId === 'verse').toBe(true)
  })

  it('keeps live mixer state across an edit', () => {
    engine.loadProject(stemProject())
    engine.startSong('song1')
    engine.setStemMuted('sA', true)
    engine.setStemGain('sB', 0.25)

    engine.updateProject(stemProject())

    expect(engine.stems.get('sA')?.muted).toBe(true)
    expect(engine.stems.get('sB')?.gain).toBeCloseTo(0.25)
  })

  it('stops only when the playing song itself is deleted', () => {
    const p = stemProject()
    engine.loadProject(p)
    engine.startSong('song1')
    const withoutSong = { ...p, items: [], scenes: [], clips: [], stems: [] }
    engine.updateProject(withoutSong)
    expect(engine.isPlaying).toBe(false)
  })

  it('dequeues a scene that was deleted before it launched', () => {
    engine.loadProject(project())
    engine.triggerScene('intro')
    backend.advance(0.05 + 0.75)
    engine.triggerScene('verse')
    expect(engine.queuedSceneId).toBe('verse')

    const edited = project()
    edited.scenes = edited.scenes.filter((s) => s.id !== 'verse')
    edited.clips = edited.clips.filter((c) => c.liveSceneId !== 'verse')
    engine.updateProject(edited)
    expect(engine.queuedSceneId).toBeNull()
  })
})

describe('stem controls addressing another song', () => {
  it('no-op instead of throwing when the target is not in the current deck', () => {
    // The seeded pad map and MIDI mappings point at the first song's stems;
    // hitting them during any other song must not throw on stage.
    const p = project({
      items: [item('song1'), item('song2', { sortOrder: 1, title: 'SONG TWO' })],
      stems: [stem('sA', 'song1', 'stemA'), stem('sB', 'song2', 'stemB')],
    })
    p.padMap[4] = { index: 4, mode: 'stem_mute', label: 'DRUMS', targetId: 'sA', color: '' }
    engine.loadProject(p)
    engine.startSong('song2')

    expect(() => engine.triggerPad(4)).not.toThrow()
    expect(engine.setStemMuted('sA', true)).toBe(false)
    expect(engine.setStemSolo('sA', true)).toBe(false)
    expect(engine.setStemGain('sA', 0.5)).toBe(false)
    expect(engine.setStemPan('sA', 0.5)).toBe(false)
    // The current song's own stem still responds.
    expect(engine.setStemMuted('sB', true)).toBe(true)
  })
})

describe('crash recovery', () => {
  it('restored mixer state survives the next song change', () => {
    const p = project({ stems: [stem('sA', 'song1', 'stemA', { gain: 1, muted: false })] })
    engine.loadProject(p)
    engine.restoreStemStates([{ id: 'sA', gain: 0.3, pan: -0.5, muted: true, solo: false }])
    // The song loads *after* the restore — the stored defaults must not win.
    engine.startSong('song1')
    expect(engine.stems.get('sA')?.muted).toBe(true)
    expect(engine.stems.get('sA')?.gain).toBeCloseTo(0.3)
    // Restoring never starts audio on its own beyond the song's own stems.
    engine.clearRestoredStemStates()
  })

  it('selectSong puts the set where the performer was, in silence', () => {
    const p = project({
      items: [item('song1'), item('song2', { sortOrder: 1, title: 'SONG TWO' })],
      stems: [stem('sA', 'song1', 'stemA'), stem('sB', 'song2', 'stemB')],
    })
    engine.loadProject(p)

    // A fresh engine after a crash: nothing playing, sitting at no song.
    expect(engine.isPlaying).toBe(false)
    expect(engine.selectSong('song2')).toBe(true)

    // Position restored...
    expect(engine.currentItem?.id).toBe('song2')
    // ...and that song's stems are on the deck, so the mixer shows the right
    // channels rather than the previous song's.
    expect(engine.stems.get('sB')).toBeDefined()
    // ...but nothing is playing. Sound after a crash must be a deliberate act.
    expect(engine.isPlaying).toBe(false)
    expect(backend.plays).toHaveLength(0)
  })

  it('selectSong refuses a song that is not in the set rather than throwing', () => {
    engine.loadProject(project({}))
    // A snapshot can outlive the set it was taken from — an edited setlist
    // must not make recovery explode.
    expect(engine.selectSong('song-that-was-deleted')).toBe(false)
    expect(engine.isPlaying).toBe(false)
  })

  it('continues the set from the restored song rather than the first', () => {
    const p = project({
      items: [item('song1'), item('song2', { sortOrder: 1, title: 'SONG TWO' }), item('song3', { sortOrder: 2, title: 'SONG THREE' })],
      stems: [stem('sA', 'song1', 'stemA'), stem('sB', 'song2', 'stemB')],
    })
    engine.loadProject(p)
    engine.selectSong('song2')

    // The reason positional restore matters: NEXT SONG used to jump to song 2
    // because the engine still believed it was on song 1.
    engine.nextSong()
    expect(engine.currentItem?.id).toBe('song3')
  })

  it('persists and restores a snapshot without starting audio', async () => {
    const store = new MemorySnapshotStore()
    const snapshot = PerformanceSnapshot.parse({
      snapshotVersion: 1,
      projectId: 'proj',
      packageVersion: 1,
      savedAt: new Date(0).toISOString(),
      currentItemId: 'song1',
      currentSceneId: 'intro',
      setPosition: 0,
      bpm: 120,
      clickEnabled: true,
      locked: false,
      stems: [{ id: 'sA', gain: 0.5, pan: 0, muted: true, solo: false }],
      outputs: [],
      midiDeviceIds: [],
    })
    await store.save(snapshot)
    const loaded = await store.load('proj')
    expect(loaded).toEqual(snapshot)
    // Restoring is state-only: nothing has been scheduled on the backend.
    expect(backend.plays.length).toBe(0)
    await store.clear('proj')
    expect(await store.load('proj')).toBeNull()
  })
})
