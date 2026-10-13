# MOTION release-gate checklist — safe staging drill

**Status:** Draft PR #30 only. Do not execute on customer production. Claude handles Street Banker cross-suite integrations; this document covers MOTION itself.

## 1. Static and database gates

- Require a successful full CI for the actual reviewed head: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- Back up the staging database and storage first; confirm a restore works.
- Review pending schema migrations and apply the forward-only `0004_media_finish_leases` via the repository's migration runner on staging **before the new workers start**.
- Check that `media_finish_leases(master_id,owner_token,expires_at,updated_at)` exists and that rerunning migrations applies nothing new.
- Verify all workers share the SAME database. A local SQLite file per worker does not provide shared locking; deploy PostgreSQL or a genuinely shared SQLite database with correct concurrency semantics.
- Staging ffmpeg must support AAC, H.264 and the subtitles/libass filter. Check font fallback and sample output with `ffprobe`.

## 2. Two-worker lease/crash test

- Use a short, explicitly rights-cleared staging WAV and an approved sandbox-rendered video; no paid provider calls.
- Start two separate media workers with the same database and storage. Enqueue song-moment finishing twice and check that the dedupe key returns the same queue ID.
- Simulate concurrent recoveries: only one per-master fencing token should own the lock. A competing job must defer without registering an asset.
- Kill the lock-owning worker in the middle of processing, wait for BOTH queue lease and media lease recovery, then verify one surviving worker can finish and register exactly one derivative.
- A stale former worker must fail its final fenced commit. Database asset, lineage and deliverable records must remain consistent.
- Repeat for captioned finishing and verify the clean audio-video master stays untouched.
- Verify director-only retry after terminal failure, duplicate retry dedupe, and persisted status after a full browser reload. No internal stack/error paths should be visible to artists.

## 3. Rights revocation

- Create a signed local MP4 delivery link before revocation and verify it plays.
- Revoke source-audio rights; request the SAME previously issued link again. MOTION should return 403 for new local serving. Also verify the asset listing withholds a new URL.
- Run revocation during a slow local FFmpeg finish: final fenced registration should refuse to publish the derivative.
- Test unrelated non-audio assets still work normally.
- **S3 exception:** Already-issued direct S3 presigned links will remain usable until their underlying signature expires. The shorter 120s lifetime limits exposure but does not provide instant revocation. Do not advertise instant revocation in S3 until a first-party authenticated proxy, gateway, or provider token invalidation has been implemented and tested.

## 4. Physical mobile checks

- iPhone Safari and Android Chrome must independently pass audio playback even when the phone has mute settings, scrubbing at 0.1-second precision, waveform loading, caption editing, long text, choosing treatments, saved draft recovery, compare view, background app/resume and Masters job status after relaunch.
- Verify safe areas, keyboard overlap, 320px widths, contrast, zoom, large touch targets and screen-reader labels.
- Rendering should survive browser exit. No screen should say an MP4 is ready until the worker completes and an actual signed derivative can be played.

## 5. Evidence and decision

Record the tested staging commit SHA, database dialect, worker count, ffmpeg/libass versions, output SHA256, screenshots of browser/mobile checks, failure/recovery logs (secrets removed), sample derivative lineage and signed URL rejection. Do not merge or deploy PR #30 without these recorded results and owner review.

## Rollback
Stopping new feature requests and workers requires preserving customer originals, generated videos, immutable shot versions and all previously registered delivery assets. A forward-only migration should not be rolled back destructively; revert the application feature code only after verifying worker compatibility and job drain/retention.
