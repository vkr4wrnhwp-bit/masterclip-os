# Song Lab — Producer View

A deeper mode for producers, engineers and advanced users. Artist View and Producer
View read the **same measurements**; the difference is how much is shown, not what
was computed.

## What it adds

Every raw feature with its **value, confidence band, analysis method, provider and
model version** — plus the note attached to any figure that carries a caveat.

```
Feature                  Value            Confidence   Method                        Provider
Tempo                    92 BPM           HIGH         onset_autocorrelation         local-dsp 1.0.0
Key                      E minor          MODERATE     krumhansl_schmuckler          local-dsp 1.0.0
                         next closest: G major
Integrated loudness      −9.4 LUFS        MODERATE     gated_block_rms               local-dsp 1.0.0
                         approximate programme loudness, not a BS.1770 measurement
Stereo width             not enough info  NOT ENOUGH   side_mid_energy_ratio         local-dsp 1.0.0
                         the source is mono, so it has no stereo field to measure
```

Also: section boundaries with confidence, chord-change rate (as a rate, not chord
symbols), melodic range, vocal register, spectral density, transient density,
dynamic range, low-frequency density, vocal occupancy, arrangement density, section
similarity, repetition index, transition strength, loudness progression,
silence/rest architecture, and stem-level analysis where stems exist.

## The register panel

Producer View draws the vocal register as a **band per section** rather than a
single value, because the low-to-high span is the part a producer reads: two
sections whose medians differ but whose bands overlap completely are, to a
listener, the same part of the voice.

```
INTRO           not enough information                       —
VERSE 1         ├──────▌────────┤                          0.34
PRE-CHORUS 1              ├──────▌────────┤                0.41
CHORUS 1            ├──────▌────────┤                      0.38
BRIDGE                             ├──────▌────────┤       0.52
FINAL CHORUS               ├──────▌────────┤               0.44

Verse register 0.345 · Chorus register 0.403 · Chorus lift +0.058 · Contour repetition 96%
```

Alongside it, the melodic contours as sparklines — the raw shape, since Producer
View is the mode where a shape is more useful than a summary number. Sections with
too little voiced content to have a shape are listed rather than hidden: a gap in
the grid is information about the record.

The panel refuses to render a scale when nothing was measured. A song with no
detectable lead vocal shows one line — *no lead vocal was detected reliably enough
to measure a register* — and no bands.

## Provenance

The engine version, the source checksum, and each stage's provider and model
version. Enough to answer "why does this run disagree with the one from March?"
without guessing.

## Why the split

An experienced engineer immediately wants to check a number, so Producer View shows
every method. An artist deciding whether to shorten a verse does not, so Artist View
shows plain English:

> Your first chorus arrives later than most songs in the comparison group.

not

> Structural temporal deviation z-score = 1.82.

Burying forty raw features in front of an artist is how a diagnostic tool stops
being usable. Hiding them from a producer is how it stops being trusted.

## Deliberately absent

**Chord symbols.** Naming chords from a mixed master is unreliable enough that
Producer View shows the *rate* of harmonic change, which is defensible, rather than
a chart that would look authoritative and be wrong.

**Absolute pitch claims.** Vocal register is a normalized band, not note names, and
the melodic contour is normalized to shape rather than kept in absolute terms. The
band answers "the same area of the voice"; the contour answers "the same melodic
shape". Neither answers "which note", and neither pretends to.

**A single quality score.** Hook Intelligence is a nine-row profile, not a number.
Compressing nine independent measurements with different confidences into one
figure would hide exactly the disagreements worth looking at.
