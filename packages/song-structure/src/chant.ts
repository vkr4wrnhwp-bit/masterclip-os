import type { DetectedSection, SectionFeatures } from '@masterclip/song-analysis'

/**
 * Chant Finder.
 *
 * Looks for sections that already have the properties a crowd needs in order to
 * join in: a strong downbeat, room in the vocal, harmonic simplicity, and
 * repetition. It suggests *rhythmic shapes* first — where the syllables would
 * sit — and only offers words if the artist explicitly asks for them, with
 * their own lyric as context. A tool that hands an artist a chorus lyric it
 * invented is a songwriter, and Song Lab is not that.
 */

export type ChantPattern = 'four_syllable' | 'call_response' | 'title_chant' | 'two_beat_answer'

export interface ChantPatternIdea {
  pattern: ChantPattern
  label: string
  /** How the syllables sit against the beat, e.g. `DA — DA — DA — DA`. */
  rhythm: string
  description: string
}

export interface ChantOpportunity {
  sectionOrderIndex: number
  sectionLabel: string
  startMs: number
  endMs: number
  /** 0–1 composite of the measured properties below. */
  score: number
  signals: {
    /** Room in the vocal — the single biggest factor. */
    vocalSpace: number
    downbeatStrength: number
    harmonicSimplicity: number
    repetition: number
    /** True when this section type recurs, which crowds rely on. */
    recurring: boolean
  }
  observation: string
  patterns: ChantPatternIdea[]
}

export interface ChantInput {
  sections: DetectedSection[]
  features: SectionFeatures[]
  /** Harmonic change rate in changes/minute; lower is simpler to chant over. */
  harmonicChangesPerMinute?: number | null
  /** Syllable density per section, when authorized lyrics exist. */
  syllableDensityBySection?: Record<number, number>
  /** Sections the user has marked as containing the title phrase. */
  titleSectionIndexes?: number[]
}

const CHANTABLE_SECTIONS = new Set(['chorus', 'final_chorus', 'post_chorus', 'hook', 'drop', 'break', 'outro', 'breakdown'])

export function findChantOpportunities(input: ChantInput): ChantOpportunity[] {
  const typeCounts = new Map<string, number>()
  for (const section of input.sections) {
    const family = section.sectionType === 'final_chorus' ? 'chorus' : section.sectionType
    typeCounts.set(family, (typeCounts.get(family) ?? 0) + 1)
  }

  const opportunities: ChantOpportunity[] = []
  for (const section of input.sections) {
    if (!CHANTABLE_SECTIONS.has(section.sectionType)) continue
    const features = input.features[section.orderIndex]
    if (!features) continue

    // Space in the vocal: measured occupancy where we have it, syllable density
    // where lyrics were supplied. A wall of words leaves nowhere to chant.
    const density = input.syllableDensityBySection?.[section.orderIndex]
    const vocalSpace =
      density !== undefined
        ? clamp(1 - density / 8)
        : features.vocalOccupancy === null
          ? 0.5
          : clamp(1 - features.vocalOccupancy)

    const downbeatStrength = clamp(features.transientDensity * 0.6 + features.lowFrequencyDensity * 0.4)
    const harmonicSimplicity =
      input.harmonicChangesPerMinute === null || input.harmonicChangesPerMinute === undefined
        ? 0.5
        : clamp(1 - input.harmonicChangesPerMinute / 60)
    const family = section.sectionType === 'final_chorus' ? 'chorus' : section.sectionType
    const recurring = (typeCounts.get(family) ?? 0) > 1
    const repetition = recurring ? 0.8 : 0.3

    const score = clamp(vocalSpace * 0.35 + downbeatStrength * 0.25 + harmonicSimplicity * 0.2 + repetition * 0.2)
    // Below this there is no defensible opportunity to report, and inventing
    // one would be noise dressed as insight.
    if (score < 0.45) continue

    opportunities.push({
      sectionOrderIndex: section.orderIndex,
      sectionLabel: section.label,
      startMs: section.startMs,
      endMs: section.endMs,
      score: round(score),
      signals: {
        vocalSpace: round(vocalSpace),
        downbeatStrength: round(downbeatStrength),
        harmonicSimplicity: round(harmonicSimplicity),
        repetition: round(repetition),
        recurring,
      },
      observation: observationFor(vocalSpace, recurring, section.label),
      patterns: patternsFor(vocalSpace, Boolean(input.titleSectionIndexes?.includes(section.orderIndex))),
    })
  }

  return opportunities.sort((a, b) => b.score - a.score)
}

function observationFor(vocalSpace: number, recurring: boolean, label: string): string {
  const space = vocalSpace >= 0.6 ? 'has substantial rhythmic space' : 'has some rhythmic space'
  const recurrence = recurring ? ', and it recurs, so a crowd would hear it more than once' : ''
  return `${label} ${space} for a crowd-response element${recurrence}.`
}

function patternsFor(vocalSpace: number, hasTitle: boolean): ChantPatternIdea[] {
  const patterns: ChantPatternIdea[] = [
    {
      pattern: 'four_syllable',
      label: 'Four-syllable pattern',
      rhythm: 'DA — DA — DA — DA',
      description: 'Four evenly spaced syllables on the beat. The easiest shape for a room to find without being taught.',
    },
    {
      pattern: 'call_response',
      label: 'Call and response',
      rhythm: 'LEAD PHRASE ↓ 4-BEAT GROUP RESPONSE',
      description: 'Lead sings the line, the room answers in the following bar. Needs a full bar of space after the phrase.',
    },
  ]
  if (hasTitle) {
    patterns.push({
      pattern: 'title_chant',
      label: 'Title chant',
      rhythm: 'TITLE / TITLE / REST / TITLE',
      description: 'The title on beats one and two, a rest, then the title again. Uses words the song already has.',
    })
  }
  if (vocalSpace >= 0.6) {
    patterns.push({
      pattern: 'two_beat_answer',
      label: 'Two-beat answer',
      rhythm: '— — DA DA',
      description: 'A short answer on the last two beats of the bar. Fits where the lead has already stopped singing.',
    })
  }
  return patterns
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
