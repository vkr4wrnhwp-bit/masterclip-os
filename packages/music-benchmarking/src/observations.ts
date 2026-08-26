import { formatMetric, metricDefinition, ordinal } from '@masterclip/song-feature-vectors'
import type { BenchmarkComparison, BenchmarkMetricResult } from './compare.js'

/**
 * Observations and suggested experiments.
 *
 * This is where the product's voice is enforced in code rather than in a style
 * guide. An observation states what was measured and against what. A
 * recommendation says what is *worth testing*. Neither is permitted to predict
 * performance, and there is no code path here that can emit "this will make
 * your song a hit" — the phrasing is assembled from fixed templates that do not
 * contain such a claim.
 */

export type ObservationType =
  | 'structure_outlier'
  | 'tempo_outlier'
  | 'timing_outlier'
  | 'low_section_contrast'
  | 'melodic_contrast'
  | 'hook_architecture'
  | 'vocal_density'
  | 'lyric_density'
  | 'energy_shape'
  | 'arrangement_density'
  | 'unusual_by_design'

export type ObservationSeverity = 'worth_testing' | 'potential_opportunity' | 'needs_review' | 'informational'

export type ObservationStatus = 'open' | 'acknowledged' | 'testing' | 'accepted' | 'dismissed'

export interface SongObservationDraft {
  observationType: ObservationType
  category: string
  title: string
  description: string
  severity: ObservationSeverity
  confidence: number
  sourceMetricKeys: string[]
  recommendations: SongRecommendationDraft[]
}

export type RecommendationType =
  | 'earlier_chorus'
  | 'shorter_intro'
  | 'tempo_change'
  | 'section_cut'
  | 'section_duplicate'
  | 'alternate_outro'
  | 'arrangement_change'
  | 'vocal_change'
  | 'lyric_change'
  | 'review_only'

export interface SongRecommendationDraft {
  recommendationType: RecommendationType
  title: string
  description: string
  /** True when the experiment engine can render this as audio to listen to. */
  experimentSupported: boolean
  confidence: number
}

export interface ObservationInput {
  comparison: BenchmarkComparison
  /** Repeated-section similarity, e.g. chorus 1 → chorus 2. */
  repeatedSimilarities?: Array<{ fromLabel: string; toLabel: string; similarity: number }>
  /**
   * Verse-to-chorus register, measured from this recording alone.
   *
   * Supplied separately from the cohort comparison because it does not need
   * one: "the chorus sits in the same register as the verse" is a statement
   * about this song, and it holds whether or not a benchmark cohort was
   * selected.
   */
  registerContrast?: {
    verseLabel: string
    chorusLabel: string
    verseRegister: number
    chorusRegister: number
    lift: number
    confidence: number
  }
  /** Section labels by order index, for readable recommendation text. */
  sectionLabels?: Record<number, string>
  /** Whether the project has confirmed structure, which raises confidence. */
  structureConfirmed?: boolean
}

/** Similarity above this between two repeats is worth surfacing. */
const HIGH_SIMILARITY = 0.88
/**
 * A verse-to-chorus register lift smaller than this reads as "the same
 * register". Registers are normalized 0–1 bands, so this is roughly a twentieth
 * of the measurable range — small enough that a listener would not hear the
 * chorus as going anywhere new.
 */
const LOW_REGISTER_LIFT = 0.05
/** Below this, a comparison is too weakly supported to raise as an observation. */
const MIN_OBSERVATION_CONFIDENCE = 0.2

export function generateObservations(input: ObservationInput): SongObservationDraft[] {
  const drafts: SongObservationDraft[] = []

  for (const result of input.comparison.results) {
    // Anything outside the cohort's middle half is worth surfacing; the
    // classification decides how strongly it is worded.
    const notable = result.classification === 'structure_outlier' || result.classification === 'above_cohort' || result.classification === 'below_cohort'
    if (!notable) continue
    if (result.confidence < MIN_OBSERVATION_CONFIDENCE) continue
    const draft = observationForMetric(result, input)
    if (draft) drafts.push(draft)
  }

  for (const similarity of input.repeatedSimilarities ?? []) {
    if (similarity.similarity < HIGH_SIMILARITY) continue
    drafts.push({
      observationType: 'low_section_contrast',
      category: 'arrangement',
      title: `Low section contrast — ${similarity.toLabel}`,
      description:
        `${similarity.toLabel} measures ${Math.round(similarity.similarity * 100)}% similar to ${similarity.fromLabel} across energy, ` +
        'spectral balance, low-frequency weight and vocal density. That may be exactly what the record wants, or it may be a place where ' +
        'something new could land.',
      severity: 'potential_opportunity',
      // Similarity is directly measured from the audio, so this stands on
      // firmer ground than a cohort-relative observation.
      confidence: 0.6,
      sourceMetricKeys: ['chorus_similarity'],
      recommendations: [
        {
          recommendationType: 'arrangement_change',
          title: `Introduce one new element in ${similarity.toLabel}`,
          description:
            'Add a single arrangement element that has not appeared before, or withhold one until the final chorus. Song Lab will not ' +
            'generate the element — this is a note for the producer.',
          experimentSupported: false,
          confidence: 0.5,
        },
      ],
    })
  }

  const register = input.registerContrast
  if (register && register.confidence >= MIN_OBSERVATION_CONFIDENCE && Math.abs(register.lift) < LOW_REGISTER_LIFT) {
    drafts.push({
      observationType: 'melodic_contrast',
      category: 'melodic',
      title: `Low register contrast — ${register.chorusLabel}`,
      description:
        `${register.chorusLabel} occupies nearly the same vocal register as ${register.verseLabel} — a measured lift of ` +
        `${register.lift >= 0 ? '+' : ''}${register.lift.toFixed(3)} on a normalized register band. That may contribute to lower perceived ` +
        'section contrast, or it may be exactly the intimacy this record wants. Register here is a normalized band derived from the ' +
        'voiced signal, not a transcribed melody, so read it as "the same area of the voice" rather than as note names.',
      severity: 'potential_opportunity',
      confidence: register.confidence,
      sourceMetricKeys: ['chorus_register_lift', 'verse_register', 'chorus_register'],
      recommendations: [
        {
          recommendationType: 'vocal_change',
          title: 'Options worth trying for register contrast',
          description:
            'Try the chorus melody a third or fourth higher, hold the top note longer, or keep the verse lower so the chorus has ' +
            'somewhere to go. All performance and writing choices — Song Lab measures the register, it does not write the melody.',
          experimentSupported: false,
          confidence: register.confidence,
        },
      ],
    })
  }

  // Most-supported first, so "Three Things Worth Testing" takes the top three.
  drafts.sort((a, b) => b.confidence - a.confidence)

  // Two metrics can describe the same finding — a song whose hook *is* its
  // chorus produces an identical observation from `first_hook_seconds` and
  // `first_chorus_seconds`. Showing it twice would make one finding look like
  // two, so the better-supported copy wins and the other is folded into it.
  const seen = new Map<string, SongObservationDraft>()
  for (const draft of drafts) {
    const existing = seen.get(draft.title)
    if (!existing) {
      seen.set(draft.title, draft)
      continue
    }
    for (const key of draft.sourceMetricKeys) {
      if (!existing.sourceMetricKeys.includes(key)) existing.sourceMetricKeys.push(key)
    }
  }
  return [...seen.values()]
}

function observationForMetric(result: BenchmarkMetricResult, input: ObservationInput): SongObservationDraft | null {
  const definition = metricDefinition(result.metricKey)
  if (!definition || result.percentile === null || result.songValue === null || result.cohortMedian === null) return null

  const later = result.percentile > 50
  const cohortName = input.comparison.cohortName
  const difference = Math.abs(result.songValue - result.cohortMedian)
  const evidence =
    `Your track measures ${result.songDisplay}; the median for ${cohortName} is ${formatMetric(result.metricKey, result.cohortMedian)} ` +
    `(${result.sampleSize} songs)${result.lowSample ? '. This cohort is small, so read the percentile with caution' : ''}.`

  const shared = {
    category: definition.group,
    severity: 'worth_testing' as ObservationSeverity,
    confidence: result.confidence,
    sourceMetricKeys: [result.metricKey],
  }

  switch (result.metricKey) {
    case 'first_chorus_seconds':
    case 'first_hook_seconds':
      if (!later) {
        return {
          ...shared,
          observationType: 'timing_outlier',
          title: 'Earlier payoff than cohort',
          description: `${evidence} Reaching the payoff sooner than the comparison group is a choice, not a problem — noted so it is visible.`,
          severity: 'informational',
          recommendations: [],
        }
      }
      return {
        ...shared,
        observationType: 'timing_outlier',
        title: 'Chorus sooner',
        description: `${evidence} Worth hearing a version where it arrives earlier, to judge whether the wait is doing work.`,
        recommendations: [
          {
            recommendationType: 'earlier_chorus',
            title: `Bring the first chorus forward by about ${Math.round(difference)} seconds`,
            description:
              'Removes bars from the section before the chorus so the chorus lands earlier. Non-destructive: the original stays untouched ' +
              'and the result is a preview you can A/B.',
            experimentSupported: true,
            confidence: result.confidence,
          },
        ],
      }

    case 'intro_seconds':
      if (!later) return null
      return {
        ...shared,
        observationType: 'structure_outlier',
        title: 'Shorter intro',
        description: `${evidence} Worth hearing what the record sounds like with a shorter runway.`,
        recommendations: [
          {
            recommendationType: 'shorter_intro',
            title: `Reduce the intro to around ${Math.max(4, Math.round(result.cohortMedian))} seconds`,
            description: 'Trims the opening so the first vocal appears sooner. Rendered as a preview, never applied to the master.',
            experimentSupported: true,
            confidence: result.confidence,
          },
        ],
      }

    case 'bpm':
      return {
        ...shared,
        observationType: 'tempo_outlier',
        title: later ? 'Tempo outlier — faster than cohort' : 'Tempo outlier — slower than cohort',
        description:
          `${evidence} Tempo sits in the ${later ? 'upper' : 'lower'} ${Math.round(later ? 100 - result.percentile : result.percentile)}% of this cohort's range. ` +
          'A tempo change moves the track closer to that range; whether it improves the song is a listening decision.',
        recommendations: [
          {
            recommendationType: 'tempo_change',
            title: `${later ? '−' : '+'}${Math.max(1, Math.min(8, Math.round(difference)))} BPM`,
            description:
              'Pitch-preserving time stretch of the whole track. Runtime is recalculated automatically. The original tempo is always one ' +
              'click away in the A/B player.',
            experimentSupported: true,
            confidence: result.confidence,
          },
        ],
      }

    case 'first_verse_seconds':
    case 'second_verse_seconds': {
      if (!later) return null
      const label = definition.label
      return {
        ...shared,
        observationType: 'structure_outlier',
        title: `Structure outlier — ${label}`,
        description: `${evidence} Worth hearing a version that reaches the following section earlier.`,
        recommendations: [
          {
            recommendationType: 'section_cut',
            title: `Remove about ${Math.round(difference)} seconds from ${label}`,
            description: 'Cuts on a bar line where tempo allows, so the edit stays musical. Preview only.',
            experimentSupported: true,
            confidence: result.confidence,
          },
        ],
      }
    }

    case 'runtime_after_final_hook':
      if (!later) return null
      return {
        ...shared,
        observationType: 'structure_outlier',
        title: 'Long tail after the final hook',
        description: `${evidence} Worth hearing an alternate ending.`,
        recommendations: [
          {
            recommendationType: 'alternate_outro',
            title: 'Try a shorter outro, or end on the hook',
            description: 'Removes the instrumental tail, optionally repeating the final hook to hold a similar runtime.',
            experimentSupported: true,
            confidence: result.confidence,
          },
        ],
      }

    case 'title_repetition':
      if (later) return null
      return {
        ...shared,
        observationType: 'hook_architecture',
        title: 'Title repetition below cohort',
        description: `${evidence} A lyric change, not an edit — Song Lab will not write it.`,
        severity: 'potential_opportunity',
        recommendations: [
          {
            recommendationType: 'lyric_change',
            title: 'Test a second title repetition at the end of the chorus',
            description: 'A note for the writer. Song Lab measures where the title lands; the words are yours.',
            experimentSupported: false,
            confidence: result.confidence,
          },
        ],
      }

    case 'hook_line_syllables':
      if (!later) return null
      return {
        ...shared,
        observationType: 'lyric_density',
        title: 'Hook lines longer than cohort',
        description:
          `${evidence} Longer hook phrases leave less rhythmic space around the line. Neither length is universally better — this is a ` +
          'comparison, not a rule.',
        severity: 'potential_opportunity',
        recommendations: [
          {
            recommendationType: 'lyric_change',
            title: 'Try one primary hook phrase at roughly 5–8 syllables',
            description: 'A writing experiment, with more rhythmic space preserved around the phrase.',
            experimentSupported: false,
            confidence: result.confidence,
          },
        ],
      }

    case 'chorus_register_lift':
      if (later) return null
      return {
        ...shared,
        observationType: 'melodic_contrast',
        title: 'Chorus register lift below cohort',
        description:
          `${evidence} The chorus sits closer to the verse register than most records in this comparison group. Register is a ` +
          'normalized band derived from the voiced signal, not a transcribed melody.',
        severity: 'potential_opportunity',
        recommendations: [
          {
            recommendationType: 'vocal_change',
            title: 'Test whether the chorus has somewhere to go',
            description:
              'Try the chorus melody higher, or hold the verse lower. A performance and writing decision — no melody is generated here.',
            experimentSupported: false,
            confidence: result.confidence,
          },
        ],
      }

    case 'vocal_density_contrast':
      if (later) return null
      return {
        ...shared,
        observationType: 'vocal_density',
        title: 'Low verse-to-chorus vocal contrast',
        description: `${evidence} The chorus creates relatively little vocal-density change from the verse.`,
        severity: 'potential_opportunity',
        recommendations: [
          {
            recommendationType: 'vocal_change',
            title: 'Options worth trying in the chorus',
            description:
              'Reduce the chorus syllable count, hold a longer vowel, insert space before the title, repeat the title, add a response ' +
              'vocal, or shorten one line. All writing and performance choices — none are generated here.',
            experimentSupported: false,
            confidence: result.confidence,
          },
        ],
      }

    case 'chorus_share':
    case 'melodic_contour_repetition':
    case 'rhythmic_contrast':
    case 'arrangement_density':
    case 'dynamic_contrast':
    case 'energy_range':
      return {
        ...shared,
        observationType:
          result.metricKey === 'chorus_share'
            ? 'hook_architecture'
            : result.metricKey === 'melodic_contour_repetition' || result.metricKey === 'rhythmic_contrast'
              ? 'melodic_contrast'
              : 'energy_shape',
        title: `${definition.label} — ${directionWord(definition, later)}`,
        description: `${evidence} Recorded so it is visible; it may be exactly what this record intends.`,
        severity: 'informational',
        recommendations: [],
      }

    default:
      return {
        ...shared,
        observationType: 'unusual_by_design',
        title: `${definition.label} — ${directionWord(definition, later)}`,
        description: `${evidence} No experiment is suggested for this metric; it is here as context.`,
        severity: 'informational',
        recommendations: [],
      }
  }
}

/** The neutral direction word, without the "— Outlier" suffix. */
function directionWord(definition: { direction: { above: string; below: string } }, later: boolean): string {
  return later ? definition.direction.above : definition.direction.below
}

/** The overview's "Three Things Worth Testing". Never pads to three. */
export function topThingsWorthTesting(observations: SongObservationDraft[], limit = 3): SongObservationDraft[] {
  return observations
    .filter((observation) => observation.severity === 'worth_testing' || observation.severity === 'potential_opportunity')
    .slice(0, limit)
}
