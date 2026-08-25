# Live Lab offline performance

The rule the whole module is built around:

> **During Performance Mode, playback reads only from the local performance
> package. No ElevenLabs, no cloud storage, no Street Banker API, no internet.**

If connectivity disappears mid-show, the UI shows
`CLOUD OFFLINE — LIVE PLAYBACK UNAFFECTED — AI GENERATION PAUSED` and nothing
else changes. This is not a retry strategy; the network is simply not on the
playback path.

## The performance package

Building a package (`POST /api/live-lab/projects/:id/performance-package`):

1. The server assembles a `PerformanceManifest`
   (`packages/performance-project/src/manifest.ts`): project + setlist + scenes
   + clips + stems + pad map + MIDI mappings + outputs + `requiredFiles`, where
   each required file carries its package path, asset id, kind
   (clip/stem/click/cue/waveform), SHA-256 and byte size.
2. The server verifies its own copy of every file (existence, size, checksum,
   decodability) and refuses to hand out a package that could never be READY.
3. The client downloads every required file into IndexedDB
   (`IndexedDbCacheStore`, one database per project), hashes each cached file
   **on the device**, and reports the results to
   `POST /api/live-lab/performance-packages/:id/verify`.
4. Only when the device's checksums match the manifest exactly does the package
   reach **READY**.

Status flow: `NOT READY → CACHING → VERIFYING → READY | ERROR`.

The conceptual layout mirrors a show folder:

```
SHOW/
├── clips/<assetId>.wav
├── stems/<assetId>.wav
├── click/<assetId>.wav
├── cue/ · waveforms/
└── manifest (stored server-side, embedded in the package record)
```

## What verification checks

`verifyPackage` reports **every** failure, not just the first — a tech fixing a
package at soundcheck needs the complete list:

- missing files, size mismatches, checksum mismatches, undecodable audio
- scenes with no audio anywhere (no clip and no stems on their song)
- MIDI mappings pointing at targets that are not in the package
- stems/clips referencing assets with no cached file (`cloud_only_asset`)
- click stems not cached as click files
- insufficient local storage for the package size

Missing anything ⇒ the package is ERROR and the UI will not claim SHOW READY.

## Performance Mode loading

`useLiveEngine(bundle, 'cache')` reads audio exclusively from the package cache
by manifest path. A missing cached file makes the affected pad show **ERROR** —
the engine does not quietly reach for the network mid-show.

## Crash recovery

Performance state (current song/scene, stem states, tempo, click, lock) is
persisted locally on every engine event. After a crash or reload the app
**offers** `RESTORE PERFORMANCE`; restoring reinstates state without starting
audio — sound after a crash must be a deliberate act. See
[LIVE_ENGINE.md](LIVE_ENGINE.md).

## Analytics

Performance events (set start/end, songs, scene launches, pad hits, errors,
crash recoveries) are collected locally and synced to
`POST /api/live-lab/projects/:id/events` when the device is online — after the
show, in batches, and only what the client chooses to send. Reliability data,
not surveillance.

## How the cache is verified

`IndexedDbCacheStore` is exercised in real Chromium by
`tests/e2e/live-lab-browser.spec.ts`, not only through the in-memory
implementation. It asserts a byte-identical round-trip, that the store's digest
agrees with a digest of the source bytes, that flipping a single byte changes
that digest, that a non-WAV is refused as undecodable, and that a cached show
**survives a page reload** — the property everything above depends on, and the
one an in-memory store can never demonstrate.

Storage headroom (`estimateAvailableStorageBytes`) and the persistence request
(`requestPersistentStorage`) are checked against the real `navigator.storage`,
which exists only in a secure context; localhost qualifies, as does production
over HTTPS.
