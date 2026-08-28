import type { AnalysisFrames, PcmAudio } from '@masterclip/song-analysis'

/**
 * The vocabulary the Mix Station speaks.
 *
 * Two rules shape everything in this file, and they are the reason the module
 * exists as its own package rather than as a folder inside the engine:
 *
 *   1. **A metric is a measurement with provenance, never a bare number.** Every
 *      value carries the method that produced it, a confidence, and a note. A
 *      metric that could not be determined is `null` — never zero — and every
 *      consumer renders it as "not enough information".
 *
 *   2. **Analyzers are a list, not a schema.** Adding an analyzer is appending
 *      to an array; it needs no migration, no change to the repository, and no
 *      change to the UI, because metrics are stored and rendered by key. The
 *      brief for this module says more analyzers arrive later, so that is the
 *      one thing the design has to make cheap.
 */

/** Physical unit of a metric. Drives formatting and comparison, nothing else. */
export type MixMetricUnit = 'db' | 'dbfs' | 'dbtp' | 'lufs' | 'lu' | 'ratio' | 'percent' | 'hz' | 'count' | 'seconds' | 'index'

export type MixMetricGroup =
  | 'level'
  | 'loudness'
  | 'dynamics'
  | 'spectrum'
  | 'stereo'
  | 'defects'
  | 'low_end'
  | 'midrange'
  | 'high_frequency'
  | 'vocal'

export interface MixMetricDefinition {
  key: string
  label: string
  unit: MixMetricUnit
  group: MixMetricGroup
  /** One sentence a musician can read. Printed next to the number. */
  description: string
  /**
   * Whether a higher or lower reading is generally *preferred for translation*.
   * `none` means the metric is descriptive and has no better direction — most
   * of the spectral metrics are like this, and saying so is the difference
   * between a diagnostic and a scoreboard.
   */
  preference: 'higher' | 'lower' | 'none'
}

/**
 * The metric catalogue.
 *
 * Every key an analyzer can emit is declared here so the UI can label and unit
 * anything it is handed. An analyzer emitting an undeclared key is a bug the
 * registry surfaces at analysis time rather than a mystery row in the table.
 */
export const MIX_METRICS: MixMetricDefinition[] = [
  // --- level --------------------------------------------------------------
  { key: 'peak_dbfs', label: 'Sample peak', unit: 'dbfs', group: 'level', preference: 'none', description: 'Highest sample value in the file.' },
  {
    key: 'true_peak_dbtp',
    label: 'True peak (estimated)',
    unit: 'dbtp',
    group: 'level',
    preference: 'lower',
    description: 'Estimated inter-sample peak from 4× oversampling. An estimate, not a certified meter.',
  },
  { key: 'headroom_db', label: 'Headroom', unit: 'db', group: 'level', preference: 'higher', description: 'Distance from the estimated true peak to full scale.' },
  { key: 'crest_factor_db', label: 'Crest factor', unit: 'db', group: 'level', preference: 'none', description: 'Peak level minus RMS level across the whole record.' },

  // --- loudness -----------------------------------------------------------
  {
    key: 'integrated_lufs',
    label: 'Integrated loudness',
    unit: 'lufs',
    group: 'loudness',
    preference: 'none',
    description: 'Gated programme loudness. Approximated without K-weighting, so treat it as ±1 LU.',
  },
  { key: 'short_term_max_lufs', label: 'Loudest 3 s', unit: 'lufs', group: 'loudness', preference: 'none', description: 'The loudest short-term window in the record.' },
  { key: 'loudness_range_lu', label: 'Loudness range', unit: 'lu', group: 'loudness', preference: 'none', description: 'Spread between the quiet and loud parts of the programme.' },

  // --- dynamics -----------------------------------------------------------
  { key: 'dynamic_range_db', label: 'Dynamic range', unit: 'db', group: 'dynamics', preference: 'none', description: '95th minus 10th percentile of block loudness.' },
  {
    key: 'transient_retention',
    label: 'Transient retention',
    unit: 'index',
    group: 'dynamics',
    preference: 'higher',
    description: 'How much of the attack energy survives relative to sustained energy. 0–1.',
  },

  // --- spectrum -----------------------------------------------------------
  { key: 'sub_energy_pct', label: 'Sub (below 60 Hz)', unit: 'percent', group: 'spectrum', preference: 'none', description: 'Share of total energy below 60 Hz.' },
  { key: 'low_energy_pct', label: 'Low (60–200 Hz)', unit: 'percent', group: 'spectrum', preference: 'none', description: 'Share of total energy from 60 to 200 Hz.' },
  { key: 'low_mid_energy_pct', label: 'Low-mid (200–600 Hz)', unit: 'percent', group: 'spectrum', preference: 'none', description: 'Share of total energy from 200 to 600 Hz.' },
  { key: 'mid_energy_pct', label: 'Mid (600 Hz–2 kHz)', unit: 'percent', group: 'spectrum', preference: 'none', description: 'Share of total energy from 600 Hz to 2 kHz.' },
  { key: 'high_mid_energy_pct', label: 'High-mid (2–6 kHz)', unit: 'percent', group: 'spectrum', preference: 'none', description: 'Share of total energy from 2 to 6 kHz.' },
  { key: 'high_energy_pct', label: 'High (above 6 kHz)', unit: 'percent', group: 'spectrum', preference: 'none', description: 'Share of total energy above 6 kHz.' },
  { key: 'spectral_centroid_hz', label: 'Spectral centre', unit: 'hz', group: 'spectrum', preference: 'none', description: 'The frequency the energy balances around.' },
  {
    key: 'spectral_tilt_db_per_oct',
    label: 'Spectral tilt',
    unit: 'db',
    group: 'spectrum',
    preference: 'none',
    description: 'Slope of the average spectrum in dB per octave. Negative means darker.',
  },

  // --- stereo -------------------------------------------------------------
  { key: 'stereo_width', label: 'Stereo width', unit: 'ratio', group: 'stereo', preference: 'none', description: 'Mean side-to-mid ratio. Null for mono sources.' },
  {
    key: 'phase_correlation',
    label: 'Phase correlation',
    unit: 'ratio',
    group: 'stereo',
    preference: 'higher',
    description: '+1 is mono-identical, 0 is wide, negative means the channels partly cancel in mono.',
  },
  { key: 'stereo_imbalance_db', label: 'L/R imbalance', unit: 'db', group: 'stereo', preference: 'lower', description: 'Level difference between the left and right channels.' },
  {
    key: 'mono_fold_loss_db',
    label: 'Mono fold-down loss',
    unit: 'db',
    group: 'stereo',
    preference: 'lower',
    description: 'Level lost when the mix is summed to mono — what a phone speaker or a club sub actually hears.',
  },

  // --- defects ------------------------------------------------------------
  { key: 'clipped_sample_pct', label: 'Clipped samples', unit: 'percent', group: 'defects', preference: 'lower', description: 'Share of samples at or above full scale.' },
  { key: 'clipping_runs', label: 'Clipping events', unit: 'count', group: 'defects', preference: 'lower', description: 'Consecutive runs of samples pinned at full scale.' },
  { key: 'dc_offset', label: 'DC offset', unit: 'ratio', group: 'defects', preference: 'lower', description: 'Mean sample value. Anything meaningfully non-zero wastes headroom.' },
  { key: 'lead_in_seconds', label: 'Lead-in silence', unit: 'seconds', group: 'defects', preference: 'none', description: 'Silence before the record starts.' },
  { key: 'tail_seconds', label: 'Tail silence', unit: 'seconds', group: 'defects', preference: 'none', description: 'Silence after the record ends.' },
  { key: 'internal_silence_count', label: 'Internal gaps', unit: 'count', group: 'defects', preference: 'lower', description: 'Silences longer than 250 ms inside the programme.' },

  // --- low end ------------------------------------------------------------
  {
    key: 'low_end_centroid_hz',
    label: 'Low-end centre',
    unit: 'hz',
    group: 'low_end',
    preference: 'none',
    description: 'Where the weight of the bottom end sits below 250 Hz.',
  },
  {
    key: 'kick_bass_masking_index',
    label: 'Kick/bass overlap',
    unit: 'index',
    group: 'low_end',
    preference: 'lower',
    description: 'How much of the sub and low-bass energy peaks at the same moments. 0–1.',
  },

  // --- midrange -----------------------------------------------------------
  {
    key: 'midrange_congestion_index',
    label: 'Midrange congestion',
    unit: 'index',
    group: 'midrange',
    preference: 'lower',
    description: 'How concentrated and flat the 200 Hz–2 kHz band is over time. 0–1.',
  },

  // --- high frequency -----------------------------------------------------
  {
    key: 'harshness_index',
    label: 'Upper-mid harshness',
    unit: 'index',
    group: 'high_frequency',
    preference: 'lower',
    description: 'Sustained energy concentration in the 2–5 kHz region relative to its neighbours. 0–1.',
  },
  {
    key: 'sibilance_index',
    label: 'Sibilance indicator',
    unit: 'index',
    group: 'high_frequency',
    preference: 'lower',
    description: 'Short bursts of 5–10 kHz energy typical of consonants. 0–1. An indicator, not a de-esser.',
  },

  // --- vocal --------------------------------------------------------------
  {
    key: 'vocal_presence_index',
    label: 'Vocal presence',
    unit: 'index',
    group: 'vocal',
    preference: 'none',
    description: 'Estimated share of the record where a lead vocal dominates the midrange. Measured from the full mix unless a stem was supplied.',
  },
  {
    key: 'vocal_level_stability',
    label: 'Vocal level stability',
    unit: 'index',
    group: 'vocal',
    preference: 'higher',
    description: 'How consistent the estimated vocal band level is across the record. 0–1.',
  },
  {
    key: 'vocal_masking_index',
    label: 'Vocal masking',
    unit: 'index',
    group: 'vocal',
    preference: 'lower',
    description: 'How much accompaniment energy sits in the same band as the estimated vocal at the same time. 0–1.',
  },
]

const METRIC_INDEX = new Map(MIX_METRICS.map((definition) => [definition.key, definition]))

export function mixMetricDefinition(key: string): MixMetricDefinition | undefined {
  return METRIC_INDEX.get(key)
}

export function isMixMetricKey(key: string): boolean {
  return METRIC_INDEX.has(key)
}

/**
 * One measurement.
 *
 * `value: null` is the honest answer for anything that could not be determined
 * — a mono file has no phase correlation, a 3-second clip has no loudness
 * range. The note says why, and the UI prints the note instead of a number.
 */
export interface MixMetric {
  key: string
  value: number | null
  unit: MixMetricUnit
  /** 0–1. Zero whenever `value` is null: an unmeasured figure is not confident. */
  confidence: number
  analysisMethod: string
  provider: string
  note: string
}

export function metric(
  key: string,
  value: number | null,
  opts: { confidence: number; method: string; provider: string; note?: string },
): MixMetric {
  const definition = METRIC_INDEX.get(key)
  if (!definition) throw new Error(`unknown mix metric: ${key}`)
  return {
    key,
    value: value === null || !Number.isFinite(value) ? null : round(value),
    unit: definition.unit,
    confidence: value === null || !Number.isFinite(value) ? 0 : clamp01(opts.confidence),
    analysisMethod: opts.method,
    provider: opts.provider,
    note: opts.note ?? '',
  }
}

export function unmeasured(key: string, opts: { method: string; provider: string; note: string }): MixMetric {
  return metric(key, null, { confidence: 0, method: opts.method, provider: opts.provider, note: opts.note })
}

/** A time series a UI can draw and the Mix Doctor can walk. */
export interface MixCurve {
  key: string
  stepMs: number
  /** `null` where the value could not be measured at that moment. */
  points: Array<number | null>
}

/**
 * The frequency bands the whole module reasons in.
 *
 * Named and fixed here so "the low-mids" means one thing in the analyzer, in
 * the Mix Doctor, in the readiness score and in the mastering plan. Ranges are
 * in Hz and deliberately musical rather than octave-aligned.
 */
export const MIX_BANDS = {
  // Starts at 0 rather than 20 Hz so the six balance bands tile the whole
  // spectrum: any gap between them would make the shares sum to less than
  // 100% and every "x% of the energy" statement quietly wrong.
  sub: [0, 60],
  low: [60, 200],
  lowMid: [200, 600],
  mid: [600, 2000],
  highMid: [2000, 6000],
  high: [6000, 20000],
  /** Overlapping diagnostic bands — not part of the balance sum. */
  kick: [40, 100],
  bassBody: [80, 250],
  vocalBand: [300, 3500],
  presence: [2000, 5000],
  sibilance: [5000, 10000],
  air: [10000, 20000],
} as const

export type MixBandKey = keyof typeof MIX_BANDS

/** The six bands whose shares sum to the whole spectrum. */
export const BALANCE_BANDS: MixBandKey[] = ['sub', 'low', 'lowMid', 'mid', 'highMid', 'high']

/**
 * One pass over the audio, shared by every analyzer.
 *
 * Band energies are absolute power sums rather than ratios so an analyzer can
 * form whichever ratio it needs without re-reading the samples. The whole file
 * is walked exactly once, at the source sample rate: mix work asks questions
 * about 8–16 kHz that a 22.05 kHz analysis rate cannot answer at all.
 */
export interface MixSpectrogram {
  sampleRate: number
  fftSize: number
  hopSize: number
  frameSeconds: number
  count: number
  /** Frame start time in seconds. */
  times: number[]
  /** Absolute band power per frame, keyed by band. */
  bands: Record<MixBandKey, number[]>
  /** Total spectral power per frame. */
  total: number[]
  /** Frame RMS amplitude of the mono sum, 0–1. */
  rms: number[]
  /** Energy-weighted mean frequency per frame, in Hz. */
  centroidHz: number[]
  /** Highest frequency this analysis can see, i.e. Nyquist of the source. */
  measurableCeilingHz: number
}

/** What every analyzer is handed. Computed once, walked many times. */
export interface MixAnalysisContext {
  audio: PcmAudio
  /** Mono sum at the source sample rate. */
  mono: Float32Array
  /** The shared single-pass spectrogram. */
  spectrogram: MixSpectrogram
  /** Song Lab's frame descriptors, for anything that wants its band ratios. */
  frames: AnalysisFrames
  sourceSampleRate: number
  channelCount: number
  /** Bit depth reported by the container, or null when it does not say. */
  bitDepth: number | null
  /**
   * An isolated vocal, when one was supplied. Analyzers that can use it say so
   * in their metric notes; the rest ignore it and keep measuring the mix.
   */
  isolatedVocal: Float32Array | null
}

export interface MixAnalyzerResult {
  metrics: MixMetric[]
  curves?: MixCurve[]
}

/**
 * An analyzer.
 *
 * Deliberately small: given the shared context, emit metrics and optionally
 * curves. It has no access to storage, to the database, or to the project, so
 * a future third-party analyzer can satisfy this interface without adopting
 * anything else in this repository.
 */
export interface MixAnalyzer {
  readonly id: string
  readonly version: string
  /** Which metric keys this analyzer is responsible for. Checked at registration. */
  readonly metricKeys: readonly string[]
  run(context: MixAnalysisContext): MixAnalyzerResult
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

export { clamp01 as clampUnit, round as roundMetric }
