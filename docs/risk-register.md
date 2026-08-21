# Risk register

Ordered by expected cost of being wrong.

| # | Risk | Likelihood | Impact | Mitigation in place | Residual |
|---|---|---|---|---|---|
| 1 | **Google's "per 1 count" pricing unit is per-clip, not per-second** | low-medium | 8× cost error either way | quotes marked `estimated`; warning surfaced in the UI and in every quote's `raw`; global live-spend cap bounds it. Re-checked 2026-08-18 against Vertex's published card, now reachable: prices confirmed to the cent, and "count" shown to be Google's generic unit word (used for images, video inputs, and 1,000-count tokens), which argues against the per-clip reading | **open** — narrowed, not settled; one cheap live render reads the charge and ends it |
| 2 | **Provider API drift** (renamed models, changed fields) | high | submissions fail after a shot is planned | capabilities and prices carry `retrievedAt` + `sourceUrl`; live catalogues preferred; contract battery per adapter; static fallbacks labelled `source: 'static'` | ongoing — re-run `masterclip providers contract` on a schedule |
| 3 | **No live provider call has ever been made from this build** | certain | adapters are spec-correct but unproven on the wire | every host was egress-blocked during development; adapters written from vendors' own client source, not memory | **open** — first live run needs a sandbox key and `masterclip providers contract --submit` |
| 4 | **A routing bug spends at scale** | low | unbounded | sandbox default; global `LIVE_SPEND_CAP_USD`; batch-aware authorization; re-authorization at submit; attempt caps; contract battery gated on the cost controller. An adversarial review on 2026-08-18 found the caps were largely inert and fixed it: `sandbox` is now a provider fact rather than the deployment posture (it previously exempted every real provider from every cap), completions with no provider-reported cost are charged at estimate rather than not at all, in-flight jobs hold a reservation, and a zero or negative price is refused | low |
| 5 | **Acceptance-rate learning overfits a tiny sample** | medium | bad routing that looks data-driven | Beta prior with 8 pseudo-observations; confidence reported on every decision; UI says when a ranking rests on priors | low |
| 6 | **Identity misuse** — generating a real person without consent | low | serious | consent recorded at upload; `requireAuthorizedForIdentity` refuses unless explicitly authorized and unexpired; rights changes audited | low |
| 7 | **A vision-QC false negative passes a bad clip** | medium | wasted finishing work | auto-rejection restricted to *demonstrated* technical failures; low confidence routes to a human; nothing auto-promotes | low |
| 8 | **A vision-QC false positive rejects a good clip** | medium | wasted spend | visual hard-failures require ≥0.6 confidence; human review remains the default for anything uncertain | medium |
| 9 | **Provider webhook spoofing** | low | fake completions | HMAC token bound to `(provider, job)`; per-provider signature where offered; dedupe index; state always re-fetched from the provider | low |
| 10 | **MuAPI's image field name varies by model** | high | 422 on submit | runtime recovery loop swaps `image_url` ↔ `images_list` on a field-required 422 | low |
| 11 | **Self-hosting adopted before it pays** | medium | worse cost per approved second plus ops burden | provider refuses to quote without measured GPU rate and compute ratio; `SELF_HOSTED_DRAFT` is not a default profile | low |
| 12 | **S3 driver has never touched a live AWS bucket** | medium | uploads fail in a cloud deployment | SigV4 unit-tested against AWS's published vector; the driver is now exercised over a real socket against an S3-compatible server — put/get/head/delete/list, key encoding checked against the S3 spec on the wire, XML parsing, status mapping, presigned fetch; local driver is still the default | **partially open** — wire mechanics proven, AWS compatibility not; run `doctor` with `STORAGE_DRIVER=s3` before relying on it |
| 13 | **API rate limiting is per process** | low | behind N instances the effective budget is N× | token-bucket limiter on every API class, per client address, plus a per-account login budget; `TRUST_PROXY` off by default so the key cannot be forged | low — closed for single-instance; use a shared limiter in the proxy for a cluster |
| 14 | **Long single generations degrade** | high | wasted renders past ~10s | validator warns above 10s and points at chaining via `CONTINUITY` | low |
| 15 | **Queue starvation under load** | low | slow renders block cheap bookkeeping | four separate queues (render, qc, media, maintenance) | low |
| 16 | **Estimate-vs-invoice drift goes unnoticed** | medium | budgets quietly wrong | `estimate` and `charge` are separate ledger entry types; `variance()` reports the delta per job | low |
| 17 | **Ledger corruption via a partial write** | low | wrong spend totals | ledger writes are transactional with the state change they describe; append-only | low |
| 18 | **The deployment image had never been built** | ~~medium~~ | first deploy fails | no Docker daemon was reachable during development, so `docker build` was never run here. **Closed 2026-08-18**: the image built on Render's builders first time and the service is running — ffmpeg layer, corepack, `pnpm install --frozen-lockfile` and `pnpm build` all succeeded on a clean clone, which is the part this repository could not test. The application layers had already been proven locally against an exact replica of the build context | **closed** — the image is built and serving |

---

## Deployed 2026-08-18

Live on Render in `sandbox` mode with no provider keys set. That closes #18 (the
image builds) and changes nothing about #1 or #3: a deployment that refuses every
billable submission proves the factory runs, not that it renders.

Two risks the deployment makes newly relevant:

- **#13, per-process rate limiting** — currently correct, because this is a
  single instance. Scaling to more than one makes the effective budget N× the
  configured one; move the limiter to the proxy before scaling out.
- **#12, the untested S3 driver** — unchanged and still unused. Storage is the
  local driver on a mounted disk. Do not switch `STORAGE_DRIVER=s3` on a live
  deployment without running `doctor` against the bucket first.

## The two that need a human before production

1. **Confirm the Google pricing unit against a real invoice** (#1).
2. **Run one live sandbox render per provider** and re-run the contract battery
   with `--submit` (#3).

Both need credentials this build has never had. Everything else on the list is
mitigated in code.

---

## Found by attacking the money path (2026-08-18)

Six lenses attacked the cost engine, router, ledger and agent spend boundaries;
each finding was handed to a separate agent instructed to refute it. **20 of 44
candidates survived.** The four that mattered most, all fixed:

| Defect | Why it mattered |
|---|---|
| `isSandboxProvider()` returned true for every provider whenever `MASTERCLIP_MODE=sandbox` | the default, documented-as-safe posture marked real fal/Google/Runway requests `sandbox: true`, which skipped the live-spend cap, human approval and attempt caps — and wrote ledger rows `sandbox = 1` so they never counted later either. A verifier reproduced 30 real submissions with the cap never once consulted |
| Five of seven adapters return `actualMicros: null`, and no charge was recorded without one | every budget, including the global cap, read $0 for ever. Unpriced completions are now charged at estimate and labelled, because a cap fed slightly wrong numbers refuses too early while a cap fed nothing never refuses at all |
| The live cap counted only settled charges | N concurrent submissions each authorized against a balance none had moved; in-flight jobs now hold a reservation from `authorizing` through `downloading` |
| A $0 or negative quote satisfied every cap | zero passes every budget by arithmetic and slides under the approval threshold; a billable request now needs a positive price, and `unknown` confidence is the honest way to report no price |
| `GET /api/queue/dead` swallowed its own auth failure; replay had no auth at all | any caller could read every tenant's dead letters, and replay re-triggers a billable generation for another org |

The remaining confirmed findings are now fixed too:

| Defect | Fix |
|---|---|
| Retry re-submitted a job still generating at the provider — a second paid generation alongside the first, with the original orphaned so its cost was never recorded | retry is refused for any job in `authorizing`/`submitted`/`processing`/`downloading`; cancel it first |
| Cancel discarded provider errors and marked the job cancelled locally, stopping the poll loop before anything was charged | cancel now reports whether the provider actually stopped, and settles at estimate for any job that reached the provider — the last chance to record it |
| The poll timeout failed the job without ever asking the provider for a final state or cost | it asks once more, charges what the provider reports, and falls back to the estimate when it reports nothing |
| Webhook-driven and timer-driven polls could both settle the same job, writing one generation to the ledger as two charges | `chargeJobOnce()` — idempotence belongs to the ledger, not to whichever poller noticed first |
| Visual QC spent real Anthropic money with no reference to the global cap | QC checks the same ceiling before running; it is not a provider generation, but it is real spend |
| An unpriced QC model returned `-1` and the caller only ledgered `> 0`, hiding the spend entirely | any nonzero cost is recorded, and an unpriced model is logged as an error |
| A `rank` or `reset` review overwrote an earlier `approve` in the routing statistics, turning approvals into failures | only decisions carrying a verdict count toward measured acceptance |
| The contract battery submitted with `sandbox: true`, exempting a live run from the cap, the unknown-price denial and the approval gate | a contract run against a real provider now says it is billable |
| `validate()` computed a provider-legal duration and no caller applied it, so a 7.6s shot was priced at 7.6s and generated at 8s | adjustments are applied before quoting, so the priced request is the submitted request |

One further bug surfaced while writing the regression tests: `addVersion`
passed `title: spec.title || undefined` to an update, and `undefined` reaches
SQL as NULL against a NOT NULL column — so saving a shot whose spec carried an
empty title failed outright. Fixed by omitting the field instead.
