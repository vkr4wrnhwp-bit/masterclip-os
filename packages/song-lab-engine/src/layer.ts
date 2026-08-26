import type { Db } from '@masterclip/database'
import type { DurableQueue } from '@masterclip/queue'
import type { StorageDriver } from '@masterclip/asset-storage'
import { AuditLog, type EntitlementService } from '@masterclip/domain'
import { systemClock, type AppConfig, type Clock, type Logger } from '@masterclip/shared'
import { HeuristicLyricAnalysisProvider } from '@masterclip/lyric-analysis'
import { ReferenceBenchmarkProvider } from '@masterclip/music-benchmarking'
import {
  FfmpegExperimentRenderer,
  PlaceholderExperimentRenderer,
  ResilientExperimentRenderer,
  type AudioExperimentRenderer,
} from '@masterclip/audio-experiments'
import {
  LocalMusicFeatureProvider,
  LocalVocalAnalysisProvider,
  MockMusicFeatureProvider,
  MockVocalAnalysisProvider,
} from '@masterclip/song-analysis'
import { LocalStructureProvider, MockStructureProvider } from '@masterclip/song-structure'
import {
  BenchmarkCohortRepo,
  SongAnalysisRepo,
  SongArReviewRepo,
  SongBenchmarkResultRepo,
  SongExperimentRepo,
  SongLabHandoffRepo,
  SongVocalStemRepo,
  SongLabProjectRepo,
  SongLyricRepo,
  SongObservationRepo,
  SongOutcomeRepo,
  SongSectionRepo,
  SongVersionRepo,
} from '@masterclip/song-lab-domain'
import type { AudioAssetRepo, ConsentRepo, OperatorDeskRepo, RemixRepo, TranscriptRepo } from '@masterclip/audio-domain'
import type { AudioAssetService } from '@masterclip/audio-engine'
import type { AudioProviderRegistry } from '@masterclip/audio-core'
import type { TranscriptionService } from '@masterclip/audio-engine'
import { SongLabAccessControl } from './access.js'
import { SongAnalysisService } from './analysis.js'
import { SongBenchmarkService } from './benchmark.js'
import { SongExperimentService } from './experiments.js'
import { SongLyricService } from './lyrics.js'
import { SongLabViewService } from './views.js'
import { SongArService } from './ar.js'
import { SongLabIntegrationService } from './integrations.js'
import { SongVocalStemService } from './vocal-stems.js'
import { SongLyricTranscriptionService } from './lyric-transcription.js'
import { SongOutcomeService } from './outcomes.js'
import { SongLabProjectService } from './projects.js'
import type { SongLabDeps, SongLabProviders, SongLabRepos } from './deps.js'

/**
 * Composition root for Song Lab.
 *
 * One place decides which providers are registered and how the services are
 * wired, so the API, the worker, the CLI and the tests all exercise the same
 * assembly. Provider selection is configuration, not code: switching to a
 * commercial MIR vendor is a registration change here and nothing else.
 */
export interface SongLabLayer {
  repos: SongLabRepos
  providers: SongLabProviders
  access: SongLabAccessControl
  projects: SongLabProjectService
  analysis: SongAnalysisService
  benchmark: SongBenchmarkService
  experiments: SongExperimentService
  lyrics: SongLyricService
  views: SongLabViewService
  ar: SongArService
  integrations: SongLabIntegrationService
  outcomes: SongOutcomeService
  vocalStems: SongVocalStemService
  lyricTranscription: SongLyricTranscriptionService
}

export interface CreateSongLabLayerOptions {
  config: AppConfig
  logger: Logger
  db: Db
  storage: StorageDriver
  queue: DurableQueue
  clock?: Clock
  entitlements: EntitlementService
  audio: {
    assets: AudioAssetService
    assetRepo: AudioAssetRepo
    consents: ConsentRepo
    operatorDesk: OperatorDeskRepo
    remix: RemixRepo
    /** Resolved for stem separation only; Song Lab registers nothing in it. */
    providerRegistry: AudioProviderRegistry
    transcription: TranscriptionService
    transcripts: TranscriptRepo
  }
  /** Registers only deterministic providers. Used by fast tests. */
  mockOnly?: boolean
  /** Overrides for tests and for future vendor adapters. */
  providers?: Partial<SongLabProviders>
}

export function createSongLabLayer(opts: CreateSongLabLayerOptions): SongLabLayer {
  const clock = opts.clock ?? systemClock
  const useMock = opts.mockOnly || opts.config.SONG_LAB_ANALYSIS_PROVIDER === 'mock-song-analysis'

  // ffmpeg is required to render an experiment preview. Whether it exists is
  // not knowable here — the API and worker start long before anything renders —
  // so the resilient renderer decides on first use and falls back to the
  // placeholder when the binary is absent. A missing binary is a deployment
  // fact, not a reason to dead-letter an artist's experiment.
  const renderer: AudioExperimentRenderer = useMock
    ? new PlaceholderExperimentRenderer()
    : new ResilientExperimentRenderer([new FfmpegExperimentRenderer()])

  const providers: SongLabProviders = {
    structure: opts.providers?.structure ?? (useMock ? new MockStructureProvider() : new LocalStructureProvider()),
    features: opts.providers?.features ?? (useMock ? new MockMusicFeatureProvider() : new LocalMusicFeatureProvider()),
    vocals: opts.providers?.vocals ?? (useMock ? new MockVocalAnalysisProvider() : new LocalVocalAnalysisProvider()),
    lyrics: opts.providers?.lyrics ?? new HeuristicLyricAnalysisProvider(),
    benchmarks: opts.providers?.benchmarks ?? new ReferenceBenchmarkProvider(),
    renderer: opts.providers?.renderer ?? renderer,
  }

  const repos: SongLabRepos = {
    projects: new SongLabProjectRepo(opts.db, clock),
    versions: new SongVersionRepo(opts.db, clock),
    analyses: new SongAnalysisRepo(opts.db, clock),
    sections: new SongSectionRepo(opts.db, clock),
    lyrics: new SongLyricRepo(opts.db, clock),
    cohorts: new BenchmarkCohortRepo(opts.db, clock),
    benchmarkResults: new SongBenchmarkResultRepo(opts.db, clock),
    observations: new SongObservationRepo(opts.db, clock),
    experiments: new SongExperimentRepo(opts.db, clock),
    arReviews: new SongArReviewRepo(opts.db, clock),
    outcomes: new SongOutcomeRepo(opts.db, clock),
    handoffs: new SongLabHandoffRepo(opts.db, clock),
    vocalStems: new SongVocalStemRepo(opts.db, clock),
  }

  const deps: SongLabDeps = {
    config: opts.config,
    logger: opts.logger,
    clock,
    db: opts.db,
    storage: opts.storage,
    queue: opts.queue,
    audit: new AuditLog(opts.db, clock),
    repos,
    providers,
    platform: {
      audioAssets: opts.audio.assets,
      audioAssetRepo: opts.audio.assetRepo,
      consents: opts.audio.consents,
      operatorDesk: opts.audio.operatorDesk,
      remix: opts.audio.remix,
      entitlements: opts.entitlements,
      providerRegistry: opts.audio.providerRegistry,
      transcription: opts.audio.transcription,
      transcripts: opts.audio.transcripts,
    },
  }

  const lyrics = new SongLyricService(deps)
  // Hoisted because separation finishes by queueing a reanalysis through it.
  const projects = new SongLabProjectService(deps)

  return {
    repos,
    providers,
    access: new SongLabAccessControl(opts.config, opts.db, opts.entitlements),
    projects,
    analysis: new SongAnalysisService(deps),
    benchmark: new SongBenchmarkService(deps),
    experiments: new SongExperimentService(deps),
    lyrics,
    views: new SongLabViewService(deps),
    ar: new SongArService(deps),
    integrations: new SongLabIntegrationService(deps),
    outcomes: new SongOutcomeService(deps),
    vocalStems: new SongVocalStemService(deps, projects),
    lyricTranscription: new SongLyricTranscriptionService(deps, lyrics),
  }
}
