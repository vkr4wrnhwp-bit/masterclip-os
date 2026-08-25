# Live Lab audio

## The playback path

The web engine is built on the Web Audio API. `<audio>` tags are never used for
performance playback — an `AudioBufferSourceNode` is the only primitive that
starts at an exact `AudioContext` time, and exact start times are what
quantized launching means.

```
decoded buffer ─▶ AudioBufferSourceNode ─▶ GainNode ─▶ StereoPannerNode ─▶ bus
buses: master ─▶ destination
       cue    ─▶ destination   (own gain node)
       click  ─▶ destination   (fed by the AudioWorklet click)
```

- Every clip/stem gets its own source + gain + panner chain; live gain and pan
  moves use `setTargetAtTime` ramps (~10 ms) so mutes don't click.
- A small per-voice `AnalyserNode` (fftSize 256) feeds the stem meters —
  cosmetic reads on the UI interval, never work on the audio thread.
- Loop points map to `source.loopStart/loopEnd`, clamped to the buffer.
- `decodeAudioData` is fed a copy — decoding detaches buffers, and the cache
  still owns its bytes.
- The context is created with `latencyHint: 'interactive'` and resumed from a
  user gesture (`backend.resume()`), which browsers require before sound.

## AudioWorklet

The click synth is an `AudioWorkletProcessor` (source shipped as a string,
loaded through a Blob URL — no bundler configuration, reusable by the desktop
shell). The engine posts `{when, accent, gain}` messages; the processor renders
short sine bursts sample-accurately at those context times. Browsers without
AudioWorklet fall back to scheduled oscillator bursts.

## Output abstraction

Routing goes through logical outputs, not devices:

```ts
interface LiveAudioOutput {
  id: string
  name: string
  type: 'master' | 'cue' | 'click' | 'stem' | 'custom'
  deviceId?: string
  channelIndex?: number
}
```

The web MVP mixes master, cue and click into the stereo device output, but each
is already a separate gain bus, and every clip/stem row stores an `outputId`.
Where the browser supports `AudioContext.setSinkId` (Chromium), the Live Lab
settings screen routes the whole mix to a chosen output device and remembers
the choice per device; cue and click bus levels are adjustable there too.
The desktop backend maps the same logical outputs onto real interface channels
(separate vocal/drums/bass/music sends, click-only outputs, FOH feeds) without
any change above the backend interface. Stage Control/IEM routing stays on the
Stage Control side — see [LIVE_LAB_STAGE_CONTROL.md](LIVE_LAB_STAGE_CONTROL.md).

## Formats

Uploads accept WAV and MP3, validated by magic bytes (never by filename or the
declared Content-Type). Generated audio is 16-bit PCM WAV at 22.05 kHz from the
mock provider; real providers may deliver richer formats — anything
`decodeAudioData` handles plays.

## Synthesis (`@masterclip/ai-audio`)

`wav.ts` contains a pure-TypeScript synthesizer (kick, hats, bass, pad, riser,
click) and a PCM16 WAV encoder, deterministic per seed. It exists so the mock
AI provider, the demo seed, and every test operate on genuine, decodable,
tempo-locked audio rather than empty placeholder files — checksums, package
verification, and the engine all exercise the real path.
