# MOTION — Artist-directed song structure planning

A native incremental feature stacked on PR #33 (Auto-Assembly Director), #32 (Music Video Timeline), #31 (Beat Intelligence), and #30 (Quick Create). This is an unmerged draft.

## Implemented
- User-created, track-relative musical annotations: intro, verse, pre-chorus, chorus, bridge, outro, instrumental and custom passages.
- Strict chronological, non-overlapping and in-track validation (up to 32 markers per song).
- Authorized project editors can save sections with optimistic version checking. Old browser tabs cannot silently overwrite newer annotation versions.
- The original audio and all prior timeline masters are preserved. Annotation saving never triggers AI generation, FFmpeg composition, credit spending or publication.
- The Timeline editor can display, modify, remove and reload markers and choose a labelled section's start as the next cut's soundtrack start.
- MOTION's Auto-Assembly Director uses the selected song start when proposing editable clip sequences. Section labels remain a human-authored source of truth.

## Important product truth
No automated verse/chorus/bridge recognition, stem separation, lyrics transcription, chord identification or downbeat detection is present. Beat Intelligence still estimates tempo and pulses, not semantic song structure. Applying a structure marker does not render a video; finished MP4s require an explicit, separately authorized assembly action.

## QA before merge
- CI: run TypeScript typecheck, lint, full tests and build on the latest head commit.
- Migration `0007_motion_music_sections` is forward-only and must be staged after the preceding 0004-0006 MOTION migrations; back up database and verify restore first.
- Test editor permissions, cross-project/foreign audio denial, revocation, overlapping and out-of-bounds annotations, duplicate identifiers, stale version conflicts and reload state.
- Physical mobile QA: keyboard/safe-area handling, small-screen fields, marker starts/ends, timeline scrolling and player state on iPhone and Android.
- No staging or production deployment, paid provider operation or cross-suite Street Banker integration has been performed.
