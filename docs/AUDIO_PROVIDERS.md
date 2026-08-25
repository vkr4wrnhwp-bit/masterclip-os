# Audio providers

## The abstraction

Every audio capability is a provider-independent interface in
`packages/audio-core/src/providers.ts`:

`AudioTranscriptionProvider` · `SpeechSynthesisProvider` ·
`ConversationalAgentProvider` · `DubbingProvider` · `MusicGenerationProvider` ·
`StemSeparationProvider` · `VoiceIsolationProvider` · `SoundEffectsProvider` ·
`VoiceIdentityProvider` · `StructuredReasoningProvider`

Adapters translate between these shapes and a vendor's API. The
`AudioProviderRegistry` resolves per capability slot: explicitly requested
provider → configured default → configured fallback → mock. Unconfigured
providers never resolve implicitly. Nothing outside the adapters names a
vendor; swapping one is writing an adapter, not a migration.

Every provider also answers `supportsZeroRetention(operation)` — consulted
*before* any bytes leave the platform for an org whose policy requires zero
retention (see [AUDIO_RETENTION.md](AUDIO_RETENTION.md)).

## ElevenLabs adapters

Endpoint paths, parameter names, response shapes and the webhook signature
scheme were verified against the official `@elevenlabs/elevenlabs-js` SDK
**v2.64.0 on 2026-08-25** (types read directly from the published package).
No live call has been made from this build environment — run a cheap request
(the health check hits `GET v1/user`) with your own key before trusting an
adapter on the wire.

| Adapter | Endpoint(s) | Notes |
|---|---|---|
| Transcription (Scribe) | `POST v1/speech-to-text` | multipart; `model_id` (default `scribe_v2`), diarization, word timestamps, `keyterms` (≤1000, ≤50 chars, ≤5 words, surcharge applies), `entity_detection`, `tag_audio_events`, `enable_logging=false` for zero retention (enterprise), `webhook=true` for async delivery with `webhook_metadata` |
| Speech (TTS) | `POST v1/text-to-speech/{voice_id}` | `model_id` (default `eleven_multilingual_v2`), `output_format` query, `enable_logging` query; binary out; characters billed |
| Agents (ElevenAgents) | `v1/convai/agents/create`, `PATCH v1/convai/agents/{id}`, `GET v1/convai/conversation/get-signed-url`, `GET v1/convai/conversations/{id}` | tools declared as `client` tools — executed on OUR server, never provider-side |
| Dubbing | `POST v1/dubbing`, `GET v1/dubbing/{id}`, `GET v1/dubbing/{id}/audio/{lang}` | one target language per provider project; the engine fans out per language |
| Music | `POST v1/music`, `v1/music/upload`, `v1/music/plan`, `v1/music/stem-separation` | `prompt` XOR `composition_plan`; `music_length_ms` 3000–600000; models `music_v1`/`music_v2`; `store_for_inpainting` |
| Voice isolation | `POST v1/audio-isolation` | multipart `audio` field, binary out |
| Sound effects | `POST v1/sound-generation` | `duration_seconds` 0.5–30, `prompt_influence`, `loop` |
| Voice identity | `GET v1/voices/{id}`, `DELETE v1/voices/{id}` | verification state read from `voice_verification`; registration is owner-side only (see [ARTIST_VOICE_VAULT.md](ARTIST_VOICE_VAULT.md)) |
| Webhooks | header `elevenlabs-signature: t=<unix>,v0=<hmac>` | HMAC-SHA256 over `"{t}.{rawBody}"`, 30-minute tolerance |

Notes the adapters deliberately do **not** guess: model availability per
account tier, current pricing, file limits beyond documented ones, or voice
ids — `ELEVENLABS_TTS_VOICE_ID` has no default because a voice is an account
decision. This SDK version exposes no transcript-polling endpoint, so async
Scribe results complete via the signed webhook, never via an invented URL.

### Configuration

```
ELEVENLABS_API_KEY=                  # empty → adapters report unconfigured, mock serves
ELEVENLABS_BASE_URL=https://api.elevenlabs.io   # regional residency URLs supported
ELEVENLABS_STT_MODEL=scribe_v2
ELEVENLABS_TTS_MODEL=eleven_multilingual_v2
ELEVENLABS_TTS_VOICE_ID=             # required before TTS is considered configured
ELEVENLABS_WEBHOOK_SECRET=           # from the dashboard's webhook endpoint
ELEVENLABS_ZERO_RETENTION_CAPABLE=false   # operator attestation, never inferred
```

API keys live in environment configuration, are registered with the log
redactor, and are never returned by any route or sent to the browser.

## The mock provider

`mock-audio` implements every slot: deterministic diarized transcripts,
real playable WAV synthesis (pure Node, seeded), canned agent conversations,
per-language dubbing, four-stem separation, and a voice-identity flow with a
verification convention (ids containing `unverified` stay pending) and a
screening convention (uploads named `*screenme*` trigger the provider
rights-review path). It reports zero-retention supported because it retains
nothing. It is always registered — it is what makes demo mode, tests, and
credential-free deployments real.

## Estimates vs. prices

Provider prices are not hardcoded anywhere in product logic. `AUDIO_RATE_CARD`
is an operator-maintained JSON of estimate rates; absent rates estimate zero
and surface as "no estimate", never as an invented number. Final cost comes
from provider usage reconciliation into the `audio_usage_ledger`.

## Adding a provider

1. Implement the interfaces you support in a new adapter module.
2. `registry.register({ transcription: new YourAdapter(...), ... })` in
   `packages/audio-engine/src/layer.ts`.
3. Answer `supportsZeroRetention` honestly (attested, not assumed).
4. Add webhook verification for the vendor's signing scheme.
5. Add the credential to env config + the secret redactor list.
6. Extend the contract tests in `packages/audio-providers/test`.
