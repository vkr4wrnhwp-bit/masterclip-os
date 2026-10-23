# Phase 3 — Rack and Vault hand-offs

Default off. Enable only after both this PR and its V1 companion are reviewed and deployed. Existing Song Lab, Studio and Live Lab previews remain; existing Studio processing, approval and delivery controls remain. This adapter opens **V1's existing browser Rack**. It adds no mixer and makes no automatic DSP/provider claim.

## Owner configuration (names only)

Song Lab: `SONG_LAB_SUITE_ENABLED`, `SONG_LAB_SUITE_SUITE_SSO_ENABLED`, `SONG_LAB_SUITE_LINKED_RECORDS_ENABLED`, `SONG_LAB_SUITE_VAULT_HANDOFF_ENABLED`, `SONG_LAB_SUITE_RACK_HANDOFF_ENABLED`, `STREET_BANKER_URL`, `SONG_LAB_SUITE_RACK_URL`, `SUITE_SSO_SECRET_SONG_LAB`, `SONG_LAB_SUITE_HANDOFF_SIGNING_KEY`, `PUBLIC_BASE_URL`. Both new hand-off flags default `0`. Rack requires Vault as well. Existing database and storage configuration remains necessary for analysis scratch and retained legacy records.

V1: `SUITE_URL_SONG_LAB`, `SUITE_SSO_SECRET_SONG_LAB`, `SONG_LAB_SUITE_RACK_HANDOFF_ENABLED`, `SONG_LAB_SUITE_HANDOFF_SIGNING_KEY`, `SONG_LAB_SUITE_CALLBACK_URL`, existing `SECRET_KEY` / optional `VAULT_DOOR_SECRET` and Vault object-store configuration. The callback variable is the Song Lab HTTPS **origin**, with no path/query. The receiver is `/api/webhooks/song-lab-rack`; no browser-supplied destination is accepted. Do not post secret values in review material.

## Artist path

1. Enter through Street Banker sign-in. Choose and **save** the exact Song Lab version in the journey. An unsaved/stale selection is rejected by the server.
2. In Finish, write the brief, approve it for that version, and explicitly authorize the **$0 manual Rack** hand-off. Nonzero cost is refused by both servers; this adapter cannot buy a provider job. Original paid Rack tools retain their own existing consent/billing boundaries.
3. Source bytes go through the existing signed Vault deliver/read doors. A pinned Vault version and checksum are recorded only after a read-back hash agrees. Direct audio uploads, resumable uploads and Studio deliverable saves use this Vault path when enabled; analyses/preview scratch and retained legacy files remain in their existing stores. Explicit Save selected version copies an older selected file through the same verified door.
4. Open the existing Rack from the pending receipt. Load approved source. All existing controls remain. Bounce/save a master through the existing Vault export. A source change clears the hand-off's loaded-source indicator; unrelated stem/video exports do not complete the request.
5. V1 reads the actual result bytes, verifies the Vault fingerprint, pins that exact output version, then signs its result. Song Lab verifies the signature, expiry, tenant, job, source version/checksum, monotonic state and actual pinned output bytes. The completed card offers authenticated playback/download of those verified bytes. It does not automatically approve the result or overwrite either source record.
6. Refresh receipt recovers a missed callback server-to-server, using the original durable request. Stop in the Rack produces a terminal failed receipt and preserves files. Pending, failed and completed receipts remain separate. Repeated requests cannot create another paid job: the only accepted cost is zero and the deterministic request ID deduplicates the manual queue.

## Boundaries and rollback

Protocol: `v1.<base64url JSON>.<HMAC-SHA256 hex>`, directional audience, parent tenant UID, 120-second expiry (maximum envelope span 300 seconds), immutable request ID/source/brief/cost. No signed token enters browser storage or browser receipt payloads. V1's callback uses a fixed configured HTTPS origin. Receipt ordering is monotonic and terminal states never revert; event ID binds the job and sequence. Signed recovery returns the same job, rather than resubmitting provider work.

Vault proof reuses `signSuiteProof` / `vault_doors_api.py`, not a new login. Delegated Song Lab seats carry a signed parent tenant, and V1 rechecks current seat, room, edit and project/file grants on every bearer use. Read seats cannot create jobs or deliver results. Pins are in `vault_versions.py`; cleanup sees live hand-off uses. Account deletion's existing generic user-id sweep removes V1 jobs.

Disable the two new flags to stop new sends and uploads through this adapter. Off: Finish says **Send to The Rack: coming next** and no hand-off work happens. Receipts and all original records/files remain. No migration deletes or rewrites existing source histories. Callback and existing receipt reads can recover durable results after an outage when the owning doors are available.

Verification results are recorded in the PR. Fake peers only; no real paid job, account change, key lookup, screenshot or workflow edit. Physical audio quality and real hosted cross-service delivery still need owner rehearsal after both services are deployed.

## Verification

Masterclip: `814 passed` across 46 files; final signed-receipt/race checks `16 passed`; all 49 projects typecheck clean; lint and production build pass. The real built journey passes its desktop/375px browser test with screenshots/video/tracing disabled. V1 app alone: `225 passed in 192.34s (0:03:12)`. Separate serial Vault/Rack/sign-in batch: `411 passed, 6 skipped in 169.58s (0:02:49)`; the six existing browser checks have no system Chrome. Two baseline-only stale test assumptions were reproduced and corrected in the companion (current Statements wording and orphan cleanup ordering). Final narrow V1 race checks are recorded in its PR. No hosted peer or physical device test is claimed.
