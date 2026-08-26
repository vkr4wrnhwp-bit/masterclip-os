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

## What is stored on the device

Two things, and both are needed:

- **The audio**, in IndexedDB, keyed by manifest path.
- **The show itself** — setlist, scenes, pad map, MIDI mappings and the
  manifest — in `localStorage` under `masterclip.live.show.<projectId>`,
  written when the package is built.

The second used to be missing, and the omission defeated the first. Performance
Mode loaded its bundle over the network on every entry, so at a venue with no
connection it rendered **Request failed** and the verified audio cache was never
reached. Caching a show's audio while leaving the show itself in the cloud is
not local-first; it only looks like it from inside an already-running session.

Two more things had to hold before any of that was reachable after a crash:

- **The application itself.** A service worker (`apps/web/public/sw.js`) caches
  the app shell, so reloading with no network loads the app instead of
  `ERR_INTERNET_DISCONNECTED`. It never caches `/api/` — the app already knows
  how to be offline, and a worker answering an API call from a stale cache
  would make a performer trust data that is no longer true.

  The shell is cached **at install**, document and scripts together, not merely
  as it is used. On a first visit the page's own scripts are fetched before the
  worker controls anything, so runtime caching alone never sees them: load the
  app, build a show, go offline without reloading — what a performer actually
  does — and the reload at the venue would find no application to load. The
  browser's own HTTP cache hides this on a warm machine, which is why the
  offline spec asserts the bundle is in the worker's cache rather than trusting
  that the reload succeeded.

  Assets the current document no longer names are dropped when a document is
  fetched over the network. Filenames are content-hashed, so nothing overwrites
  them and every deploy would otherwise add a version that stays forever — and
  this origin's storage is shared with the show audio, which the app refuses to
  mark READY when storage is short. Shell growth is not free here.
- **The signed-in identity.** `/api/auth/me` fails when the server is
  unreachable, and that used to read as *signed out* — a sign-in form nobody at
  a venue can complete. A server that answers "no" still signs you out; a
  server that cannot be answered at all does not. This grants nothing: every
  API call still needs a real session cookie, and the only data it unlocks is
  what this same user already cached on this device.

`loadShowBundle` prefers the network and falls back to the stored copy. That
order is deliberate: a set edited since the last package should be picked up
when there is a connection to pick it up from, so the stored bundle is the
floor rather than the default. With no connection and no stored bundle there is
genuinely no show to run, and the error stands.

## How the cache is verified

The offline show is demonstrated end to end by
`tests/e2e/live-lab-offline.spec.ts`: a set is built, owned audio uploaded and
attached, the package built and cached, and then the browser is taken offline
with `context.setOffline(true)` — checked unreachable inside the test — before
Performance Mode is entered and driven.

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
