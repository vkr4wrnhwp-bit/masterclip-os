/**
 * The click AudioWorklet.
 *
 * The processor source is shipped as a string and loaded through a Blob URL,
 * so no bundler configuration is needed and the same code can be reused by the
 * desktop shell. The worklet synthesizes click ticks sample-accurately at
 * scheduled context times — a `setTimeout` click drifts; this one cannot.
 */

export const CLICK_PROCESSOR_NAME = 'livelab-click'

export const CLICK_PROCESSOR_SOURCE = `
class LiveLabClickProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ticks = []
    this.port.onmessage = (event) => {
      const data = event.data
      if (data && data.type === 'tick') {
        this.ticks.push({ when: data.when, accent: !!data.accent, gain: data.gain ?? 0.7 })
        // Keep the queue sorted and bounded.
        this.ticks.sort((a, b) => a.when - b.when)
        if (this.ticks.length > 64) this.ticks.length = 64
      } else if (data && data.type === 'clear') {
        this.ticks = []
      }
    }
  }

  process(inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const channel = output[0]
    const frames = channel.length
    const start = currentTime
    const dt = 1 / sampleRate
    const tickSeconds = 0.03

    for (let i = 0; i < frames; i++) {
      let sample = 0
      const t = start + i * dt
      for (const tick of this.ticks) {
        const age = t - tick.when
        if (age >= 0 && age < tickSeconds) {
          const freq = tick.accent ? 1760 : 880
          const envelope = 1 - age / tickSeconds
          sample += Math.sin(2 * Math.PI * freq * age) * envelope * envelope * tick.gain
        }
      }
      channel[i] = sample
    }
    for (let c = 1; c < output.length; c++) output[c].set(channel)
    // Drop ticks that have fully sounded.
    const horizon = start + frames * dt
    this.ticks = this.ticks.filter((tick) => tick.when + tickSeconds > horizon)
    return true
  }
}
registerProcessor('${CLICK_PROCESSOR_NAME}', LiveLabClickProcessor)
`

/** Loads the click processor into a context once. Returns the ready worklet node. */
export async function createClickNode(context: AudioContext): Promise<AudioWorkletNode> {
  const blob = new Blob([CLICK_PROCESSOR_SOURCE], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await context.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  return new AudioWorkletNode(context, CLICK_PROCESSOR_NAME, { numberOfInputs: 0, outputChannelCount: [2] })
}
