import type { Measured } from '@masterclip/song-feature-vectors'

/**
 * The vocabulary the analysis providers speak.
 *
 * Kept free of engine internals so a future third-party provider can satisfy
 * these interfaces without adopting this repo's DSP, and so the mock provider
 * is a peer of the real one rather than a special case.
 */

export interface AudioAssetRef {
  id: string
  orgId: string
  /** Storage key. The provider resolves bytes through the caller's storage. */
  storageKey: string
  mimeType: string
  fileName: string
  /** SHA-256 of the source bytes. Deterministic providers seed from this. */
  checksum: string
  fileSize: number
  durationMs: number | null
}

/** Section vocabulary. `custom` covers anything a user renames by hand. */
export const SECTION_TYPES = [
  'intro',
  'verse',
  'pre_chorus',
  'chorus',
  'post_chorus',
  'hook',
  'bridge',
  'break',
  'drop',
  'instrumental',
  'solo',
  'breakdown',
  'final_chorus',
  'outro',
  'custom',
] as const

export type SectionType = (typeof SECTION_TYPES)[number]

export function isSectionType(value: string): value is SectionType {
  return (SECTION_TYPES as readonly string[]).includes(value)
}

/** Sections that count as the song's primary payoff for timing metrics. */
export const HOOK_SECTION_TYPES: SectionType[] = ['chorus', 'post_chorus', 'hook', 'drop', 'final_chorus']

export const SECTION_LABELS: Record<SectionType, string> = {
  intro: 'Intro',
  verse: 'Verse',
  pre_chorus: 'Pre-Chorus',
  chorus: 'Chorus',
  post_chorus: 'Post-Chorus',
  hook: 'Hook',
  bridge: 'Bridge',
  break: 'Break',
  drop: 'Drop',
  instrumental: 'Instrumental',
  solo: 'Solo',
  breakdown: 'Breakdown',
  final_chorus: 'Final Chorus',
  outro: 'Outro',
  custom: 'Section',
}

export interface DetectedSection {
  sectionType: SectionType
  /** Display label, e.g. `Verse 2`. */
  label: string
  startMs: number
  endMs: number
  confidence: number
  orderIndex: number
}

/**
 * Where a section's vocal sits, as a normalized band rather than note names.
 *
 * Deriving lead-vocal pitch from a full mix is not reliable enough to print
 * "your chorus tops out at G5". Whether two sections occupy the *same* register
 * is answerable, and it is the question that matters for section contrast, so
 * that is the only claim made here.
 */
export interface SectionRegister {
  median: number | null
  low: number | null
  high: number | null
  /** 0 whenever the values are null — an unmeasured band is not a confident one. */
  confidence: number
}

export function emptyRegister(): SectionRegister {
  return { median: null, low: null, high: null, confidence: 0 }
}

export interface SectionFeatures {
  /** 0–1 composite energy. */
  energy: number
  vocalOccupancy: number | null
  arrangementDensity: number
  spectralDensity: number
  transientDensity: number
  lowFrequencyDensity: number
  stereoWidth: number | null
  rhythmicDensity: number
  /** Fixed-length descriptor used for section-to-section similarity. */
  similarityVector: number[]
  /** Vocal register band within this section. */
  register: SectionRegister
  /** Normalized melodic shape, empty when the section has too little voiced content. */
  melodicContour: number[]
}

export interface StructureAnalysisResult {
  sections: DetectedSection[]
  /** Per-section features, aligned by `orderIndex`. */
  features: SectionFeatures[]
  confidence: number
  provider: string
  modelVersion: string
  method: string
}

export interface MusicFeatureResult {
  durationMs: number
  bpm: Measured<number>
  tempoStability: Measured<number>
  meter: Measured<number>
  key: Measured<string>
  loudness: Measured<number>
  dynamicRange: Measured<number>
  peakDbfs: Measured<number>
  stereoWidth: Measured<number>
  spectralDensity: Measured<number>
  transientDensity: Measured<number>
  lowFrequencyDensity: Measured<number>
  /** Normalized energy value per analysis frame, for the energy curve. */
  energyCurve: number[]
  /** Seconds per energy-curve point. */
  energyCurveStepSeconds: number
  /** Detected beat times in seconds. */
  beats: number[]
  leadInSeconds: number
  tailSeconds: number
  fadeInSeconds: number | null
  fadeOutSeconds: number | null
  harmonicChangeRate: Measured<number>
  provider: string
  modelVersion: string
}

/**
 * What the vocal numbers were actually measured from.
 *
 * `full_mix` is the spectral proxy: it infers where the voice is from band
 * energy, tonality and centroid movement, and it is wrong on dense arrangements
 * in a way it cannot detect. `isolated_stem` means a real separated vocal was
 * measured. Every consumer that reports a vocal figure reports this alongside,
 * because the same number means two different things depending on which it is.
 */
export type VocalMeasurementBasis = 'full_mix' | 'isolated_stem'

export interface VocalAnalysisOptions {
  /**
   * An isolated vocal to measure instead of the mix. The mix is still passed
   * as the primary source, so a provider that cannot use a stem ignores this
   * and returns a `full_mix` result rather than failing.
   */
  isolatedVocal?: AudioSource
}

export interface VocalAnalysisResult {
  basis: VocalMeasurementBasis
  occupancy: Measured<number>
  firstVocalSeconds: Measured<number>
  averagePhraseSeconds: Measured<number>
  longestPhraseSeconds: Measured<number>
  restRatio: Measured<number>
  heldNoteSeconds: Measured<number>
  register: {
    median: number | null
    low: number | null
    high: number | null
    confidence: number
  }
  /** Continuous vocal phrases as `[startMs, endMs]`. */
  phrases: Array<[number, number]>
  /** Per-frame activity flags, for the vocal-density visualization. */
  activity: number[]
  activityStepSeconds: number
  /**
   * Per-frame voiced register — the value where a vocal is active, `null` where
   * it is not — over whatever signal `basis` names.
   *
   * Returned so a caller holding section boundaries can re-measure each
   * section's register against this signal without re-running the DSP. That
   * matters when a stem exists: boundaries have to come from the full mix
   * (an instrumental break is a section change and a vocal stem is silent
   * there), while the register of those sections is better measured from the
   * stem. Empty when the provider measured no register at all.
   */
  registerCurve: Array<number | null>
  registerCurveStepSeconds: number
  provider: string
  modelVersion: string
}

/** Everything a provider needs to resolve bytes without knowing about storage. */
export interface AudioSource {
  asset: AudioAssetRef
  /** Resolves the source bytes. Providers call this at most once. */
  read: () => Promise<Uint8Array>
}

export interface SongStructureProvider {
  readonly providerId: string
  readonly modelVersion: string
  isConfigured(): boolean
  analyzeStructure(asset: AudioSource): Promise<StructureAnalysisResult>
}

export interface MusicFeatureProvider {
  readonly providerId: string
  readonly modelVersion: string
  isConfigured(): boolean
  analyzeMusicFeatures(asset: AudioSource): Promise<MusicFeatureResult>
}

export interface VocalAnalysisProvider {
  readonly providerId: string
  readonly modelVersion: string
  isConfigured(): boolean
  analyzeVocals(asset: AudioSource, opts?: VocalAnalysisOptions): Promise<VocalAnalysisResult>
}

export interface SongAnalysisProviderSet {
  structure: SongStructureProvider
  features: MusicFeatureProvider
  vocals: VocalAnalysisProvider
}
