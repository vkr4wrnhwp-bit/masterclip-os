# Song Lab — Lyrics and Vocal Intelligence

## When lyrics are analysed

Only when the organization supplied them, or transcribed them from audio it
confirmed it controls. `lyricSource` records which — `user_supplied`,
`transcribed`, `time_coded`, `vocal_transcript` — because the rights position
differs.

A version with no lyric rows produces **no lyric analysis**. Not an empty analysis,
not an analysis full of zeroes: the API returns `analysis: null` with
*"No authorized lyrics are attached to this version."* Musical analysis never
requires lyrics.

Lyrics attach to a **version**, not an analysis, so an edited lyric belongs to the
song and survives reanalysis. Accepting an experiment carries the lyric onto the new
version.

## Getting the lyric in

Two ways, and the difference matters more than convenience:

| Route | Timings | Source | Confirmed |
| --- | --- | --- | --- |
| Pasted sheet | none, unless typed by hand | `user_supplied` | yes |
| Transcribed from the recording | per line, from the transcriber | `transcribed` | no |

```
POST /api/song-lab/projects/:id/lyrics/transcribe
```

Timings are the reason to transcribe. Syllables per second, per-section density
contrast and title placement in time are all functions of *when* a line lands,
so a pasted sheet leaves them unmeasured until someone types timecodes in by
hand. A transcript places every line inside a section on its own.

The words, though, are a machine's guess, and the system holds that line:

- Transcribed lines are stored as `transcribed`, never `user_supplied`, and land
  **unconfirmed**. Correcting a line is what promotes it.
- A segment the transcriber itself scores below 0.3 confidence is **dropped**
  rather than kept. A gap is honest; an invented line gets its syllables
  counted as though the record contained it.
- If nothing clears that bar the request fails with `song_lab.transcript_empty`
  rather than writing an empty lyric.

**It will not overwrite a lyric you supplied.** A lyric someone typed is the
artist's own words and a transcript is not an upgrade on it, so replacing one
takes a second, explicit decision (`replaceUserSupplied: true`) and the first
attempt refuses with `song_lab.lyrics_user_supplied`.

Transcription prefers a [separated vocal stem](#what-the-vocal-numbers-were-measured-from)
when one is ready for that exact recording — a transcriber hearing only the
voice makes far fewer mistakes than one picking words out of a full mix — and
the response says which it used.

Requires `audio.transcription` as well as Song Lab. Transcription is an Audio
Intelligence capability with its own retention and zero-retention rules, and it
runs through the platform's own transcription pipeline rather than a second
copy, so org policy, keyterms and usage accounting all apply unchanged.

## What is measured

Syllable counts · line lengths · phrase lengths · title placement · title
repetition · hook repetition · repeated phrases · rhyme placement · vowel density ·
consonant density · verse/chorus vocabulary overlap · question phrasing ·
first-person and second-person frequency · per-section lyric density.

Nothing here judges lyrical quality. That is not a measurable property.

## Syllable counting

A vowel-group heuristic with the exception rules that matter most in sung English:
silent terminal `e` ("time" is one), sounded `-le` after a consonant ("little" is
two), `-ed` only syllabic after `t`/`d` ("wanted" two, "walked" one), plus a table
of words the heuristic reliably gets wrong.

It is a heuristic and is labelled as one. Syllable **architecture** — whether one
line is much denser than another — survives a small per-word error; an absolute
claim about a single line would not. Lyric metrics are capped at 0.6 confidence in
the feature vector for exactly this reason.

## Syllable architecture

```
CHORUS
Line 1    11 syllables
Line 2    13 syllables
Line 3    12 syllables
Line 4    14 syllables

SELECTED COHORT
Median hook-line length: 7 syllables
```

> Your chorus uses substantially longer phrases than the selected comparison
> cohort. Try reducing one primary hook phrase to roughly 5–8 syllables and
> preserving more rhythmic space around it.

Fewer syllables are **not** universally better. This is a comparison against a
chosen group, not a rule.

## Title placement

```
TITLE APPEARS
Chorus 1:       1
Chorus 2:       1
Final Chorus:   1
TOTAL:          3

Selected Cohort Median: 4.1
```

A user's title mark is authoritative and outranks any detection: marking a line
sets `title_phrase = 1` and `user_confirmed = 1`, and clears every other line's
mark. Where the user has supplied a title phrase but marked nothing, containment
matching fills in — and only then, because matching against a title nobody gave us
would be guessing.

## Vocal density

Where vocals can be detected reliably: vocal occupancy, phrase duration, words and
syllables per second, rest duration, average and longest phrase, a held-note proxy,
and verse/chorus/hook/final-chorus density.

```
VERSE     8.2 syllables/sec   93% vocal occupancy
CHORUS    7.8 syllables/sec   89% vocal occupancy
```

> The chorus creates relatively little vocal-density contrast from the verse.

Options: reduce chorus syllable count · create a longer held vowel · insert space
before the title · repeat the title · add a response vocal · shorten one line.

All of these are writing and performance choices. None is generated here.

## What the vocal numbers were measured from

Every figure on this page is one of two very different things, and the analysis
says which:

| Basis | Method | Confidence |
| --- | --- | --- |
| `full_mix` | Infers where the voice is from band energy (roughly 200 Hz–2 kHz), tonality and centroid movement | capped ~0.45 |
| `isolated_stem` | Measures a separated lead vocal directly | ~0.85 |

The mix-based proxy is honest but limited, and limited in a way it cannot detect:
a dense guitar arrangement scores as vocal, and nothing in the signal tells the
detector it is wrong. Occupancy measured this way carries the note *"estimated
from the full mix, not an isolated vocal"* wherever it appears.

Separating the vocal replaces the inference with a measurement, so the
confidence rises — because the evidence got better, not because the number was
adjusted. The caveat is dropped only when it stops being true.

```
POST /api/song-lab/projects/:id/versions/:versionId/vocal-stem
```

Four things this deliberately does not do:

- **It is never automatic.** Separation spends the organization's provider
  budget. Song Lab is the diagnostic layer and does not spend an artist's money
  on its own initiative.
- **It requires `audio.stem_separation`**, not just Song Lab. Starting the
  action inside Song Lab does not make it a Song Lab capability.
- **It never guesses which stem is the vocal.** A provider that returns an
  archive, or stems whose names are not recognised, yields `unsupported` — a
  distinct outcome from `failed` — and the figures stay on the mix-based proxy.
- **It never touches the original.** The stem is a new derived asset, and the
  source checksum is pinned to it, so a stem is only ever measured against the
  recording it came from. An edited version has different audio and therefore no
  stem until one is separated for it.

If the stem exists but cannot be decoded, the analysis falls back to the mix and
reports `full_mix`. The failure mode worth guarding against is not the fallback
— it is falling back while still claiming stem-level confidence.

## Register and melodic shape

Reported as a normalized band from the spectral centroid of voiced frames, never as
note names, and capped by the vocal detector's own confidence — so a register
figure never outranks the detection it came from.

The cap follows the basis, exactly as the vocal figures above do: **0.5** from the
mix, **0.7** from a separated stem. Separation removes the doubt about *whether
those frames are the voice*; it does not make a spectral centroid into pitch, so
the stem ceiling stays below the 0.85 that detection itself earns. Sections are
still bounded from the mix — a vocal stem is silent through an instrumental break
— and only their registers are re-measured against the stem.

Measured **per section**, as a 10th/50th/90th percentile triple. From those bands
come the verse register, the chorus register, and the difference between them:

```
VERSE 1        ├──────▌────────┤          0.34
CHORUS 1          ├──────▌────────┤       0.38

Chorus register lift  +0.04
```

> The chorus occupies nearly the same vocal register as Verse 1, which may
> contribute to lower perceived section contrast.

Not: "your chorus is unsingable". Pitch alone does not support that judgement. The
observation is raised only when the lift measures under 0.05 *and* the register
was measured with enough confidence to stand behind — otherwise nothing is said,
because a finding drawn from a shaky measurement is worse than no finding.

Options: try the chorus melody a third or fourth higher · hold the top note longer ·
keep the verse lower so the chorus has somewhere to go. Writing and performance
choices, every one. Song Lab measures the register; it does not write the melody.

Alongside the band, a **melodic contour** — the voiced centroid resampled to eight
points and normalized to shape rather than absolute register, so two choruses sung
a tone apart trace the same contour. That separation is deliberate: the band
answers "the same area of the voice", the contour answers "the same melodic
shape", and a song can differ on one without differing on the other.

A section with too little voiced content has no band and no contour. Comparing
against it yields `null`, never `0` — "not measured" and "completely different"
are different statements, and only one of them is true.

## The provider seam

```ts
interface LyricAnalysisProvider {
  analyzeLyrics(input: LyricAnalysisInput): Promise<LyricAnalysisResult>
}
```

The heuristic implementation is the default. A language model could be registered
in its place for better syllable and rhyme accuracy — but the interface deliberately
takes lyrics as **input** rather than offering to write them. No implementation of
this interface is permitted to generate a lyric.
