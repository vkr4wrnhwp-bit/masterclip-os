# Current pricing snapshot

**Retrieved 2026-08-17.** Every figure carries its source and a confidence
marker. This document is a **snapshot for humans**, not the application's pricing
authority: the app quotes each request against the live provider where one is
available, and refuses to spend on a model whose price it cannot establish.

---

## ⚠️ Read this before trusting any number here

**Every provider host was blocked by this environment's egress policy during
research.** `muapi.ai`, `api.muapi.ai`, `ai.google.dev`, `docs.cloud.google.com`,
`fal.ai`, `docs.fal.ai`, `queue.fal.run`, `docs.dev.runwayml.com`,
`api.dev.runwayml.com`, `docs.lumalabs.ai`, `replicate.com`, and
`api.replicate.com` all returned 403 at the CONNECT tunnel — an organization
policy denial, not a transient failure.

Research therefore used **first-party machine-readable sources that were
reachable** instead of the vendors' narrative docs:

| Provider | Primary source used | Confidence |
|---|---|---|
| MuAPI | official CLI source (`github.com/SamurAIGPT/muapi-cli`, HEAD `856a2a5`) | **high** for endpoints/headers; **unverified** for prices |
| Google | Google's own v1beta API **discovery document** (rev `20260814`) + the official `googleapis/python-genai` SDK + the official cookbook | **high** for the REST surface; see the unit warning below for price |
| fal | official clients `fal-ai/fal-js` and `fal-ai/fal` | **high** for the queue API; **unverified** for prices |
| Runway | official OpenAPI spec + `sdk-node` | **high** for endpoints, headers, status enum, credit rate |
| Luma | official OpenAPI spec | **high** for endpoints and states |
| Replicate | official `replicate/client.py` | **high** for endpoints; model slugs deliberately not hardcoded |
| Anthropic | platform.claude.com docs | **high** |

**Nothing here should be treated as an invoice.** Confirm against a real bill
before running volume.

---

## 🔴 The unit ambiguity that matters most: Google Veo

Google's published rate card prints its Veo figures as **"per 1 count"** and
never defines "count" on the page. Every surrounding convention — and the widely
cited Veo 3 per-second rate — says one count is **one second of output**, but
that could not be confirmed from an official page.

**The two readings differ by 8× on an 8-second clip** ($3.20 vs $0.40 for Veo 3.1
1080p with audio).

### Re-checked 2026-08-18 — narrowed, still not resolved

`cloud.google.com/vertex-ai/generative-ai/pricing` became reachable from this
environment after the build (the `/docs/` paths under the same host remain
blocked), so the question was re-examined against Google's own page rather than
a discovery document. Three things came out of it:

1. **Every Veo figure below was confirmed unchanged** against the published rate
   card — the build-time figures, derived from the v1beta discovery document,
   were correct to the cent.
2. **Vertex AI prints the identical "per 1 count" phrasing**, so this is not a
   Gemini-API quirk to be resolved by reading the other surface. Both say the
   same thing and neither defines it.
3. **"count" is Google's generic billing-unit word, not a video-specific one.**
   The same page prices Gemini image input at `$0.00032875 / 1 count`, video
   input at `$0.002 / 1 count`, and text at `$0.0003125 / 1,000 count` — tokens.
   It means "one unit of whatever is being metered", which is *evidence against*
   reading it as "one clip": a generic unit word carries no such claim.

That shifts the balance toward the per-second reading without establishing it.
It is not enough to change the code's behaviour, and the `estimated` confidence
marker and the spend cap both stay until an invoice settles it.

How the application handles it:
- `provider-google` treats a count as one second;
- every Google quote is marked `confidence: 'estimated'`, never `exact`;
- the unit warning travels in the quote's `raw.warnings` and is surfaced in the
  UI's model catalog under "pricing note";
- the global `LIVE_SPEND_CAP_USD` bounds the damage if the reading is wrong.

**Resolve this against a real invoice before routing volume to Google.** A
single cheap live render is the cheapest way: generate one 4-second clip and read
the charge. Per-second predicts ~4x the per-clip figure, and the two are far
enough apart that one render settles it.

---

## Google — Gemini API (Veo family)

Source: `cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing`
(the one Google pricing page that did not redirect to a blocked host). USD, per
"count" (see above). **STATIC** rate card.

| Model | Mode | Resolution | Rate |
|---|---|---|---|
| Veo 3.1 | video + audio | 720p, 1080p | $0.40 |
| Veo 3.1 | video + audio | 4K | $0.60 |
| Veo 3.1 | video only | 720p, 1080p | $0.20 |
| Veo 3.1 Fast | video + audio | 720p | $0.10 |
| Veo 3.1 Fast | video + audio | 1080p | $0.12 |
| Veo 3.1 Fast | video only | 720p | $0.08 |
| Veo 3.1 Fast | video only | 1080p | $0.10 |
| Veo 3.1 Lite | video + audio | 720p | $0.05 |
| Veo 3.1 Lite | video + audio | 1080p | $0.08 |
| Veo 3.1 Lite | video only | 720p | $0.03 |
| Veo 3.1 Lite | video only | 1080p | $0.05 |
| Veo 2 | video (no audio) | 720p | $0.50 |

On the Gemini API, Veo 3.x **always** generates audio — `generateAudio` is
Vertex-only and raises. The adapter therefore quotes the with-audio rate, which
is the honest figure. Billing rounds sub-cent fractions up to one cent per cycle.

Gemini Omni Flash prices video output through the **token meter**, not a
per-second rate; the derived effective rate for 720p+audio worked out to roughly
$0.10/s, with thinking tokens billed separately on top. Not implemented in this
release — see `docs/model-capabilities.md`.

---

## fal.ai

fal exposes **no programmatic price endpoint** in either official client. These
came from research summaries of fal model pages, except the two marked VERIFIED,
which were read out of a fal-owned repository. **DYNAMIC in practice** — re-check
before volume.

| Model | Rate | Confidence |
|---|---|---|
| Seedance 2.0 T2V | $0.3034/s | **VERIFIED** (`fal-ai/seedance-2.0-api` README) |
| Seedance 2.0 Fast | $0.2419/s | **VERIFIED** (same) |
| Wan 2.2 A14B turbo | $0.08/s @720p, $0.04/s @480p | summary |
| Wan 2.5 | $0.05/s | summary |
| LTX-2.3 Fast | $0.04/s @1080p, $0.08 @1440p, $0.16 @2160p | summary |
| LTX-2.3 Pro | $0.06/s @1080p | summary |
| Kling 2.5 Turbo Pro | $0.07/s (≈$0.35 per 5s) | summary |
| Veo 3.1 Fast via fal | $0.10/s no audio, $0.15/s with audio | summary |
| Veo 3.1 Lite via fal | $0.05/s | summary |
| Hailuo 02 Standard | $0.045/s @768p | summary |
| Hailuo 02 Pro | $0.08/s @1080p | summary |

Implemented in `packages/provider-fal/src/catalog.ts`, each entry carrying its
own `sourceUrl` and `retrievedAt`.

---

## MuAPI

**Dynamic by design.** MuAPI prices most video models per request through
`POST /api/v1/models/{model}/estimate-cost`, and mirrors the actual wallet charge
into `X-MuAPI-Cost-USD` / `X-MuAPI-Cost-Credits` response headers.

The adapter therefore stores **no compiled-in prices** for MuAPI: every model
descriptor is `dynamicPricing()`, a live estimate is fetched before any paid
submission, and the response headers are used to capture the real charge.

One correction from the fact-check pass: the estimate response is documented as
returning **USD only**, not USD and credits as first reported. The adapter reads
both defensively and does not depend on either.

---

## Runway

Runway publishes **no rate-card endpoint** — all 48 paths in its OpenAPI spec were
enumerated and none returns one. What it does provide is better:

- `POST /v1/{image_to_video|text_to_video|video_to_video}` returns
  **`estimatedCost.credits`** — "the maximum credits this task may charge";
- the terminal task returns **`cost.credits`** — the invoice. A refunded task
  reports 0.
- **$0.01 per credit**, stated in the spec's own `info.description`.
- Non-mp4 output (ProRes, PNG sequence) adds **5 credits per second** on `gen4.5`
  and `aleph2`.
- `GET /v1/organization` returns `creditBalance`.

Because the estimate only arrives *with* the accepted task, `RunwayProvider.quote`
returns `confidence: 'unknown'` — which the cost controller refuses for live
spend — and `submitWithQuote()` surfaces the estimate for the caller to enforce.

---

## Luma

Credit-based. No rate card was reachable. `GET /credits` gives the balance;
the adapter marks all Luma models `dynamicPricing()` and tracks spend through
balance deltas.

---

## Replicate

Billed per **second of hardware time** on the SKU the model runs on.
`GET /v1/hardware` returns `sku` and `name` — **and no price** — so the rate must
be joined out-of-band.

There is also **no balance or spend endpoint anywhere in the official SDK**;
`GET /v1/account` returns identity only. This is a real operational gap: spend
against Replicate must be tracked internally from `metrics.predict_time`, which
is what the adapter reports and the ledger accumulates.

---

## Anthropic (the agent and QC layer)

**STATIC**, USD per million tokens, retrieved 2026-08-17 from
platform.claude.com.

| Model | API id | Input | Output |
|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | $10 | $50 |
| Claude Opus 5 | `claude-opus-5` | $5 | $25 |
| Claude Sonnet 5 | `claude-sonnet-5` | $2 | $10 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1 | $5 |

Cache multipliers on the input rate: 5-minute write ×1.25, 1-hour write ×2,
read ×0.1. Implemented in `packages/agents/src/client.ts`, which computes exact
per-call cost from the returned usage and writes it to the same ledger as video
spend. An unknown model id returns `-1` rather than 0, so unpriced spend cannot
hide as free.

Frame QC economics: roughly **$1.30 per 1,000 frames** on Haiku 4.5 against
**$6.48** on Opus 5 for a 1000×1000 frame — which is why triage runs on the cheap
model and only uncertain or expensive clips escalate.

---

## Self-hosting

No numbers are asserted here. `provider-selfhosted` refuses to quote at all until
an operator supplies a measured GPU hourly rate **and** a measured
seconds-of-compute-per-second-of-video ratio, because a self-hosted endpoint that
quotes zero would win every routing decision on cost. See `docs/cost-strategy.md`.
