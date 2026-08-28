# Studio — what is measured, and how

Every figure Mix Station reports carries its method and a confidence. This
document says what each one actually measures, and — more usefully — what it
does not.

The rule underneath all of it: **a measurement that could not be made is
`null`.** Not zero, not a default, not a plausible-looking estimate. A caller
reading a metric by key finds an honest gap and a note saying why.

---

## The single pass

`computeSpectrogram` walks the audio once, at the **source sample rate** and
not at Song Lab's fixed 22.05 kHz. Song Lab asks structural questions — where
the chorus is, how dense the arrangement is — which a downsampled signal
answers perfectly well. Mix Station asks where the harshness and the sibilance
are, and those live at 5–10 kHz: above the Nyquist of a 22.05 kHz analysis.
Downsampling first would make half these metrics unmeasurable while still
returning numbers.

Two decisions in that pass are worth knowing about:

**Spectra are averaged across channels in power, not taken from the mono sum.**
A mix with a strongly out-of-phase element partly cancels when summed, and a
mono-sum spectrogram reports that material as simply absent — the analyzer
going blind exactly where a mix has a problem worth finding. Phase behaviour is
the stereo analyzer's question. Spectral balance is a question about what the
record *contains*, and the answer must not depend on how it folds down.

**Band edges are rounded, not floored and ceiled.** Flooring a lower edge and
ceiling an upper one makes adjacent bands share a bin. On a record with a strong
55 Hz fundamental that double-count is enough to push the six band shares past
100 %, which makes every "x % of the energy" statement in the product wrong.
Rounded edges tile the spectrum exactly.

## Bands

| Band | Range |
|---|---|
| Sub | below 60 Hz |
| Low | 60–200 Hz |
| Low-mid | 200–600 Hz |
| Mid | 600 Hz–2 kHz |
| High-mid | 2–6 kHz |
| High | above 6 kHz |

Those six tile the whole spectrum and their shares sum to 100 %. Five further
bands overlap them for diagnosis only: kick (40–100), bass body (80–250), vocal
(300–3500), presence (2–5 k), sibilance (5–10 k) and air (above 10 k).

---

## The metrics

### Level

| Metric | Method | What it is not |
|---|---|---|
| Sample peak | Largest sample in the file | — (exact) |
| True peak | 4× Catmull-Rom oversampling | Not a certified meter. A polyphase implementation can read a few tenths higher. |
| Headroom | Derived from the true-peak estimate | Inherits that estimate's confidence. |
| Crest factor | Peak minus RMS over the whole record | — |

### Loudness and dynamics

Integrated loudness is gated block RMS — the two-stage BS.1770 gate, **without
K-weighting**. It is reported as an approximation and every surface that shows
it says ±1 LU. Studio is a diagnostic environment, not a compliance meter, and
pretending otherwise would be exactly the fake precision the product refuses.

`transient_retention` maps mean local crest (peak over RMS in 400 ms blocks)
onto 0–1, where 6 dB reads as 0 and 20 dB as 1. That mapping is a convention
this module owns, and the actual mean crest is printed alongside the figure.

### Stereo

Correlation is the mean of normalized cross-correlations over 250 ms blocks.
Blocks with no signal contribute nothing rather than a spurious +1, which would
flatten the curve and hide the real moments.

A "stereo" file whose channels are identical is reported as **a mono recording
in a stereo container** — a fact about the file — rather than as a width of
zero, which is a claim about the mix.

### Vocal — read this one carefully

`vocal_presence_index`, `vocal_level_stability` and `vocal_masking_index` are
measured from the **full-mix spectral proxy** unless an isolated vocal stem was
supplied. The proxy infers where the voice probably is from band energy. On a
dense guitar record it reads as vocal and it cannot tell.

Every one of those metrics carries its basis in its note, and their confidence
is capped at 0.45 without a stem (0.75 with one). Vocal masking is a
*co-occurrence* measure — accompaniment energy in the vocal's band at the same
moment — not a psychoacoustic masking model.

### Indices

`harshness_index`, `sibilance_index`, `midrange_congestion_index` and
`kick_bass_masking_index` are 0–1 composites with anchor points chosen by this
module. Each prints the raw figure it was derived from, so the mapping is
checkable rather than magic:

- **Harshness** is *sustained* 2–5 kHz weight. A bright snare is a transient; an
  abrasive record is a level. The two are different shapes and only the second
  scores.
- **Sibilance** is the opposite shape — brief excursions above the record's own
  median, not a fixed threshold, which is what keeps a naturally bright mix from
  scoring high.
- **Midrange congestion** multiplies band share by *steadiness*. A busy but
  moving midrange is an arrangement; a static one is a wall. Multiplying is what
  stops a dense-but-dynamic mix being flagged.

---

## Mix Doctor

Thresholds are the record's own median and percentiles. Regions are merged
across single-bucket dropouts — a four-second harsh passage measured in 500 ms
buckets dips below the threshold once or twice, and reporting it as three
separate findings is noise dressed as precision.

Findings are trimmed strongest-first (max 3 per type, 14 overall) then sorted
chronologically for display: an engineer works down the timeline, but the trim
has to keep what matters.

Clipping is one of the few things this module states rather than suspects —
samples pinned at full scale are a measurement, not an inference.

---

## Release Readiness

Eight bands: Dynamics, Low End, Midrange, High Frequency, Stereo Field,
Headroom, Competitive Loudness, Streaming Translation.

It is a **translation indicator**, and that is not a disclaimer bolted on at the
UI — it is what the scoring does. Every band scores how predictably the record
survives playback it was not mixed on. Nothing in it can distinguish a great
song from a dull one.

Two consequences:

- A band whose inputs could not be measured scores `null` and is excluded from
  the average. A mono file has no stereo field to be bad at.
- Scores are non-monotonic where the property is. A record can be too quiet
  *or* too crushed, and both cost the same band.

Below four scored bands, the overall figure is withheld entirely.

`Streaming Translation` is the one band that models what happens *after*
delivery: normalise to −14 LUFS, add encoder overshoot, and see whether the
result clips. That specific failure — a master that clips only after
normalisation — is what it exists to predict.

---

## Adding an analyzer

1. Declare the metric keys in `MIX_METRICS` (`packages/mix-analysis/src/types.ts`).
2. Write a `MixAnalyzer`: given the shared context, emit metrics and optionally
   curves.
3. Append it to `DEFAULT_MIX_ANALYZERS`.

No migration, no repository change, no UI change — metrics are rows keyed by
name and the UI labels anything it is handed from the catalogue. An analyzer
emitting an undeclared key is surfaced as a failure at analysis time rather than
becoming a mystery row.

Order in the list is presentation only. Analyzers never read each other's
output, which is what makes appending one safe.
