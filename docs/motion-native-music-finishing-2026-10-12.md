# MOTION — Native waveform + music-video finishing (development review)

Scope: MOTION-only. No Street Banker/Vault/Reach external integration, no live billing, publishing, provider execution or changes to existing masters.
Branch: `codex/motion-native-quick-create-20261011`, target `motion-live`. Guided learning PR #29 stays separate.

## Actual user journey
1. Open MOTION > All films > film > Quick Create.
2. In **References**, upload a rights-cleared WAV or MP3 with the actual rights owner; only project-authorized assets can be selected for a new promotional draft.
3. Select a song. MOTION measures a waveform from decoded PCM, if the recording is at most ten minutes long. This is an amplitude timeline, not AI hook analysis or a decorative equalizer.
4. Scrub with the phone/keyboard-accessible range control; choose start/end to 0.1 seconds and optionally loop playback. The source is neither edited nor overwritten.
5. Enter direction, choose a look and aspect, affirm promotional-use authorization, and **Save Quick Create draft**. This adds a versioned shot with music_cue and consent evidence; nothing has been rendered or mixed.
6. Open the professional Shot Builder to render an approved video of at least the selected moment's duration. The existing provider selection, cost controller, queue, technical QC and human review remain in force.
7. A director approves the output and promotes it to a master through the existing human-review flow.
8. Open **Masters** and use **Finish with selected song**. The server retrieves the exact immutable shot version associated with that approved render, verifies both master and recording rights, trims actual WAV/MP3 audio, replaces the video soundtrack and produces a genuine H.264/AAC MP4.
9. Only after ffprobe verifies video, audio and duration does MOTION save the derivative as a delivery asset with both original video and audio parents. The approved original, original song, saved project and source render are not replaced.
10. Preview and open the finished MP4 in Masters. Repeated finishing with unchanged source version returns the existing asset rather than producing a second output (sequential idempotency).

## Safety and limitations
- Not an automatic AI video generator, lyric aligner, adaptive soundtrack, social publisher or cross-suite handoff.
- A song-moment preview is **not a finished video**; the real output exists only after the master-finishing operation.
- The finishing endpoint requires a MOTION director for that project; ordinary project-wide access does not authorize the write.
- The saved song cue must be bound to the exact rendered shot version and have affirmative per-version promotional-use attestation.
- The audio must still be project-local, owner-attributed and explicitly authorized; expired or revoked consent blocks new finishing.
- Existing provider-generated sound is *replaced*, not mixed. No claim of mastering, loudness compliance or musical timing analysis.
- MP4 finishing is a bounded CPU operation using local FFmpeg, never a billable model provider. Unsupported/corrupt/too-short source media fail rather than publishing fake results.
- Waveform is a bounded, actual decode of up to ten minutes; longer recordings retain manual trim controls but show a truthful waveform-unavailable message.
- The storage driver may be local or S3. Runtime S3 deployment verification is still required. Existing signed URLs can remain accessible until expiry after rights change; this feature does not claim instant revocation of previously issued links.
- Same-master simultaneous requests across separate API workers are not yet guarded by a durable idempotency lock; the subsequent hardening pass should move finishing to the existing durable queue. Current idempotency is verified for sequential re-requests.
- Commercial advertising/distribution authorization is NOT inferred from the existence of a rendered MP4. The existing consent attestation is specific to this promotional creative draft.
- Native iPhone Safari and Android Chrome physical QA remain release gates; responsive CSS and browser tests are not equivalent.
- Existing live third-party provider adapters remain unverified unless individually tested against providers.

## Automated acceptance
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` — new `motion-quick-create.test.ts`, `motion-audio-finishing.test.ts`, `motion-audio-api.test.ts`, and the additive real mock-provider pipeline case.
- `pnpm build`
- Manual: upload, actual waveform, scrub, save, reopen, render, approve, promote, finish, confirm MP4 audio, confirm derivation, reload preview and revoke source rights.
- Test and deployment results must be read from GitHub Actions; do not mark them green unless actually completed.

## Rollback
- Do not merge this draft branch. Close its PR to leave production untouched.
- There is no new database migration. `music_cue` is optional on legacy canonical shots.
- If this were subsequently deployed, disable/delete the feature routes and UI via a separately reviewed rollback; do not delete original recordings, shots, masters, or stored derivatives in order to roll back the interface.
