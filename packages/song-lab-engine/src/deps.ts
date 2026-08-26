import type { Db } from '@masterclip/database'
import type { DurableQueue } from '@masterclip/queue'
import type { StorageDriver } from '@masterclip/asset-storage'
import type { AuditLog, EntitlementService } from '@masterclip/domain'
import type { AppConfig, Clock, Logger } from '@masterclip/shared'
import type { AudioAssetService } from '@masterclip/audio-engine'
import type { AudioAssetRepo, ConsentRepo, OperatorDeskRepo, RemixRepo, TranscriptRepo } from '@masterclip/audio-domain'
import type { AudioProviderRegistry } from '@masterclip/audio-core'
import type { TranscriptionService } from '@masterclip/audio-engine'
import type { AudioExperimentRenderer } from '@masterclip/audio-experiments'
import type { BenchmarkProvider } from '@masterclip/music-benchmarking'
import type { LyricAnalysisProvider } from '@masterclip/lyric-analysis'
import type { MusicFeatureProvider, SongStructureProvider, VocalAnalysisProvider } from '@masterclip/song-analysis'
import type {
  BenchmarkCohortRepo,
  SongAnalysisRepo,
  SongArReviewRepo,
  SongBenchmarkResultRepo,
  SongExperimentRepo,
  SongLabHandoffRepo,
  SongLabProjectRepo,
  SongLyricRepo,
  SongObservationRepo,
  SongOutcomeRepo,
  SongSectionRepo,
  SongVersionRepo,
  SongVocalStemRepo,
} from '@masterclip/song-lab-domain'

export interface SongLabRepos {
  projects: SongLabProjectRepo
  versions: SongVersionRepo
  analyses: SongAnalysisRepo
  sections: SongSectionRepo
  lyrics: SongLyricRepo
  cohorts: BenchmarkCohortRepo
  benchmarkResults: SongBenchmarkResultRepo
  observations: SongObservationRepo
  experiments: SongExperimentRepo
  arReviews: SongArReviewRepo
  outcomes: SongOutcomeRepo
  handoffs: SongLabHandoffRepo
  vocalStems: SongVocalStemRepo
}

/** Providers, all replaceable. None is hardwired into a service. */
export interface SongLabProviders {
  structure: SongStructureProvider
  features: MusicFeatureProvider
  vocals: VocalAnalysisProvider
  lyrics: LyricAnalysisProvider
  benchmarks: BenchmarkProvider
  renderer: AudioExperimentRenderer
}

/**
 * What Song Lab borrows from the platform.
 *
 * Audio storage, rights, consent and retention are the Audio Intelligence
 * layer's, not Song Lab's — a second implementation of secure audio storage is
 * a second place for a tenant-isolation bug to live.
 */
export interface SongLabPlatform {
  audioAssets: AudioAssetService
  audioAssetRepo: AudioAssetRepo
  consents: ConsentRepo
  operatorDesk: OperatorDeskRepo
  remix: RemixRepo
  entitlements: EntitlementService
  /**
   * The audio layer's provider registry, for stem separation.
   *
   * Song Lab resolves exactly one slot from it (`stems`) and registers nothing.
   * Reaching for the registry rather than taking a provider directly keeps the
   * org's configured default and fallback in force here as everywhere else.
   */
  providerRegistry: AudioProviderRegistry
  /**
   * The platform's transcription pipeline, for lyric transcription.
   *
   * Reused rather than re-implemented so the org's retention policy,
   * zero-retention requirement, keyterms and usage accounting apply to a lyric
   * transcript exactly as they do to any other.
   */
  transcription: TranscriptionService
  transcripts: TranscriptRepo
}

export interface SongLabDeps {
  config: AppConfig
  logger: Logger
  clock: Clock
  db: Db
  storage: StorageDriver
  queue: DurableQueue
  audit: AuditLog
  repos: SongLabRepos
  providers: SongLabProviders
  platform: SongLabPlatform
}

export interface Actor {
  userId: string
  orgId: string
  orgRole: string
}

/** The rights statement a user must accept before any audio is processed. */
export const SONG_LAB_RIGHTS_STATEMENT =
  'I confirm that I own or control the audio I am uploading, or have authorization from the rights holder to use it for analysis.'

export const SONG_LAB_ANALYSIS_VERSION = '1.0.0'
