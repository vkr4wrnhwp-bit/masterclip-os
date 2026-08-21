# Architecture

MASTERCLIP OS is a render factory: it turns a canonical shot specification into
many provider renders, measures them, and keeps the ones a human approves —
optimising for **cost per approved second**, not cost per render.

---

## 1. The shape of the system

```
                    ┌──────────────┐
   browser ────────▶│  apps/web    │  React SPA (hash-routed, dark, colour-neutral)
                    └──────┬───────┘
                           │ JSON over same-origin cookie session
                    ┌──────▼───────┐
                    │  apps/api    │  Fastify. Validates, authorizes, enqueues.
                    └──────┬───────┘  Never renders, transcodes, or polls.
                           │
                    ┌──────▼───────────────────────────────────┐
                    │  durable queue (rows in the database)    │
                    └──────┬───────────────────────────────────┘
                           │ lease / heartbeat / backoff / dead-letter
                    ┌──────▼───────┐
                    │ apps/worker  │  submit → poll → download → QC → derivatives
                    └──────┬───────┘
                           │
   ┌───────────────────────┼────────────────────────────────┐
   │                       │                                │
┌──▼─────────┐    ┌────────▼────────┐              ┌────────▼────────┐
│ providers  │    │  media (ffmpeg) │              │  Claude agents  │
│ mock/muapi │    │  probe, proxies │              │  judgement only │
│ google/fal │    │  QC, finishing  │              │                 │
│ runway/... │    └─────────────────┘              └─────────────────┘
└────────────┘
```

The load-bearing rule: **generation never happens inside an HTTP request.** The
API queues work and returns; the worker performs it. That is what makes a render
survive the browser closing, the API restarting, and the worker crashing.

---

## 2. Packages, and why each exists

| Package | Responsibility |
|---|---|
| `shared` | ids, errors + retry classification, structured logging, secret redaction, **micro-USD money**, canonical hashing, HTTP client |
| `shot-schema` | the canonical shot spec (zod → JSON Schema), semantic validation, derived requirements, Character/World bibles, CSV+JSON import/export |
| `database` | one `Db` interface over SQLite and PostgreSQL, portable DDL, migrations |
| `queue` | durable leased queue + worker loop |
| `asset-storage` | local and S3 drivers, signed URLs, SigV4 |
| `auth` | scrypt passwords, hashed session tokens, project authorization |
| `provider-core` | the `VideoProvider` contract, capability matching, pricing, webhook verification, the contract test battery |
| `provider-*` | one adapter per backend (mock, MuAPI, Google, fal, Runway, Luma, Replicate, self-hosted) |
| `media-tools` | every ffmpeg/ffprobe operation, invoked without a shell |
| `qc-engine` | deterministic technical QC, vision QC, decision rules |
| `cost-engine` | append-only ledger, four-level budgets, the authorization gate, metrics |
| `model-router` | routing profiles and expected-approved-cost ranking |
| `prompt-compiler` | provider-aware compilation that cannot lose a locked fact |
| `agents` | the Claude producer layer |
| `runtime` | the composition root, the render pipeline, master finishing |

---

## 3. Decisions, and the reasoning behind them

### 3.1 Money is integer micro-USD

Video is priced in fractions of a cent per second and a project runs tens of
thousands of these through sums and divisions. Floating-point dollars drift;
integers do not. Every ledger row, budget, and quote is micro-USD
(`1 USD = 1_000_000`), and `divideMicros` returns `null` rather than `Infinity`
so the UI shows "no data yet" instead of a fabricated number.

### 3.2 Quote → authorize → submit, in that order, every time

Nothing calls a provider's `submit()` except `RenderService.submitRender`, and
that method cannot reach the provider without passing `CostController.authorize`
first. Authorization happens **twice**: at plan time, so the operator sees a real
total before queueing, and again at submit time, because jobs sit in a queue
while prices move and other jobs spend the budget.

Within a batch, each candidate is authorized against the batch's running
commitment — otherwise every candidate is checked against the same starting
balance and a batch collectively blows a cap no single render would have
breached.

### 3.3 The canonical shot is the source of truth; prompts are compiled from it

A render references an immutable `shot_versions` row, never the mutable shot.
Editing a shot after a render cannot rewrite what that render was asked to
produce. The prompt compiler adapts phrasing per provider but verifies that every
locked creative fact survived into the output — and throws if one did not, rather
than shipping a prompt describing a different character.

### 3.4 Two QC layers, cheapest first

Technical QC is measurement: ffprobe, blackdetect, freezedetect, a full decode
pass, and arithmetic. It is free and it runs on everything. Visual QC costs money
and runs only on clips that passed technically — paying a vision model to look at
a black frame is money spent learning what ffmpeg already proved.

Two rules are encoded rather than left to a model:
- **automatic rejection is only for demonstrated failures** (frozen, all-black,
  wrong duration, duplicate, unusable bitrate). Weak creative work goes to a human.
- **nothing is ever auto-promoted to a master.** A person signs off on what ships.

### 3.5 Claude does judgement; code does everything else

Claude handles brief interpretation, shot design, prompt adaptation, routing
advice, uncertain QC adjudication, and cost strategy. Polling, hashing, file
moves, arithmetic, queue transitions, retry timing, codec work, and deterministic
validation are ordinary code. Without an `ANTHROPIC_API_KEY` the pipeline still
runs end to end; it just stops making the judgement calls, and says so.

### 3.6 The mock provider renders real video

`provider-mock` drives ffmpeg to produce genuine MP4s — including deliberately
defective ones (frozen, all-black, truncated, low-bitrate, wrong-duration) chosen
deterministically from the request id. This is what lets the entire factory be
exercised, and QC's failure detection *proven*, at zero cost. It is also what the
integration and browser suites run against.

---

## 4. Deviations from the original brief

**Vite + React SPA served by Fastify, instead of Next.js.** The brief listed
Next.js under "preferred components" and allowed a better-justified alternative.
The API here is consumed by three clients (browser, worker, CLI), so
server-component rendering buys nothing, while a single always-on Fastify process
that also serves the built SPA keeps one deployable and one auth path. The
architectural rule the brief actually cares about — no long jobs inside an HTTP
request — is enforced by the worker either way.

**A database-backed durable queue instead of Redis + BullMQ.** The brief allowed
"a comparably reliable current alternative". The state that must not be lost —
what was submitted, what it cost, what is still owed — already lives in this
database, and a queue row written in the same transaction as a ledger row cannot
disagree with it. It also removes Redis from the minimum runtime, so a clean
checkout runs with no services at all. Leases, exponential backoff with jitter,
stalled-job recovery, dead-lettering, replay, and dedupe keys are all implemented
and tested.

**SQLite is the default; PostgreSQL is a driver flag.** The DDL is written in the
intersection of both dialects and the same migrations are verified against a live
PostgreSQL 16. `DB_DRIVER=postgres` plus `DATABASE_URL` switches it.

---

## 5. Data model, in brief

- `projects → scenes → shots → shot_versions` — versions are immutable.
- `characters/environments → *_versions` — every render records the bible
  versions it used.
- `assets` carry rights and consent; `asset_lineage` records provenance, so a
  delivery traces back through the master to the render to the shot version and
  the references it consumed.
- `render_batches → render_jobs → render_attempts → outputs → output_qc/reviews →
  masters → master_deliverables`.
- `cost_ledger` is append-only: `estimate` rows before submission, `charge` rows
  after, so estimate-vs-invoice variance is a query rather than a guess.
- `audit_log` is append-only and covers money and approvals.

---

## 6. Failure handling

| Failure | Behaviour |
|---|---|
| provider 429 / 5xx | retry with exponential backoff + full jitter; the provider's own `Retry-After` wins |
| provider validation / safety refusal | never retried — it will refuse identically |
| generation failed after billing | never auto-retried; a retry is a new paid attempt and goes back through the cost controller |
| worker dies mid-job | lease expires, `recoverStalled` returns the job to the pool |
| duplicate webhook | unique `(provider_id, dedupe_key)` index; the second delivery is acknowledged and ignored |
| truncated or corrupt download | reported as a delivery failure, not a bad render, and not counted against the model's acceptance rate |
| queue job exhausts attempts | dead-lettered with its payload, replayable from the CLI or the API |

---

## 7. Running it

See the README. In short: `pnpm install && pnpm seed && pnpm dev`, then
`pnpm masterclip doctor` to verify ffmpeg, database, queue, storage, providers,
and the remaining live-spend allowance.
