# Studio — implementation note

Written before the second round of Studio work, as the audit that round asks
for. It records what is actually in this repository, what the specification
assumes is in it and is not, and what the remaining work therefore is.

Read the gap section first. It changes the shape of everything after it.

---

## 1. The gap between the brief and the repository

The specification asks Studio to integrate with the existing Street Banker
"authentication system, organizations, artists, releases, tracks, Metadata
Passport, Artist Twin, Remix Lab, Creative Studio, Rollout Engine,
Distribution, Royalty Sweep, billing, storage, and existing design system."

Verified by grep across the whole tree:

| Named system | In this repository |
|---|---|
| Authentication, organizations | **Yes** — `packages/auth`, `orgs` / `users` / `sessions` / `org_entitlements` |
| Storage | **Yes** — `packages/asset-storage`, local + S3 behind one driver |
| Billing | **Partly** — `packages/cost-engine` is a spend ledger and budget controller, not a customer-credit system |
| Design system | **Yes**, informally — CSS custom properties in `apps/web/src/styles.css` |
| Remix Lab | **Yes** — `RemixService` (`packages/audio-engine/src/remix.ts`), `remix_projects` / `remix_versions` |
| Artists, releases, tracks | **No such entities.** No `artists`, `releases` or `tracks` table exists. Artist is a text field on a project |
| Metadata Passport | **No.** Zero files |
| Artist Twin | **No.** Zero files |
| Rollout Engine | **No.** Zero files |
| Creative Studio | **No.** Zero files |
| Smart Links | **No.** Zero files |
| Distribution | **No subsystem.** The word appears in demo data, in the operator agent's script, and as `DistributionSummary` statistics types |
| Royalty Sweep | **No subsystem.** The word appears in keyword lists and meeting demo data |

There is also **no pre-existing `/rack` route** anywhere in the application.
The Rack is a tab inside the Studio built in PR #26; there is no legacy surface
to preserve, alias or migrate away from, and no user with a bookmark to it.

### What follows from that

Three things, and they should be decided rather than discovered halfway
through:

1. **"Platform connections" cannot be implemented as integrations.** Six of the
   named counterparties do not exist. What *can* be built is the boundary: a
   named interface, a stored connection record, and a disabled surface that
   says the counterpart is not configured. That is worth building — it is where
   the integration lands later — but it must not be described as connected.
2. **The canonical identity question is already answered here, differently.**
   The spec assumes `Release` and `Track` exist and that Studio hangs off them.
   In this repository the record *is* `studio_projects.id`, which the Studio
   already treats as canonical. Introducing `releases`/`tracks` now would create
   a second identity for the same song — the exact failure the first spec told
   us to avoid. Recommend: keep `studio_projects.id` canonical and add a
   nullable `release_id` when a real release entity exists.
3. **A meaningful part of the spec is already built.** PR #26 shipped 35 tables,
   three packages, the analysis engine, Mix Doctor, Master Station, Version
   Vault, Collaborate, Deliver, and the rights/provenance schemas. The
   remaining work is a delta, not a fresh build, and is listed in §8.

---

## 2. What the Rack currently does

`studio_rack_chains`, `studio_rack_modules`, `studio_rack_history`,
`studio_rack_presets`; services in `packages/studio-engine/src/rack.ts`.

It is a **document of intent**, not a signal path. A chain is an ordered list of
modules with parameters, attached to a version. Nothing in the Rack processes
audio: the only thing that renders audio is Master Station, through
`MasterRenderer`.

- `RACK_MODULES` is a catalogue of module types with parameter schemas.
- Undo/redo is snapshot-based: every mutation writes the whole chain into
  `studio_rack_history` and stepping back restores a snapshot. Chains are small
  and a snapshot cannot drift out of sync with a replayed edit log.
- Presets are org-scoped chains without a version.

Nothing imitates a third-party plugin's appearance, and the module names are
generic (`eq`, `compressor`, `saturation`) rather than modelled on named
hardware.

## 3. Reusable, and reused

| Component | Where | Used by Studio for |
|---|---|---|
| `AuthService`, org membership, CSRF | `packages/auth` | Every route |
| `EntitlementService` | `packages/auth` | All 21 Studio capabilities and `.max_*` limits |
| `StorageDriver` (`putBuffer` / `getBuffer` / `materialize` / `signedUrl`) | `packages/asset-storage` | Every audio byte |
| `DurableQueue` / `QueueWorker`, leases, dedupe keys | `packages/queue` | The five `studio.*` job types |
| `Db` driver + inline migrations | `packages/database` | `0008_studio` |
| `newId` prefixes | `packages/shared/src/ids.ts` | 27 Studio prefixes |
| `AuditLog` (append-only) | `packages/domain/src/audit.ts` | Available; Studio currently writes its own `studio_activity` |
| `ConsentRepo` | `packages/audio-domain` | Identity Vault consent verification |
| `hashObject` | `packages/shared` | Record Passport canonical hash |
| WAV decode | `packages/ai-audio/src/wav.ts` | Analysis without ffmpeg |
| Structural analysis | `packages/song-analysis` | *Not* reused — see below |

**Deliberately not shared with Song Lab.** Song Lab analyses at a fixed
22.05 kHz, which is correct for structure and fatal for mix diagnosis:
sibilance and harshness live at 5–10 kHz, above that Nyquist.
`packages/mix-analysis` runs its own pass at the source rate. The two answer
different questions and sharing the pass would break the harder one.

## 4. What stays untouched

Masterclip's video pipeline (`scenes`, `shots`, `render_batches`, providers,
QC), Live Lab, Song Lab, Audio Intelligence and Remix Lab. Studio adds tables
and routes; it modifies no existing table and no existing route handler. The
only shared files it edits are additive: the migration list, the id-prefix map,
the env schema, the queue's job-type union, the runtime composition root, the
worker's queue list and the web nav.

## 5. Database

35 tables, all in `0008_studio`, all org-scoped, all foreign-keyed to
`studio_projects.id`. DDL stays inside the SQLite ∩ PostgreSQL intersection
(TEXT/INTEGER/BIGINT/REAL, 0/1 booleans, ISO-8601 text timestamps, JSON as TEXT,
no DEFAULT expressions) because both drivers run the same statements.

Three are append-only and nothing updates or deletes from them:
`studio_activity`, `studio_identity_events`, `studio_ai_permission_events`.

Reversibility: the migration is additive only. Rolling back the application
leaves 35 unused tables; no existing column changed type or meaning, so a
rollback needs no data migration.

**Missing for the new spec:** a `processing_jobs` table with provider, cost,
idempotency key and error fields; `waveform_peaks`; `provenance_events` with a
hash chain; `connector_accounts`; `provider_configurations`. Analysis and
rendition rows currently carry their own status, which works but does not give
one place to answer "what is running, what did it cost, and can it be retried
safely".

## 6. Routes

Added: `/api/studio/*` (projects, versions, rack, mix, references, master,
album, comments, approvals, deliver, room, memory, passport, rights, market).
Web: `#/studio` and `#/studio/:id/:tab`.

Changed: none. Hash routing means the new tabs need no server route.

The spec's `/studio/session/:projectId/...` scheme is a rename of
`#/studio/:id/:tab`. Doing it costs a route-parser change and a redirect from
the old shape; there are no external links to break, so it is cheap — but it
buys nothing functional and should be done for consistency, not urgency.

## 7. Deployment and operational risk

- **ffmpeg is load-bearing and absent from the build environment used here.**
  Analysis of anything but WAV settles as `unsupported`; mastering falls back to
  a passthrough renderer that returns the *unprocessed source*, marked
  `placeholder`. The production image (`Dockerfile`, per `render.yaml`) does
  include ffmpeg, so this is an environment limitation, not a product one — but
  it means the rendered mastering output has never been executed in CI.
- **Uploads are buffered through the API process.** `assets.ts`, `live-lab.ts`
  and the audio routes all read a multipart body, write to a temp dir, then put
  it in storage. There is no resumable, direct-to-object-storage path. For
  100 MB WAVs on one Render instance this is the most likely first production
  failure — memory and request-timeout, not correctness.
- **One container runs API and worker** (`scripts/serve.mjs`). A long analysis
  competes with request handling. `STUDIO_MAX_ANALYSIS_SECONDS` (900) caps the
  damage rather than removing it.
- **Local storage on a 5 GB Render disk** is the default. Master renditions are
  24-bit and accumulate; retention marks them `generated` so a policy can expire
  them, but no policy is scheduled by default.

## 8. External services required, and what exists instead

| Need | Today |
|---|---|
| Audio decode/encode/render | ffmpeg on PATH, or `FFMPEG_PATH` / `FFPROBE_PATH`. No hosted alternative is wired |
| Object storage | `STORAGE_DRIVER=s3` + `S3_*`, or local disk |
| Mastering provider | **None.** `MasterRenderer` is the seam; the only implementation is ffmpeg-local |
| Stem separation | Flag exists (`STEM_SEPARATION_ENABLED`), provider work lives in `packages/audio-providers` |
| Payments | **None.** `cost-engine` tracks provider spend against budgets; there is no customer credit, invoice or checkout |
| Analytics / error tracking | **None wired.** Structured JSON logs to stdout |

The spec's `AudioProcessingProvider` interface does not exist. `MasterRenderer`
is a narrower version of it (render one chain, return a file) and is the right
place to widen from.

## 9. Licensing

No copyleft dependency was introduced. `packages/mix-analysis` implements its
own FFT, loudness gating, true-peak estimation and band analysis rather than
pulling in a GPL DSP library. ffmpeg is invoked as an external binary and not
linked, which is what keeps it out of the application's own licensing.

---

## 10. The remaining delta

In dependency order. Nothing here rewrites what shipped.

1. **`processing_jobs`** — one table for every async unit of work, carrying
   provider, idempotency key, cost, retry count and error. Analysis and render
   rows point at it rather than tracking status themselves. This is the
   prerequisite for the billing rule that a failed job must not consume a
   credit.
2. **`AudioProcessingProvider`** — widen `MasterRenderer` into a named interface
   with `analyze`, `render`, `transcode` and `separate`, a local adapter, and a
   registry that reports "not configured" as a first-class state rather than
   silently falling back.
3. **Resumable direct-to-storage upload** — signed multipart URLs, client-side
   chunking, server-side completion and checksum verification. Removes the
   API process from the byte path.
4. **Waveform peaks and a playback proxy** — generated once per version so the
   editor does not fetch a 100 MB WAV to draw a line.
5. **`provenance_events`** — hash-chained, append-only. The Record Passport
   already hashes a document; this is the per-event chain underneath it.
   *It is not cryptographic verification and must not be described as such until
   signing and verification exist.*
6. **Confidence taxonomy** — every recommendation carries SOURCE, CONFIDENCE and
   MISSING INPUTS. The metrics already carry method and confidence; the
   recommendations do not yet.
7. **Named feature flags** — the spec's `studio_v1` names, mapped onto the
   existing `STUDIO_*_ENABLED` env flags and the 21 entitlement capabilities.
8. **Route rename** to `/studio/session/:projectId/*`, with a redirect.
9. **Rooms** — Control Room exists. Remix Lab exists but is not presented as a
   room. Visual Room means Masterclip's video tools, which are already in the
   nav under their own name.
10. **Connection boundaries** for the six systems that do not exist: a
    `connector_accounts` record, a named interface, a disabled surface.

Order matters for 1–3. Everything after them is independent.
