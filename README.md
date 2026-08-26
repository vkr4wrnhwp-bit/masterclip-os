# MASTERCLIP OS

A cinematic AI-video render factory. Define shots once, generate them across many
providers, measure every result, keep what a human approves — and track the only
number that matters: **cost per approved second**.

Not an explainer generator. Not a single-provider wrapper.

---

## Run it

```bash
cd masterclip-os
pnpm install
pnpm seed          # demo project: 3 shots, a character bible, a world bible
pnpm dev           # API :4310 · web :4311 · worker
```

Open <http://127.0.0.1:4311> and sign in with the credentials `pnpm seed` prints.

**A clean checkout needs nothing installed except Node 22.5+ and ffmpeg.**
It runs on SQLite, local file storage, and a mock provider that renders real
MP4s with ffmpeg — so the whole factory is exercisable at zero cost before any
credential exists.

```bash
pnpm masterclip doctor      # ffmpeg, database, queue, storage, providers, spend allowance
```

### Requirements

| | |
|---|---|
| Node | ≥ 22.5 (`node:sqlite`) |
| ffmpeg + ffprobe | on `PATH`, or set `FFMPEG_PATH` / `FFPROBE_PATH`. Debian/Ubuntu: `apt-get install ffmpeg` |
| Everything else | optional — see below |

### Optional services

```bash
pnpm docker:up     # PostgreSQL + MinIO
```

Then set `DB_DRIVER=postgres` with `DATABASE_URL`, and/or `STORAGE_DRIVER=s3`
with the `S3_*` variables. The same migrations run on both dialects.

---

## The first thing to understand: sandbox mode

`MASTERCLIP_MODE=sandbox` is the default and it **refuses every billable
submission**, independent of budgets. Renders go to the local ffmpeg mock
provider, which returns genuine video files — including deliberately defective
ones, so QC's failure detection is demonstrable rather than assumed.

Going live is a deliberate act:

```bash
MASTERCLIP_MODE=live LIVE_SPEND_CAP_USD=2 FAL_KEY=... pnpm dev
```

`LIVE_SPEND_CAP_USD` is a hard global ceiling across every org and project,
checked separately from budgets, precisely so a bug in routing cannot spend at
scale. The banner at the top of every screen says which mode you are in.

---

## What it does

**Define a shot once, provider-agnostically.** A canonical spec covering subject,
identity/wardrobe/prop locks, environment, action, performance, blocking, camera
position and movement, lens and aperture, a motivated light source, materials,
physics, continuity, audio, negative constraints, routing intent, and a cost
ceiling. Validated by schema *and* by semantic rules — a `first_last_frame` shot
with no last frame is rejected before a provider charges you to find out.

**Route by expected cost per approved second.** Not by sticker price. A model
that costs 3× more but lands twice as often is cheaper per usable second, and the
router learns each model's acceptance rate *for your project, per shot category*
— starting from a conservative prior and telling you when it is still guessing.

**Generate in batches, priced before they are queued.** Build a matrix across
models, seeds, variations, aspect ratios, and durations; see the candidate count
and the real total; prune the expensive branches; then submit.

**Reject failures automatically, for free.** ffprobe, blackdetect, freezedetect
and a full decode pass catch frozen clips, black clips, wrong durations,
truncated downloads, unusable bitrates, and byte-identical duplicates before a
vision model or a person is involved. Only what survives goes to visual QC.

**Never auto-approve.** QC can reject; only a person promotes a master.

**Finish and deliver with provenance.** H.264/H.265/ProRes deliveries, alternate
aspect ratios (with an explicit crop-or-pad choice, because both lose something),
EDL and FCPXML, and a provenance sidecar recording the provider, model, prompt,
seed, shot version, QC verdicts, reviews, and cost. Transcoding never claims to
add detail, and nothing upscales or interpolates by default.

---

## Street Banker Audio Intelligence

The platform also carries a full audio intelligence and voice-services layer
— **Street Banker Audio Intelligence** — built on the same doctrine as the
render factory: provider-agnostic adapters with a real mock underneath,
budgets and an append-only usage ledger, org-scoped everything, and humans
approving what machines draft.

- **Meeting Intelligence** — authorized recordings in; diarized, timestamped
  transcripts; structured *draft* extraction (deal variables labelled
  explicit / inferred / needs-verification); human approval; commit to
  Operator Desk leads and tasks.
- **Signal Audio Briefs** — structured intelligence read aloud, confidence
  language intact, on a schedule.
- **Street Banker Operator** — a narrow intake agent with server-side
  guardrails (it cannot approve deals or promise outcomes), escalation to
  humans, and tenant-isolated white-label configuration.
- **Global Release Pack** — localization with transcript review and a human
  QA gate before export.
- **Campaign Audio Toolkit / Remix Lab / Artist Voice Vault** — approved
  voices only, imitation prompts blocked before the provider, owned-audio
  workflows with full lineage, ordered human release gates, and verified,
  revocable voice permissions.

ElevenLabs is the implemented live provider (endpoints verified against the
official SDK v2.64.0); the mock provider renders real WAV files so the whole
layer — including `pnpm seed`'s fictional demo data — runs with no
credentials and no spend. Start at
[`docs/AUDIO_INTELLIGENCE.md`](docs/AUDIO_INTELLIGENCE.md).
## Song Lab

**Drop a record. Diagnose it. Compare it intelligently. Test the possibilities.**

The song-diagnostic and experimentation module. Upload a recording the artist owns
or is authorized to use; Song Lab works out its structure, tempo, key, energy shape,
arrangement contrast, vocal density and vocal register, compares those against a
**comparison cohort the user chooses**, and lets them hear alternative versions — an
earlier chorus, a shorter intro, +4 BPM — built non-destructively from their own
audio.

Three rules are enforced in code, not in a style guide:

- **Nothing is fabricated.** Every derived feature carries its provider, method and
  confidence; a feature that could not be determined is `null` and renders as *"not
  enough information"*, never as a zero, and produces no comparison.
- **No universal formula.** Every percentile names its cohort, that cohort's sample
  size, and where its numbers came from. A cohort with no provenance cannot be
  published; one under 30 songs is flagged `LOW SAMPLE SIZE`.
- **Nothing is overwritten.** An experiment is a stored *edit decision list*; the
  renderer reads the source and writes a new asset; accepting one creates a new
  version with a parent pointer. The original stays playable forever.

Suggestions are framed as *worth testing*, never as predictions. Internal A&R is a
separate, permission-controlled view, and its draft cannot become a decision without
a named human approving it.

`pnpm seed` creates a fictional **Example Artist — "Signal Fire"** demo (3:47,
92 BPM, first chorus 0:56) with locally synthesized audio, benchmarked through the
real comparison engine, with three experiments ready to hear. Open **Song Lab** in
the nav; entitlement-gated per organization and enforced server-side.

Docs: [SONG_LAB.md](docs/SONG_LAB.md) · [analysis](docs/SONG_LAB_ANALYSIS.md) ·
[structure](docs/SONG_LAB_STRUCTURE.md) · [benchmarks](docs/SONG_LAB_BENCHMARKS.md) ·
[experiments](docs/SONG_LAB_EXPERIMENTS.md) · [lyrics](docs/SONG_LAB_LYRICS.md) ·
[producer view](docs/SONG_LAB_PRODUCER_VIEW.md) · [A&R](docs/SONG_LAB_AR.md) ·
[Signal](docs/SONG_LAB_SIGNAL.md) · [data rights](docs/SONG_LAB_DATA_RIGHTS.md) ·
[runbook](docs/SONG_LAB_RUNBOOK.md)

---

## Live Lab

The live-performance module: turn releases, stems, and authorized AI-generated
sections into a stage-ready, MIDI-controlled show. Setlist → scenes → 16-pad
grid → stem deck, with quantized launching on a Web Audio + AudioWorklet
engine, controller-agnostic MIDI Learn, an offline **performance package**
(checksum-verified local cache — the show runs with the internet unplugged),
crash recovery, and an AI Scene Builder on a provider-agnostic audio layer
whose mock synthesizes real WAVs at zero cost.

`pnpm seed` creates a fictional **Example Artist** demo set; open **Live Lab**
in the nav. Entitlement-gated per organization and enforced server-side.

Docs: [LIVE_LAB.md](docs/LIVE_LAB.md) · [LIVE_ENGINE.md](docs/LIVE_ENGINE.md) ·
[MIDI](docs/LIVE_LAB_MIDI.md) · [audio](docs/LIVE_LAB_AUDIO.md) ·
[offline](docs/LIVE_LAB_OFFLINE.md) · [AI](docs/LIVE_LAB_AI.md) ·
[Stage Control](docs/LIVE_LAB_STAGE_CONTROL.md) ·
[desktop plan](docs/LIVE_LAB_DESKTOP.md) · [runbook](docs/LIVE_LAB_RUNBOOK.md)

---

## Providers

Implemented adapters: **mock** (local ffmpeg), **MuAPI**, **Google Gemini (Veo)**,
**fal.ai**, **Runway**, **Luma**, **Replicate**, **self-hosted ComfyUI**.

Every endpoint, header, status enum, and price was verified on 2026-08-17 against
each vendor's own client library or machine-readable spec — see
[`docs/provider-matrix.md`](docs/provider-matrix.md).

> **No live provider call has been made from this build.** Every vendor host was
> blocked by the development environment's egress policy, so the adapters are
> spec-correct but unproven on the wire. Run
> `pnpm masterclip providers contract --provider <id> --submit` with a sandbox
> key before trusting one. This is tracked as risk #3 in
> [`docs/risk-register.md`](docs/risk-register.md).

---

## Commands

```bash
pnpm dev              # API + worker + web, one log stream
pnpm test             # 165 unit + integration tests
pnpm test:e2e         # 10 Playwright browser tests
pnpm typecheck        # tsc --noEmit across 27 packages
pnpm lint             # secret scan + shell/SQL guards + typecheck
pnpm build            # esbuild bundles + the web build
pnpm seed             # demo project
pnpm docker:up        # PostgreSQL + MinIO
```

### CLI

```bash
pnpm masterclip doctor
pnpm masterclip providers list | health | contract --provider mock --submit
pnpm masterclip models refresh
pnpm masterclip project create --name "Neon Rain"
pnpm masterclip shots import --project <id> --file shots.csv --dry-run
pnpm masterclip shots template --out shots.csv
pnpm masterclip render submit --shot <id> --count 6
pnpm masterclip queue work            # drain inline, no long-running worker
pnpm masterclip costs report --project <id>
pnpm masterclip masters package --master <id>
```

Every command takes `--json`. Exit codes: `0` ok · `1` error · `2` usage ·
`3` checks ran and reported failures.

---

## Deploying it

One container runs both processes. Generation never happens inside an HTTP
request — the API queues work and a worker performs it — so a deployment that
started only the API would accept renders and never run them.
`scripts/serve.mjs` seeds, then starts the worker, then the API, and exits if
either child dies, so the platform restarts a half-running factory rather than
leaving it accepting work it cannot do.

It is a Docker image rather than a plain Node runtime because ffmpeg and ffprobe
are load-bearing here: they render, probe, measure and transcode on the critical
path, and QC is meaningless without them.

```
docker build -t masterclip .
docker run -p 4310:4310 \
  -e SESSION_SECRET=... -e ASSET_SIGNING_SECRET=... \
  -e SEED_EMAIL=you@example.com -e SEED_PASSWORD=... \
  -v masterclip-data:/var/data \
  -e SQLITE_PATH=/var/data/masterclip.sqlite -e STORAGE_LOCAL_ROOT=/var/data/storage \
  masterclip
```

The repository root's `render.yaml` describes the same thing as a Render
Blueprint; syncing it prompts for `SEED_EMAIL` and `SEED_PASSWORD` and generates
the three secrets. A paid instance is required only for the persistent disk —
without it the database and every rendered clip are lost on each restart.

The externally reachable origin is not in the blueprint, because the service's
URL does not exist until the service does. It resolves from the host at runtime
instead, so provider callbacks work on a fresh deploy with nothing configured;
set `PUBLIC_BASE_URL` only to point at a custom domain.

Three things about a deployment that are not obvious:

- **Seed before the port opens.** The first account to reach `/api/auth/signup`
  bootstraps the organization and closes signup behind itself. On a public URL
  that is a race against the internet, so the owner is created at boot, before
  anything is listening. Seeding is idempotent — restarts do not accumulate demo
  projects, and the seed refuses to run under `NODE_ENV=production` with the
  development password.
- **`TRUST_PROXY` is off by default** and must be turned on behind a load
  balancer, or every visitor shares one rate-limit bucket. Turn it on only when
  a proxy you control writes `X-Forwarded-For`; otherwise the key is forgeable.
- **Sandbox is still the default.** A deployment refuses every billable
  submission until `MASTERCLIP_MODE=live` is set deliberately, and is bound by
  `LIVE_SPEND_CAP_USD` after that.

---

## Where things live

```
apps/       api (Fastify) · worker · web (React) · cli
packages/   shared · shot-schema · domain · database · queue · asset-storage
            auth · provider-core · provider-{mock,muapi,google,fal,runway,
            luma,replicate,selfhosted} · media-tools · qc-engine · cost-engine
            model-router · prompt-compiler · agents · runtime
            audio-core · audio-providers · audio-domain · audio-engine
            live-engine · midi-engine · performance-project · performance-cache
            ai-audio                          (Live Lab — docs/LIVE_LAB.md)
            song-feature-vectors · song-analysis · song-structure
            lyric-analysis · music-benchmarking · audio-experiments
            song-lab-domain · song-lab-engine  (Song Lab — docs/SONG_LAB.md)
docs/       architecture · provider-matrix · current-pricing-snapshot
            model-capabilities · licensing-inventory · security-model
            cost-strategy · cinematic-standard · risk-register · build-audit
```

---

## Documentation

| Document | Read it when |
|---|---|
| [architecture](docs/architecture.md) | you want to know why it is shaped this way |
| [cost-strategy](docs/cost-strategy.md) | before spending anything real |
| [provider-matrix](docs/provider-matrix.md) | adding or debugging an adapter |
| [current-pricing-snapshot](docs/current-pricing-snapshot.md) | budgeting — **read the caveats** |
| [model-capabilities](docs/model-capabilities.md) | choosing a model for a shot |
| [cinematic-standard](docs/cinematic-standard.md) | the default visual standard and how it is enforced |
| [security-model](docs/security-model.md) | before exposing this to a network |
| [licensing-inventory](docs/licensing-inventory.md) | before shipping commercially |
| [risk-register](docs/risk-register.md) | before production |
| [build-audit](docs/build-audit.md) | what is real, what is not |
| [AUDIO_INTELLIGENCE](docs/AUDIO_INTELLIGENCE.md) | the audio layer's map — start here for audio |
| [AUDIO_PROVIDERS](docs/AUDIO_PROVIDERS.md) | ElevenLabs/mocks, verification status, adding a provider |
| [AUDIO_SECURITY](docs/AUDIO_SECURITY.md) · [AUDIO_CONSENT](docs/AUDIO_CONSENT.md) · [AUDIO_RIGHTS_POLICY](docs/AUDIO_RIGHTS_POLICY.md) | before exposing audio features to anyone |
| [AUDIO_RETENTION](docs/AUDIO_RETENTION.md) · [AUDIO_WEBHOOKS](docs/AUDIO_WEBHOOKS.md) · [AUDIO_RUNBOOK](docs/AUDIO_RUNBOOK.md) | operating it |
| [SONG_LAB](docs/SONG_LAB.md) | the song-diagnostic module's map — start here for Song Lab |
| [SONG_LAB_ANALYSIS](docs/SONG_LAB_ANALYSIS.md) · [SONG_LAB_STRUCTURE](docs/SONG_LAB_STRUCTURE.md) | what is measured, how, and what it refuses to claim |
| [SONG_LAB_BENCHMARKS](docs/SONG_LAB_BENCHMARKS.md) | before presenting any percentile as market data |
| [SONG_LAB_EXPERIMENTS](docs/SONG_LAB_EXPERIMENTS.md) · [SONG_LAB_LYRICS](docs/SONG_LAB_LYRICS.md) · [SONG_LAB_PRODUCER_VIEW](docs/SONG_LAB_PRODUCER_VIEW.md) | the artist-facing surfaces |
| [SONG_LAB_AR](docs/SONG_LAB_AR.md) · [SONG_LAB_SIGNAL](docs/SONG_LAB_SIGNAL.md) | internal A&R and the closed loop |
| [SONG_LAB_DATA_RIGHTS](docs/SONG_LAB_DATA_RIGHTS.md) · [SONG_LAB_RUNBOOK](docs/SONG_LAB_RUNBOOK.md) | before exposing it to anyone, and operating it |

---

## Status

First production-capable release. Every feature's actual state — REAL,
DEV-LABELED, PARTIAL, or NOT BUILT — is itemised in
[`docs/build-audit.md`](docs/build-audit.md), including what still needs
credentials and what has never been run against a live provider.
