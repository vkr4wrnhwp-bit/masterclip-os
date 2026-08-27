# Live Lab runbook

The pre-show and mid-show procedures. The design intent behind all of it:
**the show must continue**, and every recovery path must be deliberate.

## Before the show (soundcheck checklist)

1. Open the project workspace. Confirm every setlist item shows its scenes and
   stems, and no pad reads ERROR.
2. **Build show package.** Watch the status walk CACHING → VERIFYING → READY.
   Anything but READY comes with the complete issue list (missing files,
   checksum mismatches, undecodable audio, mappings pointing at nothing,
   storage too small). Fix, rebuild, re-verify. Do not go on stage without
   READY — that word is a claim about bytes on *this device*.
3. Open **Performance Mode** on the machine that will run the show. Confirm the
   status row: CACHE READY · MIDI · AUDIO · CLICK · CLOUD.
4. Plug in the controller. If MIDI shows disconnected, check the browser's MIDI
   permission; mappings live server-side and in the package, so re-plugging
   needs no re-learning. No hardware? The MIDI screen's mock controller
   exercises every mapping.
5. Trigger one pad from hardware. The first sound requires a user gesture
   (browser audio policy) — do this at soundcheck, not at doors.
6. Enable the click if the drummer needs it; confirm it lands on the grid.
7. **LOCK PERFORMANCE.** Locked mode blocks navigation away and accidental
   edits; unlock is explicit.
8. Optional: export the Stage Control handoff and hand it to FOH.

## During the show

- **Internet dies:** the banner reads `CLOUD OFFLINE — LIVE PLAYBACK
  UNAFFECTED — AI GENERATION PAUSED`. Do nothing. Playback reads only from the
  local package; nothing on the audio path touches the network.
- **Controller dies:** the MIDI indicator drops. Pads remain fully operable by
  touch/mouse. Re-plugging re-binds automatically.
- **A pad shows ERROR:** its audio is not in the local cache. It will not
  half-play; other pads are unaffected. (This is what package verification
  exists to catch before doors.)
- **Wrong scene launched:** trigger the right one — quantization keeps the
  transition on the grid. Truly wrong song: NEXT/PREV SONG.
- **Everything must stop now:** EMERGENCY STOP. Every source stops immediately.

## After a crash or reload

The app offers `RESTORE PERFORMANCE` with the saved timestamp. Restoring
reinstates song position, stem states, click and lock — **it does not start
audio**. Trigger the next scene deliberately. Declining discards the snapshot.

If you were locked before the crash you come back locked, which is the point:
the surface you did not want touched is still the surface you do not want
touched. Unlocking is the same explicit tap it always was.

## After the show

- Unlock, exit Performance Mode.
- Analytics (songs played, scenes launched, pads hit, errors, crash
  recoveries) sync automatically once online, in batches; nothing blocks on it.

## Operational failure modes

| Symptom | Cause | Action |
|---|---|---|
| Package stuck VERIFYING | device checksums never reported | re-run Build show package; check browser storage quota |
| Package ERROR with `insufficient_storage` | IndexedDB quota | free site storage or shrink the set's audio |
| No sound at all | AudioContext never resumed | tap any pad once (user gesture), check AUDIO indicator |
| Click drifts | it cannot (AudioWorklet, sample-accurate) — if it *sounds* off, the stem audio itself is off-grid | check stem render |
| AI job stuck GENERATING | worker not running | `pnpm dev` runs it; jobs are durable and resume with the worker |
| 403 `entitlement.missing` | org not provisioned | grant capabilities via `EntitlementService` (seed grants flagship) |
