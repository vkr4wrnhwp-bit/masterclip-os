# MOTION Phase 3 — Native Music Video Timeline

Date: October 12, 2026
Branch: codex/motion-music-timeline-20261012
Parent: codex/motion-beat-intelligence-20261012 (draft PR #31)
MOTION-only, stacked development. Never merge, deploy or spend AI credits without independent owner approval.

## What the feature does
- The project-scoped **Music Video Timeline** tab selects only human-approved, project-local video masters and currently authorized audio.
- A creator orders, removes and reorders up to 16 real clips, edits each video source in/out, and chooses the recorded song start.
- Manual **Snap cut to beat** consults Beat Intelligence's measured data; it is disabled for low-confidence rhythm and is always subject to user review.
- A browser sequence previews the genuine source files. It is not frame-accurate and must not be represented as the final output.
- Saving stores a non-destructive, optimistic-versioned edit decision list in `motion_music_timelines` (migration 0005). Concurrent edits return a conflict instead of overwriting another editor's cut.
- A director can request **Assemble MP4 from saved cut**. The API checks all clips and recording rights again and queues `media.music_timeline`, with a dedupe key tied to the exact saved version. Rendering is handled only in the media worker.
- FFmpeg trims and letterboxes each approved source into standard silent H.264/24fps segments, joins straight cuts, then adds the original recording's precise selected segment. Output is ffprobe-verified. It does not upscale information, add AI transitions, auto-transcribe, mix original AI audio or publish.
- A verified MP4 delivery is registered once per timeline version using migration 0006 (`motion_timeline_exports` unique on timeline/version), with immutable source-video and audio lineage. Concurrent job attempts can compute in parallel but only one transactional export is published. Other attempts clean up their unregistered storage blobs.
- Masters, source WAV/MP3, clips, shot versions and previous timeline versions are preserved. A new edit never rewrites the prior finalized output.
- The UI reports pending/running/completed/failed states from the durable media queue; completed exports are playable through signed URLs subject to current lineage-based rights checks.

## Product truth and limits
- One music bed and straight cuts only. No multi-audio mixing, timeline transitions, motion graphics, speed ramps, auto-choreography, instant publishing or full song structure intelligence.
- Browser real-time preview can drift on seek/buffering. The FFmpeg MP4, not the browser, is the render of record.
- Frame size follows the first approved source's aspect, capped at the rendering policy. Every later shot is letterboxed rather than silently cropped.
- A cut has at most 16 clips and 60 seconds. Artist/editor can author; director permission is required to execute finishing.
- Beat Intelligence estimates BPM and pulses; it does not reliably detect song sections or music bars.
- The queue's version-keyed dedupe and unique export guarantee one registered derivative, but if two workers race they may both consume local CPU before the loser yields. An explicit timeline-level work lease is a later optimization for high-load production.
- Reopening an old saved timeline version is not supported as a separate editable draft; version is advanced with optimistic locking. Render workers receive an immutable copy of the submitted spec.
- S3-based prior presigned URLs are not instantly revocable. Do not deploy without separate S3 rights gateway validation.

## Mandatory verification
- CI: typecheck, lint/security guard, full tests, build on actual reviewed HEAD.
- Technical test: decode two video files, trim at different in/out, normalize portrait/landscape framing, join and insert a real audio track; independently probe output streams, duration, dimensions, and source checksums.
- API and pipeline: unauthorized/foreign master denial, source music rights, live human review, project boundaries, optimistic-version stale conflict, worker queue dedupe, exactly one export row, and signed playable output from an approved master.
- Staging: run migrations 0004, 0005, 0006 in order; back up and verify restore. Test one and two workers, crash/restart, storage access, missing codec and FFmpeg failure recovery.
- Real iPhone and Android QA: clip reordering, touch areas, trim numeric controls, song preview, playback after interruption, completion status after browser restart, and finished video output.

## Release rule
This PR must remain draft until PR #30 (core Quick Create) and PR #31 (Beat Intelligence) pass all staging gates and are separately approved for merge. Claude retains all external Street Banker integration work. No production or staging deployment has been carried out by this branch.
