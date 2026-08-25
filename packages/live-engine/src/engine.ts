import type { LiveClip, LiveScene, LiveSetItem, LiveStem, PadAssignment, PadState } from '@masterclip/performance-project'
import type { AudioBackend, PlayHandle } from './backend.js'
import { barsToBeats, beatsToSeconds, nextBoundaryBeat, parseTimeSignature, quantizationGridBeats, secondsToBeats, type TimeSignature } from './tempo.js'
import { StemDeck } from './stems.js'

/**
 * LiveAudioEngine — the performance core.
 *
 * Owns the tempo clock, the transport, scene launching, stem playback, the
 * click, and quantization. It schedules everything against an AudioBackend's
 * clock with a short lookahead window, which is what makes launches land on
 * the grid instead of on whenever the UI thread got around to it.
 *
 * The engine never touches the network. Audio enters through loadAudio()
 * (bytes from the local performance package) and nothing else — cloud
 * connectivity can disappear mid-show without this class noticing.
 */

export interface EngineProject {
  projectId: string
  masterTempo: number
  timeSignature: string
  items: LiveSetItem[]
  scenes: LiveScene[]
  clips: LiveClip[]
  stems: LiveStem[]
  padMap: PadAssignment[]
}

export type EngineEvent =
  | { type: 'started'; itemId: string | null }
  | { type: 'stopped' }
  | { type: 'song_changed'; itemId: string }
  | { type: 'scene_queued'; sceneId: string; launchBeat: number }
  | { type: 'scene_launched'; sceneId: string; launchBeat: number }
  | { type: 'scene_ended'; sceneId: string }
  | { type: 'pad_triggered'; index: number; mode: string }
  | { type: 'click_changed'; enabled: boolean }
  | { type: 'error'; message: string }

export interface ActiveScene {
  sceneId: string
  startBeat: number
  /** Beat at which the follow action fires; null while looping or open-ended. */
  endBeat: number | null
  handles: PlayHandle[]
  followHandled: boolean
}

export interface EngineOptions {
  /** How far ahead (seconds) tick() schedules audio. */
  lookaheadSeconds?: number
  clickGain?: number
}

export class LiveAudioEngine {
  private readonly lookahead: number
  private project: EngineProject | null = null
  private signature: TimeSignature = { beatsPerBar: 4, beatUnit: 4 }
  private bpm = 120
  /** Backend time at which beat 0 of the current song occurred. */
  private zeroTime = 0
  private playing = false
  private currentItemId: string | null = null
  private current: ActiveScene | null = null
  private queued: { sceneId: string; launchBeat: number; scheduled: boolean } | null = null
  private stemHandles = new Map<string, PlayHandle>()
  readonly stems = new StemDeck()
  private clickEnabled = false
  private clickGain: number
  private nextClickBeat = 0
  private readonly listeners = new Set<(event: EngineEvent) => void>()

  constructor(
    private readonly backend: AudioBackend,
    opts: EngineOptions = {},
  ) {
    this.lookahead = opts.lookaheadSeconds ?? 0.12
    this.clickGain = opts.clickGain ?? 0.7
  }

  // ------------------------------------------------------------- loading ----

  loadProject(project: EngineProject): void {
    this.stopAll()
    this.project = project
    this.signature = parseTimeSignature(project.timeSignature)
    this.bpm = project.masterTempo
  }

  async loadAudio(assetId: string, data: ArrayBuffer): Promise<void> {
    await this.backend.load(assetId, data)
  }

  isAudioLoaded(assetId: string): boolean {
    return this.backend.isLoaded(assetId)
  }

  // -------------------------------------------------------------- events ----

  on(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  // ----------------------------------------------------------- transport ----

  get isPlaying(): boolean {
    return this.playing
  }

  get currentItem(): LiveSetItem | null {
    if (!this.project || !this.currentItemId) return null
    return this.project.items.find((i) => this.currentItemId === i.id) ?? null
  }

  get currentSceneId(): string | null {
    return this.current?.sceneId ?? null
  }

  get queuedSceneId(): string | null {
    return this.queued?.sceneId ?? null
  }

  get effectiveBpm(): number {
    return this.bpm
  }

  get timeSignature(): TimeSignature {
    return this.signature
  }

  /** Current transport position in beats (0 when stopped). */
  beatNow(): number {
    if (!this.playing) return 0
    return secondsToBeats(this.backend.currentTime() - this.zeroTime, this.bpm)
  }

  /**
   * Selects a song and starts its stems in sync. Does not auto-launch a scene:
   * launching is always a deliberate trigger.
   */
  startSong(itemId: string): void {
    const project = this.requireProject()
    const item = project.items.find((i) => i.id === itemId)
    if (!item) throw new Error(`unknown set item: ${itemId}`)

    const wasPlaying = this.playing
    this.clearPlayback()
    this.currentItemId = itemId
    this.bpm = item.bpm ?? project.masterTempo
    // A hair of scheduling headroom so the first samples start together.
    this.zeroTime = this.backend.currentTime() + 0.05
    this.playing = true
    this.nextClickBeat = 0

    const stems = project.stems.filter((s) => s.liveSetItemId === itemId)
    this.stems.load(
      stems.map((s) => ({ id: s.id, stemType: s.stemType, label: s.label || s.stemType, gain: s.gain, pan: s.pan, muted: s.muted, solo: s.solo })),
    )
    const gains = this.stems.resolve()
    for (const stem of stems) {
      if (!this.backend.isLoaded(stem.sourceAssetId)) continue
      const handle = this.backend.play({
        sampleId: stem.sourceAssetId,
        when: this.zeroTime,
        gain: gains.get(stem.id) ?? stem.gain,
        pan: stem.pan,
        outputId: stem.outputId ?? (stem.stemType === 'click' ? 'click' : 'master'),
      })
      this.stemHandles.set(stem.id, handle)
    }
    if (!wasPlaying) this.emit({ type: 'started', itemId })
    this.emit({ type: 'song_changed', itemId })
  }

  nextSong(): void {
    this.moveSong(1)
  }

  prevSong(): void {
    this.moveSong(-1)
  }

  private moveSong(direction: 1 | -1): void {
    const project = this.requireProject()
    if (project.items.length === 0) return
    const ordered = [...project.items].sort((a, b) => a.sortOrder - b.sortOrder)
    const index = ordered.findIndex((i) => i.id === this.currentItemId)
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, (index === -1 ? 0 : index + direction)))]
    if (next && next.id !== this.currentItemId) this.startSong(next.id)
  }

  /** Emergency stop: everything, immediately. */
  stopAll(): void {
    this.clearPlayback()
    if (this.playing) {
      this.playing = false
      this.emit({ type: 'stopped' })
    }
  }

  private clearPlayback(): void {
    const now = this.backend.currentTime()
    if (this.current) {
      for (const handle of this.current.handles) handle.stop(now)
      this.emit({ type: 'scene_ended', sceneId: this.current.sceneId })
    }
    this.current = null
    this.queued = null
    for (const handle of this.stemHandles.values()) handle.stop(now)
    this.stemHandles.clear()
  }

  // -------------------------------------------------------------- scenes ----

  /**
   * Triggers a scene. Early triggers queue until the scene's quantization
   * boundary; the UI shows QUEUED until the launch beat passes.
   */
  triggerScene(sceneId: string): { queued: boolean; launchBeat: number } {
    const project = this.requireProject()
    const scene = project.scenes.find((s) => s.id === sceneId)
    if (!scene) throw new Error(`unknown scene: ${sceneId}`)

    // Launching a scene from a different song switches the song first.
    if (scene.liveSetItemId !== this.currentItemId || !this.playing) {
      this.startSong(scene.liveSetItemId)
    }
    if (scene.bpm) this.retime(scene.bpm)

    // Just after startSong the transport zero sits slightly in the future
    // (scheduling headroom), which reads as a negative beat. Beat 0 is the
    // earliest a launch can land — clamping keeps the first launch in sync
    // with the stems instead of a hair before them.
    const now = Math.max(0, this.beatNow())
    const grid = quantizationGridBeats(scene.quantization, this.signature)
    let launchBeat: number
    if (grid === null) {
      // scene_end: wait for the playing scene to finish; with nothing playing
      // or an open-ended loop, launch on the next bar.
      launchBeat = this.current?.endBeat ?? nextBoundaryBeat(now, this.signature.beatsPerBar)
    } else {
      launchBeat = nextBoundaryBeat(now, grid)
    }

    this.queued = { sceneId, launchBeat, scheduled: false }
    this.emit({ type: 'scene_queued', sceneId, launchBeat })
    this.tick()
    return { queued: launchBeat > now, launchBeat }
  }

  /**
   * The scheduler. Call it every ~25ms (the web app uses an interval; tests
   * call it directly). Everything time-critical is scheduled onto the backend
   * clock inside the lookahead window — the tick cadence itself never decides
   * when audio starts.
   */
  tick(): void {
    if (!this.playing || !this.project) return
    const nowBeat = this.beatNow()
    const horizonBeat = nowBeat + secondsToBeats(this.lookahead, this.bpm)

    // 1. Promote the queued scene into scheduled audio once its beat is close.
    if (this.queued && !this.queued.scheduled && this.queued.launchBeat <= horizonBeat) {
      this.scheduleLaunch(this.queued.sceneId, this.queued.launchBeat)
      this.queued.scheduled = true
    }
    // 2. Once the launch beat has passed, the queued scene is the current one.
    if (this.queued?.scheduled && this.queued.launchBeat <= nowBeat) {
      this.emit({ type: 'scene_launched', sceneId: this.queued.sceneId, launchBeat: this.queued.launchBeat })
      this.queued = null
    }

    // 3. Follow actions at scene end.
    const current = this.current
    if (current && current.endBeat !== null && !current.followHandled && current.endBeat <= horizonBeat && !this.queued) {
      const scene = this.project.scenes.find((s) => s.id === current.sceneId)
      if (scene) {
        current.followHandled = true
        if (scene.followAction === 'next_scene' || scene.followAction === 'target') {
          const target =
            scene.followAction === 'target'
              ? scene.followTargetSceneId
              : this.nextSceneInSong(scene)?.id ?? null
          if (target) {
            this.queued = { sceneId: target, launchBeat: current.endBeat, scheduled: false }
            this.emit({ type: 'scene_queued', sceneId: target, launchBeat: current.endBeat })
            // Schedule in this same tick so a lookahead-sized gap cannot open.
            this.scheduleLaunch(target, current.endBeat)
            this.queued.scheduled = true
          }
        }
        // 'stop': clips already carry their duration; the scene simply ends.
        // 'loop' never sets endBeat, so it cannot reach here.
      }
    }
    if (current && current.endBeat !== null && current.endBeat <= nowBeat && this.current === current && !this.queued) {
      this.emit({ type: 'scene_ended', sceneId: current.sceneId })
      this.current = null
    }

    // 4. Click.
    if (this.clickEnabled) {
      while (this.nextClickBeat <= horizonBeat) {
        if (this.nextClickBeat >= nowBeat - 0.001) {
          const when = this.zeroTime + beatsToSeconds(this.nextClickBeat, this.bpm)
          const accent = Math.round(this.nextClickBeat) % this.signature.beatsPerBar === 0
          this.backend.scheduleClick(when, accent, this.clickGain)
        }
        this.nextClickBeat += 1
      }
    }
  }

  private scheduleLaunch(sceneId: string, launchBeat: number): void {
    const project = this.requireProject()
    const scene = project.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const launchTime = this.zeroTime + beatsToSeconds(launchBeat, this.bpm)

    // The outgoing scene stops exactly when the incoming one starts.
    if (this.current) {
      for (const handle of this.current.handles) handle.stop(launchTime)
    }

    const clips = project.clips.filter((c) => c.liveSceneId === sceneId)
    const handles: PlayHandle[] = []
    const sceneBeats = scene.bars !== null ? barsToBeats(scene.bars, this.signature) : null
    for (const clip of clips) {
      if (!this.backend.isLoaded(clip.sourceAssetId)) {
        this.emit({ type: 'error', message: `clip audio not cached: ${clip.name || clip.id}` })
        continue
      }
      const offset = clip.startMs / 1000
      const sampleDuration = this.backend.duration(clip.sourceAssetId) ?? 0
      const clipEnd = clip.endMs !== null ? clip.endMs / 1000 : sampleDuration
      let duration: number | undefined
      if (!scene.loopEnabled) {
        const byBars = sceneBeats !== null ? beatsToSeconds(sceneBeats, this.bpm) : undefined
        const byClip = clipEnd > offset ? clipEnd - offset : undefined
        duration = clip.oneShot ? byClip : (byBars ?? byClip)
      }
      handles.push(
        this.backend.play({
          sampleId: clip.sourceAssetId,
          when: launchTime,
          offsetSeconds: offset,
          ...(duration !== undefined ? { durationSeconds: duration } : {}),
          loop: scene.loopEnabled
            ? {
                startSeconds: (clip.loopStartMs ?? clip.startMs) / 1000,
                endSeconds: (clip.loopEndMs ?? clip.endMs ?? sampleDuration * 1000) / 1000,
              }
            : null,
          gain: clip.gain,
          pan: clip.pan,
          outputId: clip.outputId ?? 'master',
        }),
      )
    }

    this.current = {
      sceneId,
      startBeat: launchBeat,
      endBeat: scene.loopEnabled || sceneBeats === null ? null : launchBeat + sceneBeats,
      handles,
      followHandled: false,
    }
  }

  private nextSceneInSong(scene: LiveScene): LiveScene | null {
    const project = this.requireProject()
    const siblings = project.scenes.filter((s) => s.liveSetItemId === scene.liveSetItemId).sort((a, b) => a.sortOrder - b.sortOrder)
    const index = siblings.findIndex((s) => s.id === scene.id)
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1]! : null
  }

  /** Rebase the beat grid so the current beat stays put under a new tempo. */
  private retime(newBpm: number): void {
    if (newBpm === this.bpm) return
    const nowBeat = this.beatNow()
    const now = this.backend.currentTime()
    this.bpm = newBpm
    this.zeroTime = now - beatsToSeconds(nowBeat, newBpm)
  }

  // ---------------------------------------------------------------- pads ----

  triggerPad(index: number): void {
    const project = this.requireProject()
    const pad = project.padMap.find((p) => p.index === index)
    if (!pad || pad.mode === 'empty') return
    this.emit({ type: 'pad_triggered', index, mode: pad.mode })
    switch (pad.mode) {
      case 'scene':
      case 'clip':
      case 'fx':
      case 'transition':
        if (pad.targetId) this.triggerScene(pad.targetId)
        break
      case 'stem_mute':
        if (pad.targetId) this.setStemMuted(pad.targetId, !(this.stems.get(pad.targetId)?.muted ?? false))
        break
      case 'stem_solo':
        if (pad.targetId) this.setStemSolo(pad.targetId, !(this.stems.get(pad.targetId)?.solo ?? false))
        break
      case 'stop':
        this.stopAll()
        break
      case 'next_song':
        this.nextSong()
        break
      case 'prev_song':
        this.prevSong()
        break
      case 'custom':
        break
    }
  }

  padState(index: number): PadState {
    const project = this.project
    if (!project) return 'empty'
    const pad = project.padMap.find((p) => p.index === index)
    if (!pad || pad.mode === 'empty') return 'empty'
    if (pad.mode === 'scene' || pad.mode === 'clip' || pad.mode === 'fx' || pad.mode === 'transition') {
      if (!pad.targetId) return 'error'
      const scene = project.scenes.find((s) => s.id === pad.targetId)
      if (!scene) return 'error'
      const clips = project.clips.filter((c) => c.liveSceneId === scene.id)
      const missing = clips.some((c) => !this.backend.isLoaded(c.sourceAssetId))
      if (this.queued?.sceneId === scene.id) return 'queued'
      if (this.current?.sceneId === scene.id) return scene.loopEnabled ? 'looping' : 'playing'
      return missing ? 'error' : 'loaded'
    }
    if (pad.mode === 'stem_mute' && pad.targetId) {
      return this.stems.get(pad.targetId)?.muted ? 'muted' : 'loaded'
    }
    return 'loaded'
  }

  // ---------------------------------------------------------------- stems ----

  setStemMuted(stemId: string, muted: boolean): void {
    this.stems.setMuted(stemId, muted)
    this.applyStemGains()
  }

  setStemSolo(stemId: string, solo: boolean): void {
    this.stems.setSolo(stemId, solo)
    this.applyStemGains()
  }

  setStemGain(stemId: string, gain: number): void {
    this.stems.setGain(stemId, gain)
    this.applyStemGains()
  }

  setStemPan(stemId: string, pan: number): void {
    this.stems.setPan(stemId, pan)
    const handle = this.stemHandles.get(stemId)
    handle?.setPan(pan)
  }

  private applyStemGains(): void {
    const gains = this.stems.resolve()
    for (const [stemId, gain] of gains) {
      this.stemHandles.get(stemId)?.setGain(gain)
    }
  }

  // ---------------------------------------------------------------- click ----

  setClickEnabled(enabled: boolean): void {
    this.clickEnabled = enabled
    if (enabled) this.nextClickBeat = Math.ceil(this.beatNow())
    this.emit({ type: 'click_changed', enabled })
  }

  get isClickEnabled(): boolean {
    return this.clickEnabled
  }

  setMasterGain(value: number): void {
    this.backend.setMasterGain(Math.min(2, Math.max(0, value)))
  }

  private requireProject(): EngineProject {
    if (!this.project) throw new Error('no project loaded')
    return this.project
  }
}
