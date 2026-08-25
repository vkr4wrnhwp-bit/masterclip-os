# Live Lab desktop migration plan

The desktop application (`apps/desktop-live`, not yet created) is Phase 4. The
work done now is the part that matters: keeping the Live Engine portable so the
desktop build is a packaging exercise, not a rewrite.

## What already ports unchanged

- `@masterclip/live-engine` — everything above the `AudioBackend` interface:
  tempo, quantization, transport, scenes, stems, click scheduling, recovery.
  Its unit tests run against `TestAudioBackend` and stay authoritative.
- `@masterclip/midi-engine` — parsing, Learn, mapping application. Only the
  `MidiSource` implementation is platform-specific.
- `@masterclip/performance-project` — records, manifest, verification,
  Stage Control interfaces.
- `@masterclip/performance-cache` — the `CacheStore` interface; the desktop
  adds a filesystem implementation beside the IndexedDB one.
- The React workspace/performance views, if the shell embeds a webview.

## What the desktop adds

| Concern | Web today | Desktop |
|---|---|---|
| Audio backend | WebAudioBackend | native backend (CoreAudio/WASAPI/ALSA-JACK) implementing `AudioBackend`, real multi-output |
| Outputs | logical buses mixed to stereo | `LiveAudioOutput.deviceId/channelIndex` mapped to interface channels |
| MIDI | Web MIDI (permissioned, browser-dependent) | native MIDI implementing `MidiSource`; more reliable, hot-plug, virtual ports |
| Cache | IndexedDB | offline-first filesystem package store, larger caches |
| Crash isolation | one tab | engine process separated from UI process |
| Sync | Ableton Link, MIDI Clock | native additions behind new engine hooks |
| Stage Bridge | — | desktop-side integration |
| Controller profiles | generic MIDI Learn | presets layered *on top of* Learn, never replacing it |

## Tauri vs Electron

**Recommendation: prefer Tauri** if native audio/MIDI requirements and team
skills make it practical; use Electron if fastest reuse of the existing
JS/React code matters more.

- **Tauri** — small binaries, a real native (Rust) side where low-latency audio
  (cpal/JACK) and MIDI (midir) live comfortably, engine-off-the-UI-thread for
  crash isolation. Cost: a Rust `AudioBackend`/`MidiSource` bridge (the webview
  can keep running the TS engine for logic while audio I/O moves native, or the
  engine logic itself is ported later — the interface is the contract either
  way).
- **Electron** — everything stays TypeScript (native addons for audio/MIDI),
  fastest path to a running desktop app; heavier, and Chromium's audio stack
  limits multi-device output quality.

The decision can be made at Phase 4 kickoff without refactoring: both shells
consume the same packages.

## Migration steps (when Phase 4 starts)

1. Scaffold `apps/desktop-live` (shell of choice) rendering the existing
   Performance Mode view against the shared engine.
2. Implement filesystem `CacheStore` + package import/export from the same
   manifest format.
3. Implement native `MidiSource`; keep Web MIDI as the webview fallback.
4. Implement native `AudioBackend` with device/channel routing; map
   `LiveAudioOutput` rows onto real channels; add an output-assignment UI.
5. Wire offline-first project sync against the existing API (`live_lab.desktop`
   entitlement gates it server-side).
6. Add Link/MIDI Clock behind explicit engine hooks; controller preset packs on
   top of MIDI Learn.
