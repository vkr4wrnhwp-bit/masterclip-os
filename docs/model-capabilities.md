# Model capabilities

**Retrieved 2026-08-17.** The application's live view of this is
`GET /api/models` (Providers & models in the UI) or
`pnpm masterclip models refresh --json`, which merges live catalogues where a
provider exposes one. This document explains what the capability fields mean and
records what could and could not be verified.

---

## Why capabilities are declared, not discovered at submit time

The router filters models against a shot's **derived requirements** before
anything is queued. An overstated capability means a model gets sent work it
cannot do, and the failure surfaces as a paid render that was never going to
work. So each adapter declares:

| Field | Meaning |
|---|---|
| `modes` | which of `text_to_video`, `image_to_video`, `first_last_frame`, `reference_to_video`, `video_to_video`, `video_extend` it performs |
| `duration` | `minSeconds`, `maxSeconds`, and `allowedSeconds` where only discrete lengths are legal |
| `resolutions` / `aspectRatios` | exact supported values, not "up to" |
| `fps` | empty array means fps is **not settable** — which is different from "24 only" |
| `nativeAudio` / `dialogue` | can it generate synchronized sound / spoken lines |
| `firstFrame` / `lastFrame` | frame-anchored control |
| `videoReference` / `extension` | video-to-video and continuation |
| `maxReferenceImages` | how many references actually reach the model |
| `seed` | false means repeat runs are **not** reproducible |
| `negativePrompt` | false means constraints get folded into the positive prompt |
| `maxPromptChars` | the compression budget the prompt compiler works within |
| `tier` | `draft` / `standard` / `premium` — drives routing profiles and premium approval |

A mismatch is either **hard** (the model cannot do it — excluded) or **soft**
(it will be coerced, e.g. 5s → 6s on a discrete-duration model). Soft mismatches
are reported as adjustments *before* submission, so nobody is billed for 10
seconds after asking for 8 without being told.

---

## Google — Veo 3.1 family

Verified from Google's official cookbook and the `googleapis/python-genai` SDK.

| Capability | Value |
|---|---|
| text-to-video | ✅ |
| image-to-video (first frame) | ✅ `image` |
| last frame / interpolation | ✅ `lastFrame` — **image-to-video only** |
| reference images | ✅ **Veo 3.1 only, not Fast**; 720p and 16:9 landscape only; up to 3 |
| video extension | ✅ adds **7s per call**; input must be 720p, Veo-generated, <141s; ceiling 148s |
| video-to-video / masking | ❌ on the Gemini API (`mask` is Vertex-only) |
| duration | **4, 6 or 8 seconds** (Veo 3.1); always 8 for Veo 3; 7 when extending |
| aspect ratio | `16:9`, `9:16` |
| resolution | `720p`, `1080p`. **4K unverified** — the rate card prices it and the enum includes it, but acceptance on `generativelanguage.googleapis.com` was not confirmable |
| fps | **not settable** — Vertex-only |
| seed | **rejected** — Vertex-only |
| native audio | ✅ always on; `generateAudio` is Vertex-only and raises. Veo 2 has none |
| safety | `personGeneration` parameter |

Veo 3.1 Lite has no 4K row on the rate card. Whether Lite supports extension is
**unconfirmed** — the adapter conservatively declares `extension: false` for it.

## Gemini Omni Flash — **NOT BUILT**

`gemini-omni-flash-preview` is a genuinely different integration: it uses the
**Interactions API** (`POST /{version}/interactions`), not
`:predictLongRunning`, is stateful via `previous_interaction_id`, accepts up to 5
reference images and 5 audio tracks, and prices video through the token meter
rather than per second. Its task modes are
`text_to_video | image_to_video | reference_to_video | edit | extend`, and
setting an explicit `task` **disables chaining** via `previous_interaction_id` —
you pick one or the other.

It is not implemented in this release. The Interactions resource is also absent
from the published v1beta discovery document, so the surface could not be pinned
from a machine-readable first-party source. Adding it means a second Google
adapter, not a flag on this one.

## fal.ai

Compiled descriptors in `packages/provider-fal/src/catalog.ts`, covering Wan 2.2
turbo (the draft workhorse), Wan 2.5, LTX-2.3 Fast and Pro, Kling 2.5 Turbo Pro,
Veo 3.1 Fast and Lite via fal, Veo 3.1 extension, and Hailuo 02 Standard and Pro.
Each entry carries its own `sourceUrl` and `retrievedAt`.

Note `durationField: 'string'` on Kling — some fal models take `duration` as a
string, not a number.

## MuAPI

MuAPI's catalogue does **not** publish structured capability metadata, so
capabilities are **inferred from the model slug** (`-i2v` implies image-to-video,
`veo3`/`sora`/`omni` implies audio, `fast`/`lite`/`turbo` implies draft tier).
This is recorded as `raw.capability_source: 'inferred from slug'` so nothing
downstream mistakes a guess for a provider-declared fact. The authoritative check
is `GET /api/v1/models/{model}` for the input schema, or the OpenAPI spec.

## Runway

`gen4_turbo`, `gen4.5` (image-to-video), `gen4.5` (text-to-video), `aleph2`
(video-to-video). Runway takes an explicit **pixel ratio string** (`1280:720`)
rather than an aspect-ratio name; the adapter converts.

## Luma

`ray-2`, `ray-flash-2`. First/last frames via typed keyframes. Also exposes
reframe, upscale, and add-audio-to-an-existing-generation endpoints, which are
**not** wired into the canonical request model in this release.

## Replicate

Capabilities are **derived from the model's own `openapi_schema`** at catalogue
time — an input named `image`/`start_image` implies image-to-video, `end_image`
implies last-frame control, `seed` implies reproducibility. Conservative by
design: an unrecognised field becomes an absent capability rather than an assumed
one.

## Mock

Four models spanning the tiers (`mock-draft`, `mock-standard`, `mock-hero`,
`mock-edit`) with realistic capability shapes, including discrete durations and a
premium tier that requires human approval — so routing, budget, and approval
logic are all exercisable without a credential.
