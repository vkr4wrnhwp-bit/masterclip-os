/**
 * The audio backend abstraction.
 *
 * The engine schedules against this interface, never against the Web Audio API
 * directly. That is the boundary that lets the same LiveAudioEngine run in the
 * browser today and inside a native desktop shell later — and lets every piece
 * of scheduling logic run under vitest with a manual clock.
 */

export interface LoadedSample {
  id: string
  durationSeconds: number
}

export interface PlayOptions {
  sampleId: string
  /** Absolute backend time (seconds) at which playback must start. */
  when: number
  /** Offset into the sample, seconds. */
  offsetSeconds?: number
  /** Stop after this long; omitted plays to the end (or loops forever). */
  durationSeconds?: number
  loop?: { startSeconds: number; endSeconds: number } | null
  gain: number
  pan: number
  /** Logical output id ("master", "cue", "click", …). Unknown ids fall back to master. */
  outputId?: string
}

export interface PlayHandle {
  readonly id: string
  stop(atTime?: number): void
  setGain(value: number): void
  setPan(value: number): void
  readonly stopped: boolean
  /** Instantaneous peak level 0–1, when the backend can meter. */
  level?(): number
}

export interface AudioBackend {
  readonly name: string
  /** Monotonic backend clock, seconds. All scheduling uses this timeline. */
  currentTime(): number
  load(id: string, data: ArrayBuffer): Promise<LoadedSample>
  isLoaded(id: string): boolean
  duration(id: string): number | null
  play(opts: PlayOptions): PlayHandle
  /** Sample-accurate click tick at `when`; accented ticks mark the downbeat. */
  scheduleClick(when: number, accent: boolean, gain: number): void
  setMasterGain(value: number): void
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Test backend: a manual clock and a full record of what was scheduled.
// ---------------------------------------------------------------------------

export interface RecordedPlay extends PlayOptions {
  handleId: string
  stoppedAt: number | null
  gainChanges: number[]
  /** Settable by tests so meter plumbing is assertable. */
  meterLevel: number
}

export interface RecordedClick {
  when: number
  accent: boolean
  gain: number
}

/** Deterministic backend for unit tests. Time only moves when advance() is called. */
export class TestAudioBackend implements AudioBackend {
  readonly name = 'test'
  private time = 0
  private readonly samples = new Map<string, LoadedSample>()
  readonly plays: RecordedPlay[] = []
  readonly clicks: RecordedClick[] = []
  masterGain = 1
  private handleSeq = 0

  advance(seconds: number): void {
    this.time += seconds
  }

  currentTime(): number {
    return this.time
  }

  /** Registers a sample without decoding anything. */
  preload(id: string, durationSeconds: number): void {
    this.samples.set(id, { id, durationSeconds })
  }

  async load(id: string, data: ArrayBuffer): Promise<LoadedSample> {
    // No decoder in Node: duration is approximated from size so tests can load
    // real buffers, and preload() exists for exact control.
    const sample = this.samples.get(id) ?? { id, durationSeconds: Math.max(0.1, data.byteLength / 176_400) }
    this.samples.set(id, sample)
    return sample
  }

  isLoaded(id: string): boolean {
    return this.samples.has(id)
  }

  duration(id: string): number | null {
    return this.samples.get(id)?.durationSeconds ?? null
  }

  play(opts: PlayOptions): PlayHandle {
    if (!this.samples.has(opts.sampleId)) throw new Error(`sample not loaded: ${opts.sampleId}`)
    const record: RecordedPlay = { ...opts, handleId: `h${++this.handleSeq}`, stoppedAt: null, gainChanges: [], meterLevel: 0 }
    this.plays.push(record)
    const backend = this
    return {
      id: record.handleId,
      get stopped() {
        return record.stoppedAt !== null
      },
      stop(atTime?: number) {
        if (record.stoppedAt === null) record.stoppedAt = atTime ?? backend.time
      },
      setGain(value: number) {
        record.gainChanges.push(value)
      },
      setPan() {},
      level() {
        return record.meterLevel
      },
    }
  }

  scheduleClick(when: number, accent: boolean, gain: number): void {
    this.clicks.push({ when, accent, gain })
  }

  setMasterGain(value: number): void {
    this.masterGain = value
  }

  async close(): Promise<void> {
    this.samples.clear()
  }

  /** Plays that would be audible at backend time `at`. */
  playingAt(at: number): RecordedPlay[] {
    return this.plays.filter((p) => p.when <= at && (p.stoppedAt === null || p.stoppedAt > at))
  }
}
