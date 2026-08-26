# Build audit

**First production-capable release. Audited 2026-08-17.**

Status vocabulary, used strictly:

| | |
|---|---|
| **REAL** | implemented, tested, and verified running |
| **DEV-LABELED** | functional and spec-correct, but not validated against the live third party |
| **PARTIAL** | legitimately started, incomplete, and described as such |
| **NOT BUILT** | absent, and never represented as working |

---

## The one thing to read first

**No live provider API call has ever been made from this build.** Every vendor
host — MuAPI, Google, fal, Runway, Luma, Replicate — was blocked by the
development environment's egress policy (403 at the CONNECT tunnel, an
organization policy denial). The adapters were therefore written against each
vendor's **own client library or machine-readable spec**, not from memory, and
are correct as far as those sources go. They have not touched the wire.

**Total live spend: $0.00.** Not "under the cap" — zero, because no billable call
was reachable. The `$2` cap was never approached.

Everything else below is genuinely exercised: the pipeline runs end to end
against the mock provider, which renders real MP4s with ffmpeg.

---

## Verification performed

| Check | Result |
|---|---|
| `pnpm typecheck` | **27/27 projects clean** |
| `pnpm lint` | **clean** — secret scan, shell-exec guard, SQL-interpolation guard, typecheck |
| `pnpm test` | **223 passed / 223**, 16 files |
| `pnpm test:e2e` | **11 passed / 11** (Playwright, Chromium, against the production web build) |
| `pnpm build` | **succeeds** — `dist/api.js`, `dist/worker.js`, `dist/masterclip.js`, `apps/web/dist` |
| bundled artifacts run | `node dist/masterclip.js doctor` → all required checks pass; `node dist/api.js` → serves `/api/health` |
| PostgreSQL parity | same migrations and same SQL verified against live PostgreSQL 16 |
| full pipeline | plan → authorize → submit → poll → download → verify → QC → derivatives → review → promote → finish → package, with real media |

138 source files, ~26,500 lines, 27 workspace packages, 18 test files.

---

## Feature audit

### Foundation

| Feature | Status | Files | Verification |
|---|---|---|---|
| Monorepo, 27 packages, strict TS | **REAL** | `pnpm-workspace.yaml`, `scripts/scaffold.mjs` | typecheck 27/27 |
| Micro-USD money | **REAL** | `packages/shared/src/money.ts` | 3 tests incl. a 500-clip exactness check |
| Error taxonomy + retry classification | **REAL** | `packages/shared/src/{errors,retry}.ts` | 5 tests |
| Secret redaction (by key *and* by value) | **REAL** | `packages/shared/src/redact.ts` | 3 tests |
| Structured JSON logging | **REAL** | `packages/shared/src/logger.ts` | used throughout; redaction tested |
| Database: SQLite + PostgreSQL, one SQL | **REAL** | `packages/database/` | 10 tests; verified on live PG 16 |
| Migrations, forward-only, transactional | **REAL** | `packages/database/src/migrations.ts` | idempotency + all-tables tests |
| Durable queue: leases, backoff+jitter, dead-letter, stalled recovery, dedupe, replay | **REAL** | `packages/queue/` | 13 tests |
| Local object storage + signed URLs | **REAL** | `packages/asset-storage/src/local.ts`, `src/expiry.ts` | 16 tests incl. path-escape, expiry, and cache stability |
| S3 storage driver | **DEV-LABELED** | `packages/asset-storage/src/s3.ts` | SigV4 verified against AWS's published test vector; 12 tests drive the driver over a real socket against an in-repo S3-compatible server (put/get/head/delete/list, spec-checked key encoding, XML parsing, status mapping, presigned fetch), and three deliberate mutations were confirmed to fail them; **still never run against a live AWS bucket** |
| Auth: scrypt, hashed sessions, project roles | **REAL** | `packages/auth/` | exercised by every API test + e2e |
| Rate limiting: token bucket, 9 request classes, two-tier login budget | **REAL** | `packages/shared/src/rate-limit.ts`, `apps/api/src/security/rate-limit.ts` | 10 unit tests on a fake clock (refill, burst, memory bound, self-lockout, eviction-under-attack) + 24 HTTP tests |
| CSRF: origin check + session-bound double-submit token | **REAL** | `apps/api/src/security/csrf.ts` | HTTP tests incl. forged token, cross-site, foreign Origin, stale-cookie recovery; proven in-browser by the e2e suite |
| `TRUST_PROXY` off by default | **REAL** | `apps/api/src/server.ts` | HTTP test confirms a rotated `X-Forwarded-For` buys no extra budget |
| Webhook callback token demanded unconditionally | **REAL** | `apps/api/src/routes/ops.ts` | HTTP test: omitting `job` is 403 and writes no row |
| Schema failures answered as 400 with field errors | **REAL** | `packages/shared/src/errors.ts` | HTTP test asserts kind, code and `details.issues` |

### Canonical shot system

| Feature | Status | Files | Verification |
|---|---|---|---|
| Canonical shot schema (47 fields) | **REAL** | `packages/shot-schema/src/shot.ts` | 3 tests |
| JSON Schema generated from the same source | **REAL** | `packages/shot-schema/src/index.ts` | test asserts >40 properties |
| Semantic validation beyond the schema | **REAL** | `packages/shot-schema/src/validate.ts` | 6 tests |
| Derived requirements for routing | **REAL** | `packages/shot-schema/src/requirements.ts` | 5 tests |
| Locked-fact extraction | **REAL** | same | 1 test |
| Character + World bibles, versioned | **REAL** | `packages/shot-schema/src/bible.ts`, `packages/domain/src/bibles.ts` | pipeline test resolves both |
| CSV + JSON import/export, lossless round trip | **REAL** | `packages/shot-schema/src/io.ts` | 5 tests incl. RFC 4180 and prototype-pollution refusal |
| Shot versioning; renders bind to an immutable version | **REAL** | `packages/domain/src/projects.ts` | pipeline provenance test |

### Providers

| Feature | Status | Files | Verification |
|---|---|---|---|
| `VideoProvider` contract + capability matcher | **REAL** | `packages/provider-core/` | 17 tests |
| Contract test battery | **REAL** | `packages/provider-core/src/contract.ts` | runs green against mock incl. submit→poll→download |
| Mock provider rendering real, defective-on-purpose MP4s | **REAL** | `packages/provider-mock/` | 8 tests |
| MuAPI adapter | **DEV-LABELED** | `packages/provider-muapi/` | built from MuAPI's official CLI source; **no live call** |
| Google (Veo 3.1 family) adapter | **DEV-LABELED** | `packages/provider-google/` | built from Google's v1beta discovery doc + official SDK; **no live call** |
| fal adapter | **DEV-LABELED** | `packages/provider-fal/` | built from `fal-js`/`fal` official clients; **no live call** |
| Runway adapter | **DEV-LABELED** | `packages/provider-runway/` | built from the official OpenAPI spec + `sdk-node`; **no live call** |
| Luma adapter | **DEV-LABELED** | `packages/provider-luma/` | built from the official OpenAPI spec; **no live call** |
| Replicate adapter (schema-driven) | **DEV-LABELED** | `packages/provider-replicate/` | built from `replicate/client.py`; **no live call** |
| Self-hosted ComfyUI adapter | **DEV-LABELED** | `packages/provider-selfhosted/` | endpoints verified against ComfyUI's routes; **no live instance** |
| Webhook verification (HMAC, replay window, callback tokens) | **REAL** | `packages/provider-core/src/webhook.ts` | 3 tests |
| Webhook ingest with dedupe | **REAL** | `apps/api/src/routes/ops.ts` | unique-index dedupe; **not exercised by a real provider callback** |

### Render factory

| Feature | Status | Files | Verification |
|---|---|---|---|
| Batch matrix builder with pruning and stop-loss | **REAL** | `packages/domain/src/matrix.ts` | used by API + UI; priced before submit |
| Plan → quote → authorize → queue | **REAL** | `packages/runtime/src/render.ts` | pipeline tests |
| Submit → poll → download → verify | **REAL** | same | pipeline tests, real files |
| Idempotency (duplicate cells collapse) | **REAL** | `packages/domain/src/renders.ts` | dedicated test |
| Worker survives death mid-flight | **REAL** | `packages/queue` + worker | dedicated test |
| Provider health monitoring | **REAL** | `packages/provider-core/src/registry.ts` | doctor + UI |
| Four-level budgets, caps, attempt ceilings | **REAL** | `packages/cost-engine/src/budget.ts` | 15 tests |
| Batch-aware authorization | **REAL** | `packages/cost-engine/src/controller.ts` | dedicated test (found and fixed a real over-spend bug) |
| Global live-spend cap | **REAL** | same | dedicated test |
| Append-only cost ledger + variance | **REAL** | `packages/cost-engine/src/ledger.ts` | 3 tests |

### QC and review

| Feature | Status | Files | Verification |
|---|---|---|---|
| Technical QC (integrity, black, freeze, duration, bitrate, duplicates, decode) | **REAL** | `packages/qc-engine/src/technical.ts` | **10 tests against real defective media** |
| Frame extraction, contact sheets, proxies, thumbnails | **REAL** | `packages/media-tools/src/transform.ts` | pipeline test asserts all three derivatives |
| QC decision rules | **REAL** | `packages/qc-engine/src/decide.ts` | 7 tests |
| Visual QC via Claude vision | **DEV-LABELED** | `packages/qc-engine/src/visual.ts`, `packages/agents/src/vision.ts` | wired end to end and cost-metered; **never run against the live Anthropic API from this build** |
| Honest fallback with no vision model | **REAL** | `HeuristicVisionClient` | test asserts it reports 0 scores, 0.05 confidence, and routes to human review |
| Rejection taxonomy feeding routing | **REAL** | `packages/cost-engine/src/metrics.ts` | dedicated test |
| Review grid: sync playback, frame step, compare, rank | **REAL** | `apps/web/src/views/ReviewGrid.tsx` | e2e test |
| Master promotion requires a human approval | **REAL** | `packages/runtime/src/masters.ts` | test asserts promotion is refused without one |

### Routing and learning

| Feature | Status | Files | Verification |
|---|---|---|---|
| 8 routing profiles | **REAL** | `packages/model-router/src/profiles.ts` | consistency test over all 8 |
| Expected-approved-cost ranking | **REAL** | `packages/model-router/src/index.ts` | test proves the pricier, more-accepted model wins |
| Conservative priors + reported confidence | **REAL** | same | 3 tests |
| Acceptance history per model per shot category | **REAL** | `packages/cost-engine/src/metrics.ts` | dedicated test |
| Draft-vs-premium strategy simulator | **REAL** | `compareStrategies` + Cost Lab | 2 tests incl. the case where drafting *loses* |
| Prompt compiler with locked-fact verification | **REAL** | `packages/prompt-compiler/` | 14 tests incl. "fails loudly rather than truncating" |
| A/B testing | **PARTIAL** | matrix + acceptance stats | the mechanism exists (multi-model, multi-seed, multi-variation batches with per-model acceptance) but there is no dedicated experiment object with significance reporting |

### Finishing and delivery

| Feature | Status | Files | Verification |
|---|---|---|---|
| Delivery transcodes (H.264/H.265/ProRes/social) | **REAL** | `packages/media-tools/src/transform.ts` | pipeline test renders one |
| Reframing with a required explicit crop/pad choice | **REAL** | `packages/runtime/src/masters.ts` | refuses without `reframeMode` |
| Delivery package in the documented layout | **REAL** | same | pipeline test asserts files + manifest |
| Provenance sidecar + cost CSV | **REAL** | same | test asserts provider, prompt, shot version, cost, disclaimers |
| EDL + FCPXML | **REAL** | `packages/media-tools/src/edl.ts` | generated and shape-checked |
| Archive to tar | **DEV-LABELED** | `MasterService.archive` | shells out to `tar`; not covered by a test |
| Audio replace / normalize / extract | **REAL** | `packages/media-tools/src/transform.ts` | implemented; **not covered by a test** |

### Interfaces

| Feature | Status | Files | Verification |
|---|---|---|---|
| Web: dashboard, project, shot builder, queue, review, masters, cost lab, providers | **REAL** | `apps/web/src/views/` | 10 e2e tests + screenshots |
| REST API | **REAL** | `apps/api/` | exercised by e2e and pipeline tests |
| CLI, 20 commands, `--json`, exit codes | **REAL** | `apps/cli/src/main.ts` | `doctor`, `render submit`, `queue work`, `costs report` all run |
| `masterclip doctor` | **REAL** | same | verified against the production bundle |

### Claude agent layer

| Feature | Status | Files | Verification |
|---|---|---|---|
| Messages API client with prompt caching + exact cost metering | **REAL (code)** / **DEV-LABELED (live)** | `packages/agents/src/client.ts` | pricing table and cost maths are code-verified; **no live API call** |
| 7 producer agents with permissions | **REAL (definitions)** | `packages/agents/src/agents.ts` | system prompts, permission model, and forced-JSON schemas are defined and wired |
| Agent-run persistence + ledger integration | **REAL** | `agent_runs` table, `entryType: 'agent'` | schema present; QC path writes to the ledger |
| Agents driving the pipeline end to end | **PARTIAL** | — | the QC vision path is wired into the worker. The Creative Director, Shot Designer, Continuity Supervisor, and Cost Controller are defined with schemas and permissions but are **not yet invoked from an API route or the UI** |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) subprocess orchestration | **NOT BUILT** | — | the Messages API was used directly instead: the worker needs a small, pinned bundle and per-call cost attribution into the same ledger as video spend, which the subprocess model does not give |

### Not built

| Feature | Why |
|---|---|
| Gemini Omni Flash adapter | A different API entirely (Interactions, stateful, token-metered). Needs its own adapter, not a flag. See `docs/model-capabilities.md` |
| Cloud-GPU benchmark harness | The self-hosted adapter refuses to quote without measured numbers, which is the honest posture; the harness that *produces* those numbers is not written |
| Scene-level and org-level budget **UI** | Both scopes are enforced in the cost engine; only the project scope has an editor |
| OpenTelemetry export | Logs carry trace-shaped fields (`trace_id`, `job_id`, `provider`) but there is no OTLP exporter |
| API rate limiting | Documented as a gap; deploy behind a rate-limiting proxy |
| Per-org encrypted provider credentials | `provider_credentials` table and `SECRETS_ENCRYPTION_KEY` exist; this release reads keys from the environment only |

---

## Testing added after the hardening pass

**The S3 driver now makes real HTTP requests.** It previously had no test that
opened a socket: the SigV4 signer was verified against AWS's published vector,
but URL construction, key encoding, list-XML parsing, status mapping and
presigned-URL fetchability were all unexercised. A minimal S3-compatible server
lives in `packages/asset-storage/test/s3-server.ts` and 12 tests drive the real
driver against it.

Two of its checks are genuinely independent rather than circular:

- It hashes the bytes that actually arrived and compares them to the driver's
  declared `x-amz-content-sha256`, so a body signed differently from the body
  sent is a 400.
- It re-derives each path segment's percent-encoding from the S3 spec's rule
  (only `A-Za-z0-9-._~` literal) and compares it to the raw path on the wire.
  Node's `URL` leaves characters like `(` alone, so this is the only way to
  catch a driver that skipped its own encoder — and it is the encoding the
  signature is computed over, so a mismatch would be a 403 at AWS.

The suite was mutation-checked rather than trusted for passing: breaking the
payload hash failed 10 tests, breaking presign date stability failed 1, and
breaking key encoding initially failed **none** — which exposed a real gap in
the test, fixed by adding the spec-derived encoding check above.

It is not a compatibility oracle. Passing proves the driver speaks well-formed
S3 to something expecting S3, not that AWS agrees, so risk #12 is downgraded
rather than closed.

## Resilience defects found by the same review

The verifier refuted these as *security* findings, correctly — they are
usability and performance defects. They were sitting in the screens an operator
uses all day, so they are fixed anyway:

| Defect | Why it mattered |
|---|---|
| `AsyncBlock` returned the error callout *instead of* data whenever an error was set | one failed poll blanked the whole queue table, the stat cards and the cost-controller callout, replacing a working screen with a line of red text. Stale data with a banner beats losing what you were reading; the error now only takes the screen when there is nothing else to show |
| The queue polled every 4s forever, with no backoff and no pause when hidden | a tab left open polled all night for nobody, and retrying into a 429 at full speed spent the budget that would let it recover. Now backs off exponentially on consecutive failures, stops while the document is hidden, and refreshes on return |
| Free pricing previews shared the paid `render` budget | a producer iterating in the cost lab spent the allowance the submission needed, so the refusal landed on the submit rather than the preview |

Both UI fixes are pinned by a browser test that fails against the old code —
verified by reverting the change and watching it fail.

## Bugs an adversarial review of the hardening work found and fixed

Four agents attacked the new rate-limit and CSRF code from independent angles;
each candidate finding was then handed to a separate agent told to refute it.
Nine survived and are fixed, with a regression test each:

| Defect | Why it mattered |
|---|---|
| `classify()` read the raw URL while the router matches the decoded one | `POST /api/shots/x/%72ender` reached the render handler but was billed to the cheaper `mutation` budget |
| The per-account login budget was keyed on email alone and charged before authentication | anyone who knew your address could hold you out of your own account for five requests every fifteen minutes |
| A stale session cookie made login, signup **and** logout return 403 | the endpoints that repair a broken session were the ones a broken session locked you out of; the only escape was clearing cookies by hand |
| The webhook callback token was only checked when the caller supplied `job` | omitting the parameter skipped verification, leaving an anonymous write path into `webhook_events` with an attacker-chosen dedupe key |
| Retries and dead-letter replays fell into the `mutation` budget | both submit a new billable generation |
| Every zod failure became a 500 with the raw `ZodError` dump as the message | caller mistakes logged as server faults, unreadable in the UI |
| An 8-file upload stored only the last file, with a 200 | a dropped set of character references surfaced later as identity work that had seen one image |
| `RATE_LIMIT_SCALE=0` clamped to 0.01 instead of disabling | "get out of my way" became one request per window, with nothing in the log connecting cause to symptom |
| `Retry-After` was a second too long on an empty bucket | dividing by the rounded refill rate instead of multiplying by the window |

Bucket eviction was also rewritten during this work: the first version evicted
least-recently-used, which let an attacker erase their own penalty by making
noise from a few hundred fresh addresses. It now evicts by fullness, so the
noise evicts itself. That one was caught by a test written before the review.

## Performance defects found after the hardening pass

| Defect | Why it mattered |
|---|---|
| Signed asset URLs embedded `now + ttl`, so every response produced a different string | the review grid re-signs each clip whenever outputs reload — once per approve or reject — so the browser re-downloaded every video and poster in the grid on every decision, and the `cache-control: private, max-age=3600` on the asset route never applied. Both drivers are now anchored to a window boundary (`stableExpiry`), so the URL is byte-identical within the window and still never outlives the requested ttl |

## Bugs this build's own tests found and fixed

Worth recording, because they are the argument for the tests existing:

1. **Out-of-range durations were silently snapped.** The provider contract battery
   caught `validate()` accepting a 999-second request and coercing it to 10s.
   Snapping now only chooses between legal values.
2. **Freezes running to end-of-file were scored as zero frozen seconds.** ffmpeg
   emits `freeze_start` with no `freeze_end` in exactly the worst case — a still
   image padded to length. It now closes the interval at the clip duration.
3. **A batch could collectively blow a per-shot cap.** Every candidate was
   authorized against the same starting balance. Authorization now carries the
   batch's running commitment.
4. **Vertical video was silently low-resolution.** `frameSize` treated the
   resolution label as the height, making "1080p" vertical 608×1080 instead of
   1080×1920.
5. **Form labels were not associated with their controls.** Found by Playwright,
   fixed by rendering controls inside their `<label>` — an accessibility fix, not
   a test workaround.

---

## Exact commands to run it

```bash
cd masterclip-os
pnpm install
pnpm seed                    # demo project + credentials, printed to stdout
pnpm dev                     # web :4311 · api :4310 · worker
pnpm masterclip doctor       # verify ffmpeg, db, queue, storage, providers, spend
pnpm test && pnpm test:e2e && pnpm typecheck && pnpm lint && pnpm build
```

Requires Node ≥22.5 and ffmpeg/ffprobe on `PATH`.

## Credentials still needed

| For | Variable |
|---|---|
| MuAPI | `MUAPI_API_KEY` (a sandbox/test key first) |
| Google Veo | `GOOGLE_API_KEY` |
| fal | `FAL_KEY` |
| Runway / Luma / Replicate | `RUNWAY_API_KEY` / `LUMA_API_KEY` / `REPLICATE_API_TOKEN` |
| Visual QC + producer agents | `ANTHROPIC_API_KEY` |
| Provider callbacks | `PUBLIC_BASE_URL` + `WEBHOOK_SECRET` |
| Production deployment | `ASSET_SIGNING_SECRET`, `SESSION_SECRET` |

## Deployment status

Live since 2026-08-18 on Render, from the repository-root `render.yaml`
Blueprint: a Docker image on a paid instance with a 5 GB disk at `/var/data`
holding the SQLite database and every rendered clip. It was the third service
of a shared blueprint back in `music-artist-hub`; since the split this
repository is the whole product and `masterclip` is the only service in it.

| Fact | State |
|---|---|
| Runtime | one container, `scripts/serve.mjs` — seed, then worker, then API; exits if either child dies |
| Mode | `sandbox`. Every billable provider submission is refused outright, before any budget is consulted |
| Providers | all unconfigured. No provider key is set on the deployment |
| Signup | closed. The owner is seeded before the port opens, so the bootstrap race with the internet is over before there is anything to race |
| `TRUST_PROXY` | on, because Render terminates TLS and writes `X-Forwarded-For` itself |
| Secrets | `SESSION_SECRET`, `ASSET_SIGNING_SECRET` and `WEBHOOK_SECRET` generated by Render and never in the repository |
| Public origin | resolved from Render's own `RENDER_EXTERNAL_URL`; the blueprint cannot name a URL that does not exist yet |

The image built on Render's builders first time. That closes risk #18 — the
ffmpeg layer, corepack, `pnpm install --frozen-lockfile` and `pnpm build` on a
clean clone were the part this repository had no way to test, since no Docker
daemon was reachable during development.

What the deployment does **not** change: no live provider call has still ever
been made (risk #3), and the Google pricing unit is still unconfirmed (risk #1).
A deployment in sandbox mode proves the factory runs, not that it renders.

## Security warnings

1. Rate limiting is per process. One API instance is bounded; behind N instances
   the effective budget is N times the configured one, so a cluster still wants a
   shared limiter in the proxy.
2. `TRUST_PROXY` now defaults to off. A deployment that genuinely sits behind a
   proxy **must** set it, or every client will be rate-limited as one address.
3. The S3 driver has never touched a live bucket.
4. `ASSET_SIGNING_SECRET` and `SESSION_SECRET` **must** both be set in
   production. `loadConfig()` refuses to start under `NODE_ENV=production` if
   either is absent, is the value published in this repository, or is shorter
   than 16 characters. Until 2026-08-18 that refusal covered only
   `ASSET_SIGNING_SECRET`, and only on the local-storage path — with
   `STORAGE_DRIVER=s3` nothing checked it, and nothing checked `SESSION_SECRET`
   anywhere, so a production deployment could sign CSRF tokens with a value
   printed in the source.

## Cost-saving recommendations

1. **Resolve the Google "per 1 count" unit against a real invoice before routing
   volume there.** It is an 8× ambiguity and it is risk #1.
2. Draft on Wan 2.2 turbo / LTX-2.3 Fast (≈$0.04–0.08/s), finish on Veo 3.1 Fast
   or Lite. Let the router's measured acceptance rates take over from the priors
   after ~20 reviewed candidates per model.
3. Keep visual QC triage on Haiku 4.5 and escalate only uncertain or HERO clips —
   roughly an order of magnitude per frame.
4. Set `PUBLIC_BASE_URL` + `WEBHOOK_SECRET` in any real deployment so providers
   call back instead of being polled.
5. Do not self-host until the measured cost per **accepted** second beats the API.

## Recommended next milestone

**Prove one live provider end to end.** MuAPI, fal and Runway remain
unreachable from this environment; Google and Anthropic became reachable after
the build, so Google is the one to do first. With `GOOGLE_API_KEY` set:

```
pnpm masterclip providers contract --provider google          # free: catalog, capabilities, quote, health
MASTERCLIP_MODE=live LIVE_SPEND_CAP_USD=2 \
  pnpm masterclip providers contract --provider google --submit --project <projectId> --yes
```

The first command spends nothing. The second refuses unless the mode is `live`,
a real project is named, `--yes` is given, **and** the cost controller
authorizes it — it prints the exact figure and declines until you confirm.
Then confirm the charge the ledger records matches Google's own reported cost. That single
run converts six adapters from DEV-LABELED toward REAL faster than any amount of
further building, and it is the only way to close risk #3.

---

## Street Banker Audio Intelligence (audited 2026-08-25)

Same vocabulary, same standard. The audio layer's own verification run:
`pnpm typecheck` **36/36 clean** · `pnpm lint` **clean** · `pnpm test`
**418 passed / 418** · `pnpm test:e2e` **23 passed / 23** (whole repo, after
merging Live Lab from `main`).

| Area | Status | Notes |
|---|---|---|
| Provider-independent interfaces, registry, capability gate | **REAL** | every route and job passes the layered gate; flagship implicit entitlement + partner grants tested |
| Mock audio providers (all nine slots) | **REAL** | real seeded WAV output; deterministic transcripts; demo + tests run on it end to end |
| ElevenLabs adapters (STT, TTS, agents, dubbing, music, stems, isolation, SFX, voices) | **DEV-LABELED** | endpoints/params verified against official SDK v2.64.0; **no live call made from this environment** — run the `GET v1/user` health probe with a real key first |
| Meeting Intelligence (upload → transcript → draft → approval → Operator Desk commit) | **REAL** | consent gate, speaker rename, transcript correction, inferred-vs-explicit labelling all tested |
| Signal Audio Briefs + scheduling | **REAL** | confidence language preserved into audio (tested); schedule tick runs in the worker; Signal *data source* is NOT BUILT — items are caller-supplied |
| Operator agent (web channel, guardrails, escalation, post-call) | **REAL** | server-side orchestration tested incl. commitment refusal and human transfer; provider voice channel is DEV-LABELED (agent + KB sync implemented, never run live) |
| Global Release Pack (transcript review → dub fan-out → QA gate → export) | **REAL** on mock | per-language SRT+VTT caption assets from the reviewed transcript; per-segment QA UI is PARTIAL (prompt-based edit, no rich editor) |
| Campaign Audio Toolkit | **REAL** on mock | voiceover/SFX/isolation with lineage; vault-permission gate tested |
| Remix Lab (rights gates, moderation, stems, concepts, release gate) | **REAL** on mock | imitation prompts blocked pre-provider (tested); ElevenLabs stems arrive as one archive — per-stem unpacking NOT BUILT |
| Artist Voice Vault (owner-verified registration, scopes, revocation) | **REAL** on mock | proxy registration refused at the adapter; revocation cascade tested; provider verification webhooks NOT BUILT |
| Webhooks (signature, replay, idempotency, routing) | **REAL** | HMAC scheme matches the SDK's own implementation; tested incl. stale/tampered/duplicate deliveries |
| Retention sweeps + zero-retention gate | **REAL** | content deleted, audit metadata kept (tested); zero-retention refusal before upload (tested) |
| Usage ledger + budgets | **REAL** | append-only; hard stops/warnings tested; provider **cost reconciliation** (final_cost backfill) NOT BUILT — estimates are labelled estimates |
| Partner OS entitlement administration | **REAL** | flagship console at `/audio/admin`: per-org capability grant/revoke, enable-disable toggle, plan presets, budgets and month spend; grant/toggle/revoke covered by integration tests, flagship presentation + budget editing by a browser test |
| White-label operator config | **PARTIAL** | tenant-isolated settings + branding fields exist and apply to conversations; branding is edited via the settings API, not a dedicated screen |
| Realtime transcription, telephony/calendar capture | **NOT BUILT** | catalogued capabilities, no implementation |

---

## Street Banker Live Lab (audited 2026-08-25)

Same vocabulary, same standard. Verification run at `dd2d95f`: `pnpm typecheck`
**44/44 clean** · `pnpm lint` **clean** · `pnpm test` **621 passed / 621** ·
`pnpm test:e2e` **46 passed / 46** (whole repo).

Additionally booted through `scripts/serve.mjs` against the bundled `dist/` in
production mode, on a database built by the *previous* release rather than a
fresh one: an existing `0004` database carrying the Live Lab demo set was
upgraded to `0005` by the new build. Every Live Lab row survived byte-identical
— a content hash over projects, set items, scenes and mappings was unchanged —
the Song Lab tables were created, and the keyboard-zone endpoint was exercised
against that upgraded data, including its refusal to overwrite occupied keys.

What that boot does **not** establish: the deployed instance was unreachable
from this environment (egress policy denied `masterclip.onrender.com:443`), so
**which commit is actually serving production is unverified here.** The health
endpoint reports `commit` for exactly this question; read it from a network
that can reach the service.

The distinction that matters most here: **scheduling logic is unit-tested
against a manual clock; the browser audio path is not testable that way.** A
`TestAudioBackend` records what was scheduled and when, so quantization,
transitions and follow actions are verified precisely. The browser path is
covered separately, in real Chromium, by the browser suite described below.
Whether that graph actually emits the right sound on a stage rig is a third
claim, and this build has not made it.

| Area | Status | Notes |
|---|---|---|
| Tempo, launch quantization, queued launch, scene transitions | **REAL** | asserted against the audio timeline via `TestAudioBackend`: a queued clip lands exactly on the boundary, the outgoing scene stops at the incoming launch time |
| Transport, setlist, scenes, clips, follow actions | **REAL** | incl. edit-during-playback (the engine swaps project data in place without stopping the show) |
| Stem deck (mute/solo resolution, gain, pan) | **REAL** | solo/mute precedence tested; cross-song stem targets no-op rather than throw |
| 16-pad grid + pad states | **REAL** | states derived from real engine state, incl. `error` for uncached audio |
| Web Audio backend (buffer sources, buses, ramps, meters) | **DEV-LABELED** | now driven in real Chromium by the browser suite: a generated scene WAV decodes through `decodeAudioData`, and an `OfflineAudioContext` render of the shipping graph proves gain is applied proportionally and that zero gain is silence rather than "quiet" (both assertions fail when `play()` is mutated to ignore gain). **Ramps, meters and audibility on a real device remain unverified — no audio has been heard, on any device, from this environment** |
| AudioWorklet click | **DEV-LABELED** | the browser suite confirms the Blob-URL module parses and `registerProcessor` runs under a real `AudioWorkletGlobalScope`, returning a live `AudioWorkletNode`; falls back to scheduled oscillators where the worklet is absent. Still **never heard** |
| MIDI parsing, Learn, mapping application, duplicate detection | **REAL** | unit-tested plus an end-to-end Playwright flow that emits real MIDI bytes through a mock device |
| Keyboard zone mapping (bulk note → scene/pad) | **REAL** | one call maps a run of consecutive notes onto a song's scenes in performance order, or the sixteen pads; targets are validated before any write and colliding keys are reported rather than silently overwritten (both tested) |
| Web MIDI against physical hardware | **DEV-LABELED** | implemented against the spec; **no controller has ever been plugged into this build** |
| Offline performance package (manifest, checksums, verification) | **REAL** | server-side and device-reported verification both tested; a missing or corrupted cached file provably prevents READY |
| IndexedDB show cache in a browser | **REAL** | run in real Chromium against real IndexedDB and real WebCrypto: byte-identical round-trip, store digest agreeing with a digest of the source bytes, a single flipped byte changing that digest, a non-WAV refused as undecodable, and **a cached show surviving a page reload** — the property the offline package actually depends on |
| Performance Mode running with the network down | **REAL** | demonstrated in Chromium with `context.setOffline(true)` — the network genuinely off, verified unreachable inside the test before the show is started. The demonstration found a real defect: audio was cached but the *show* was not, so Performance Mode fetched its setlist, scenes and manifest over the network and rendered "Request failed" at a venue with no connection. The bundle is now stored on the device when the package is built, and the offline start is regression-tested |
| Crash recovery (snapshot, offer, restore) | **REAL** | restores mixer state *and position*: `selectSong` puts the set back on the song the performer was on without making a sound, so the set continues rather than jumping to the second song. Tested incl. that a restore survives the next song change and never auto-starts audio — the silence assertion fails if `selectSong` is made to start playback, and demonstrated **offline in a real browser**: reload with the network down, the app loads from the service-worker shell cache, the session survives an unreachable `/api/auth/me`, RESTORE PERFORMANCE is offered, and the transport reads stopped afterwards. Reaching that offer offline needed all three — shell, session, bundle — and none of them worked before |
| Entitlements + tenant isolation | **REAL** | server-side enforcement, numeric limits, and cross-org/cross-project write rejection all tested |
| Rights gating + prompt safety | **REAL** | rights confirmation required at API *and* provider boundary; imitation/cloning prompts blocked pre-provider (tested) |
| AI Scene Builder | **REAL** on mock | async via the durable queue, three options, lineage recorded, acceptance explicit; **the only provider is the local synthesizer** |
| A real AI audio provider for Live Lab | **DEV-LABELED** | Live Lab now composes through the platform's music slot (`PlatformMusicProvider`), so a configured ElevenLabs key serves the scene builder with no further wiring — tested end to end against the platform *mock*, and **never run against a live music model** |
| Live Lab spend in the platform ledger | **REAL** | a platform generation records what the provider measured into `audio_usage_ledger`, attributed to `live_lab` with the project and job, and is priced through the operator's configured `AUDIO_RATE_CARD` — the same rate card and the same `estimateMicros('music')` the audio layer prices its own jobs with, so nothing here knows what anything costs. Live Lab therefore counts toward `monthSpendMicros`, the figure budgets read; it previously left no trace at all, then briefly recorded units at zero cost, which read as *free* rather than *not yet priced*. An unconfigured rate card yields zero, exactly as it does for every other feature, and the local synthesizer records nothing because it buys nothing. **Live Lab is still not *gated* by the audio budget** — `live_lab.max_ai_generations_per_month` bounds it, and whether an exhausted audio budget should refuse a scene is an open policy question |
| Live Set Builder (suggestions + approval-gated apply) | **REAL** | approval gating, subset application, click routing, pad mapping and idempotent re-planning tested |
| Stage Control handoff | **REAL** as an interface | export/import is versioned and tested; there is **no Stage Control system in this repo to talk to** |
| Remix/release import | **REAL** | imports org project audio and cross-project Live Lab assets, org- and project-checked |
| Duplicating a set | **REAL** | scenes, clips, stems and assets are re-created and every reference to them rewritten — pads repoint at the copies, pads whose target did not survive are cleared to `empty`, and follow targets are remapped (a `target` follow that cannot be resolved falls back to `stop`). Verbatim copying of the pad map, and a source resolved only after the new project existed, were both fixed and are regression-tested |
| Multi-device output routing (per-stem sends, FOH) | **PARTIAL** | logical outputs, cue/click buses and whole-mix `setSinkId` selection exist; per-stem *device* routing is the desktop backend's job |
| Keyboard sampler, custom macros | **NOT BUILT** | deliberately (V1 scope). `cue` and `macro` are in the mapping vocabulary but dispatch to nothing and are not offered in the Learn UI — forward-compatible surface, not a working feature. Chromatic sampling is a desktop-phase item |
| Desktop app, Ableton Link, MIDI Clock, Stage Bridge | **NOT BUILT** | `docs/LIVE_LAB_DESKTOP.md` is a migration plan, not an implementation |
| Experimental NEXT SCENE generation | **NOT BUILT** | deliberately. Its safety constraint is already enforced: generated audio is triggerable only once cached and verified |

### What would change these statuses

A browser suite (`tests/e2e/live-lab-browser.spec.ts`) now runs the shipping
cache and audio classes in real Chromium, which is what moved the IndexedDB row
to REAL and narrowed the two audio rows. It injects a separately bundled
fixture rather than exposing anything on `window` in production, and its
assertions were checked by mutation — ignoring `opts.gain` and making the
digest content-blind each turn a test red.

Pulling the network cable turned out to be one a browser *can* settle, and
doing it found a defect no amount of reading the code had: the offline path
was never reachable offline. That is the argument for running these rather
than reasoning about them.

What a browser still cannot settle, and a rehearsal on real hardware can:
plug in a controller and listen. That session is what remains for Web MIDI
against physical hardware and — the one no test can make — that the show is
*audible*. Rendering the right samples and driving a loudspeaker are
different claims, and only the second one matters on stage.
