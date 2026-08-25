# Street Banker Audio Intelligence

The audio intelligence and voice-services layer of the platform. Audio
providers supply transcription, speech, agents, dubbing, and generative-audio
capability; Street Banker supplies the judgment, rights controls, workflows,
human review, and commercial execution around them. The provider is
replaceable infrastructure and the system never becomes dependent on one
vendor: every domain model, route, and job compiles against
provider-independent interfaces, and a full mock implementation keeps the
entire platform runnable with zero credentials and zero spend.

## What it will never claim

The platform does not present AI as a replacement for music attorneys,
business managers, royalty accountants, producers, mixers, mastering
engineers, human A&R, Street Banker operators, qualified translators, human
quality control, or rights-clearance professionals. Machines draft; humans
approve. That rule is enforced in code, not just copy:

- Meeting extraction lands as a **draft**; only human-approved items commit
  to Operator Desk ([MEETING_INTELLIGENCE.md](MEETING_INTELLIGENCE.md)).
- The operator agent cannot approve deals, promise funding, or guarantee
  outcomes — outbound replies are screened server-side
  ([AUDIO_OPERATOR.md](AUDIO_OPERATOR.md)).
- Dubbing requires human quality review before export
  ([GLOBAL_RELEASE_PACK.md](GLOBAL_RELEASE_PACK.md)).
- Remix versions cannot reach release-ready without ordered human gates
  ([REMIX_LAB_AUDIO.md](REMIX_LAB_AUDIO.md)).

## Module map

```
packages/audio-core        interfaces · registry · capability catalog · feature gate
                           data policy · moderation · consent · guardrails · keyterms
packages/audio-providers   ElevenLabs adapters (verified against SDK 2.64.0)
                           mock adapters (real WAVs, deterministic)
                           reasoning: heuristic (offline) + Claude-backed
packages/audio-domain      migration-backed repositories, all org-scoped
                           Operator Desk scaffold (leads / notes / tasks)
packages/audio-engine      services: access control · assets · transcription
                           meetings · briefs · operator agent · global release
                           campaigns · remix · voice vault · retention · webhooks
apps/api/src/routes/audio  HTTP surface: gate-checked routes + provider webhooks
apps/worker                audio queue handlers + retention/schedule ticks
apps/web                   /audio/* views on the existing design system
```

## Products

| Product | Entry point | Doc |
|---|---|---|
| Operator Desk Meeting Intelligence | `/audio/meetings` | [MEETING_INTELLIGENCE.md](MEETING_INTELLIGENCE.md) |
| Signal Audio Briefs | `/audio/briefs` | [SIGNAL_AUDIO_BRIEFS.md](SIGNAL_AUDIO_BRIEFS.md) |
| Street Banker Operator | `/audio/operator` | [AUDIO_OPERATOR.md](AUDIO_OPERATOR.md) |
| Global Release Pack | `/audio/global-release` | [GLOBAL_RELEASE_PACK.md](GLOBAL_RELEASE_PACK.md) |
| Campaign Audio Toolkit | `/audio/campaigns` | [CAMPAIGN_AUDIO_TOOLKIT.md](CAMPAIGN_AUDIO_TOOLKIT.md) |
| Remix Lab Audio Engine | `/audio/remix` | [REMIX_LAB_AUDIO.md](REMIX_LAB_AUDIO.md) |
| Artist Voice Vault | `/audio/voice-vault` | [ARTIST_VOICE_VAULT.md](ARTIST_VOICE_VAULT.md) |
| White-label operator | org settings `whiteLabel` | [AUDIO_OPERATOR.md](AUDIO_OPERATOR.md) |
| Partner entitlement admin (flagship) | `/audio/admin` | this document, “The layered gate” |

## The layered gate

Every audio route and job passes a server-side gate before anything runs
(`AudioAccessControl`): global feature flag → org entitlement (Partner OS) →
org toggle → provider entitlement → user permission → usage limit. Consent,
rights confirmation, and retention configuration are enforced by the
individual services with the concrete record in hand, and provider health is
consulted at resolution time. Hiding a button in the frontend is presentation,
not security.

Flagship admins manage this at **`/audio/admin`** (Partner entitlements):
per-organization capability grant/revoke, an enable-disable toggle that keeps
the grant, plan presets, spend budgets, and month-to-date spend. Provider
credentials are never shown there.

Entitlements are `audio.*` capabilities (see `packages/audio-core/src/capabilities.ts`).
The flagship organization — the oldest org on the deployment — holds all of
them **implicitly** (root-level access; feature toggles and budgets still
apply to it), including provider administration. Partner orgs receive only
what a flagship admin grants
(`/api/admin/audio/orgs/:orgId/entitlements`, presets `partner_core` /
`partner_full`).

## Jobs and the worker

Generation never happens inside an HTTP request. Routes validate, authorize,
write, and enqueue; the worker performs provider calls on the `audio` queue
with idempotent dedupe keys, retry with backoff, and a dead-letter queue
(all inherited from the platform's durable queue). Retention sweeps and brief
schedules run as self-re-arming maintenance ticks.

## Demo mode

`pnpm seed` creates entirely fictional demo data — meetings through the full
transcribe→extract pipeline, five rendered briefs, agent conversations
(including a human transfer), a Global Release Pack, a Remix Lab project, and
one verified fictional voice profile. No real artists, labels, releases, or
voices; no credentials consumed. The mock providers return genuine playable
WAV files, so every screen and player works.

## Build phases and current state

Phase 1 (foundation) and Phase 2 (Meeting Intelligence, Signal Briefs,
approval workflow, scheduling, retention, demo mode) are complete and tested.
Phase 3 (operator agent: web channel, tools, escalation, post-call) is
functional server-side with provider sync scaffolded. Phases 4–6 (Global
Release, Campaign Toolkit, Remix Lab, Voice Vault) are implemented through
their core workflows with human gates enforced; see
[AUDIO_RUNBOOK.md](AUDIO_RUNBOOK.md) for the phase-two backlog.

**Repository note.** This platform assumed sibling Street Banker products
that did not exist here when it was built. Operator Desk exists as a
deliberate scaffold (leads/notes/tasks) that approved intelligence commits
into, and Signal briefs take caller-supplied structured items until a Signal
data source exists. Stage Control now *does* exist, as part of Live Lab
([LIVE_LAB_STAGE_CONTROL.md](LIVE_LAB_STAGE_CONTROL.md)) — and this layer
deliberately does not touch it: no cloud AI audio path may enter a
safety-critical monitor-control loop, and the absence of any code path
between the two is verified in
[AUDIO_SECURITY.md](AUDIO_SECURITY.md).
