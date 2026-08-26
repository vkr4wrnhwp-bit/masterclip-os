import {
  HOOK_SECTION_TYPES,
  contourSimilarity,
  mean,
  type DetectedSection,
  type SectionFeatures,
  type SectionType,
} from '@masterclip/song-analysis'

/**
 * Melodic and register analysis.
 *
 * The question a producer actually asks is not "what note is that" — it is
 * "does the chorus go anywhere the verse did not". That is answerable from a
 * normalized register band and a normalized melodic shape without transcribing
 * a melody out of a full mix, and it is the only question answered here.
 *
 * Everything in this module is nullable on purpose. A record with no detectable
 * lead vocal, an instrumental, or a section too short to contain a phrase all
 * produce `null` rather than a plausible-looking number, and the UI says "not
 * enough information" rather than inventing a range.
 */

export interface RegisterMetrics {
  /** Span between the lowest low and the highest high across voiced sections. */
  vocalRegisterRange: number | null
  /** Median register across verses, and across choruses. */
  verseRegister: number | null
  chorusRegister: number | null
  /** Chorus register minus verse register. Positive means the chorus sits higher. */
  chorusRegisterLift: number | null
  /** Where the highest-register section starts, as a fraction of runtime. */
  peakRegisterPosition: number | null
  /** Mean melodic-shape agreement between repeats of the same section type, 0–1. */
  melodicContourRepetition: number | null
  /** Mean absolute rhythmic-density change between consecutive sections. */
  rhythmicContrast: number | null
  /** Lowest confidence among the register measurements this was built from. */
  confidence: number
}

const VERSE_TYPES: SectionType[] = ['verse']
const CHORUS_TYPES: SectionType[] = ['chorus', 'final_chorus']

export function registerMetrics(sections: DetectedSection[], features: SectionFeatures[]): RegisterMetrics {
  const ordered = [...sections].sort((a, b) => a.startMs - b.startMs)
  const featureOf = (section: DetectedSection) => features[section.orderIndex]
  const voiced = ordered.filter((section) => featureOf(section)?.register.median !== null && featureOf(section)?.register.median !== undefined)

  const empty: RegisterMetrics = {
    vocalRegisterRange: null,
    verseRegister: null,
    chorusRegister: null,
    chorusRegisterLift: null,
    peakRegisterPosition: null,
    melodicContourRepetition: contourRepetition(ordered, features),
    rhythmicContrast: rhythmicContrast(ordered, features),
    confidence: 0,
  }
  if (voiced.length === 0) return empty

  const lows = voiced.map((section) => featureOf(section)!.register.low).filter((value): value is number => value !== null)
  const highs = voiced.map((section) => featureOf(section)!.register.high).filter((value): value is number => value !== null)

  const verseRegister = medianRegisterOf(voiced, features, VERSE_TYPES)
  const chorusRegister = medianRegisterOf(voiced, features, CHORUS_TYPES)

  // The peak is read from the section highs rather than the medians: a chorus
  // whose top note is the highest in the song is the one that "goes somewhere",
  // even when its median sits with the verses.
  const peak = voiced.reduce<{ section: DetectedSection; high: number } | null>((best, section) => {
    const high = featureOf(section)!.register.high
    if (high === null) return best
    return !best || high > best.high ? { section, high } : best
  }, null)
  const total = ordered[ordered.length - 1]?.endMs ?? 0

  return {
    vocalRegisterRange: lows.length > 0 && highs.length > 0 ? round(Math.max(...highs) - Math.min(...lows)) : null,
    verseRegister,
    chorusRegister,
    chorusRegisterLift: verseRegister === null || chorusRegister === null ? null : round(chorusRegister - verseRegister),
    peakRegisterPosition: peak && total > 0 ? round(peak.section.startMs / total) : null,
    melodicContourRepetition: contourRepetition(ordered, features),
    rhythmicContrast: rhythmicContrast(ordered, features),
    // The weakest link decides: a lift computed from two low-confidence bands
    // is a low-confidence lift, whatever the arithmetic looks like.
    confidence: Math.min(...voiced.map((section) => featureOf(section)!.register.confidence)),
  }
}

function medianRegisterOf(sections: DetectedSection[], features: SectionFeatures[], types: SectionType[]): number | null {
  const values = sections
    .filter((section) => types.includes(section.sectionType))
    .map((section) => features[section.orderIndex]?.register.median)
    .filter((value): value is number => value !== null && value !== undefined)
  return values.length > 0 ? round(mean(values)) : null
}

/**
 * How much the song reuses its own melodic shapes.
 *
 * Compares repeats of the same section family — chorus to chorus, verse to
 * verse — because that is where a listener expects to recognize a melody. A
 * song whose choruses trace different shapes is not worse, it is less
 * repetitive, and the figure exists to be compared with a cohort.
 */
export function contourRepetition(sections: DetectedSection[], features: SectionFeatures[]): number | null {
  const groups = new Map<string, number[]>()
  for (const section of sections) {
    const family = section.sectionType === 'final_chorus' ? 'chorus' : section.sectionType
    const list = groups.get(family) ?? []
    list.push(section.orderIndex)
    groups.set(family, list)
  }

  const similarities: number[] = []
  for (const indices of groups.values()) {
    for (let i = 1; i < indices.length; i++) {
      const from = features[indices[i - 1]!]
      const to = features[indices[i]!]
      if (!from || !to) continue
      const similarity = contourSimilarity(from.melodicContour, to.melodicContour)
      if (similarity !== null) similarities.push(similarity)
    }
  }
  return similarities.length > 0 ? round(mean(similarities)) : null
}

/** Mean absolute rhythmic-density change between consecutive sections. */
export function rhythmicContrast(sections: DetectedSection[], features: SectionFeatures[]): number | null {
  const ordered = [...sections].sort((a, b) => a.startMs - b.startMs)
  const deltas: number[] = []
  for (let i = 1; i < ordered.length; i++) {
    const from = features[ordered[i - 1]!.orderIndex]
    const to = features[ordered[i]!.orderIndex]
    if (!from || !to) continue
    deltas.push(Math.abs(to.rhythmicDensity - from.rhythmicDensity))
  }
  return deltas.length > 0 ? round(mean(deltas)) : null
}

/**
 * The register bands, per section, for the register panel.
 *
 * Ordered by time and carrying the section's own label, so the panel can be
 * read against the timeline without a second lookup.
 */
export interface SectionRegisterBand {
  orderIndex: number
  label: string
  sectionType: SectionType
  startMs: number
  endMs: number
  median: number | null
  low: number | null
  high: number | null
  confidence: number
  /** True where this section is a chorus/hook, so the panel can mark the payoff. */
  isHook: boolean
  contour: number[]
}

export function registerBands(sections: DetectedSection[], features: SectionFeatures[]): SectionRegisterBand[] {
  return [...sections]
    .sort((a, b) => a.startMs - b.startMs)
    .map((section) => {
      const feature = features[section.orderIndex]
      return {
        orderIndex: section.orderIndex,
        label: section.label,
        sectionType: section.sectionType,
        startMs: section.startMs,
        endMs: section.endMs,
        median: feature?.register.median ?? null,
        low: feature?.register.low ?? null,
        high: feature?.register.high ?? null,
        confidence: feature?.register.confidence ?? 0,
        isHook: HOOK_SECTION_TYPES.includes(section.sectionType),
        contour: feature?.melodicContour ?? [],
      }
    })
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
