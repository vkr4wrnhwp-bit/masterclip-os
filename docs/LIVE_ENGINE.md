# Live Engine

`@masterclip/live-engine` is the performance core: everything that decides what
plays, and exactly when, during a show. It is a plain TypeScript package with no
React, no HTTP, no database — the isolation that lets the same engine run in
the browser today and inside a native desktop shell later.

## Architecture

```
LiveAudioEngine ──schedules against──▶ AudioBackend (interface)
     │                                    ├── WebAudioBackend  (browser: AudioContext,
     │                                    │    buffer sources, AudioWorklet click)
     ├── tempo.ts    beat math            └── TestAudioBackend (vitest: manual clock,
     ├── stems.ts    mute/solo/gain            records every scheduled play)
     ├── recovery.ts crash snapshots
     └── worklet.ts  click processor source
```

The engine never touches the network. Audio enters through
`loadAudio(assetId, bytes)` — bytes come from the local performance package in
Performance Mode, or from signed URLs while editing. If the internet disappears
mid-show, nothing in this package notices.

## Scheduling model

The engine uses the standard lookahead pattern:

- The **backend clock** (`AudioContext.currentTime` in the browser) is the only
  timeline. UI timers never decide when audio starts.
- `tick()` runs every ~25 ms. Anything due within the **lookahead window**
  (120 ms by default) is scheduled onto the backend clock at its exact time —
  scene launches, scene stops, click ticks, follow actions.
- A scene triggered early is **queued**: its launch beat is computed from the
  scene's quantization (`none`, `1/4`, `1/2`, `1bar`, `2bars`, `4bars`,
  `scene_end`) via `nextBoundaryBeat`, the UI shows QUEUED, and the audio is
  scheduled when the boundary enters the lookahead window. Triggering exactly on
  a boundary launches on that boundary (epsilon-tolerant), not a bar later.
- The outgoing scene's sources are stopped **at the incoming scene's launch
  time**, so transitions are sample-adjacent, not tick-adjacent.

Beat position is derived, never accumulated: `beat = (now − zeroTime) / spb`.
Tempo changes rebase `zeroTime` so the current beat is preserved (`retime`).

## Transport and songs

`startSong(itemId)` selects a set item, loads its stems into the `StemDeck`,
and starts all stem sources at the same backend time (with ~50 ms of scheduling
headroom so they begin together). Scenes launch on top; `nextSong`/`prevSong`
move through the setlist; `stopAll()` is the emergency stop — every handle, now.

Follow actions run at a non-looping scene's end beat: `stop` (clips carry their
own duration), `next_scene` (sort order), `target` (explicit scene id). Looping
scenes have no end beat — they loop until the next trigger or stop.

## Stems

`StemDeck` resolves the one piece of mixer logic V1 needs: when any stem is
soloed, only soloed stems are audible; mute always wins, including over solo on
the same stem. Gain/pan changes reach playing handles through short ramps
(no zipper noise) without restarting sources.

## Click

The click is an AudioWorklet processor (`worklet.ts`) that synthesizes ticks
sample-accurately at scheduled context times — a `setTimeout` click drifts,
this one cannot. Ticks are scheduled per-beat inside the lookahead window with
accents on downbeats. Browsers without AudioWorklet fall back to scheduled
oscillator bursts. See [LIVE_LAB_AUDIO.md](LIVE_LAB_AUDIO.md).

## Crash recovery

`recovery.ts` defines the `PerformanceSnapshot` schema and stores
(`LocalStorageSnapshotStore` in the browser, `MemorySnapshotStore` in tests).
The app persists a snapshot on every meaningful engine event. After a reload
the UI **offers** RESTORE PERFORMANCE; restoring reinstates mixer and position
state only — audio never restarts without an explicit trigger.

## Testing

`TestAudioBackend` gives tests a manual clock (`advance(seconds)`) and a full
record of scheduled plays (`when`, `stoppedAt`, gain changes, loop points,
click ticks). The quantization, transition, stem, follow-action, click and
recovery behaviors in `packages/live-engine/test/` all assert against the audio
timeline, not the UI.

## Portability

Everything above the `AudioBackend` interface is platform-neutral. The desktop
build supplies a native backend (CoreAudio/WASAPI/JACK via the shell) plus a
filesystem `CacheStore` and a native `MidiSource` — the engine, the scheduling
logic, and every test stay identical. See [LIVE_LAB_DESKTOP.md](LIVE_LAB_DESKTOP.md).
