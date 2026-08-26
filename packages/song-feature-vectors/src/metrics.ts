/**
 * The metric registry.
 *
 * One catalogue of every comparable quantity, shared by the analysis engine,
 * the benchmark engine, the observation generator and the UI. A metric is in
 * here only if it can be measured from a recording *and* compared against a
 * cohort — that constraint is what keeps benchmarking honest.
 *
 * `direction` deliberately does not mean "better". It records which way a
 * difference from the cohort should be *described* ("earlier than cohort",
 * "higher density"), because Song Lab describes differences rather than
 * ranking them.
 */

export type MetricUnit = 'seconds' | 'milliseconds' | 'bpm' | 'count' | 'ratio' | 'percent' | 'lufs' | 'db' | 'index'

export type MetricGroup =
  | 'global'
  | 'structure'
  | 'timing'
  | 'hook'
  | 'energy'
  | 'arrangement'
  | 'vocal'
  | 'melodic'
  | 'lyric'

export interface MetricDefinition {
  key: string
  label: string
  group: MetricGroup
  unit: MetricUnit
  /** How to phrase a value above the cohort median, and below it. */
  direction: { above: string; below: string }
  description: string
  /** Metrics that only make sense when lyrics/vocals were analysed. */
  requires?: 'lyrics' | 'vocals' | 'stereo'
}

export const METRICS: MetricDefinition[] = [
  // ----- global -------------------------------------------------------------
  { key: 'duration_seconds', label: 'Runtime', group: 'global', unit: 'seconds', direction: { above: 'Longer Than Cohort', below: 'Shorter Than Cohort' }, description: 'Total runtime of the recording.' },
  { key: 'bpm', label: 'Tempo', group: 'global', unit: 'bpm', direction: { above: 'Faster Than Cohort', below: 'Slower Than Cohort' }, description: 'Estimated global tempo.' },
  { key: 'tempo_stability', label: 'Tempo stability', group: 'global', unit: 'ratio', direction: { above: 'Steadier Than Cohort', below: 'Looser Than Cohort' }, description: 'How consistent the beat period is across the recording.' },
  { key: 'loudness_lufs', label: 'Integrated loudness', group: 'global', unit: 'lufs', direction: { above: 'Louder Than Cohort', below: 'Quieter Than Cohort' }, description: 'Programme loudness estimate.' },
  { key: 'dynamic_range_db', label: 'Dynamic range', group: 'global', unit: 'db', direction: { above: 'Wider Dynamics', below: 'Narrower Dynamics' }, description: 'Spread between loud and quiet passages.' },
  { key: 'stereo_width', label: 'Stereo width', group: 'global', unit: 'ratio', direction: { above: 'Wider Than Cohort', below: 'Narrower Than Cohort' }, description: 'Side-to-mid energy ratio.', requires: 'stereo' },

  // ----- timing / early payoff ---------------------------------------------
  { key: 'intro_seconds', label: 'Intro length', group: 'timing', unit: 'seconds', direction: { above: 'Longer Than Cohort', below: 'Shorter Than Cohort' }, description: 'Runtime before the first non-intro section.' },
  { key: 'first_vocal_seconds', label: 'Time to first vocal', group: 'timing', unit: 'seconds', direction: { above: 'Later Than Cohort', below: 'Earlier Than Cohort' }, description: 'Where vocal activity is first detected.' },
  { key: 'first_hook_seconds', label: 'Time to first hook', group: 'timing', unit: 'seconds', direction: { above: 'Later Than Cohort', below: 'Earlier Than Cohort' }, description: 'Start of the section marked or detected as the hook.' },
  { key: 'first_chorus_seconds', label: 'Time to first chorus', group: 'timing', unit: 'seconds', direction: { above: 'Later Than Cohort', below: 'Earlier Than Cohort' }, description: 'Start of the first chorus section.' },
  { key: 'runtime_before_first_repeat', label: 'Runtime before first repeat', group: 'timing', unit: 'seconds', direction: { above: 'Later Than Cohort', below: 'Earlier Than Cohort' }, description: 'How long before any section type recurs.' },
  { key: 'runtime_after_final_hook', label: 'Runtime after final hook', group: 'timing', unit: 'seconds', direction: { above: 'Longer Than Cohort', below: 'Shorter Than Cohort' }, description: 'Tail length after the last primary hook ends.' },

  // ----- structure ----------------------------------------------------------
  { key: 'section_count', label: 'Section count', group: 'structure', unit: 'count', direction: { above: 'More Sections', below: 'Fewer Sections' }, description: 'Number of detected sections.' },
  { key: 'unique_section_count', label: 'Unique sections', group: 'structure', unit: 'count', direction: { above: 'More Variety', below: 'Less Variety' }, description: 'Distinct section types present.' },
  { key: 'chorus_count', label: 'Chorus count', group: 'structure', unit: 'count', direction: { above: 'More Choruses', below: 'Fewer Choruses' }, description: 'Number of chorus sections.' },
  { key: 'verse_count', label: 'Verse count', group: 'structure', unit: 'count', direction: { above: 'More Verses', below: 'Fewer Verses' }, description: 'Number of verse sections.' },
  { key: 'average_section_seconds', label: 'Average section length', group: 'structure', unit: 'seconds', direction: { above: 'Longer Sections', below: 'Shorter Sections' }, description: 'Mean section duration.' },
  { key: 'section_length_variance', label: 'Section-length variance', group: 'structure', unit: 'index', direction: { above: 'Less Even', below: 'More Even' }, description: 'Spread of section durations.' },
  { key: 'first_verse_seconds', label: 'Verse 1 length', group: 'structure', unit: 'seconds', direction: { above: 'Longer Than Cohort', below: 'Shorter Than Cohort' }, description: 'Duration of the first verse.' },
  { key: 'second_verse_seconds', label: 'Verse 2 length', group: 'structure', unit: 'seconds', direction: { above: 'Longer Than Cohort', below: 'Shorter Than Cohort' }, description: 'Duration of the second verse.' },
  { key: 'chorus_seconds', label: 'Chorus length', group: 'structure', unit: 'seconds', direction: { above: 'Longer Than Cohort', below: 'Shorter Than Cohort' }, description: 'Mean chorus duration.' },
  { key: 'bridge_position_ratio', label: 'Bridge placement', group: 'structure', unit: 'ratio', direction: { above: 'Later Than Cohort', below: 'Earlier Than Cohort' }, description: 'Where the bridge sits as a fraction of runtime.' },
  { key: 'outro_seconds', label: 'Outro length', group: 'structure', unit: 'seconds', direction: { above: 'Longer Than Cohort', below: 'Shorter Than Cohort' }, description: 'Duration of the closing section.' },
  { key: 'structural_symmetry', label: 'Structural symmetry', group: 'structure', unit: 'index', direction: { above: 'More Symmetrical', below: 'Less Symmetrical' }, description: 'How evenly section lengths mirror across the runtime.' },
  { key: 'repetition_frequency', label: 'Repetition frequency', group: 'structure', unit: 'ratio', direction: { above: 'More Repetition', below: 'Less Repetition' }, description: 'Share of sections that repeat an earlier type.' },

  // ----- hook ---------------------------------------------------------------
  { key: 'chorus_share', label: 'Chorus share of runtime', group: 'hook', unit: 'percent', direction: { above: 'Higher Share', below: 'Lower Share' }, description: 'Percentage of runtime occupied by chorus/hook sections.' },
  { key: 'hook_repetition', label: 'Hook repetitions', group: 'hook', unit: 'count', direction: { above: 'More Repetition', below: 'Less Repetition' }, description: 'How many times the hook section recurs.' },
  { key: 'title_repetition', label: 'Title repetitions', group: 'hook', unit: 'count', direction: { above: 'More Repetition', below: 'Less Repetition' }, description: 'How many times the title phrase appears in the lyric.', requires: 'lyrics' },
  { key: 'final_chorus_contrast', label: 'Final-chorus contrast', group: 'hook', unit: 'index', direction: { above: 'More Contrast', below: 'Less Contrast' }, description: 'How much the final chorus differs from the previous one.' },

  // ----- energy -------------------------------------------------------------
  { key: 'peak_energy_position', label: 'Peak-energy position', group: 'energy', unit: 'ratio', direction: { above: 'Later Peak', below: 'Earlier Peak' }, description: 'Where the highest-energy section sits in the runtime.' },
  { key: 'energy_range', label: 'Energy range', group: 'energy', unit: 'index', direction: { above: 'Wider Range', below: 'Narrower Range' }, description: 'Distance between the quietest and busiest section.' },
  { key: 'chorus_energy_lift', label: 'Chorus energy lift', group: 'energy', unit: 'index', direction: { above: 'Bigger Lift', below: 'Smaller Lift' }, description: 'Energy gain from verse into chorus.' },
  { key: 'dynamic_contrast', label: 'Dynamic contrast', group: 'energy', unit: 'index', direction: { above: 'Higher Contrast', below: 'Lower Contrast' }, description: 'Mean section-to-section energy change.' },

  // ----- arrangement --------------------------------------------------------
  { key: 'arrangement_density', label: 'Arrangement density', group: 'arrangement', unit: 'index', direction: { above: 'Higher Density', below: 'Lower Density' }, description: 'Mean simultaneous-activity proxy across the song.' },
  { key: 'spectral_density', label: 'Spectral density', group: 'arrangement', unit: 'index', direction: { above: 'Higher Density', below: 'Lower Density' }, description: 'Spread of energy across the spectrum.' },
  { key: 'transient_density', label: 'Transient density', group: 'arrangement', unit: 'index', direction: { above: 'Busier', below: 'Sparser' }, description: 'Onsets per second, normalized.' },
  { key: 'low_frequency_density', label: 'Low-frequency density', group: 'arrangement', unit: 'index', direction: { above: 'Heavier Low End', below: 'Lighter Low End' }, description: 'Share of energy below 200 Hz.' },
  { key: 'chorus_similarity', label: 'Chorus-to-chorus similarity', group: 'arrangement', unit: 'percent', direction: { above: 'More Similar', below: 'Less Similar' }, description: 'How alike repeated choruses are across measured features.' },

  // ----- vocal --------------------------------------------------------------
  { key: 'vocal_occupancy', label: 'Vocal occupancy', group: 'vocal', unit: 'percent', direction: { above: 'Higher Occupancy', below: 'Lower Occupancy' }, description: 'Share of runtime with detected vocal activity.', requires: 'vocals' },
  { key: 'verse_vocal_occupancy', label: 'Verse vocal occupancy', group: 'vocal', unit: 'percent', direction: { above: 'Higher Occupancy', below: 'Lower Occupancy' }, description: 'Vocal occupancy within verses.', requires: 'vocals' },
  { key: 'chorus_vocal_occupancy', label: 'Chorus vocal occupancy', group: 'vocal', unit: 'percent', direction: { above: 'Higher Occupancy', below: 'Lower Occupancy' }, description: 'Vocal occupancy within choruses.', requires: 'vocals' },
  { key: 'vocal_density_contrast', label: 'Verse/chorus vocal contrast', group: 'vocal', unit: 'index', direction: { above: 'More Contrast', below: 'Less Contrast' }, description: 'Difference in vocal density between verse and chorus.', requires: 'vocals' },
  { key: 'average_phrase_seconds', label: 'Average phrase length', group: 'vocal', unit: 'seconds', direction: { above: 'Longer Phrases', below: 'Shorter Phrases' }, description: 'Mean length of a continuous vocal phrase.', requires: 'vocals' },
  { key: 'longest_phrase_seconds', label: 'Longest phrase', group: 'vocal', unit: 'seconds', direction: { above: 'Longer', below: 'Shorter' }, description: 'Longest continuous vocal phrase.', requires: 'vocals' },
  { key: 'rest_ratio', label: 'Vocal rest ratio', group: 'vocal', unit: 'percent', direction: { above: 'More Space', below: 'Less Space' }, description: 'Share of runtime with no vocal.', requires: 'vocals' },

  // ----- melodic ------------------------------------------------------------
  //
  // A normalized register band, not note names. Deriving lead-vocal pitch from
  // a full mix is not reliable enough to print "your chorus tops out at G5";
  // whether two sections occupy the same register is answerable, and it is the
  // question section contrast actually turns on.
  { key: 'vocal_register_range', label: 'Vocal register range', group: 'melodic', unit: 'index', direction: { above: 'Wider Range', below: 'Narrower Range' }, description: 'Span between the lowest and highest measured vocal register across the song.', requires: 'vocals' },
  { key: 'verse_register', label: 'Verse register', group: 'melodic', unit: 'index', direction: { above: 'Higher Register', below: 'Lower Register' }, description: 'Median vocal register across the verses.', requires: 'vocals' },
  { key: 'chorus_register', label: 'Chorus register', group: 'melodic', unit: 'index', direction: { above: 'Higher Register', below: 'Lower Register' }, description: 'Median vocal register across the choruses.', requires: 'vocals' },
  { key: 'chorus_register_lift', label: 'Chorus register lift', group: 'melodic', unit: 'index', direction: { above: 'Bigger Lift', below: 'Smaller Lift' }, description: 'How far the chorus register sits above the verse register.', requires: 'vocals' },
  { key: 'peak_register_position', label: 'Peak-register position', group: 'melodic', unit: 'ratio', direction: { above: 'Later Peak', below: 'Earlier Peak' }, description: 'Where the highest-register section sits in the runtime.', requires: 'vocals' },
  { key: 'melodic_contour_repetition', label: 'Melodic contour repetition', group: 'melodic', unit: 'percent', direction: { above: 'More Repetition', below: 'Less Repetition' }, description: 'How closely repeats of the same section trace the same melodic shape.', requires: 'vocals' },
  { key: 'rhythmic_contrast', label: 'Rhythmic contrast', group: 'melodic', unit: 'index', direction: { above: 'Higher Contrast', below: 'Lower Contrast' }, description: 'Mean rhythmic-density change between consecutive sections.' },

  // ----- lyric --------------------------------------------------------------
  { key: 'syllables_per_second', label: 'Syllable density', group: 'lyric', unit: 'ratio', direction: { above: 'Denser', below: 'Sparser' }, description: 'Syllables per second across the lyric.', requires: 'lyrics' },
  { key: 'chorus_syllables_per_second', label: 'Chorus syllable density', group: 'lyric', unit: 'ratio', direction: { above: 'Denser', below: 'Sparser' }, description: 'Syllables per second within choruses.', requires: 'lyrics' },
  { key: 'hook_line_syllables', label: 'Hook-line length', group: 'lyric', unit: 'count', direction: { above: 'Longer Phrases', below: 'Shorter Phrases' }, description: 'Median syllable count of hook lines.', requires: 'lyrics' },
  { key: 'verse_chorus_vocabulary_overlap', label: 'Verse/chorus vocabulary overlap', group: 'lyric', unit: 'percent', direction: { above: 'More Overlap', below: 'Less Overlap' }, description: 'Shared vocabulary between verse and chorus.', requires: 'lyrics' },
  { key: 'lyric_repetition', label: 'Lyric repetition', group: 'lyric', unit: 'percent', direction: { above: 'More Repetition', below: 'Less Repetition' }, description: 'Share of lines that repeat an earlier line.', requires: 'lyrics' },
]

const BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]))

export function metricDefinition(key: string): MetricDefinition | undefined {
  return BY_KEY.get(key)
}

export function metricLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key
}

export function metricsInGroup(group: MetricGroup): MetricDefinition[] {
  return METRICS.filter((metric) => metric.group === group)
}

export function isMetricKey(key: string): boolean {
  return BY_KEY.has(key)
}

/** Formats a metric value for display. Unknowns never print as `0`. */
export function formatMetric(key: string, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'not enough information'
  const unit = BY_KEY.get(key)?.unit ?? 'index'
  switch (unit) {
    case 'seconds':
      return formatClock(value)
    case 'milliseconds':
      return formatClock(value / 1000)
    case 'bpm':
      return `${Math.round(value)} BPM`
    case 'count':
      return String(Math.round(value * 10) / 10)
    case 'percent':
      return `${Math.round(value)}%`
    case 'lufs':
      return `${value.toFixed(1)} LUFS`
    case 'db':
      return `${value.toFixed(1)} dB`
    case 'ratio':
      return value.toFixed(2)
    default:
      return String(Math.round(value))
  }
}

/** `83rd`, not `83th`. This is a product about not being sloppy with numbers. */
export function ordinal(value: number): string {
  const lastTwo = Math.abs(value) % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`
  switch (Math.abs(value) % 10) {
    case 1:
      return `${value}st`
    case 2:
      return `${value}nd`
    case 3:
      return `${value}rd`
    default:
      return `${value}th`
  }
}

/** `0:56` — the timeline format used everywhere in Song Lab. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}
