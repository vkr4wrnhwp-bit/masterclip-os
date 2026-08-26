# Audio Intelligence runbook

## Running it

```bash
pnpm seed     # fictional demo data through the full pipeline (mock provider)
pnpm dev      # api :4310 · worker · web :4311 — /audio/* in the sidebar
pnpm test     # includes the audio suites (unit + integration)
```

No credentials are required for any of the above. To go live:

1. Set `ELEVENLABS_API_KEY` (and `ELEVENLABS_TTS_VOICE_ID` for speech).
2. Configure the webhook endpoint ([AUDIO_WEBHOOKS.md](AUDIO_WEBHOOKS.md)).
3. Optionally set `AUDIO_RATE_CARD` so estimates are non-zero.
4. Keep `MUSIC_GENERATION_ENABLED` / `VOICE_CLONING_ENABLED` off until the
   org policies and contracts that govern them are reviewed.

## Deployment notes

- API and worker both need the full env (webhook secret included) — receipt
  happens in the API, processing in the worker.
- The worker owns retention sweeps and brief schedules; a deployment that
  runs only the API will accept work and never perform it (`scripts/serve.mjs`
  runs both, same as the render factory).
- `PUBLIC_BASE_URL` must resolve for provider webhooks to reach you. On a
  host that publishes its own external origin (Render sets
  `RENDER_EXTERNAL_URL`) it resolves by itself; set `PUBLIC_BASE_URL`
  explicitly only to point at a custom domain instead.
- Migrations run automatically at boot (`0003_audio_intelligence`), on both
  SQLite and PostgreSQL.

## Health and observability

- `/audio/settings` — usage this month, recent jobs with failure messages;
  flagship admins also see provider health and webhook events.
- `GET /api/admin/audio/providers` — adapter health (`GET v1/user` probe),
  configured state, zero-retention support per slot.
- Queue state: the existing queue tooling (`pnpm masterclip queue work`
  drains inline; dead-letter replay works the same for audio jobs).

## Failure triage

| Symptom | Look at |
|---|---|
| Meeting stuck `transcribing` | `audio_jobs` row: `failed` has code+message; `awaiting_provider` means webhook-delivery mode — check webhook events |
| Job failed `audio.zero_retention_unavailable` | Org policy requires ZR; provider not attested — fix policy or account tier, never bypass |
| Brief `failed` | `signal_briefs.error_message`; commonly no voice configured for live TTS |
| Remix job failed `remix.prompt_blocked` | Working as intended — the prompt asked for imitation |
| Remix `provider_rights_review` | Human review path; do not resubmit |
| Webhook `rejected` rows | Secret mismatch / stale timestamp — see the webhooks runbook |

## Phase-two backlog

- **Signal integration**: feed brief items from real Signal data instead of
  caller-supplied items; per-user authorization filters at the source.
- **Realtime transcription** (`audio.realtime_transcription` is catalogued
  but unimplemented) and in-browser meeting recording with live consent
  capture.
- **Operator voice channel**: the agent definition, tools, and knowledge base
  now sync to the provider (`POST /api/audio/agents/:id/sync` → the
  `audio.agent.sync` job); remaining work is embedding the web widget /
  phone numbers against the synced agent, plus calendar-recording and
  telephony integrations behind their own approval flows.
- **Dubbing depth**: per-segment correction exists (click a line in
  transcript review); remaining: a rich editor, human QA checklists,
  lip-sync review, translated caption tracks per language (captions are
  currently source-language SRT + VTT).
- **Stems unpacking**: expand the provider's stem archive into individual
  per-stem assets server-side.
- **Voice Vault**: person-level identity linkage, provider verification
  status webhooks, contractual takedown workflow automation.
- **Cost reconciliation**: account-level usage (character count/limit, tier)
  now shows in flagship provider admin; per-request `final_cost_micros`
  backfill still needs a documented per-request usage feed.
- **Email/Slack/mobile delivery** for briefs and human-transfer alerts.
- **White-label branding UI**: partner branding (display name, welcome
  message, accent colour, support contact) is stored and applied but edited
  through the settings API rather than a dedicated screen. Entitlement and
  budget administration now has one at `/audio/admin`.
