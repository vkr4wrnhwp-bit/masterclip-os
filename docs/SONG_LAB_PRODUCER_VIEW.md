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

**Absolute pitch claims.** Vocal register is a normalized band, not note names.

**A single quality score.** Hook Intelligence is a seven-row profile, not a number.
Compressing seven independent measurements with different confidences into one
figure would hide exactly the disagreements worth looking at.
