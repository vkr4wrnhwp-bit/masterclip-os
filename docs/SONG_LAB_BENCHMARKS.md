# Song Lab — Benchmarks

## The rule

There is no universal hit-song formula, and this module will not simulate one.
Every comparison names the population it compared against, how many records were
in it, and where those records' numbers came from.

## Cohorts

**Broad** — Current Top Songs · Genre Leaders · Catalog Classics · Streaming
Breakouts · Radio Hits · Viral Records · Sync-Friendly Records · Independent
Breakouts · Street Banker Successful Releases · Artist's Own Catalogue.

**Genre** — Alternative · Rock · Metal · Punk · Pop · Country · Hip-Hop · R&B ·
Electronic · Dance · Indie · Singer-Songwriter · Other.

**Custom** — built from genre, subgenre, release year, territory, label type,
performance cohort, streaming range, chart and radio performance, career stage,
duration, tempo range, vocal configuration (only where a rights holder supplied it
as metadata — never inferred from audio), and live/streaming/radio/sync orientation.

```
Alternative Rock · 2022–2026 · Independent · US + UK · 2M–50M streams
```

## The comparison

Per metric: the song's value, cohort median, mean, p10, p25, p75, p90, the song's
percentile, a z-score, sample size, confidence and the cohort definition.

```
FIRST CHORUS
Your Track:       0:56
Cohort Median:    0:43
75th Percentile:  0:52
Your song reaches the first chorus approximately 13 seconds later than
the cohort median — 77th percentile of 120 songs.
```

Two thresholds do different jobs:

- **Outside the interquartile range** (p25–p75) is worth *mentioning*: the song sits
  outside the middle half of the group, which is something an artist can act on.
- **Outside p10–p90** is worth calling an *outlier*: the song is unlike almost
  everything in the group.

Keeping these separate is what lets the product say "later than three quarters of
this cohort" without inflating it into "outlier", and say "outlier" only when the
word is earned.

Classification labels use the metric's own direction words:
`Later Than Cohort` · `Slower Than Cohort` · `Higher Density` · `Similar To Cohort`
· `Not Enough Information` — never a generic "high" or "low" that implies a target.

## The metric registry

A quantity is comparable only if it is in the registry, and it is in the registry
only if it can be measured from a recording **and** compared against a cohort.
That constraint is what keeps benchmarking honest — there is no way to introduce a
percentile for something the analyser cannot measure.

Groups: `global` · `timing` · `structure` · `hook` · `energy` · `arrangement` ·
`vocal` · `melodic` · `lyric`. Each definition carries a unit, a description, and
the two **direction words** used to phrase a difference in either direction — never
"better" and "worse".

Metrics marked `requires: 'vocals' | 'lyrics' | 'stereo'` are skipped rather than
zeroed when their input is absent: a mono file gets no stereo-width percentile, an
instrumental gets no register percentile, and a song with no attached lyric gets no
title-repetition percentile.

## Sample size

| Threshold | Behaviour |
|---|---|
| `MINIMUM_SAMPLE_SIZE = 8` | Below this, **no comparison is produced at all** |
| `LOW_SAMPLE_THRESHOLD = 30` | Below this, `LOW SAMPLE SIZE` is displayed and the confidence is capped |

Confidence on a result is `min(measurement confidence, sample confidence)`. A
perfectly measured value compared against ten songs is still a weak result, and the
figure says so.

## Provenance

Every cohort records where its numbers came from, and the record is required:

```ts
sources: Array<{
  kind: 'licensed_metadata' | 'internal_analysis' | 'public_dataset'
      | 'rights_holder_supplied' | 'partner_supplied'
  name: string
  basis: string        // licence or authorization reference — cannot be empty
  capturedAt: string
  storesMasters: boolean
}>
```

`validateCohortDefinition` refuses a cohort with no sources, a source with an empty
basis, a licensed-metadata source that also claims to store masters, and a published
cohort under the minimum sample size. Provenance is denormalized into
`benchmark_provenance` so it can be listed, audited and exported without parsing
every cohort's JSON, and it is shown in the UI alongside the results.

## The data architecture

`benchmark_song_features` stores **derived features and metadata only**. There is
deliberately no column for audio bytes or a storage key: a benchmark library built
from licensed metadata and derived measurements is defensible; a library of other
people's masters is not.

`BenchmarkProvider` answers exactly one question — *for this cohort, what are the
per-metric distributions?* — and the interface gives it no way to return audio.

Copyrighted recordings are never played back to a user for comparison unless Street
Banker holds the rights to do so; nothing in this module provides that path.

## The shipped provider

`reference-distribution` generates distributions from published, openly-documented
*ranges* for broad song characteristics, widened to plausible spreads and seeded
deterministically per cohort, with coarse documented genre tendencies applied to a
handful of metrics.

It exists so the product is fully operable before a licensed data agreement is in
place. Every result it returns is stamped:

> **kind:** `reference_distribution`
> **basis:** Synthetic distributions over published general song-characteristic
> ranges. Not market data, not licensed catalogue data, no master recordings.

**Replace it with a licensed provider before presenting these figures as market
data.** Set `SONG_LAB_BENCHMARK_PROVIDER` and register the adapter in
`createSongLabLayer`.

## Entitlements

Proprietary cohorts (Street Banker's own intelligence) require
`song_lab.signal_benchmarks`. The flagship organization always holds it; a partner
needs an explicit grant. `BenchmarkCohortRepo.getForOrg` takes
`entitledToProprietary` as a **required** argument, so a caller cannot read flagship
intelligence by omitting a parameter, and a cohort belonging to another organization
is invisible regardless.
