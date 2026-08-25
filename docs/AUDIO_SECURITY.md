# Audio security model

Extends the platform's [security-model.md](security-model.md); this file
covers what the audio layer adds.

## Tenant isolation

Every tenant-owned table carries `org_id`, and every repository accessor
filters on it — a valid id from another tenant is indistinguishable from a
missing one. Object storage keys are always
`organizations/{orgId}/audio/{area}/…`, built from sanitised parts, so user
input cannot escape its tenant prefix. Serving is signed-URL only. Agent
knowledge bases, conversations, voice profiles, budgets, and webhook org
mapping are all tenant-scoped. Tested explicitly in
`tests/audio-intelligence.test.ts`.

## The access gate

Server-side, on every route and job: global flag → org entitlement → org
toggle → provider entitlement → user permission → usage limit; consent,
rights, retention, and provider health enforced at the service layer with
the concrete record in hand. Frontend hiding is never a control.

## Secrets

Provider keys and webhook secrets live in environment configuration, are
registered with the log redactor at config load, are never returned by any
route, and never reach the browser. Flagship provider administration shows
health and configuration state, not key material.

## Webhooks

Signature over the **raw** request bytes (the server's content-type parser
preserves them), timestamp tolerance enforced, unsigned/mis-signed/stale
deliveries rejected with 403 and recorded (without trusting their content),
duplicates collapsed on a unique `(provider, external_event_id)` index,
processing decoupled from receipt via the durable queue. See
[AUDIO_WEBHOOKS.md](AUDIO_WEBHOOKS.md).

## Uploads

Magic-byte sniffing (declared Content-Type and filename are
attacker-controlled), allow-listed formats, 512 MB cap, checksum dedupe,
one file per request. Filenames are sanitised before any path join.

## Agent containment

The operator agent's tool effects execute on our server behind
authentication; the provider sees tool names and JSON schemas only. Outbound
replies pass commitment guardrails; inbound turns pass escalation detection.
The agent holds no database access and no unrestricted functions to call.

## Stage Control restriction

No cloud AI audio generation or speech agent may sit in a safety-critical
monitor-control path. Live Lab and its Stage Control surface
([LIVE_LAB_STAGE_CONTROL.md](LIVE_LAB_STAGE_CONTROL.md)) must remain local
where required, deterministic, engineer-authorized, bounded, and functional
with every cloud AI feature disabled — including full ElevenLabs
unavailability. Audio Intelligence may transcribe post-show notes, summarize
monitor requests, and produce tour-day briefings; it must never directly
control monitor levels, FOH, IEM levels, or venue routing.

**Verified as of this build:** there is no code path between the two. No
`audio-*` package imports Live Lab or performance-project code, and no Live
Lab package imports `audio-*`; Live Lab's scene builder runs on its own
`@masterclip/ai-audio` provider layer, selected by `LIVE_AI_PROVIDER` and
defaulting to the local mock. Adding an integration point in either direction
requires a security review — a grep for cross-imports between the two package
families is the cheap way to re-check this claim.

## Spend containment

Budgets (org / user / feature) with soft warnings and hard stops, per-job
caps, an append-only usage ledger, and the platform's sandbox-mode posture:
without credentials only the mock provider serves, which cannot spend.
