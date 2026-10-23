# Build plan — review before implementation

This is documentation/static mockups only. **No app code until Claude reviews
the plan and LJ explicitly approves it.** The PR targets masterclip-os `main`;
no merge, deploy, Render/account change or preview-route replacement is authorized
by Phase 0. Keep the existing Song Lab, Studio and Live Lab working throughout.

## Phase 1 service and membership proposal

Propose access for **Pro and Label**, with Artist seeing an honest locked door;
the owner approves entitlement policy before build. Add one door in the V1 suite
strip, backed by `sb_suite_sso.py`, and deploy the suite to its **own Render
service** only after the later implementation is reviewed. Keep Motion staging
(`motion-vault`) and live (`motion-live`) untouched. The existing labs preview on
`main` stays working. Phase 0 neither creates nor configures a service.

Reuse Motion’s existing TypeScript verifier on `motion-live`,
`packages/auth/src/suite-sso.ts` (verified blob
`75705ed21a4245459c5870dce6e9c3fc49360d5b`), and V1’s Python
`sb_suite_sso.py` contract. Review the latest adapter and tests; port the minimal
verified boundary in a later PR without merging or modifying Motion live.
Do not make a parallel sign-in system. New suite identifier is an approval
decision tied to the selected name; never borrow Motion’s accepted suite ID/key.

## Proposed later PRs

All file lists below are scoped targets, not edits made in this PR. Reinspect the
then-current repository and each counterpart before selecting an implementation.
New paths and variables are explicitly proposals, not claims they already exist.

| Later PR | Scope / likely files | Tests and acceptance / rollback |
| --- | --- | --- |
| 1. Shell, suite sign-in, access and service | Existing `apps/web/src/App.tsx`, `SuiteChrome.tsx`, `styles.css`; `apps/api/src/server.ts`; `packages/auth/src/index.ts`; `packages/shared/src/env.ts`; Song/Studio access services and API helpers. Proposed `apps/web/src/song-journey/` and a server-side suite identity adapter. Reuse the verified Motion suite-SSO adapter and V1 `sb_suite_sso.py` contract; proposed own Render service, Pro/Label policy and a V1 suite-strip door (`hubs.py::tool_suites`, `templates/base.html` suite strip/marks, `app.py` suite access, and `sb_suite_sso.py::SUITES`; reinspect current base before editing). | Existing api, motion-suite-chrome, song-lab and studio tests; new forged/expired/replayed/wrong-suite sign-in, tenant, entitlement and reviewer isolation tests; browser 375px/keyboard/deep-link/back tests. Flag off retains exact old entry points. No secret or identity token in browser storage. |
| 2. One song journey | Existing SongLabHome/Project, StudioHome/Project/Workflow and both engine/domain packages; proposed linked-record repository/API under `packages/song-journey-domain/src` and `packages/song-journey-engine/src`; additive migration in `packages/database/src/migrations.ts`. Link both existing IDs; do not rewrite their source histories. New upload/save paths use V1 Vault, with local analysis scratch treated only as temporary work. Keep every inventory item mapped to a named reachable destination before any later replacement. | Song Lab, Studio and database suites; fixtures with separate IDs, conflicting titles, duplicate uploads, analyzer versions, comments and approvals; mapping rollback/export; manual input, missing/partial/failed analysis and cancellation. Original checksums, records and preview hashes unchanged. |
| 3. Rack / Vault handoffs | Existing `packages/song-lab-engine/src/integrations.ts`, Studio processing/versions/deliver services and asset storage. Proposed versioned handoff/receipt adapter and authorization routes. Counterpart V1: inspect current `app.py`, `vault_doors_api.py`, `vault_versions.py`, Rack routes/templates/JS, `sb_suite_sso.py`; do not assume Studio's intent Rack is V1 DSP. | Fake peers only: signed expiry/tenant ownership, explicit cost consent, duplicate/retried/out-of-order/forged callbacks, source checksum, output bytes/hash and cancellation/refund. V1 app alone then focused Vault/Rack/SSO tests separately; masterclip engine/API suites. Off flag offers manual verified result attach, never fabricated completion. |
| 4. Live in Stage | Add a Stage entry and suite-authenticated integration in V1; preserve Stage Control performer-link panel and security. Reuse current `apps/web/src/live`, `apps/api/src/routes/live-lab.ts`, `packages/live-engine`, `midi-engine`, `performance-project`, `performance-cache`, `packages/runtime/src/live-lab.ts`. Packaging may remain a service rather than copying TypeScript into Flask; decide after auth/storage contract review. | Existing live-lab, platform-wiring, e2e live-lab-browser/offline suites; actual device browser/audio/MIDI tests; package checksum/quota/decode, no network during playback, lock, accidental navigation, reload restoration without autoplay, emergency stop, lost controller and access expiry. V1 Stage/passport/lights/live/fold guards. No Stage text, navigation, help, sample title or destination may name/link the travel suite; scan rendered pages and templates. Disable new entry to roll back; preserve old preview and all records/cache. |
| 5. Approved feature upgrades | One bounded PR for each selected proposal from FEATURE-RESEARCH.md, using existing analysis, comments, rights and provider seams. New external adapters only in the owning Rack/Room service with terms approval. No bulk “ten features” commit. | Per-feature fixtures/evaluation and opt-in pilot; measured error rate, user task success, spend/retry behavior and saved-result integrity. All optional upgrades independently default off. Owner decides rollout after evidence. |

## Proposed Render variable names and defaults

These are future names for review, not settings changed by this PR. Put actual
blank names in the relevant repository's `.env.example` only when its approved
implementation lands. The owner supplies values in Render; never commit secrets.

| Proposed name | Default / purpose |
| --- | --- |
| SONG_JOURNEY_ENABLED | `0`; combined entry and APIs |
| SONG_JOURNEY_SUITE_SSO_ENABLED | `0`; verified parent-suite sign-in adapter |
| SONG_JOURNEY_LINKED_RECORDS_ENABLED | `0`; additive linked identity flow |
| SONG_JOURNEY_VAULT_HANDOFF_ENABLED | `0`; verified Vault input/result contract |
| SONG_JOURNEY_RACK_HANDOFF_ENABLED | `0`; authorizable V1 Rack round trip |
| SONG_JOURNEY_RACK_URL | blank; validated HTTPS origin, never client-selected |
| SONG_JOURNEY_HANDOFF_SIGNING_KEY | blank secret; server-only, rotation/expiry required |
| SONG_JOURNEY_PROVIDER_JOBS_ENABLED | `0`; optional paid provider work in owner service |
| SONG_JOURNEY_PROVIDER_DAILY_CAP | `0`; no spend until owner sets a measured cap |
| STAGE_LIVE_LAB_ENABLED | `0`; V1 entry only after device-level verification |
| STAGE_LIVE_LAB_SERVICE_URL | blank; verified HTTPS service origin if separate service retained |
| STAGE_LIVE_LAB_HANDOFF_ENABLED | `0`; signed set import/receipt contract |

Each top-ten feature gets an independent default-off switch after selection;
propose suffixes MAP, VERSION_COMPARE, REFERENCES, TRANSLATION_NOTES, LYRICS,
RACK_RECEIPTS, REVIEW, DELIVERY, LIVE_PREP, LINEAGE under `SONG_JOURNEY_FEATURE_`.
Do not turn off or silently repurpose existing `SONG_LAB_ENABLED` or
`STUDIO_ENABLED` defaults to implement a migration. Reuse existing SSO variable
names if a verified counterpart contract already defines them; avoid parallel
secrets for the same boundary. Provider keys belong only to their owning service.

## Owner setup by phase (names only; no values or settings changed)

| Phase | Names the owner supplies/approves in the later Render setup | Default-off boundary |
| --- | --- | --- |
| 1 | STREET_BANKER_URL, PUBLIC_BASE_URL, SUITE_SSO_SECRET_<APPROVED_SUITE_ID>, SUITE_URL_<APPROVED_SUITE_ID>, DATABASE_URL, STORAGE_DRIVER, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; reuse then-current deployment equivalents instead of inventing duplicates | SONG_JOURNEY_ENABLED and SONG_JOURNEY_SUITE_SSO_ENABLED off; parent door locked/off until service health and Pro/Label access pass |
| 2 | SONG_JOURNEY_LINKED_RECORDS_ENABLED; existing analysis/provider configuration remains unchanged | Linked journey and each selected feature off until data-preservation fixtures pass |
| 3 | SONG_JOURNEY_VAULT_HANDOFF_ENABLED, SONG_JOURNEY_RACK_HANDOFF_ENABLED, SONG_JOURNEY_RACK_URL, SONG_JOURNEY_HANDOFF_SIGNING_KEY | Both handoff switches off; no paid job without owner-configured cap |
| 4 | STAGE_LIVE_LAB_ENABLED, STAGE_LIVE_LAB_SERVICE_URL, STAGE_LIVE_LAB_HANDOFF_ENABLED; existing suite key contract on the actual owning service | All three entry/connection paths off until device rehearsal/security review |
| 5 | Selected SONG_JOURNEY_FEATURE_* switches; provider credential names only in the owning approved service .env.example | Every optional feature and provider job off; daily cap zero |

The service-specific SSO secret is a placeholder naming pattern, not a literal
variable to create before the name is approved. Storage names must be reconciled
with the actual runtime configuration during Phase 1; the table proposes required
settings, not verified live values. No Render workflow or blueprint is added now.

## Contract and data decisions required before PR 1–3

Confirm canonical parent identity → local tenant mapping, sign-in TTL/replay and
logout, exact Vault permission/download/return APIs, V1 Rack's supported work and
actual saved-output receipt, credit reservation/refund owner, file size/retention
limits, and whether a retained service is needed for Live's TypeScript runtime.
Do not invent Release/Track entities in this repo: current Studio projects are
their own record identities. A link model can refer to a parent release only
after that API and ownership contract exists.

Handoff concept: contract version, tenant and actor, stable idempotency ID,
source project/version/asset checksum, consent/right scope, approved brief,
destination/work requested, cost authorization, callback expiry and state.
Result: same contract/identity, actual output asset + checksum, processing basis,
provider outcome, failure/partial status, timestamp and original request ID.
No raw secret, unrestricted permanent URL or fabricated external ID travels.
All production controls require an implemented outcome and honest error state.

## Test and review sequence

1. Claude reviews inventory/status accuracy, cross-service contracts, the design,
   top-ten priority and migration strategy; LJ approves a concrete scope/name.
2. Rebase a new implementation branch on its target's current base; capture
   original records/checksums and routing. Preserve old entry points behind tests.
3. Run relevant unit/API/domain regressions plus typecheck/lint/build. Use only
   fake storage/provider/peer services for automated spend-sensitive tests.
4. Run browser journeys on desktop and 375px, keyboard/focus, 200% zoom, denied
   permissions, slow/offline, missing key, partial output, cancellation and reload.
5. Stage migration additionally requires audio/MIDI hardware and offline rehearsal.
   Verify Stage Control tokens/performer security and no forbidden navigation.
6. Owner reviews evidence and each PR before rollout. Never self-merge. Rollback
   changes the entry switch, not stored files/history or a completed provider job.

Phase 0 validation is limited to source/hash inspection, document/link/HTML/CSS
checks and static JavaScript parsing. It does not claim the three existing apps
or new proposed integrations passed a runtime suite. Browser rendering and live
device QA remain required review evidence before an implementation is accepted.

## Claude-ready MVP implementation brief

```text
Review first; do not implement until LJ explicitly approves this Phase 0 plan.
Inspect current masterclip-os and V1 counterpart contracts before choosing files.
Objective: one six-step song journey: choose owned input, understand it, choose
work, finish through V1 Rack, compare/approve, save a truthful delivery to Vault.
Use Street Banker sign-in and tenant permissions; retain both old project IDs,
immutable assets, version histories, consent, comments and approval provenance.
Create no second Vault, recorder, DAW, multitrack editor, instrument system,
mix/master engine, Room, Audio Studio or Remix Lab. Preserve all three preview labs.
Implement separately reviewed PRs for shell/access, journey/linked records,
Rack/Vault contracts, Live in V1 Stage and each selected feature upgrade.
All new paths/features default off. Explicit owner cost consent and idempotency
are mandatory for paid work. Fake peers/providers/storage in tests. No real cloud
or Render changes without a separate owner instruction.
Every page: Back to Street Banker, Walkthrough, section help, Start here → The
work → Your results / Save to Vault → Help; readable sans-serif, >=12px text,
>=44px controls, no sideways overflow at 375px, visible keyboard focus.
Preserve source files on failure/cancel. Queued/partial/sample/missing key are
distinct from completed measured results. No fake audio, metrics, integration
receipts, readiness or distribution success. A real output must be hash-verifiable.
Live migration must preserve cache, playback, MIDI, recovery without autoplay,
Stage Control security and performer-link creation on its desk; Stage must have
no Tour word or link anywhere, including shared navigation/help/sample names.
Record only minimal IDs/states/timing in analytics; no raw lyrics/audio/secrets.
Test tenant isolation, expiry/replay/revocation, retries/charging, source-result
lineage, old routes, all failure states, 375px/keyboard, and real device offline
performance. Fail the migration on lost records, leaked assets, wrong-version
approval, duplicate charges or false completion. Roll back entry flags, never data.
```
