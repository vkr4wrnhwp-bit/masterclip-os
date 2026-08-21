# Provider matrix

**Retrieved 2026-08-17.** Endpoint and header details were verified against each
vendor's own client library or machine-readable spec — see
`docs/current-pricing-snapshot.md` § "Read this before trusting any number here"
for why the narrative docs sites were unreachable and what was used instead.

Implementation status: **REAL** = implemented and covered by the provider
contract battery against mocked transport; **DEV-LABELED** = implemented from
verified specs but never exercised against the live API from this environment.

---

## Summary

| Provider | id | Status | Auth | Quote source | Webhook signature | Balance |
|---|---|---|---|---|---|---|
| Mock (local ffmpeg) | `mock` | **REAL** | none | exact, simulated | n/a | n/a |
| MuAPI | `muapi` | **DEV-LABELED** | `x-api-key` | live `estimate-cost` | **none published** | `GET /account/balance` |
| Google Gemini (Veo) | `google` | **DEV-LABELED** | `x-goog-api-key` | rate card (unit caveat) | `webhookConfig` in body, unsigned | none |
| fal.ai | `fal` | **DEV-LABELED** | `Authorization: Key` | compiled rate card | **none in official clients** | none |
| Runway | `runway` | **DEV-LABELED** | `Bearer` + `X-Runway-Version` | `estimatedCost` on submit | polling only | `GET /v1/organization` |
| Luma | `luma` | **DEV-LABELED** | `Bearer` | none — credits | `callback_url`, unsigned | `GET /credits` |
| Replicate | `replicate` | **DEV-LABELED** | `Bearer` | none — hardware seconds | **signed**, `GET /v1/webhooks/default/secret` | **none** |
| Self-hosted ComfyUI | `selfhosted` | **DEV-LABELED** | optional `Bearer` | operator-supplied GPU rate | n/a | n/a |

---

## MuAPI — `packages/provider-muapi`

```
base     https://api.muapi.ai/api/v1
auth     x-api-key: <key>          ⚠️ the hosted MCP server uses Bearer instead
submit   POST /api/v1/{model_slug}          per-model slugs; no generic /generate
status   GET  /api/v1/predictions/{id}/result
upload   POST /api/v1/upload_file           multipart, field name "file"
balance  GET  /api/v1/account/balance
quote    POST /api/v1/models/{model}/estimate-cost
spec     https://api.muapi.ai/openapi.json
```

**Status enum:** `pending · processing · completed · failed` (docs also list
`queued`). Treat the enum as **open**: only `completed` and `failed` are
terminal — MuAPI's own client ignores everything else and keeps polling.

**Two traps, both handled in the adapter:**

1. **The reference-image field name varies by model family.** Some models take
   `image_url` (string), others `images_list` (array). MuAPI's own LangChain
   adapter treats this as a runtime recovery loop, and so does ours: a 422 naming
   a missing field retries once with the other shape.
2. **Webhooks carry no signature.** No HMAC header appears in any reachable
   source. The adapter treats the callback purely as a wake-up signal and
   re-fetches authoritative state from the result endpoint before anything is
   recorded or spent. Our own callback URL additionally carries an HMAC token
   bound to the job id.

**Sandbox:** documented as a `"is_test": true` key that returns mock media
without consuming credits. Unverified — the docs page was unreachable.

---

## Google Gemini API (Veo) — `packages/provider-google`

```
base     https://generativelanguage.googleapis.com
auth     x-goog-api-key: <key>
submit   POST /v1beta/models/{model}:predictLongRunning
poll     GET  /v1beta/{operation.name}        no status enum — poll `done`
files    GET  /v1beta/files/{id}:download?alt=media   (API key required)
```

Model ids verified in Google's official cookbook:
`veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`,
`veo-3.1-lite-generate-preview`. The `-001` GA aliases appear on the rate card
but could not be confirmed live — call `GET /v1beta/models` with a real key
before pinning one.

**Field-name traps, both real and both handled:**
- `image` and `lastFrame` use `bytesBase64Encoded` + `mimeType`, but the `video`
  input uses **`encodedVideo` + `encoding`**;
- `webhookConfig` is a **top-level sibling** of `instances`/`parameters`, and is
  Gemini-API-only (Vertex rejects it).

**Rejected on the Gemini API** (the SDK raises "only supported in Gemini
Enterprise Agent Platform mode"): `fps`, `seed`, `generateAudio`, `mask`,
`storageUri`, `compressionQuality`, `labels`, `image.gcs_uri`. The adapter's
capability descriptors declare `fps: []` and `seed: false` accordingly, so the
router never offers a shot those would be needed for.

`predictLongRunning` exists in `v1beta` and `v1alpha` but **not** `v1`.

---

## fal.ai — `packages/provider-fal`

```
submit   POST https://queue.fal.run/{endpoint_id}[?fal_webhook=<url>]
status   GET  .../requests/{id}/status
result   GET  .../requests/{id}
cancel   PUT  .../requests/{id}/cancel        ← PUT, not DELETE
upload   POST https://rest.fal.ai/storage/upload/initiate → PUT upload_url
auth     Authorization: Key <FAL_KEY>
```

**Status enum is exactly three values:** `IN_QUEUE · IN_PROGRESS · COMPLETED`.
There is no distinct failure state — a failed job reports `COMPLETED` and the
error surfaces when the result is fetched, which is why the adapter fetches the
result before reporting success.

**The trap that shapes the adapter's design:** fal's own clients build the
status/result/cancel URLs from **only `owner/alias`, discarding the rest of the
endpoint path**. So `fal-ai/wan/v2.2-a14b/image-to-video/turbo` submits to that
path but polls `fal-ai/wan/requests/{id}/status`. Rather than reconstruct them,
the adapter **persists the URLs fal returns** inside an encoded external job id.

No webhook-verification helper exists in either official client, so fal callbacks
are treated as unauthenticated wake-ups.

---

## Runway — `packages/provider-runway`

```
base     https://api.dev.runwayml.com
auth     Authorization: Bearer <key>
version  X-Runway-Version: 2024-11-06     confirmed current two ways
submit   POST /v1/image_to_video | /v1/text_to_video | /v1/video_to_video
status   GET  /v1/tasks/{id}
cancel   DELETE /v1/tasks/{id}
balance  GET  /v1/organization → creditBalance
```

**Status enum:** `PENDING · THROTTLED · RUNNING · SUCCEEDED · FAILED · CANCELLED`.
Note the double-L `CANCELLED` (Replicate spells it `canceled`). `THROTTLED` is
backpressure, not an error — keep polling.

**Cost field names differ by phase:** `estimatedCost.credits` before terminal,
`cost.credits` after. The adapter reads both. $0.01 per credit.

---

## Luma — `packages/provider-luma`

```
base     https://api.lumalabs.ai/dream-machine/v1     ← the path prefix is part
auth     Authorization: Bearer <key>                     of the base; hitting
submit   POST /generations/video                          /v1/generations is the
status   GET  /generations/{id}                           classic mistake
balance  GET  /credits
```

**States:** `queued · dreaming · completed · failed`. `dreaming` is Luma's
running state. `assets.progress_video` is a live partial render available during
it — surfaced in the adapter's status `raw` for progress UI.

First and last frames are expressed as typed **keyframes** (`frame0`, `frame1`)
rather than separate fields.

---

## Replicate — `packages/provider-replicate`

```
base     https://api.replicate.com
auth     Authorization: Bearer <token>
submit   POST /v1/models/{owner}/{name}/predictions
status   GET  /v1/predictions/{id}
cancel   POST /v1/predictions/{id}/cancel
schema   GET  /v1/models/{owner}/{name} → latest_version.openapi_schema
secret   GET  /v1/webhooks/default/secret → { key: "whsec_…" }
```

**States:** `starting · processing · succeeded · failed · canceled` (one L).

**The architectural difference:** Replicate's `input` is model-defined and
untyped — there is no fixed request schema. The adapter is therefore
**schema-driven**: it fetches each model's `openapi_schema` and maps canonical
fields onto whatever input names that model declares. Model slugs are
**operator-configured, never hardcoded**, because Replicate slugs change and a
stale one fails at submit time after the shot is already planned.

Replicate is the only implemented provider with **signed** webhooks.

---

## Self-hosted ComfyUI — `packages/provider-selfhosted`

```
submit   POST /api/prompt      { prompt: <graph>, client_id, prompt_id }
status   GET  /api/history/{prompt_id}
output   GET  /api/view?filename=&subfolder=&type=output
upload   POST /api/upload/image
health   GET  /api/system_stats
```

Prefer the `/api/*` prefix over the bare paths: both work, but `/api/*` is the
stable surface and does not collide with the web UI's static routes. An absent
history entry means still running — ComfyUI only writes history on completion.

Workflow graphs are operator-supplied with `{{placeholder}}` substitution.
**The adapter refuses to quote** until a measured GPU hourly rate and a measured
compute ratio are configured.

---

## Adding a provider

1. Implement `VideoProvider` (`packages/provider-core/src/provider.ts`) —
   extending `BaseProvider` gives you capability validation and rate-card
   quoting for free.
2. Declare capabilities honestly. An overstated capability means the router
   sends it work it cannot do and the failure surfaces as a wasted paid render.
3. Never fabricate a price. Return `confidence: 'unknown'` and let the cost
   controller refuse; `pnpm lint` fails the build on a zero price that is not
   marked unknown.
4. Run the contract battery: `pnpm masterclip providers contract --provider <id>`,
   adding `--submit` once a sandbox credential exists.
5. Register it in `packages/runtime/src/index.ts`.
