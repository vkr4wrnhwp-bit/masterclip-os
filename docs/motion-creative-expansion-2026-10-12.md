# MOTION native expansion — captions, variations and treatments

Date: 2026-10-12
Branch: codex/motion-native-quick-create-20261011 (draft PR #30 targeting motion-live)
This is a native MOTION application change only. No Street Banker core, Vault, Reach, Claude integration, Stripe, Shopify, provider spend, or live deployment.

## Built on existing capabilities

- Existing Quick Create: project-local authorized WAV/MP3, decoded PCM waveform, in/out trim, creative look, saved shot versions, professional Shot Builder handoff.
- Existing render system: model routing, cost authorization, real render jobs, technical QC, human Review Grid, approved masters, delivery assets with source lineage.
- Existing storage: project IDs, signed asset URLs, local or S3-compatible file storage with project-scoped permissions.

## New workflow A — manually synchronized captions

1. Open film > Quick Create; choose source audio and in/out.
2. Add 1–32 caption lines with exact start/end measured **relative to the selected clip**, with nonoverlapping times and maximum 160 characters per line.
3. Scrub/play the source and inspect which line is active at the playhead. This is a timing preview, not a final render.
4. Confirm usage authorization and save. The caption data becomes part of the immutable shot version. Saving does not burn text or spend credits.
5. Render a shot using the existing Shot Builder, approve a genuine result in Review Grid, promote to a master.
6. In Masters, first **Finish with selected song**, then **Burn captions into a separate MP4**. Only a project director can execute the finishing operations.
7. The backend rechecks the exact rendered shot version, review and current audio rights. FFmpeg reads a sanitized SRT file and burns visible text into the MP4; the output is probed for video/audio and duration before it is registered.
8. MOTION stores the derived MP4 as a delivery asset with provenance to the clean approved music-video source; both original recording and clean video remain unchanged. Subsequent sequential requests reuse the verified derivative.

Not automatic transcription, word-level speech recognition, karaoke tracking, mastering, social publication or a guarantee of caption accuracy. Users supply/approve text and timing.

## New workflow B — compare real variants across shots

1. From Quick Create, save an alternative direction/look as a new shot. The source shot is recorded, while the source version and media are preserved.
2. Render each alternative using the existing Shot Builder and human Review Grid; no paid provider actions occur merely from making a draft.
3. Film > Compare variants: select a source shot and a related alternative. Cross-shot lineage is resolved exclusively within the accessible project's loaded shot list; cycles and missing parents are not treated as verified relationships.
4. Side-by-side panels fetch the **actual** available candidate outputs, offer play/pause/restart, and show provider, render status, approval state, measured duration/format, reported actual cost and existing QC action.
5. Empty candidates are explicitly reported. The comparison does not guess results or choose a winner; keep approval in the original Review Grid.

The older Review Grid's same-shot candidate comparison remains intact.

## New workflow C — project reusable creative treatments

1. Choose a supported look, aspect and creative direction in Quick Create.
2. Name and save a treatment; the server checks project editor access and persists it into the existing project's style-bible record.
3. The treatment can be selected again within that film. There are no cloned media assets or separate catalog/database. Maximum 24 named treatments per project; duplicate names (case-insensitive) are rejected.
4. Treatment selection pre-fills direction, look and format. It does not submit, approve, or publish a render.

## Security and reliability gates still open

- Physical iPhone Safari and Android Chrome QA: audio seeking, signed playback, forms, project tabs, preview and large-file behavior.
- FFmpeg installed with subtitles/libass support on each staging worker, plus predictable font fallback. Unsupported environments must visibly fail, never fabricate output.
- Concurrency: song/caption finishing is synchronous and only sequentially idempotent. Migrate costly jobs to the existing durable queue, with cross-worker locking, before high-volume rollout.
- Storage: verify S3 materialization, signed URL delivery, record-creation failures and cleanup.
- Revocation: previously minted signed URLs are time-limited but cannot currently be instantly recalled. Enforce lineage-based read restrictions and token invalidation before public commercial use.
- Audio/video finishing currently replaces video soundtrack rather than mixing; loudness and distribution-safe mastering require a separate measured pipeline.
- No automatic captions or translations; no automated quality verdict.
- Only existing, authorized provider output qualifies as a source. Third-party generation providers still need independent production integration tests.
- Saved style-bible edits should gain concurrency protection when multiple editors modify the same project simultaneously.

## Automated checks

- Typecheck/lint/test/build on GitHub Actions; final HEAD results must be verified.
- New and extended tests:
  - motion-captions.test.ts: SRT text/timing and actual burned white text in decoded output frames.
  - motion-variation-compare.test.ts: real lineage and broken ancestry refusal.
  - motion-audio-api.test.ts: editor authorization, duplicate saved treatments, source-linked draft variations, preserved caption data and no render submission.
  - tests/pipeline.test.ts: sandbox render → human approval → master → clean song MP4 → burned-caption MP4 → lineage → repeat requests → revoked audio-rights failure.

## Rollback

The draft pull request is unmerged. Close PR #30 to leave motion-live and production unchanged. No migrations or source-media overwrites were introduced. The new caption/variant fields default safely for legacy shots. If deployed after independent approval, stop new feature endpoints before reverting UI and code, preserve all project media and derived assets for recovery, and never delete existing client records as part of rollback.

## October 12 concurrency and rights hardening

- Forward-only migration `0004_media_finish_leases` introduces per-master database leases. Apply this migration to staging before starting upgraded workers or enabling new finishing endpoints; existing data is not deleted.
- Both the song and caption finishing workers now serialize work on a master, renew the lease and defer competing jobs. Registration of the derivative asset, parent lineage and delivery row happens atomically under a fencing-token check.
- A separate source-audio rights check runs inside the fenced database transaction. If authorization is revoked during FFmpeg processing, its output is not registered.
- Local signed media reads now re-check every recorded audio ancestor and return 403 after revocation, even if the caller presents a previously issued signed URL. New URLs are withheld after revocation and playback of sensitive local media uses no-store caching.
- For S3, newly requested audio-related presigned links use a 120-second lifetime after the authorization check. Already-issued direct S3 provider URLs **cannot be instantly recalled** by this code; storage/gateway revocation remains a release gate. Already-downloaded local user copies cannot be recalled either.
- The explicit director-only failed-job retry endpoint remains in place. Queue dedupe avoids common duplicate clicks, but administrative recovery and crash/restart staging drills are still required.
- The implementation now requires reviewing forward-migration results and the complete latest-head CI run before merge.
