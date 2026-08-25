# Audio webhooks runbook

## Endpoint

`POST /api/webhooks/elevenlabs` — CSRF-exempt (server-to-server), rate-limit
class `webhook`. Authenticity comes exclusively from the provider signature.

## Verification

Header `elevenlabs-signature: t=<unix seconds>,v0=<hex>` where the digest is
HMAC-SHA256 over `"{t}.{rawBody}"` with `ELEVENLABS_WEBHOOK_SECRET`.
Verified against the raw request bytes (preserved by the server's
content-type parser); tolerance 30 minutes. Failures return 403 and record a
`rejected` event row that stores only the body length — unverified content is
never persisted as data.

## Processing pipeline

1. Verify signature → 2. store raw event idempotently (unique
`(provider, external_event_id)`; duplicates return `deduped: true` and are
not re-enqueued) → 3. worker processes from the stored copy
(`audio.webhook.process`):

- `speech_to_text_transcription` — completes a transcription job parked
  `awaiting_provider` by `transcription_id`, stores the normalized
  transcript, and advances the owning meeting/dubbing project.
- `post_call_transcription` / `call.ended` — maps `conversation_id` to the
  agent conversation and runs post-call processing.
- Unknown types are logged and marked processed (no dead-lettering on
  vendor-added event types).

Org attribution comes from our own `webhook_metadata` (set when we created
the provider job), never from unauthenticated payload fields alone.

## Setup

1. In the ElevenLabs dashboard, create a webhook endpoint pointing at
   `https://<your-host>/api/webhooks/elevenlabs` (requires `PUBLIC_BASE_URL`
   to be your externally reachable origin).
2. Copy the endpoint's signing secret into `ELEVENLABS_WEBHOOK_SECRET` for
   both API and worker processes; restart.
3. Subscribe the event types above.

## Secret rotation

Set the new secret in the dashboard, update `ELEVENLABS_WEBHOOK_SECRET`,
restart API + worker. During the gap deliveries are rejected and recorded;
the provider retries per its policy — check the rejected-event count in
`/audio/settings` (flagship admin card) after rotation and reconcile any
missed completions by re-running the affected jobs.

## Triage

- **Rejected events climbing**: wrong secret, clock skew beyond tolerance, or
  someone probing the endpoint. Compare a rejected row's `receivedAt` with
  the provider dashboard's delivery log.
- **`failed` events**: `failure_reason` on the row; the queue retried with
  backoff already. Fix the cause, then re-enqueue `audio.webhook.process`
  with the event id (or replay from the dead-letter queue).
- **Orphan warnings** (`audio.webhook_orphan_*` in logs): a delivery for a
  job/conversation this deployment doesn't know — usually a stale provider
  config pointing at the wrong environment.
