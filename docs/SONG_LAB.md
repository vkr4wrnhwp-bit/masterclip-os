# Street Banker Song Lab

**Upload the record. Diagnose the record. Compare it intelligently. Test the possibilities.**

Song Lab is an artist-development, song-diagnostic, benchmarking and experimentation
system. It listens to a recording the artist owns or is authorized to use, works out
what that recording is doing structurally and musically, compares it against a
comparison group the user chooses, and lets them *hear* alternative versions built
from their own audio.

It is not an AI songwriter, a remix generator, a mastering tool, or a hit predictor.

---

## The rule the module is built around

> Evidence first. Suggestions second. Artist judgment always.

Three consequences, each enforced in code rather than in a style guide:

**No fabricated data.** Every derived musical feature travels as a `Measured<T>`
carrying `value`, `confidence`, `analysisMethod`, `provider` and `modelVersion`.
A feature the analyser could not determine has `value: null`, renders as
*"not enough information"*, and produces **no** benchmark comparison. There is no
code path that turns an unmeasured quantity into a zero.

**No universal formula.** Every percentile names the cohort it came from, that
cohort's sample size, and where its numbers came from. A cohort with no provenance
cannot be published (`validateCohortDefinition`), and a cohort under
`MINIMUM_SAMPLE_SIZE` produces no comparison at all.

**No claims of guaranteed success.** Observations state what was measured against
what. Recommendations are phrased as *worth testing*. The wording is assembled from
fixed templates that contain no such claim, and a test asserts the generated text
never contains "will perform better", "guarantee", "will be a hit" and similar.

---

## The workflow

```
SONG LAB
   ↓  analyse the record
   ↓  compare against a relevant cohort
   ↓  test structure / tempo / hook / arrangement
   ↓  artist + producer decision
   ├── needs development ──→ REMIX LAB ──→ producer review
   └── ready ─────────────→ RELEASE COMMAND CENTER ──→ distribution
                                       ↓
                                    SIGNAL ──→ performance data ──→ LIVE LAB
```

Song Lab sits **before** Remix Lab: diagnose the record, then decide what to do with it.

---

## Routes

| Route | What it is |
|---|---|
| `/song-lab` | Entry — **DROP A RECORD** |
| `/song-lab/new` | Create a project, confirm rights, attach audio |
| `/song-lab/projects` | Project list |
| `/song-lab/projects/:id/overview` | Three things worth testing, plus the headline figures |
| `/song-lab/projects/:id/structure` | Timeline, manual correction |
| `/song-lab/projects/:id/hook` | Hook architecture profile, Chant Finder |
| `/song-lab/projects/:id/lyrics` | Syllable architecture, title placement |
| `/song-lab/projects/:id/energy` | Energy curve and per-section energy |
| `/song-lab/projects/:id/tempo` | Tempo Lab |
| `/song-lab/projects/:id/arrangement` | Section contrast, vocal register, Build Intelligence |
| `/song-lab/projects/:id/benchmark` | Cohort selection and percentile comparison |
| `/song-lab/projects/:id/experiments` | What If? engine and A/B playback |
| `/song-lab/projects/:id/producer` | Producer View — every raw feature with its method |
| `/song-lab/projects/:id/versions` | Version lineage, comparison, handoffs |
| `/song-lab/projects/:id/ar` | **Internal only** — permission controlled |

---

## Packages

The analytical engine is deliberately outside the React tree and outside the API,
so Signal, Remix Lab, Live Lab and internal A&R tooling can reuse it.

| Package | Responsibility |
|---|---|
| `@masterclip/song-feature-vectors` | The `Measured<T>` envelope, the metric registry, the versioned feature vector |
| `@masterclip/song-analysis` | PCM decoding, FFT, tempo, key, loudness, vocal activity (from the mix or a separated stem), register and melodic contour, provider interfaces |
| `@masterclip/song-structure` | Section detection, structural metrics, contrast, register and melodic analysis, Build Intelligence, Chant Finder |
| `@masterclip/lyric-analysis` | Syllables, phrases, title/hook repetition, density |
| `@masterclip/music-benchmarking` | Cohorts, percentiles, comparison, observation generation |
| `@masterclip/audio-experiments` | Edit decision lists, builders, renderers |
| `@masterclip/song-lab-domain` | Repositories, capabilities, record types |
| `@masterclip/song-lab-engine` | Services and the composition root |

> The build prompt suggested `/services/song-lab` and `/services/song-benchmarking`.
> This repository has no `services/` directory — every deployable unit lives in
> `apps/` and every library in `packages/`. `song-lab-engine` is the service layer
> and `music-benchmarking` is the benchmarking service; the split is the same, the
> directory follows the repository's existing convention.

---

## Vocabulary

Song Lab never says a song is wrong. The vocabulary is fixed:

`Structure Outlier` · `Worth Testing` · `Earlier Than Cohort` · `Later Than Cohort`
`Higher Density` · `Lower Contrast` · `Similar To Cohort` · `Unusual By Design`
`Needs Review` · `Potential Opportunity` · `Low Sample Size` · `Not Enough Information`
`Higher Register` · `Lower Register` · `Bigger Lift` · `Smaller Lift`

Direction words come from the metric's own definition, so a slow track reads
*"Slower Than Cohort"* and a late chorus reads *"Later Than Cohort"* — never a
generic "low" that implies a target.

---

## What Song Lab does not do

Not a DAW: no piano roll, no MIDI sequencing, no VST hosting, no multitrack
recording, no mixing console, no mastering.

Not a generative tool: it does not invent melodies, voices, lyrics or arrangement
elements. Build Intelligence *suggests* "add a backing-vocal layer in bars 7–8" and
renders it only where the artist's own separated stems already exist. Register
analysis measures where the chorus sits against the verse and says a lift is worth
trying; it does not write the higher melody.

Not a decision maker: it cannot sign, reject, fund or promise anything to an artist.
The A&R draft cannot leave `draft` status without a named human.

---

## Further reading

- [`SONG_LAB_ANALYSIS.md`](SONG_LAB_ANALYSIS.md) — what is measured and how
- [`SONG_LAB_STRUCTURE.md`](SONG_LAB_STRUCTURE.md) — section detection and correction
- [`SONG_LAB_BENCHMARKS.md`](SONG_LAB_BENCHMARKS.md) — cohorts, percentiles, provenance
- [`SONG_LAB_EXPERIMENTS.md`](SONG_LAB_EXPERIMENTS.md) — the What If? engine
- [`SONG_LAB_LYRICS.md`](SONG_LAB_LYRICS.md) — lyric and vocal intelligence
- [`SONG_LAB_PRODUCER_VIEW.md`](SONG_LAB_PRODUCER_VIEW.md) — the deep mode
- [`SONG_LAB_AR.md`](SONG_LAB_AR.md) — internal A&R
- [`SONG_LAB_SIGNAL.md`](SONG_LAB_SIGNAL.md) — Signal integration and the closed loop
- [`SONG_LAB_DATA_RIGHTS.md`](SONG_LAB_DATA_RIGHTS.md) — rights, privacy, retention
- [`SONG_LAB_RUNBOOK.md`](SONG_LAB_RUNBOOK.md) — operating it
