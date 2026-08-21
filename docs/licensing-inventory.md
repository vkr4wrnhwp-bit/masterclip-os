# Licensing inventory

**Retrieved 2026-08-17**, licences re-verified by fetching each `LICENSE` file
and each npm registry record directly.

---

## The headline finding

**The two most architecturally interesting open-source projects in this space are
the two you cannot borrow code from.** Every pattern this codebase shares with
them is a clean-room reimplementation of the *idea*, written from the description
in `docs/architecture.md`, with no code copied.

| Project | Licence | Verified how | Code reusable here? |
|---|---|---|---|
| **OVG** — `outscal/video-generator` | **NONE** — no LICENSE file, no grant in the README → all rights reserved | `main/LICENSE` → HTTP 404; README (21,491 bytes) grepped for licence/copyright/"all rights" → zero hits | **NO.** Read for ideas only |
| `digitalsamba/claude-code-video-toolkit` | **MIT** © 2024 Digital Samba | `main/LICENSE` → 200, 1,070 bytes, opens `MIT License` | **YES**, with attribution |
| `calesthio/OpenMontage` | **AGPL-3.0** | 661-line LICENSE, README badge, README §License — confirmed three ways | **NO** for a hosted service. AGPL §13's network clause triggers on SaaS |
| `remotion` / `@remotion/renderer` | **Proprietary source-available**, free for individuals and for-profits with **≤3 employees**; a Company Licence is required otherwise | `remotion-dev/remotion@main/LICENSE.md` fetched in full | **Conditional** — not used |

**Patterns adopted, code not copied:** a machine-readable scene/shot manifest as
the single source of truth; a producer/orchestrator above specialised subagents;
deterministic renderers driven by that manifest; per-scene regeneration; asset
provenance; automated review loops.

**MASTERCLIP OS uses none of these projects' code.** No file in this repository
derives from OVG, OpenMontage, the DigitalSamba toolkit, or Remotion.

---

## The ffmpeg packaging trap

This one is worth stating plainly because it is easy to get wrong and it is a
licence problem, not a technical one.

| Package | Wrapper licence | Bundled binary licence |
|---|---|---|
| `ffmpeg-static@5.3.0` | **GPL-3.0-or-later** | GPL-3 |
| `ffprobe-static@3.1.0` | MIT | **GPL-3** (binary reports `--enable-gpl --enable-version3`) |
| `@ffmpeg-installer/ffmpeg@1.1.0` | LGPL-2.1 | **GPLv3** sub-package |
| `@ffprobe-installer/ffprobe@2.1.2` | LGPL-2.1 | **GPL-3.0** sub-package |

An MIT wrapper around a GPL-3 binary is still shipping a GPL-3 binary.

**MASTERCLIP OS depends on none of them.** It invokes the **system** `ffmpeg` and
`ffprobe` through `execFile`, with the paths configurable via `FFMPEG_PATH` and
`FFPROBE_PATH`. Calling a separate executable over a process boundary does not
create a derived work, which keeps the application's own licensing unconstrained
and lets an operator choose an LGPL build if their situation requires it.

`pnpm masterclip doctor` reports whether the binaries are present and which build.

---

## Runtime dependencies

All permissive. Nothing copyleft is linked into the application.

| Package | Licence | Why it is here |
|---|---|---|
| `fastify`, `@fastify/{cookie,multipart,static}` | MIT | HTTP server |
| `zod` | MIT | schema validation; `zod/v4` also generates the published JSON Schema |
| `pg` | MIT | the PostgreSQL driver |
| `react`, `react-dom` | MIT | the review interface |
| `vite`, `@vitejs/plugin-react` | MIT | web build |
| `esbuild` | MIT | production bundles for api/worker/cli |
| `tsx`, `typescript` | MIT / Apache-2.0 | dev execution and typechecking |
| `vitest`, `@playwright/test` | MIT / Apache-2.0 | tests |

Deliberately **not** taken as dependencies:

- **AWS SDK** — the S3 driver implements SigV4 directly (~120 lines, unit-tested
  against AWS's own published test vector) rather than pulling a large surface
  for four operations.
- **A SQLite native binding** — Node's built-in `node:sqlite` needs no compile
  step, so a clean checkout runs with no build toolchain.
- **An ORM** — every query is visible SQL with bound parameters.
- **An ffmpeg npm package** — see above.
- **`@fastify/rate-limit`** (MIT, and perfectly usable) — the limiter is ~90 lines
  in `@masterclip/shared` instead, because every timing-sensitive component here
  takes an injectable `Clock`. A plugin bound to real wall-clock time would have
  made the only tests worth having — does the 11th login in a minute get refused,
  does a bucket refill correctly after an hour idle — either slow or flaky. The
  in-repo version is tested by advancing a fake clock, and it holds the
  app-specific policy (a per-account login budget, a separate budget for
  spend-causing routes) that a generic plugin would not.

---

## Assets and generated media

The application's own rules, enforced in code:

- Every uploaded asset records owner, source, licence, consent status, allowed
  use, expiry, and an explicit `authorized` flag. Rights are captured **at upload
  time**, not added later.
- Identity-preserving generation calls `requireAuthorizedForIdentity`, which
  refuses unless consent is explicitly `authorized` and unexpired. Consent is
  never inferred from the fact that a file exists.
- Generated outputs record the provider, model, prompt, seed, shot version, and
  cost; provider terms of service govern their use and the sidecar says so.
- Nothing ingests arbitrary internet imagery. There is no fetch-by-URL ingest
  path in the product.
- **No training or fine-tuning on user media happens anywhere in this codebase.**
