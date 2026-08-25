import type { AudioBackend, LoadedSample, PlayHandle, PlayOptions } from './backend.js'
import { createClickNode } from './worklet.js'

/**
 * The Web Audio backend.
 *
 * One AudioContext, a master bus, a click bus fed by the AudioWorklet click
 * synth, and AudioBufferSourceNodes for playback. `<audio>` tags are never
 * used: buffer sources are the only way to start playback at an exact context
 * time, which is what quantized launching requires.
 *
 * Output routing is an abstraction (`outputId`): the web MVP mixes master,
 * cue and click into the stereo device output, but each keeps its own gain
 * node so a desktop backend can split them onto real interface channels
 * without the engine changing.
 */
export class WebAudioBackend implements AudioBackend {
  readonly name = 'web-audio'
  private readonly context: AudioContext
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly master: GainNode
  private readonly buses = new Map<string, GainNode>()
  private clickNode: AudioWorkletNode | null = null
  private clickReady: Promise<void>

  constructor(context?: AudioContext) {
    this.context = context ?? new AudioContext({ latencyHint: 'interactive' })
    this.master = this.context.createGain()
    this.master.connect(this.context.destination)
    for (const bus of ['cue', 'click']) {
      const gain = this.context.createGain()
      gain.connect(this.context.destination)
      this.buses.set(bus, gain)
    }
    this.clickReady = this.initClick()
  }

  private async initClick(): Promise<void> {
    try {
      this.clickNode = await createClickNode(this.context)
      this.clickNode.connect(this.buses.get('click') ?? this.master)
    } catch {
      // No AudioWorklet (old browser): clicks fall back to oscillator bursts.
      this.clickNode = null
    }
  }

  /** Must be called from a user gesture before the first play. */
  async resume(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume()
    await this.clickReady
  }

  currentTime(): number {
    return this.context.currentTime
  }

  async load(id: string, data: ArrayBuffer): Promise<LoadedSample> {
    // decodeAudioData detaches the buffer; copy so callers can reuse theirs.
    const buffer = await this.context.decodeAudioData(data.slice(0))
    this.buffers.set(id, buffer)
    return { id, durationSeconds: buffer.duration }
  }

  isLoaded(id: string): boolean {
    return this.buffers.has(id)
  }

  duration(id: string): number | null {
    return this.buffers.get(id)?.duration ?? null
  }

  play(opts: PlayOptions): PlayHandle {
    const buffer = this.buffers.get(opts.sampleId)
    if (!buffer) throw new Error(`sample not loaded: ${opts.sampleId}`)

    const source = this.context.createBufferSource()
    source.buffer = buffer
    const gain = this.context.createGain()
    gain.gain.value = opts.gain
    const panner = this.context.createStereoPanner()
    panner.pan.value = opts.pan
    source.connect(gain)
    gain.connect(panner)
    panner.connect(this.busFor(opts.outputId))

    if (opts.loop) {
      source.loop = true
      source.loopStart = Math.min(opts.loop.startSeconds, buffer.duration)
      source.loopEnd = Math.min(Math.max(opts.loop.endSeconds, source.loopStart + 0.01), buffer.duration)
    }

    const when = Math.max(opts.when, this.context.currentTime)
    if (opts.durationSeconds !== undefined && !opts.loop) {
      source.start(when, opts.offsetSeconds ?? 0, opts.durationSeconds)
    } else {
      source.start(when, opts.offsetSeconds ?? 0)
    }

    let stopped = false
    source.onended = () => {
      stopped = true
      try {
        source.disconnect()
        gain.disconnect()
        panner.disconnect()
      } catch {
        // already disconnected
      }
    }

    return {
      id: `${opts.sampleId}@${when.toFixed(4)}`,
      get stopped() {
        return stopped
      },
      stop: (atTime?: number) => {
        if (stopped) return
        try {
          source.stop(Math.max(atTime ?? this.context.currentTime, this.context.currentTime))
        } catch {
          // stop() before start() resolves, or already stopped — both fine.
        }
      },
      setGain: (value: number) => {
        // A short ramp avoids zipper noise on live mute/volume moves.
        gain.gain.setTargetAtTime(value, this.context.currentTime, 0.01)
      },
      setPan: (value: number) => {
        panner.pan.setTargetAtTime(value, this.context.currentTime, 0.01)
      },
    }
  }

  scheduleClick(when: number, accent: boolean, clickGain: number): void {
    if (this.clickNode) {
      this.clickNode.port.postMessage({ type: 'tick', when, accent, gain: clickGain })
      return
    }
    // Fallback path: a scheduled oscillator burst.
    const osc = this.context.createOscillator()
    osc.frequency.value = accent ? 1760 : 880
    const env = this.context.createGain()
    env.gain.setValueAtTime(clickGain, when)
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.03)
    osc.connect(env)
    env.connect(this.busFor('click'))
    osc.start(when)
    osc.stop(when + 0.04)
  }

  setMasterGain(value: number): void {
    this.master.gain.setTargetAtTime(value, this.context.currentTime, 0.02)
  }

  /** Gain node for a logical output; unknown ids route to master. */
  private busFor(outputId?: string): GainNode {
    if (outputId && this.buses.has(outputId)) return this.buses.get(outputId)!
    return this.master
  }

  setBusGain(outputId: string, value: number): void {
    const bus = this.buses.get(outputId)
    if (bus) bus.gain.setTargetAtTime(value, this.context.currentTime, 0.02)
  }

  async close(): Promise<void> {
    await this.context.close()
  }
}
