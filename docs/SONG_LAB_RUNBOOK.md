# Song Lab — Runbook

## Running it

```bash
pnpm seed          # includes the fictional "Example Artist — Signal Fire" demo
pnpm dev           # API :4310 · web :4311 · worker
```

Open <http://127.0.0.1:4311> → **Song Lab → Drop a record**.

A clean checkout needs nothing installed except Node 22.5+. ffmpeg is required only
to decode compressed uploads and to render experiment previews; without it, WAV
uploads analyse normally, other formats fall back per-file to the deterministic
provider, and previews are marked as unavailable rather than silently silent.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `SONG_LAB_ENABLED` | `true` | Umbrella kill switch — off means no route or job runs |
| `SONG_LAB_BENCHMARKS_ENABLED` | `true` | Cohorts, comparisons, custom cohorts |
| `SONG_LAB_EXPERIMENTS_ENABLED` | `true` | The What If? engine |
| `SONG_LAB_LYRICS_ENABLED` | `true` | Lyric analysis and Chant Finder |
| `SONG_LAB_AR_VIEW_ENABLED` | `true` | Internal A&R (also entitlement-gated) |
| `SONG_LAB_ANALYSIS_PROVIDER` | `local-dsp` | `local-dsp` or `mock-song-analysis` |
| `SONG_LAB_BENCHMARK_PROVIDER` | `reference-distribution` | Swap for a licensed provider |
| `SONG_LAB_MAX_ANALYSIS_SECONDS` | `900` | Cap so one long upload cannot occupy a worker |
| `SONG_LAB_PREVIEW_RETENTION_DAYS` | `30` | Experiment preview lifetime |

## Jobs

Queue `song_lab`:

```
song_lab.upload.validate        song_lab.features.build
song_lab.audio.analyze          song_lab.benchmark.compare
song_lab.structure.detect       song_lab.observations.generate
song_lab.vocal.analyze          song_lab.experiment.render
song_lab.lyrics.transcribe      song_lab.waveform.generate
song_lab.lyrics.analyze         song_lab.outcome.update
song_lab.reanalyze
```

All are idempotent (dedupe-keyed on the record id), retried with backoff by the
durable queue, organization-scoped, and record human-readable failure reasons on the
record itself rather than only in logs.

## Granting access

```ts
// Flagship
await runtime.entitlements.grantAll(orgId, FLAGSHIP_SONG_LAB_CAPABILITIES)

// Partner — everything except the internal layers
await runtime.entitlements.grantAll(orgId, PARTNER_SONG_LAB_CAPABILITIES)

// Limits
await runtime.entitlements.setLimit(orgId, 'song_lab.max_projects', 25)
await runtime.entitlements.setLimit(orgId, 'song_lab.max_experiments_per_project', 20)
await runtime.entitlements.setLimit(orgId, 'song_lab.max_custom_cohorts', 10)
```

The flagship organization is the oldest org on the deployment, by construction of
the bootstrap flow.

## Common situations

**"Analysis failed."** Read `song_analyses.failure_reason`. The most common cause is
an undecodable upload with no ffmpeg available. The source audio is untouched and
the project can be reanalysed once the cause is fixed.

**"The benchmark tab says select a cohort."** Expected: Song Lab will not compare a
song against a universal formula. Choose a cohort.

**"LOW SAMPLE SIZE."** The cohort holds fewer than 30 songs. The percentile is
arithmetic, not evidence. Widen the cohort filters or use a broader cohort.

**"Not enough information" on a metric.** The analyser could not determine it —
a mono file has no stereo width, a track with no detectable pulse has no tempo, a
song with one verse has no second-verse duration. This is the correct output, not a
bug. Producer View shows the reason.

**"The preview is silent."** ffmpeg is unavailable. The experiment's edit list and
predicted timings are real; only the audio render is missing. Install ffmpeg and
re-render.

**"An experiment cannot be built."** The structure does not contain the section the
builder needs. Correct the structure on the Structure tab first — corrections are
authoritative and feed straight back into the builders.

**Reanalysis after an engine upgrade.** `POST /api/song-lab/projects/:id/reanalyze`
creates a new analysis row and preserves the old one. Human-confirmed sections carry
forward automatically.

**"The register panel is empty on an older project."** Register and melodic contour
arrived in migration `0007_song_lab_register`. Sections analysed before it have no
register columns, so they read as *not measured* — which is honest, not broken.
Reanalyse the project to measure them; the previous analysis stays readable.

**"No lead vocal was detected reliably enough to measure a register."** Expected on
an instrumental, and common on a dense mix where the detector cannot separate a
lead. Register is inferred from a full mix, so its confidence caps at 0.5 and it
reports nothing rather than guessing. Supplying an isolated vocal stem raises both
the detection and the register that follows from it.

## Replacing the benchmark provider

1. Implement `BenchmarkProvider` — one method, `queryCohort`, returning per-metric
   distributions and provenance. It cannot return audio; the interface has no path
   for it.
2. Register it in `createSongLabLayer` and set `SONG_LAB_BENCHMARK_PROVIDER`.
3. Create cohorts with real `sourceDefinition.sources` entries. A cohort with no
   provenance, or a licensed-metadata source claiming to store masters, is refused
   at creation.

Until that is done, cohort figures come from `reference-distribution` and are
stamped as synthetic in every result. Do not present them as market data.

## Demo mode

The seed creates a fictional project — **Example Artist, "Signal Fire"**, 3:47,
92 BPM, first chorus at 0:56 — with locally synthesized audio. No real recording is
used, downloaded or referenced. It is benchmarked through the real comparison engine
against a published cohort and carries three experiments ready to hear: earlier
chorus, +4 BPM, shorter intro. Re-running the seed is idempotent.
