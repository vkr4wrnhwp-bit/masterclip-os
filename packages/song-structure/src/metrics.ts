import {
  HOOK_SECTION_TYPES,
  contourSimilarity,
  cosineSimilarity,
  mean,
  standardDeviation,
  type DetectedSection,
  type SectionFeatures,
  type SectionType,
} from '@masterclip/song-analysis'

/**
 * Structural metrics.
 *
 * Everything the benchmark engine compares about *shape* is computed here, from
 * the section list alone. It runs identically on machine-detected and
 * human-corrected structures, which is the point: after a user fixes a
 * boundary, every downstream figure moves with it.
 */

export interface StructuralMetrics {
  durationSeconds: number
  introSeconds: number | null
  firstVocalSeconds: number | null
  firstHookSeconds: number | null
  firstChorusSeconds: number | null
  firstVerseSeconds: number | null
  secondVerseSeconds: number | null
  chorusSeconds: number | null
  preChorusSeconds: number | null
  bridgePositionRatio: number | null
  outroSeconds: number | null
  chorusCount: number
  verseCount: number
  sectionCount: number
  uniqueSectionCount: number
  averageSectionSeconds: number
  sectionLengthVariance: number
  repetitionFrequency: number
  /** e.g. `intro-verse-pre_chorus-chorus-…`, the comparable shape signature. */
  sectionOrderPattern: string
  runtimeBeforeFirstRepeat: number | null
  runtimeAfterFinalHook: number | null
  chorusShare: number
  vocalOccupancy: number | null
  hookRepetition: number
  structuralSymmetry: number
}

export interface MetricsInput {
  sections: DetectedSection[]
  features: SectionFeatures[]
  durationMs: number
  /** From vocal analysis; the section list alone cannot know this. */
  firstVocalSeconds?: number | null
  vocalOccupancy?: number | null
}

export function structuralMetrics(input: MetricsInput): StructuralMetrics {
  const sections = [...input.sections].sort((a, b) => a.startMs - b.startMs)
  const durationSeconds = input.durationMs / 1000
  const seconds = (section: DetectedSection) => (section.endMs - section.startMs) / 1000
  const lengths = sections.map(seconds)

  const byType = (type: SectionType) => sections.filter((section) => section.sectionType === type)
  const choruses = sections.filter((section) => section.sectionType === 'chorus' || section.sectionType === 'final_chorus')
  const verses = byType('verse')
  const hooks = sections.filter((section) => HOOK_SECTION_TYPES.includes(section.sectionType))
  const preChoruses = byType('pre_chorus')
  const bridge = byType('bridge')[0] ?? null
  const outro = byType('outro')[0] ?? sections[sections.length - 1] ?? null
  const intro = sections[0]?.sectionType === 'intro' ? sections[0] : null

  const types = sections.map((section) => section.sectionType)
  const uniqueTypes = new Set(types)
  const repeated = types.filter((type, index) => types.indexOf(type) !== index).length

  const firstRepeatIndex = types.findIndex((type, index) => types.indexOf(type) !== index)
  const finalHook = hooks[hooks.length - 1] ?? null
  const chorusSpan = choruses.reduce((total, section) => total + seconds(section), 0)

  return {
    durationSeconds: round(durationSeconds),
    introSeconds: intro ? round(seconds(intro)) : null,
    firstVocalSeconds: input.firstVocalSeconds ?? null,
    firstHookSeconds: hooks[0] ? round(hooks[0].startMs / 1000) : null,
    firstChorusSeconds: choruses[0] ? round(choruses[0].startMs / 1000) : null,
    firstVerseSeconds: verses[0] ? round(seconds(verses[0])) : null,
    secondVerseSeconds: verses[1] ? round(seconds(verses[1])) : null,
    chorusSeconds: choruses.length > 0 ? round(mean(choruses.map(seconds))) : null,
    preChorusSeconds: preChoruses.length > 0 ? round(mean(preChoruses.map(seconds))) : null,
    bridgePositionRatio: bridge && durationSeconds > 0 ? round(bridge.startMs / 1000 / durationSeconds) : null,
    outroSeconds: outro ? round(seconds(outro)) : null,
    chorusCount: choruses.length,
    verseCount: verses.length,
    sectionCount: sections.length,
    uniqueSectionCount: uniqueTypes.size,
    averageSectionSeconds: lengths.length > 0 ? round(mean(lengths)) : 0,
    sectionLengthVariance: lengths.length > 1 ? round(standardDeviation(lengths) / Math.max(1, mean(lengths))) : 0,
    repetitionFrequency: sections.length > 0 ? round(repeated / sections.length) : 0,
    sectionOrderPattern: types.join('-'),
    runtimeBeforeFirstRepeat: firstRepeatIndex >= 0 && sections[firstRepeatIndex] ? round(sections[firstRepeatIndex]!.startMs / 1000) : null,
    runtimeAfterFinalHook: finalHook ? round(Math.max(0, durationSeconds - finalHook.endMs / 1000)) : null,
    chorusShare: durationSeconds > 0 ? round((chorusSpan / durationSeconds) * 100) : 0,
    vocalOccupancy: input.vocalOccupancy ?? null,
    hookRepetition: hooks.length,
    structuralSymmetry: symmetry(lengths),
  }
}

/**
 * How evenly section lengths mirror across the midpoint. A verse-chorus song
 * with matching halves scores near 1; a through-composed one scores low.
 * Neither is better — the figure exists to be compared with a cohort.
 */
function symmetry(lengths: number[]): number {
  if (lengths.length < 2) return 0
  const half = Math.floor(lengths.length / 2)
  const front = lengths.slice(0, half)
  const back = lengths.slice(lengths.length - half).reverse()
  let deviation = 0
  for (let i = 0; i < half; i++) {
    const a = front[i]!
    const b = back[i]!
    const scale = Math.max(a, b, 1)
    deviation += Math.abs(a - b) / scale
  }
  return round(Math.max(0, 1 - deviation / Math.max(1, half)))
}

export interface SectionContrast {
  fromOrderIndex: number
  toOrderIndex: number
  fromLabel: string
  toLabel: string
  /** 0–1 cosine similarity over the section similarity vectors. */
  similarity: number
  energyDelta: number
  spectralDelta: number
  vocalDelta: number | null
  stereoWidthDelta: number | null
  lowFrequencyDelta: number
  transientDelta: number
  arrangementDelta: number
  rhythmicDelta: number
  /** Change in vocal register band. Null when either section has no measured register. */
  registerDelta: number | null
  /** 0–1 melodic-shape agreement. Null when either section has no comparable contour. */
  contourSimilarity: number | null
}

/** Consecutive-section contrast — the "does anything change here?" measure. */
export function sectionContrasts(sections: DetectedSection[], features: SectionFeatures[]): SectionContrast[] {
  const out: SectionContrast[] = []
  for (let i = 1; i < sections.length; i++) {
    const previous = features[i - 1]
    const current = features[i]
    if (!previous || !current) continue
    out.push(contrastBetween(sections[i - 1]!, previous, sections[i]!, current))
  }
  return out
}

/** Contrast between any two sections, consecutive or not (chorus 1 → chorus 2). */
export function contrastBetween(
  fromSection: DetectedSection,
  fromFeatures: SectionFeatures,
  toSection: DetectedSection,
  toFeatures: SectionFeatures,
): SectionContrast {
  return {
    fromOrderIndex: fromSection.orderIndex,
    toOrderIndex: toSection.orderIndex,
    fromLabel: fromSection.label,
    toLabel: toSection.label,
    similarity: round(Math.max(0, cosineSimilarity(fromFeatures.similarityVector, toFeatures.similarityVector))),
    energyDelta: round(toFeatures.energy - fromFeatures.energy),
    spectralDelta: round(toFeatures.spectralDensity - fromFeatures.spectralDensity),
    vocalDelta:
      fromFeatures.vocalOccupancy === null || toFeatures.vocalOccupancy === null
        ? null
        : round(toFeatures.vocalOccupancy - fromFeatures.vocalOccupancy),
    stereoWidthDelta:
      fromFeatures.stereoWidth === null || toFeatures.stereoWidth === null ? null : round(toFeatures.stereoWidth - fromFeatures.stereoWidth),
    lowFrequencyDelta: round(toFeatures.lowFrequencyDensity - fromFeatures.lowFrequencyDensity),
    transientDelta: round(toFeatures.transientDensity - fromFeatures.transientDensity),
    arrangementDelta: round(toFeatures.arrangementDensity - fromFeatures.arrangementDensity),
    rhythmicDelta: round(toFeatures.rhythmicDensity - fromFeatures.rhythmicDensity),
    registerDelta:
      fromFeatures.register.median === null || toFeatures.register.median === null
        ? null
        : round(toFeatures.register.median - fromFeatures.register.median),
    contourSimilarity: contourSimilarity(fromFeatures.melodicContour, toFeatures.melodicContour),
  }
}

/** Pairs of same-type sections, for "chorus 2 is 94% similar to chorus 1". */
export function repeatedSectionContrasts(sections: DetectedSection[], features: SectionFeatures[]): SectionContrast[] {
  const out: SectionContrast[] = []
  const groups = new Map<string, number[]>()
  for (const section of sections) {
    // Final chorus is compared against the chorus family it belongs to.
    const family = section.sectionType === 'final_chorus' ? 'chorus' : section.sectionType
    const list = groups.get(family) ?? []
    list.push(section.orderIndex)
    groups.set(family, list)
  }
  for (const indices of groups.values()) {
    for (let i = 1; i < indices.length; i++) {
      const from = sections.find((section) => section.orderIndex === indices[i - 1])
      const to = sections.find((section) => section.orderIndex === indices[i])
      const fromFeatures = features[indices[i - 1]!]
      const toFeatures = features[indices[i]!]
      if (from && to && fromFeatures && toFeatures) out.push(contrastBetween(from, fromFeatures, to, toFeatures))
    }
  }
  return out
}

/** Mean absolute energy change between consecutive sections. */
export function dynamicContrast(features: SectionFeatures[]): number {
  if (features.length < 2) return 0
  const deltas: number[] = []
  for (let i = 1; i < features.length; i++) deltas.push(Math.abs(features[i]!.energy - features[i - 1]!.energy))
  return round(mean(deltas))
}

/** Energy gain from the verses into the choruses. Null when either is absent. */
export function chorusEnergyLift(sections: DetectedSection[], features: SectionFeatures[]): number | null {
  const energyOf = (type: SectionType[]) =>
    sections.filter((section) => type.includes(section.sectionType)).map((section) => features[section.orderIndex]?.energy ?? 0)
  const verses = energyOf(['verse'])
  const choruses = energyOf(['chorus', 'final_chorus'])
  if (verses.length === 0 || choruses.length === 0) return null
  return round(mean(choruses) - mean(verses))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
