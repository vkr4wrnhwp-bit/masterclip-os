# Song Lab — Analysis

What Song Lab measures, how, and how much it will claim to know.

## The pipeline

```
upload → rights check → secure store → decode → frame analysis
      → tempo · key · loudness · vocal activity
      → structure detection
      → structural metrics
      → feature vector
      → cohort comparison → observations → suggested experiments
```

Each stage records its own provider and model version. A stage that fails
contributes explicit unknowns rather than failing the run, so a mono file still
gets a structure analysis and a track with no detectable pulse still gets an
energy curve.

## The measured value

No derived feature travels as a bare number:

```ts
interface Measured<T = number> {
  value: T | null          // null means "not enough information", never zero
  confidence: number       // 0–1, meaningless without a value
  analysisMethod: string   // e.g. onset_autocorrelation
  provider: string         // local-dsp | mock-song-analysis | a vendor id
  modelVersion: string
  note?: string            // the caveat shown next to a low-confidence figure
}
```

Confidence bands: `HIGH ≥ 0.75` · `MODERATE ≥ 0.5` · `LOW ≥ 0.25` ·
`NOT ENOUGH INFORMATION` below that or whenever `value` is null.

## What is measured

**Global** — duration, BPM, tempo stability, meter, key, loudness, dynamic range,
peak, spectral balance, stereo width, silence, fades, first vocal.

**Per frame** (~46 ms) — RMS energy, spectral centroid, spectral flatness,
spectral flux, low/mid/high band shares, 12-bin chroma, stereo width.

**Per section** — energy, vocal occupancy, arrangement density, spectral density,
transient density, low-frequency density, stereo width, rhythmic density, vocal
register band, melodic contour, and a similarity vector used for section-to-section
comparison.

## Method notes, and their limits

**Tempo** — onset-strength autocorrelation over 60–200 BPM. Confidence is the
share of the winning autocorrelation peak standing above the typical lag. Before
any peak is trusted, onset *salience* is measured on the raw flux: material with
no transients (a pad, a drone, a solo voice) reports no tempo rather than the
analysis window's own periodicity.

**Key** — Krumhansl–Schmuckler profile correlation over mean chroma. Confidence
derives from the margin to the runner-up, because relative major/minor pairs
correlate closely. A modal or key-changing record reports low confidence, and the
runner-up is shown alongside.

**Meter** — beat-accent periodicity, 4/4 vs 3/4. Reported only when one wins
clearly. Time signature is the feature most often stated with false confidence by
automatic analysis, and a wrong meter silently corrupts every bar-based edit, so
the honest answer here is frequently *not enough information*.

**Loudness** — gated 400 ms block mean-square with the two-stage BS.1770 gate, but
**without** K-weighting. It is an approximation of programme loudness, is capped at
0.7 confidence, and is labelled as an estimate everywhere it appears. Song Lab is a
diagnostic tool, not a compliance meter.

**Stereo width** — side/mid energy ratio. A mono file reports `null`, not `0`: a
mono file has no stereo field, which is different from a very narrow one. A
"stereo" file whose channels are identical also reports `null`.

**Vocal activity** — a *proxy*, and named one everywhere it surfaces. Without source
separation the detector scores three properties per frame: energy concentrated in
200 Hz–2 kHz, tonality above percussion, and continuous small centroid motion.
Confidence caps at **0.45** from a full mix and rises to **0.85** when an isolated
vocal stem is supplied. A dense guitar record will score higher than it should, and
the UI says so.

Supplying that stem is a queued job, not a synchronous one, so a separation finishes
*after* the analysis that would have used it. Separation therefore ends by queueing
a reanalysis of its own — otherwise the organization pays a provider for a stem and
the figures on screen never move off the 0.45 proxy. That reanalysis is additive
like every other: a new row, the previous one still readable, confirmed sections
carried forward. It is skipped in exactly one case — a newer version became current
while separation was running, which makes the stem a stem of the previous recording.
The stem is kept, so returning to that version finds it again.

**Energy** — a composite, not LUFS. Loudness 0.40, transient activity 0.20,
spectral spread 0.15, low-end weight 0.15, brightness 0.10. Normalized *within one
song*, so values compare sections to each other and never one song to another.

**Melodic register** — reported as a normalized band from voiced-frame spectral
centroids, never as note names. Deriving lead-vocal pitch from a full mix is not
reliable enough to print "your chorus tops out at G5". What is defensible is
whether two sections occupy the same register, which is the question that matters
for section contrast.

The band is measured per section over the raw analysis frames rather than the
pooled ones — a pool is three quarters of a second, long enough to average two
sung notes into one that was never sung — and reported as a 10th/50th/90th
percentile triple. A section with fewer than eight voiced frames reports `null`
throughout, at confidence 0.

The ceiling depends on what was measured. From a full mix there are two
independent doubts — whether the frames scored as voiced are the voice at all,
and whether a spectral centroid tracks sung pitch — and the confidence caps at
**0.5**. A separated vocal stem settles the first outright and leaves only the
second, so it caps at **0.7**: higher, but deliberately below the 0.85 that vocal
*detection* earns on a stem, because centroid is not pitch and no amount of
source separation makes it pitch. Either way the figure stays bounded by the
detection behind it, so a stem measured by a detector that found almost nothing
is not a confident register.

Section boundaries and section registers therefore come from **different
signals**. Boundaries are detected from the mix — an instrumental break is a
section change and a vocal stem is silent there, so a detector fed the stem
would lose it. The register of those sections is then re-measured against the
stem where one exists, by windowing the per-frame register curve the vocal
provider returns. A section the stem has nothing in keeps the mix band rather
than losing it: separation can drop a quiet passage the proxy still caught.

From the per-section bands the engine derives `verse_register`,
`chorus_register`, `chorus_register_lift`, `vocal_register_range` and
`peak_register_position`. The lift is the one the product speaks in: a chorus
that measures within 0.05 of the verse register raises *"low register contrast"* —
worded as a possible contributor to lower perceived section contrast, never as a
fault. Peak position is read from the section **tops** rather than the medians,
because the section a listener hears as the top of the song is the one that
reaches highest, not the one that sits highest on average.

**Melodic contour** — the voiced centroid resampled to eight points per section by
bucket mean, then peak-normalized into −1..1 around the window's own mean. That
normalization is the point: two choruses sung a tone apart trace the *same*
contour, so `contourSimilarity` answers "is this the same melodic shape" rather
than "is this the same register" — the register band already answers that. A
window with fewer than twelve voiced frames has no shape and returns an empty
contour; comparing against it yields `null`, never `0`, because "not measured" and
"completely different" are not the same statement.

`melodic_contour_repetition` averages the shape agreement between repeats of the
same section family — chorus to chorus, verse to verse — since that is where a
listener expects to recognize a melody.

## Providers

```ts
interface SongStructureProvider  { analyzeStructure(asset): Promise<StructureAnalysisResult> }
interface MusicFeatureProvider   { analyzeMusicFeatures(asset): Promise<MusicFeatureResult> }
interface VocalAnalysisProvider  { analyzeVocals(asset): Promise<VocalAnalysisResult> }
interface LyricAnalysisProvider  { analyzeLyrics(input): Promise<LyricAnalysisResult> }
interface AudioExperimentRenderer{ renderExperiment(input): Promise<AudioExperimentResult> }
interface BenchmarkProvider      { queryCohort(input): Promise<BenchmarkCohortResult> }
```

Two implementations ship for each analysis interface:

**`local-dsp`** — the in-process engine. Default, because it needs no credentials,
no network and no per-song cost, and because its methods are inspectable.

**`mock-song-analysis`** — deterministic, seeded from the source checksum. It exists
so the whole product flow is exercisable where the DSP path cannot run. It never
claims to have heard anything: every value is capped at **0.3** confidence and
carries the note *"synthesized by the deterministic analysis provider — not measured
from audio"*. Its structure sections are emitted at confidence **0**.

Registering a commercial MIR vendor is a change in `createSongLabLayer` and nothing
else.

## Decoding

WAV is decoded in pure TypeScript, so the diagnostic pipeline works on a clean
checkout with no native dependency. Anything else is transcoded by ffmpeg first.
If ffmpeg is unavailable for a compressed upload, that *file* falls back to the
deterministic provider and the substitution is recorded in the analysis provenance
— never hidden.

## Versioning and reanalysis

Every run stores engine version, model version, provider, date, configuration,
confidence and the source checksum. Reanalysis creates a **new** `song_analyses` row
and leaves the old one intact, so a result produced by an older engine stays
readable and comparable rather than being silently replaced.

Human-confirmed sections are carried forward: a user who corrected a boundary does
not have to correct it again after reanalysis.
