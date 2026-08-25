# Live Lab ↔ Stage Control

Live Lab describes the show; Stage Control runs the room. The interfaces exist
now (`packages/performance-project/src/stage-control.ts`) so the two systems
can integrate without either re-modeling the other.

## The boundary

**Live Lab never controls IEM or monitor levels.** Anything safety-critical for
a performer's ears stays on the Stage Control side. The handoff is a
description, not a control channel — there is no message in either direction
that changes a gain in the other system.

## Live Lab → Stage Control

`GET /api/live-lab/projects/:id/stage-control` returns a
`StageControlHandoff` (zod-validated, versioned):

- set name, artist, master tempo, time signature, expected duration
- the ordered setlist: per song — title, type, BPM, key, duration,
  **click requirement** (derived from whether the song carries a click stem),
  stem→output assignments, notes
- scene transitions (from/to scene per song with launch quantization)
- the output list (master/cue/click/stem/custom with device/channel fields)
- playback-rig details (`live-engine/web-audio`, platform, offline-capable)
- stage notes

The workspace's "Stage Control export" button downloads this document as JSON.

## Stage Control → Live Lab

`POST /api/live-lab/projects/:id/stage-control` accepts a
`StageControlSession`:

- show session id, venue, soundcheck time
- monitor assignments (performer → mix, informational)
- technical notes

It is recorded org-scoped in the audit log against the live project, giving the
show's timeline a venue context without granting Stage Control any write access
to the set itself.

## Versioning

Both documents carry `kind` and `version` literals. Breaking changes bump the
version; consumers reject kinds/versions they don't understand rather than
guessing.
