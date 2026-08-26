# Song Lab — Structure

## Detection

Two stages, in the order a listener would use:

1. **Where do things change** — a self-similarity matrix over per-pool timbre and
   energy descriptors (chroma, band shares, flatness, energy, vocal share), then a
   Foote checkerboard novelty curve. Peaks are candidate boundaries, chosen
   greedily strongest-first with a six-second minimum section length, and snapped
   to the nearest detected beat within 250 ms.

2. **What is each part** — segments are agglomerated by descriptor similarity, and
   the clusters are assigned musical roles from position, energy, repetition and
   vocal presence.

Stage 2 is inference about *convention*, not measurement, and the confidence it
reports says so:

| Assignment | Confidence | Why |
|---|---|---|
| Chorus, verse | 0.40–0.80 | Scaled by how many times the cluster recurs |
| Intro, outro | 0.60 | Position is strong evidence |
| Pre-chorus, bridge | 0.35 | Inferred from position alone |
| Everything else | 0.30 | |

Overall segmentation confidence combines how sharply the novelty peaks stand out
with whether the section count is musically plausible (1–6 per minute), and is
capped at 0.85.

## The vocabulary

`intro` · `verse` · `pre_chorus` · `chorus` · `post_chorus` · `hook` · `bridge` ·
`break` · `drop` · `instrumental` · `solo` · `breakdown` · `final_chorus` ·
`outro` · `custom`

The last chorus becomes `final_chorus` when more than one chorus exists — it is the
section every "does it evolve?" question is about.

## Correction

The timeline is editable. A user can correct boundaries, rename, merge (delete),
split (add), mark the actual hook and mark the title phrase.

Anything a user touches is stamped `human_confirmed = 1` with `confidence = 1`.
That flag is authoritative:

- structural metrics are recomputed immediately from the corrected structure, so
  every benchmark and observation downstream reflects what the user said the song is;
- the vector's structural half is rewritten with provider `human-confirmed`;
- **reanalysis preserves it.** A fresh detection is overlaid: confirmed boundaries
  win outright, detected sections overlapping one are dropped, and detected sections
  in the gaps are kept — so a user who corrected two boundaries still benefits from a
  better detector everywhere else.

Both the machine-detected and the human-confirmed structure are visible: the
timeline marks confirmed sections, and the confidence column shows which are which.

## Structural metrics

Intro duration · time to first vocal · time to first hook · time to first chorus ·
verse durations · pre-chorus durations · chorus durations · bridge placement ·
outro duration · chorus count · verse count · section count · unique section count ·
average section length · section-length variance · repetition frequency ·
section-order pattern · runtime before first repeat · runtime after final hook ·
chorus share of runtime · vocal occupancy · structural symmetry.

`structural_symmetry` measures how evenly section lengths mirror across the
midpoint. A verse-chorus song with matching halves scores near 1; a
through-composed one scores low. **Neither is better** — the figure exists to be
compared with a cohort.

## Contrast

Consecutive-section contrast answers "does anything change here?". Repeated-section
contrast answers "is chorus 2 the same as chorus 1?" — cosine similarity over the
seven-element section similarity vector, plus per-dimension deltas for energy,
spectral balance, vocal occupancy, stereo width, low frequency, transients,
rhythmic density, arrangement density and **vocal register**, and the melodic-shape
agreement between the two sections.

Two of those are nullable and stay that way. A section with no measured register
reports a register delta of `null`, and a section with too little voiced content to
have a melodic shape reports a contour similarity of `null` — never `0`, which
would read as "completely different" rather than "not measured".

Similarity at or above **88%** between two repeats raises a *Low section contrast*
observation. It is measured directly from the audio rather than against a cohort,
so it carries higher confidence (0.6) than a cohort-relative finding — and it is a
note for a producer, not something the engine can render.

A verse-to-chorus register lift under **0.05** raises a *Low register contrast*
observation on the same basis: measured from this recording alone, worded as a
possible contributor to lower perceived section contrast, and never rendered —
a melody is a writing and performance decision.

## Build Intelligence

Transitions **into** chorus, final chorus, drop, bridge, breakdown, outro and
post-chorus are scored on how much arrangement change the listener is actually
given at that moment: energy delta ×1.6, transient delta ×1.2, low-frequency delta
×1.0, spectral delta ×0.6, vocal delta ×0.8, stereo-width delta ×0.6, plus up to
0.3 for near-silence immediately before the section.

Bands: `strong ≥ 0.55` · `moderate ≥ 0.28` · `minimal` below.

It measures the transition. It does not decide whether the transition is good — a
deliberately flat entry into a chorus is a valid choice, and the output distinguishes
"we found nothing" from "we found something you may have meant".

Ideas offered for a minimal build: remove the kick for four bars, increase
subdivision across the final two bars, drop the bass on the last beat, insert a
brief pause, delay full stereo width. **Where separated stems exist** some of these
can be rendered as listening experiments; where they do not, the suggestion is
offered as a suggestion, and the UI says which.

## Chant Finder

Looks for sections that already have what a crowd needs: room in the vocal
(weighted 0.35), a strong downbeat (0.25), harmonic simplicity (0.20) and
repetition (0.20). Below 0.45 nothing is reported — inventing an opportunity would
be noise dressed as insight.

It suggests **rhythmic shapes first**:

```
Four-Syllable Pattern     DA — DA — DA — DA
Call / Response           LEAD PHRASE ↓ 4-BEAT GROUP RESPONSE
Title Chant               TITLE / TITLE / REST / TITLE
Two-Beat Answer           — — DA DA
```

Words are the artist's. Song Lab measures where the syllables could sit; it does
not write them.
