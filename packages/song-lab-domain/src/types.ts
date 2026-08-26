import type { SectionRegister, SectionType } from '@masterclip/song-analysis'
import type { ExperimentEdit, ExperimentType } from '@masterclip/audio-experiments'
import type { CohortFilterDefinition, CohortSourceDefinition, CohortType, ObservationSeverity, ObservationStatus, ObservationType, RecommendationType } from '@masterclip/music-benchmarking'
import type { SongFeatureVector } from '@masterclip/song-feature-vectors'

/** Record shapes for Song Lab. Every tenant-owned record carries orgId. */

export const SONG_LAB_PROJECT_STATUSES = [
  'draft',
  'awaiting_audio',
  'analyzing',
  'analyzed',
  'benchmarked',
  'in_review',
  'review_complete',
  'failed',
] as const
export type SongLabProjectStatus = (typeof SONG_LAB_PROJECT_STATUSES)[number]

export interface SongLabProjectRecord {
  id: string
  orgId: string
  artistId: string | null
  artistName: string
  title: string
  genre: string
  status: SongLabProjectStatus
  sourceAssetId: string | null
  currentVersionId: string | null
  selectedBenchmarkCohortId: string | null
  rightsConfirmationId: string
  titlePhrase: string
  notes: string
  demo: boolean
  reviewCompletedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export const SONG_VERSION_TYPES = [
  'original_upload',
  'human_revision',
  'song_lab_experiment',
  'producer_revision',
  'remix_lab_version',
  'release_candidate',
  'final_master',
] as const
export type SongVersionType = (typeof SONG_VERSION_TYPES)[number]

export interface SongVersionRecord {
  id: string
  orgId: string
  songLabProjectId: string
  parentVersionId: string | null
  versionType: SongVersionType
  versionLabel: string
  sourceAssetId: string | null
  experimentId: string | null
  notes: string
  createdBy: string
  createdAt: string
}

export const VOCAL_STEM_STATUSES = ['pending', 'ready', 'failed', 'unsupported'] as const
export type VocalStemStatus = (typeof VOCAL_STEM_STATUSES)[number]

/**
 * A vocal stem separated out of a mix so vocal metrics can be measured from
 * the voice rather than from a spectral guess at where the voice is.
 *
 * `unsupported` is a distinct outcome from `failed`: the provider ran and
 * succeeded, but returned nothing identifiable as a vocal (an archive, or a
 * set of stems with names this code does not recognise). That is a capability
 * gap rather than an error, and it is worth telling the user apart from a
 * separation that actually broke.
 */
export interface SongVocalStemRecord {
  id: string
  orgId: string
  songLabProjectId: string
  songVersionId: string
  sourceAssetId: string
  /** Pinned so a stem is never reused against a recording it did not come from. */
  sourceChecksum: string
  stemAssetId: string | null
  status: VocalStemStatus
  /** Verbatim provider stem name, so a renamed output shows up in the data. */
  stemName: string | null
  provider: string
  modelVersion: string
  failureReason: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export const SONG_ANALYSIS_STATUSES = ['queued', 'running', 'complete', 'failed'] as const
export type SongAnalysisStatus = (typeof SONG_ANALYSIS_STATUSES)[number]

export interface SongAnalysisRecord {
  id: string
  orgId: string
  songLabProjectId: string
  songVersionId: string
  analysisVersion: string
  engineVersion: string
  status: SongAnalysisStatus
  durationMs: number | null
  bpm: number | null
  bpmConfidence: number | null
  tempoStability: number | null
  key: string | null
  keyConfidence: number | null
  meter: number | null
  meterConfidence: number | null
  loudness: number | null
  dynamicRange: number | null
  peakDbfs: number | null
  stereoWidth: number | null
  firstVocalMs: number | null
  structureConfidence: number | null
  featureVector: SongFeatureVector | null
  energyCurve: { values: number[]; stepSeconds: number }
  vocalAnalysis: Record<string, unknown>
  providers: Record<string, { provider: string; modelVersion: string }>
  configuration: Record<string, unknown>
  sourceChecksum: string
  failureReason: string | null
  createdAt: string
  completedAt: string | null
}

export interface SongSectionRecord {
  id: string
  orgId: string
  songAnalysisId: string
  sectionType: SectionType
  label: string
  startMs: number
  endMs: number
  confidence: number
  humanConfirmed: boolean
  isHook: boolean
  isTitlePhrase: boolean
  orderIndex: number
  createdAt: string
  updatedAt: string
}

export interface SongSectionFeatureRecord {
  id: string
  orgId: string
  songSectionId: string
  energy: number
  vocalOccupancy: number | null
  syllableDensity: number | null
  arrangementDensity: number
  spectralDensity: number
  transientDensity: number
  lowFrequencyDensity: number
  stereoWidth: number | null
  rhythmicDensity: number
  similarityVector: number[]
  /** Vocal register band within the section. Null throughout when unmeasured. */
  register: SectionRegister
  /** Normalized melodic shape; empty when the section had too little voiced content. */
  melodicContour: number[]
}

export interface SongLyricLineRecord {
  id: string
  orgId: string
  songVersionId: string
  sectionId: string | null
  lineIndex: number
  startMs: number | null
  endMs: number | null
  text: string
  syllableCount: number
  titlePhrase: boolean
  hookPhrase: boolean
  userConfirmed: boolean
  lyricSource: string
  createdAt: string
  updatedAt: string
}

export interface BenchmarkCohortRecord {
  id: string
  orgId: string | null
  name: string
  description: string
  cohortType: CohortType
  filterDefinition: CohortFilterDefinition
  sourceDefinition: CohortSourceDefinition
  sampleSize: number
  status: 'draft' | 'published' | 'retired'
  proprietary: boolean
  providerId: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface SongBenchmarkResultRecord {
  id: string
  orgId: string
  songAnalysisId: string
  benchmarkCohortId: string
  metricKey: string
  songValue: number | null
  percentile: number | null
  cohortMedian: number | null
  cohortMean: number | null
  p10: number | null
  p25: number | null
  p75: number | null
  p90: number | null
  zScore: number | null
  sampleSize: number
  confidence: number
  classification: string
  classificationLabel: string
  summary: string
  createdAt: string
}

export interface SongObservationRecord {
  id: string
  orgId: string
  songLabProjectId: string
  songVersionId: string
  songAnalysisId: string
  benchmarkCohortId: string | null
  observationType: ObservationType
  category: string
  title: string
  description: string
  severity: ObservationSeverity
  confidence: number
  sourceMetricKeys: string[]
  benchmarkResultIds: string[]
  status: ObservationStatus
  createdAt: string
  updatedAt: string
  recommendations?: SongRecommendationRecord[]
}

export interface SongRecommendationRecord {
  id: string
  orgId: string
  songObservationId: string
  recommendationType: RecommendationType
  title: string
  description: string
  experimentSupported: boolean
  confidence: number
  humanApproved: boolean
  approvedBy: string | null
  approvedAt: string | null
  createdAt: string
}

export const SONG_EXPERIMENT_STATUSES = ['draft', 'rendering', 'ready', 'accepted', 'rejected', 'failed'] as const
export type SongExperimentStatus = (typeof SONG_EXPERIMENT_STATUSES)[number]

export interface SongExperimentRecord {
  id: string
  orgId: string
  songLabProjectId: string
  sourceVersionId: string
  recommendationId: string | null
  name: string
  experimentType: ExperimentType
  intent: string
  editDecisionList: ExperimentEdit[]
  bpmOverride: number | null
  status: SongExperimentStatus
  previewAssetId: string | null
  predictedDurationMs: number | null
  renderedDurationMs: number | null
  renderer: string | null
  rendererVersion: string | null
  placeholderPreview: boolean
  acceptedVersionId: string | null
  failureReason: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export const AR_RATINGS = ['strong', 'promising', 'moderate', 'below_cohort', 'needs_review', 'not_enough_data'] as const
export type ArRating = (typeof AR_RATINGS)[number]

export const AR_RECOMMENDATIONS = [
  'listen',
  'develop',
  'review_with_producer',
  'request_revision',
  'release_ready',
  'live_led_opportunity',
  'sync_led_opportunity',
  'needs_more_data',
  'pass_for_now',
] as const
export type ArRecommendation = (typeof AR_RECOMMENDATIONS)[number]

export interface SongArReviewRecord {
  id: string
  orgId: string
  songLabProjectId: string
  songAnalysisId: string | null
  structureRating: ArRating
  hookRating: ArRating
  earlyPayoffRating: ArRating
  arrangementContrastRating: ArRating
  vocalMemorabilityRating: ArRating
  streamingFitRating: ArRating
  livePotentialRating: ArRating
  syncPotentialRating: ArRating
  recommendation: ArRecommendation
  why: string
  /** Which measured features and cohort comparisons each rating rests on. */
  evidence: Array<{ dimension: string; metricKeys: string[]; note: string }>
  confidence: number
  /** `draft` until a human approves it. A draft is never a decision. */
  status: 'draft' | 'approved' | 'superseded'
  reviewedBy: string | null
  reviewedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface SongOutcomeLinkRecord {
  id: string
  orgId: string
  songLabProjectId: string
  recommendationId: string | null
  observationId: string | null
  suggestedAt: string
  accepted: boolean
  acceptedAt: string | null
  implemented: boolean
  implementedVersionId: string | null
  releaseId: string | null
  releasedAt: string | null
  outcomeWindow: string
  outcomeMetrics: Record<string, number>
  correlationNotes: string
  createdAt: string
  updatedAt: string
}

export const HANDOFF_TARGETS = ['remix_lab', 'live_lab', 'release_command_center', 'operator_desk', 'signal'] as const
export type HandoffTarget = (typeof HANDOFF_TARGETS)[number]

export interface SongLabHandoffRecord {
  id: string
  orgId: string
  songLabProjectId: string
  songVersionId: string
  target: HandoffTarget
  targetRecordId: string | null
  status: 'pending' | 'delivered' | 'failed'
  payload: Record<string, unknown>
  failureReason: string | null
  createdBy: string
  createdAt: string
}
