# Studio runbook

Operating Street Banker Studio: flags, jobs, what breaks, and what a failure
looks like from a user's side.

---

## Enabling it

Studio is entitlement-gated per organization. A fresh org has no access, and the
nav entry does not appear.

```ts
await runtime.entitlements.grantAll(orgId, FLAGSHIP_STUDIO_CAPABILITIES)
// or, for a partner edition:
await runtime.entitlements.grantAll(orgId, PARTNER_STUDIO_CAPABILITIES)
```

`pnpm seed` grants the flagship set to the seeded org and creates the demo.

### Flags

| Flag | Default | Off means |
|---|---|---|
| `STUDIO_ENABLED` | on | No Studio route or job runs at all |
| `STUDIO_MIX_ENABLED` | on | No Mix Station, Mix Doctor or references |
| `STUDIO_MASTER_ENABLED` | on | No Master Station or album mastering |
| `STUDIO_TRANSLATION_LAB_ENABLED` | on | No translation estimates |
| `STUDIO_ASK_THE_ROOM_ENABLED` | on | No advisory assistant |
| `STUDIO_DELIVER_ENABLED` | on | No delivery checks or handoff |
| `STUDIO_SONIC_DNA_ENABLED` | on | Approving a master learns nothing |
| `STUDIO_RECORD_PASSPORT_ENABLED` | on | No provenance record |
| `STUDIO_IDENTITY_VAULT_ENABLED` | on | No identity controls |
| `STUDIO_AI_LICENSING_ENABLED` | on | No AI permission surface |
| `STUDIO_MARKETPLACE_ENABLED` | **off** | Engineer marketplace hidden |
| `STUDIO_OPPORTUNITY_ENGINE_ENABLED` | **off** | Opportunity engine hidden |

The last two default off because the thing behind them does not exist yet — no
configured providers and no payment integration; no connection to the audience,
streaming and campaign data the engine is meant to weigh. Their schemas and API
boundaries are real; the surfaces stay dark.

Two more worth knowing:

- `STUDIO_MAX_ANALYSIS_SECONDS` (900) caps analysed length so one long upload
  cannot occupy a worker.
- `STUDIO_ANALYZER_SET` is recorded on every analysis. Two analyses from
  different values are reported as incomparable rather than diffed.

---

## Jobs

All on the `studio` queue, and all recorded in `studio_processing_jobs` — one
row per unit of work, whoever performed it.

| Column | Answers |
|---|---|
| `provider` / `adapter` | Who did the work. Local work is named `street-banker` / `local-dsp`, never left blank |
| `idempotency_key` | Unique per org. A redelivered message resolves to the job that exists rather than doing the work twice |
| `attempt` / `max_attempts` | How many times this has been tried |
| `cost_micros` | What the provider reported. **Null means no cost was reported** — not zero |
| `credit_state` | `not_billable` → `reserved` → `consumed` or `released` |
| `error_code` / `error_message` | Why it ended that way |

`GET /api/studio/projects/:id/jobs` is the support view.

### The billing rule

A reservation converts to `consumed` in exactly one place: a job that both
succeeded **and** produced a usable result. Every other terminal state releases
it, including the two that look like success and are not:

- A rendition that came back `placeholder` — a completed render whose output is
  the customer's own unprocessed mix. Charging for that would be charging
  somebody for their own audio.
- Any path where the work throws. That is the one a caller would forget, so the
  release happens in `StudioProcessingService.run` before the exception
  continues on to the queue.

Nothing is billable today: `billable` is `false` everywhere, because no payment
integration exists and marking work billable against a balance nobody holds
would be an invented charge. The column is there so a paid adapter can set it
truthfully.

`jobId` is optional in every queue payload. A message queued before this ledger
existed still runs — unrecorded — rather than being stranded across the deploy.

| Job | Does | Settles |
|---|---|---|
| `studio.mix.analyze` | Runs the analyzer set, writes metrics and curves, runs Mix Doctor | `ready` / `failed` / `unsupported` |
| `studio.reference.analyze` | Measures a reference, then **discards its audio** where the rights basis requires it | as above |
| `studio.master.render` | Renders a rendition, stores the output, queues its analysis | `ready` / `failed` / `unsupported` |
| `studio.master.analyze` | Analyses the output and computes the loudness-match gain | — |

Every failure path settles the row with a reason. A rendition or an analysis
stuck at `pending` forever is a worse outcome than one that says what went
wrong, so there is no path that leaves either unresolved.

The reference discard lives in the *same job* that measured it, so a reference
cannot linger in storage because a later step never ran.

---

## Who performs the work

Every byte of audio goes through an `AudioProcessingProvider`. A provider
declares what it can do (`analyze_mix`, `render_master`, `transcode`,
`separate_stems`), who it is, and how ready it is *here*:

| Readiness | Means |
|---|---|
| `ready` | It holds what it needs and will do the work |
| `degraded` | It will answer, but only with a clearly labelled placeholder |
| `unavailable` | It cannot answer at all, and says why |

Three states rather than two because the middle one is real: the local renderer
with no ffmpeg still keeps the plan, the comparison table and the approval gate
usable, and calling that "ready" would let a settings screen claim mastering
works here when it does not.

`GET /api/studio/processing-providers` reports every provider, and Master
Station reads it before the first click so a user is told up front rather than
discovering it from an output that sounds identical to the input.

Resolution order: a **ready** provider always beats a degraded one, whatever the
registration order; a degraded one is used only when nothing is ready; and if
neither exists the work refuses with `studio.processing_provider_not_configured`
naming the capability. A provider whose own status check throws is treated as
unavailable — a provider that cannot answer is not a provider that works.

Only one provider is registered today: `street-banker` / `local-dsp`, which
does the work on this machine. It is named rather than left blank precisely so
a local result can never read as a hosted professional service.

---

## Without ffmpeg

ffmpeg is required to decode anything that is not WAV, and to render a master.

**Analysis.** A WAV is decoded in-process and analyses normally. Anything else
settles as `unsupported` with the reason, and **no metrics are written**. A
half-populated report reads as a diagnosis of the record rather than a fact
about the deployment.

**Mastering.** The renderer falls back to passthrough: the rendition is marked
`placeholder`, `status: unsupported`, and the output is the *unprocessed source*
rather than silence. The plan, the comparison table and the approval gate stay
intact; returning the source keeps the comparison surface usable — the user
hears their own mix on both sides and the UI says why they are identical —
instead of presenting silence as a mastering result.

The choice is made on first render and cached. Once a real renderer is selected
its failures are real failures and propagate: the fallback is for a missing
binary, not for papering over a chain ffmpeg could otherwise have run.

Install it: `apt-get install ffmpeg`, or set `FFMPEG_PATH` / `FFPROBE_PATH`.

---

## Refusals, and what they mean

These are all deliberate. A support question about one of them usually has a
one-line answer.

| Code | Means |
|---|---|
| `studio.gate.module_entitlement` | The org has not been granted Studio |
| `studio.gate.capability_entitlement` | The org holds Studio but not that capability |
| `studio.gate.collaborator_permission` | The person is not a collaborator, or their role lacks that permission |
| `studio.rights_not_confirmed` | Project creation without a rights confirmation |
| `studio.reference_rights_not_confirmed` | A reference without its narrower confirmation |
| `studio.not_analyzed` | Mastering or comparing a version nothing has measured |
| `studio.no_audio` | The version carries no audio |
| `studio.version_not_deletable` | Deleting a version that carries audio. Never allowed |
| `studio.approval_needs_audio` | Approving a version with nothing in it |
| `studio.delivery_checks_failed` | Sending with failing checks. Warnings do not block |
| `studio.delivery_not_approved` | Sending without a delivery approval |
| `studio.identity_needs_consent` | Permitting an identity use with no verified consent record |
| `studio.irrevocable_needs_contract` | An irrevocable AI permission with no contract reference |
| `studio.permission_not_revocable` | Revoking a contractually irrevocable permission |
| `studio.passport_finalized` | Editing a finalized passport. Build a new one |
| `studio.provider_not_configured` | Ordering a service with no configured engineer |

A 404 on a project id that exists elsewhere is the tenant boundary working: the
gate verifies the project belongs to the caller's org, so "not yours" and "does
not exist" are the same answer.

---

## Diagnosing a bad report

**Metrics missing.** Check `studio_mix_analyses.status` and `failure_reason`.
On a `ready` analysis, `failure_reason` names any individual analyzer that
failed — the report has a hole in it and this says which.

**Every stereo metric null.** The file is mono, or its channels are identical.
The metric notes say so. This is correct behaviour, not a bug.

**Analysis failed with "the source audio changed".** The asset was replaced
after the analysis was queued. Re-run it; measuring the new bytes under the old
row would attach numbers to a file nobody asked about.

**A/B says "not loudness-matched".** The rendition's output analysis has not
finished, or one side's loudness could not be measured. The comparison is still
playable and the UI says it is unmatched. It becomes matched when
`studio.master.analyze` completes.

**Readiness says "not enough data".** Fewer than four of eight bands could be
measured. Look at the individual bands: each says what it could not measure.

---

## Data

35 tables, all created by migration `0008_studio`, all org-scoped, all
FK-referencing `studio_projects.id` — the canonical record id.

Three are append-only and nothing in the application updates or deletes a row
in them: `studio_activity`, `studio_identity_events`,
`studio_ai_permission_events`.

Retention: source uploads are `source`; master renditions and measured
references are `generated`, so the org's retention policy expires derived audio
without touching a source. Archiving a project is a flag, never a delete —
approvals, the passport and the delivery history exist precisely so somebody can
answer questions about the past.
