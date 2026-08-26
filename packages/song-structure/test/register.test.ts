import { describe, expect, it } from 'vitest'
import { emptyRegister, type DetectedSection, type SectionFeatures } from '@masterclip/song-analysis'
import { contrastBetween, contourRepetition, registerBands, registerMetrics, rhythmicContrast, sectionContrasts } from '../src/index.js'

/**
 * Melodic and register metrics.
 *
 * The properties pinned here are the ones the product's language depends on:
 * a register that was not measured never becomes a number, a lift is computed
 * across the structure the user currently has, and shape comparison is about
 * shape rather than absolute register.
 */

function section(type: string, label: string, index: number, startMs: number, endMs: number): DetectedSection {
  return { sectionType: type as DetectedSection['sectionType'], label, startMs, endMs, confidence: 0.7, orderIndex: index }
}

function features(overrides: Partial<SectionFeatures> = {}): SectionFeatures {
  return {
    energy: 0.5,
    vocalOccupancy: 0.8,
    arrangementDensity: 0.5,
    spectralDensity: 0.5,
    transientDensity: 0.5,
    lowFrequencyDensity: 0.4,
    stereoWidth: 0.2,
    rhythmicDensity: 0.5,
    similarityVector: [0.5, 0.4, 0.4, 0.3, 0.5, 0.8, 0.2],
    register: emptyRegister(),
    melodicContour: [],
    ...overrides,
  }
}

function withRegister(median: number, contour: number[] = [], rhythmicDensity = 0.5): SectionFeatures {
  return features({
    register: { median, low: median - 0.08, high: median + 0.1, confidence: 0.45 },
    melodicContour: contour,
    rhythmicDensity,
  })
}

const VERSE_CONTOUR = [-0.7, -0.3, 0.2, 0.7, 0.4, -0.1, -0.5, -0.9]
const CHORUS_CONTOUR = [0.8, 0.4, -0.1, -0.6, 0.7, 0.3, -0.2, -0.8]

describe('register metrics', () => {
  const sections = [
    section('intro', 'Intro', 0, 0, 13_000),
    section('verse', 'Verse 1', 1, 13_000, 42_000),
    section('chorus', 'Chorus 1', 2, 42_000, 70_000),
    section('verse', 'Verse 2', 3, 70_000, 99_000),
    section('chorus', 'Chorus 2', 4, 99_000, 127_000),
    section('outro', 'Outro', 5, 127_000, 140_000),
  ]

  it('computes the chorus lift across the verses and choruses only', () => {
    const metrics = registerMetrics(sections, [
      features(),
      withRegister(0.3),
      withRegister(0.5),
      withRegister(0.32),
      withRegister(0.52),
      features(),
    ])
    expect(metrics.verseRegister).toBeCloseTo(0.31, 3)
    expect(metrics.chorusRegister).toBeCloseTo(0.51, 3)
    expect(metrics.chorusRegisterLift).toBeCloseTo(0.2, 3)
  })

  it('reports no lift rather than zero when the choruses have no measured register', () => {
    const metrics = registerMetrics(sections, [features(), withRegister(0.3), features(), withRegister(0.32), features(), features()])
    expect(metrics.chorusRegister).toBeNull()
    // The distinction the product rests on: "not measured", never "no lift".
    expect(metrics.chorusRegisterLift).toBeNull()
  })

  it('returns nothing measurable for a song with no detected vocal at all', () => {
    const metrics = registerMetrics(sections, sections.map(() => features()))
    expect(metrics.verseRegister).toBeNull()
    expect(metrics.chorusRegister).toBeNull()
    expect(metrics.vocalRegisterRange).toBeNull()
    expect(metrics.peakRegisterPosition).toBeNull()
    expect(metrics.confidence).toBe(0)
  })

  it('takes its confidence from the weakest register it was built from', () => {
    const weak = withRegister(0.5)
    weak.register.confidence = 0.1
    const metrics = registerMetrics(sections, [features(), withRegister(0.3), weak, withRegister(0.32), withRegister(0.52), features()])
    expect(metrics.confidence).toBe(0.1)
  })

  it('places the peak register by the highest section top, not the highest median', () => {
    // Chorus 2 has the lower median but reaches higher, which is the section a
    // listener hears as the top of the song.
    const chorus2 = withRegister(0.4)
    chorus2.register.high = 0.9
    const metrics = registerMetrics(sections, [features(), withRegister(0.3), withRegister(0.5), withRegister(0.32), chorus2, features()])
    expect(metrics.peakRegisterPosition).toBeCloseTo(99_000 / 140_000, 2)
  })

  it('measures contour repetition between repeats of the same section family', () => {
    const nearlyIdentical = CHORUS_CONTOUR.map((value) => value + 0.02)
    const repetition = contourRepetition(sections, [
      features(),
      withRegister(0.3, VERSE_CONTOUR),
      withRegister(0.5, CHORUS_CONTOUR),
      withRegister(0.32, VERSE_CONTOUR),
      withRegister(0.52, nearlyIdentical),
      features(),
    ])
    expect(repetition).not.toBeNull()
    expect(repetition!).toBeGreaterThan(0.95)
  })

  it('reports no contour repetition rather than zero when no repeat has a shape', () => {
    expect(contourRepetition(sections, sections.map(() => features()))).toBeNull()
  })

  it('measures rhythmic contrast as mean absolute change between consecutive sections', () => {
    const contrast = rhythmicContrast(sections.slice(0, 3), [
      withRegister(0.3, [], 0.2),
      withRegister(0.3, [], 0.5),
      withRegister(0.3, [], 0.9),
    ])
    // |0.5 − 0.2| and |0.9 − 0.5| average to 0.35.
    expect(contrast).toBeCloseTo(0.35, 3)
  })
})

describe('register in section contrast', () => {
  it('carries the register delta and the shape agreement between two sections', () => {
    const verse = section('verse', 'Verse 1', 0, 0, 30_000)
    const chorus = section('chorus', 'Chorus 1', 1, 30_000, 60_000)
    const contrast = contrastBetween(verse, withRegister(0.3, VERSE_CONTOUR), chorus, withRegister(0.52, CHORUS_CONTOUR))

    expect(contrast.registerDelta).toBeCloseTo(0.22, 3)
    expect(contrast.contourSimilarity).not.toBeNull()
    // Different shapes: the agreement must not read as a match.
    expect(contrast.contourSimilarity!).toBeLessThan(0.7)
  })

  it('reports the register delta as unmeasured when either side has no register', () => {
    const verse = section('verse', 'Verse 1', 0, 0, 30_000)
    const instrumental = section('instrumental', 'Instrumental', 1, 30_000, 60_000)
    const contrast = contrastBetween(verse, withRegister(0.3, VERSE_CONTOUR), instrumental, features())

    expect(contrast.registerDelta).toBeNull()
    expect(contrast.contourSimilarity).toBeNull()
  })

  it('includes the rhythmic delta alongside the other arrangement deltas', () => {
    const sections = [section('verse', 'Verse 1', 0, 0, 30_000), section('chorus', 'Chorus 1', 1, 30_000, 60_000)]
    const contrast = sectionContrasts(sections, [features({ rhythmicDensity: 0.3 }), features({ rhythmicDensity: 0.75 })])[0]!
    expect(contrast.rhythmicDelta).toBeCloseTo(0.45, 3)
  })
})

describe('register bands', () => {
  it('returns a row per section in time order, marking the hooks', () => {
    const sections = [
      section('verse', 'Verse 1', 1, 13_000, 42_000),
      section('intro', 'Intro', 0, 0, 13_000),
      section('chorus', 'Chorus 1', 2, 42_000, 70_000),
    ]
    const bands = registerBands(sections, [features(), withRegister(0.3, VERSE_CONTOUR), withRegister(0.5, CHORUS_CONTOUR)])

    expect(bands.map((band) => band.label)).toEqual(['Intro', 'Verse 1', 'Chorus 1'])
    expect(bands[0]!.median).toBeNull()
    expect(bands[0]!.isHook).toBe(false)
    expect(bands[2]!.isHook).toBe(true)
    expect(bands[2]!.contour).toEqual(CHORUS_CONTOUR)
  })
})
