# Street Banker Song Lab — build plan

This plan records the staged Song Lab implementation. The owner has separately
authorized each numbered job; each remains on its own review branch and PR. Keep
the existing Song Lab, Studio and Live Lab working throughout. No merge, deploy,
Render/account change or production-route replacement is authorized here.

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
Do not make a parallel sign-in system. The owner chose Street Banker Song Lab, monogram SL. Propose `song_lab_suite`
as the distinct registry identity, subject to counterpart format validation; never
borrow Motion’s accepted suite ID/key or repurpose the legacy preview identity.

## Proposed later PRs

All file lists below are scoped targets, not edits made in this PR. Reinspect the
then-current repository and each counterpart before selecting an implementation.
New paths and variables are explicitly proposals, not claims they already exist.

| Later PR | Scope / likely files | Tests and acceptance / rollback |
| --- | --- | --- |
| 1. Shell, suite sign-in, access and service | Existing `apps/web/src/App.tsx`, `SuiteChrome.tsx`, `styles.css`; `apps/api/src/server.ts`; `packages/auth/src/index.ts`; `packages/shared/src/env.ts`; Song/Studio access services and API helpers. Proposed `apps/web/src/song-journey/` and a server-side suite identity adapter. Reuse the verified Motion suite-SSO adapter and V1 `sb_suite_sso.py` contract; proposed own Render service, Pro/Label policy and a V1 suite-strip door (`hubs.py::tool_suites`, `templates/base.html` suite strip/marks, `app.py` suite access, and `sb_suite_sso.py::SUITES`; reinspect current base before editing). | Existing api, motion-suite-chrome, song-lab and studio tests; new forged/expired/replayed/wrong-suite sign-in, tenant, entitlement and reviewer isolation tests; browser 375px/keyboard/deep-link/back tests. Flag off retains exact old entry points. No secret or identity token in browser storage. |
| 2. One song journey | Existing SongLabHome/Project, StudioHome/Project/Workflow and both engine/domain packages; proposed linked-record repository/API under `packages/song-journey-domain/src` and `packages/song-journey-engine/src`; additive migration in `packages/database/src/migrations.ts`. Link both existing IDs; do not rewrite their source histories. New upload/save paths use V1 Vault, with local analysis scratch treated only as temporary work. Keep every inventory item mapped to a named reachable destination before any later replacement. | Song Lab, Studio and database suites; fixtures with separate IDs, conflicting titles, duplicate uploads, analyzer versions, comments and approvals; mapping rollback/export; manual input, missing/partial/failed analysis and cancellation. Original checksums, records and preview hashes unchanged. |
| 3. Rack / Vault handoffs | Existing `packages/song-lab-engine/src/integrations.ts`, Studio processing/versions/deliver services and asset storage. Proposed versioned handoff/receipt adapter and authorization routes. Counterpart V1: inspect current `app.py`, `vault_doors_api.py`, `vault_versions.py`, Rack routes/templates/JS, `sb_suite_sso.py`; do not assume Studio's intent Rack is V1 DSP. | Fake peers only: signed expiry/tenant ownership, explicit cost consent, duplicate/retried/out-of-order/forged callbacks, source checksum, output bytes/hash and cancellation/refund. V1 app alone then focused Vault/Rack/SSO tests separately; masterclip engine/API suites. Off flag offers manual verified result attach, never fabricated completion. |
| 4. Live in Stage | Add a flag-gated Stage entry in V1 and use the existing Song Lab TypeScript service through its verified Street Banker SSO contract. Do not copy Live Lab code into Flask or create a second service. Keep Stage-only seats in a Live-only tenant boundary. Preserve Stage Control performer links and security. | Existing live-lab, platform-wiring, e2e live-lab-browser/offline suites; checksum/decode, no network during playback, reload without autoplay, emergency stop and controller disconnect. V1 Stage/passport/lights/live/fold guards plus a rendered Stage/Live Lab copy and link scan. A real venue device rehearsal remains a release gate. Disable new entry to roll back; preserve old preview, records and cache. |
| 5. Approved feature upgrades | One bounded PR for each selected proposal from FEATURE-RESEARCH.md, using existing analysis, comments, rights and provider seams. New external adapters only in the owning Rack/Room service with terms approval. No bulk “ten features” commit. | Per-feature fixtures/evaluation and opt-in pilot; measured error rate, user task success, spend/retry behavior and saved-result integrity. All optional upgrades independently default off. Owner decides rollout after evidence. |

## Proposed Render variable names and defaults

These are future names for review, not settings changed by this PR. Put actual
blank names in the relevant repository's `.env.example` only when its approved
implementation lands. The owner supplies values in Render; never commit secrets.

| Proposed name | Default / purpose |
| --- | --- |
| SONG_LAB_SUITE_ENABLED | `0`; combined entry and APIs |
| SONG_LAB_SUITE_SUITE_SSO_ENABLED | `0`; verified parent-suite sign-in adapter |
| SONG_LAB_SUITE_LINKED_RECORDS_ENABLED | `0`; additive linked identity flow |
| SONG_LAB_SUITE_FEATURE_SONG_MAP | `0`; Song map Phase 5 upgrade, independently disabled |
| SONG_LAB_SUITE_FEATURE_REFERENCE_COMPARE | `0`; Owned-reference comparison Phase 5 upgrade, independently disabled |
| SONG_LAB_SUITE_FEATURE_TRANSLATION_NOTES | `0`; Translation listening notes Phase 5 upgrade, independently disabled |
| SONG_LAB_SUITE_VAULT_HANDOFF_ENABLED | `0`; verified Vault input/result contract |
| SONG_LAB_SUITE_RACK_HANDOFF_ENABLED | `0`; authorizable V1 Rack round trip |
| SONG_LAB_SUITE_RACK_URL | blank; validated HTTPS origin, never client-selected |
| SONG_LAB_SUITE_HANDOFF_SIGNING_KEY | blank secret; server-only, rotation/expiry required |
| SONG_LAB_SUITE_PROVIDER_JOBS_ENABLED | `0`; optional paid provider work in owner service |
| SONG_LAB_SUITE_PROVIDER_DAILY_CAP | `0`; no spend until owner sets a measured cap |
| STAGE_LIVE_LAB_ENABLED | `0`; V1 Stage entry to the existing Song Lab service |

Each top-ten feature gets an independent default-off switch after selection;
propose suffixes MAP, VERSION_COMPARE, REFERENCES, TRANSLATION_NOTES, LYRICS,
RACK_RECEIPTS, REVIEW, DELIVERY, LIVE_PREP, LINEAGE under `SONG_LAB_SUITE_FEATURE_`.
Do not turn off or silently repurpose existing `SONG_LAB_ENABLED` or
`STUDIO_ENABLED` defaults to implement a migration. Reuse existing SSO variable
names if a verified counterpart contract already defines them; avoid parallel
secrets for the same boundary. Provider keys belong only to their owning service.

## Phase 4 implementation record — JOB 40

The implementation is on independent review branches in V1 and masterclip-os.
V1 adds the default-off `/stage/live-set` door and redirects through the existing
Song Lab SSO route. The service binds the Live intent into its short-lived,
browser-bound signed state; Stage-only seats receive Live Lab, and the existing
release picker appears only when the seat also has Releases access. Song Lab,
Studio and other APIs remain blocked for those seats. Existing all-room and
Studio seats continue through the full shell.
Live Lab itself remains the existing TypeScript product and retains its setlist,
stems, pads, scenes, scene builder, MIDI, show package, Stage Control export,
performance mode and emergency stop.

The V1 rendered-page test scans Stage, Live, Lights, Passport, Stage Control and
Stage Plot for visible Tour copy and Tour destinations. The Song Lab shell browser
test also checks rendered routes and links, including Live Lab. The Stage door
and integration flag default off. No Render setting or production route was
changed. Offline browser, reload recovery, emergency stop and MIDI disconnect
checks pass; real-device rehearsal and audible venue output remain release gates.

## Owner setup by phase (names only; no values or settings changed)

| Phase | Names the owner supplies/approves in the later Render setup | Default-off boundary |
| --- | --- | --- |
| 1 | STREET_BANKER_URL, PUBLIC_BASE_URL, SUITE_SSO_SECRET_<APPROVED_SUITE_ID>, SUITE_URL_<APPROVED_SUITE_ID>, DATABASE_URL, STORAGE_DRIVER, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY; reuse then-current deployment equivalents instead of inventing duplicates | SONG_LAB_SUITE_ENABLED and SONG_LAB_SUITE_SUITE_SSO_ENABLED off; parent door locked/off until service health and Pro/Label access pass |
| 2 | SONG_LAB_SUITE_LINKED_RECORDS_ENABLED; existing analysis/provider configuration remains unchanged | Linked journey and each selected feature off until data-preservation fixtures pass |
| 3 | SONG_LAB_SUITE_VAULT_HANDOFF_ENABLED, SONG_LAB_SUITE_RACK_HANDOFF_ENABLED, SONG_LAB_SUITE_RACK_URL, SONG_LAB_SUITE_HANDOFF_SIGNING_KEY | Both handoff switches off; no paid job without owner-configured cap |
| 4 | STAGE_LIVE_LAB_ENABLED; the existing SONG_LAB_SUITE_ENABLED, SONG_LAB_SUITE_SUITE_SSO_ENABLED, STREET_BANKER_URL, SUITE_URL_SONG_LAB and SUITE_SSO_SECRET_SONG_LAB contract on their owning services | Stage entry off by default; enable only after an owner-approved device rehearsal and security review |
| 5 | Selected SONG_LAB_SUITE_FEATURE_* switches; provider credential names only in the owning approved service .env.example | Every optional feature and provider job off; daily cap zero |

The service-specific SSO secret is a placeholder naming pattern, not a literal
variable to create before the registry contract is verified. Storage names must be reconciled
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
   top-ten priority and migration strategy; LJ approves the concrete scope and design; the name is already chosen.
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

Phase 0 validation includes source/hash inspection, document/link/HTML/CSS checks,
static JavaScript parsing and rendered Chromium checks of all 17 mockups at
375px and 1440px, with disclosures collapsed and expanded. Home/song/Stage
keyboard focus and the sample A/B, pad, lock and emergency-state paths were checked too. See
VALIDATION.md. This does not establish physical iPhone/Safari, hardware playback,
or runtime correctness of the three apps or the proposed integrations. Those
checks remain required before an implementation is accepted.

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

## Revised feature and visual acceptance gate

The full public name is Street Banker Song Lab, SL. Apply NAMES.md’s collision
caution to marketing and chrome. FEATURE-MAP.md is the mandatory implementation
checklist, including 78 capabilities, 100 existing panel occurrences and all
19 principal inventory surfaces. None may disappear, be left TBD or be confused
with the ten optional research proposals. Every mapped capability needs its
real status, permission, retained record and working destination verified before
any legacy preview replacement. All 17 static mockups are design references,
not evidence that a service is connected.

Use DESIGN.md’s material/type/instrument and motion specifications. Test 375px
phone composition, 12px minimum rendered graph text, 44px minimum targets,
keyboard, reduced motion and the persistent emergency stop. Phase 4 additionally
requires three-metre stage readability and real-device audio/MIDI/offline safety
checks. Phase 0 approves no app implementation or deployment.

Phase 5 implementation record — Song map: SONG_LAB_SUITE_FEATURE_SONG_MAP defaults OFF; additive corrections, a protected API, editable Understand screen, measured-only actions and validation tests added in draft PR #74. CI acceptance must be verified on the final commit.
Phase 5 implementation record — Owned-reference comparison: SONG_LAB_SUITE_FEATURE_REFERENCE_COMPARE defaults OFF; owned-song picker, saved Studio mix comparisons, provenance, mismatch warning, Decide screen and isolation tests added in draft PR #75. CI acceptance must be verified on the final commit.

Phase 5 implementation record — Translation listening notes: SONG_LAB_SUITE_FEATURE_TRANSLATION_NOTES defaults OFF; version-bound notes, measured Studio facts, protected GET/PUT API, Finish screen and isolation tests added in draft PR #76. CI acceptance must be verified on the final commit.

Phase 5 implementation record — Job 45 (draft PR #77): VERSION_COMPARE is independently default OFF. Authenticated dual-room Song Journey routes select two owned Song Lab versions and return read-only version metadata. An exact-asset checksum-bound diagnostic endpoint returns Song Lab's gated-block RMS *estimate* with explicit method and unavailable gain status; this is not BS.1770 integrated LUFS. A separate pure gain-proposal utility is bounded to ±6 dB and measured sample-peak headroom, but is **not wired to playback** and must not be used with the diagnostic estimate. Reuse the existing VersionsTab and AbPlayer rather than duplicating their controls. Before accepting Job 45: verify standards-based LUFS and true peak for both exact assets, playback switching and cap behavior, org/auth/flag tests, version-pinned reviewer approval receipts, 375px/browser QA, and final CI. No merge or deployment authorized by this record. Job 46 remains gated on Job 45 merge.
