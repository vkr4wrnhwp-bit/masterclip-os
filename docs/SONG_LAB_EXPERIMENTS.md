# Song Lab — What If? Experiments

## The guarantee

**The original audio is never modified.** Not overwritten, not re-encoded, not
touched.

This is structural rather than procedural:

- an experiment stores an **edit decision list**, not audio;
- the renderer reads the source and writes a **new** asset — it has no API that can
  write back to a source;
- accepting an experiment creates a **new version** whose parent is the source
  version, and points the project at it. The original stays playable, analysable and
  downloadable afterwards;
- rejecting an experiment changes only the experiment row.

A test reads the source bytes before and after a render and asserts they are
byte-identical.

## The edit decision list

```ts
interface ExperimentEdit {
  type: 'remove_range' | 'duplicate_range' | 'move_range'
      | 'time_stretch' | 'insert_silence' | 'gain_change' | 'stem_mute'
  sourceStartMs?: number
  sourceEndMs?: number
  destinationMs?: number
  value?: number      // stretch ratio | dB | silence duration
  stem?: string
  note?: string
}
```

All times are on the **source** timeline. An edit never refers to a position in its
own output, which would make the list order-dependent and unreadable.

Because the list is what is stored, an experiment can be re-rendered, inspected,
reversed or compared long after the preview bytes have expired.

## Validation

`validateEdl` runs before an experiment is persisted, so a stored list is always
renderable. It refuses an empty list, more than 64 edits, a range outside the
recording, a range under 50 ms, a destination outside the source, a time stretch
outside 0.7×–1.35×, silence outside 1 ms–30 s, gain outside −60 dB–+12 dB, edits
that would remove the entire recording, and a **stem mute where the project has no
such stem** — offering an edit that would promise audio the system cannot produce.

## Projection

`projectEdl` applies the list on paper: the predicted runtime and a source→output
segment map. It is used both to show the artist the new runtime *before* anything is
rendered and by the renderer to build its filter graph — one implementation, so the
preview and the prediction cannot disagree.

`mapSourceToOutput` carries section markers across an edit, and returns `null` for a
position that was cut. "This moment is gone" is the answer, not zero.

## The builders

| Experiment | What it does |
|---|---|
| Earlier chorus | Removes bars from the **end** of the section before the chorus — cutting the start would remove that section's own entrance |
| Shorter intro | Trims from the front, keeping the final bars so the handover still resolves |
| Section cut | Removes from a section's tail, never more than two-thirds of it |
| Section duplicate | Repeats a section immediately after itself |
| Tempo | Pitch-preserving stretch; ratio is target ÷ current, so the output plays at the target BPM |
| Alternate outro | Drops the tail, optionally repeating the final hook to hold a comparable runtime |

Cuts snap to whole bars wherever tempo and meter are solid enough to use. An edit
that lands off the bar is not a musical experiment — it is a glitch the artist will
rightly dismiss without hearing the idea. Where meter is unknown, the builder falls
back to plain seconds rather than cutting on a bar line that may not exist.

A builder returns `null` when the structure does not contain the section it needs,
and the API reports that plainly instead of producing something arbitrary.

## Rendering

**`FfmpegExperimentRenderer`** builds one filter graph: each kept span becomes a
trimmed stream, spans are concatenated in order, and a tempo experiment applies
`atempo`, chained where the ratio exceeds a single stage's 0.5–2.0 range. `atempo`
preserves pitch, which is the entire point of a tempo experiment.

**`PlaceholderExperimentRenderer`** takes over where ffmpeg is unavailable. The
experiment is still created, stored and compared, and its predicted timings are
real — but the preview is a short silent WAV and `placeholder: true` travels with
it, so the UI says *"Audio rendering is unavailable on this deployment"* rather than
playing silence and letting the artist think that is their edit.

**A placeholder preview cannot be accepted.** Accepting one would adopt a silent
file as a version of the song and let its meaningless measurements become the
project's headline figures. An artist cannot accept a version they were never able
to hear. The edit list survives; the experiment becomes acceptable the moment it
renders for real.

**`ResilientExperimentRenderer`** is what the layer actually registers. Whether
ffmpeg exists cannot be known when the layer is composed — the API and worker start
long before anything renders — so it resolves the best available renderer on first
use and caches the choice. A missing binary is a deployment fact, not a reason to
dead-letter an artist's experiment. Once a real renderer is selected, its failures
propagate normally: the fallback exists for a missing binary, not to paper over a
broken edit.

## After acceptance

The accepted version is a different recording — shorter, faster, or rearranged — so
analysis of it is queued automatically. Without that, a Version A → Version B
comparison would have measurements on one side only, which is exactly the comparison
the artist accepted the experiment in order to make.

```
VERSION A → VERSION B
Runtime          3:47 → 3:31
First Chorus     0:56 → 0:42
Tempo            92 → 96 BPM
Verse 1          43 → 29 sec
```

## A/B playback

Both sources stay loaded; switching swaps which one is audible while preserving
position (clamped, since an edited version can be shorter). The comparison is
between two arrangements, not between two moments. The original is always one click
away.

## Not this

Experiments do not invent melodies, voices, lyrics or arrangement elements. Where an
observation calls for one — "introduce a new element in Chorus 2" — it is marked
`experimentSupported: false` and shown as a producer note. Generative work belongs
to Remix Lab, behind its own entitlement and its own consent.
