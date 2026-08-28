import type { Db } from '@masterclip/database'
import type { DurableQueue } from '@masterclip/queue'
import type { StorageDriver } from '@masterclip/asset-storage'
import { AuditLog, type EntitlementService } from '@masterclip/domain'
import { systemClock, type AppConfig, type Clock, type Logger } from '@masterclip/shared'
import { PassthroughMasterRenderer, ResilientMasterRenderer, type MasterRenderer } from '@masterclip/mix-analysis'
import {
  AiPermissionRepo,
  ContributionRepo,
  CreativeMemoryRepo,
  IdentityVaultRepo,
  LicenseRequestRepo,
  MasterRenditionRepo,
  MixAnalysisRepo,
  MixIssueRepo,
  OpportunityRepo,
  ProcessingJobRepo,
  RackRepo,
  RecordPassportRepo,
  ReleaseMetadataRepo,
  RoomExchangeRepo,
  ServiceOrderRepo,
  ServiceProviderRepo,
  SonicDnaRepo,
  StudioActivityRepo,
  StudioAlbumRepo,
  StudioApprovalRepo,
  StudioCollaboratorRepo,
  StudioCommentRepo,
  StudioDeliverableRepo,
  StudioNoteRepo,
  StudioProjectRepo,
  StudioReferenceRepo,
  StudioVersionRepo,
} from '@masterclip/studio-domain'
import type { AudioAssetRepo, ConsentRepo } from '@masterclip/audio-domain'
import type { AudioAssetService } from '@masterclip/audio-engine'
import { StudioAccessControl } from './access.js'
import { StudioProjectService } from './projects.js'
import { StudioMixService } from './mix.js'
import { StudioMasterService } from './master.js'
import { StudioVersionService } from './versions.js'
import { StudioCollaborationService } from './collaboration.js'
import { StudioDeliveryService } from './deliver.js'
import { StudioRoomService } from './room.js'
import { StudioMemoryService } from './memory.js'
import { StudioPassportService } from './passport.js'
import { StudioRightsService } from './rights.js'
import { StudioRackService } from './rack.js'
import { StudioMarketService } from './market.js'
import { StudioProcessingService } from './processing.js'
import type { StudioDeps, StudioProviders, StudioRepos } from './deps.js'

/**
 * Composition root for Street Banker Studio.
 *
 * One place decides which providers are registered and how the services are
 * wired, so the API, the worker, the CLI and the tests all exercise the same
 * assembly. Anything constructed outside this file is a second source of truth
 * about how the module is put together.
 */
export interface StudioLayer {
  repos: StudioRepos
  providers: StudioProviders
  access: StudioAccessControl
  projects: StudioProjectService
  mix: StudioMixService
  master: StudioMasterService
  versions: StudioVersionService
  collaboration: StudioCollaborationService
  delivery: StudioDeliveryService
  room: StudioRoomService
  memory: StudioMemoryService
  passports: StudioPassportService
  rights: StudioRightsService
  racks: StudioRackService
  market: StudioMarketService
  processing: StudioProcessingService
}

export interface CreateStudioLayerOptions {
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
  }
  /** Registers only deterministic providers. Used by fast tests. */
  mockOnly?: boolean
  /** Overrides for tests and for future vendor adapters. */
  providers?: Partial<StudioProviders>
}

export function createStudioLayer(opts: CreateStudioLayerOptions): StudioLayer {
  const clock = opts.clock ?? systemClock

  // ffmpeg is required to render a master. Whether it exists is not knowable
  // here — the API and the worker start long before anything renders — so the
  // resilient renderer decides on first use and falls back to the passthrough
  // when the binary is absent. A missing binary is a deployment fact, not a
  // reason to dead-letter an artist's master.
  const masterRenderer: MasterRenderer = opts.providers?.masterRenderer ?? (opts.mockOnly ? new PassthroughMasterRenderer() : new ResilientMasterRenderer())

  const providers: StudioProviders = { masterRenderer }

  const repos: StudioRepos = {
    projects: new StudioProjectRepo(opts.db, clock),
    versions: new StudioVersionRepo(opts.db, clock),
    notes: new StudioNoteRepo(opts.db, clock),
    activity: new StudioActivityRepo(opts.db, clock),
    racks: new RackRepo(opts.db, clock),
    analyses: new MixAnalysisRepo(opts.db, clock),
    issues: new MixIssueRepo(opts.db, clock),
    processing: new ProcessingJobRepo(opts.db, clock),
    references: new StudioReferenceRepo(opts.db, clock),
    renditions: new MasterRenditionRepo(opts.db, clock),
    albums: new StudioAlbumRepo(opts.db, clock),
    collaborators: new StudioCollaboratorRepo(opts.db, clock),
    comments: new StudioCommentRepo(opts.db, clock),
    approvals: new StudioApprovalRepo(opts.db, clock),
    deliverables: new StudioDeliverableRepo(opts.db, clock),
    releaseMetadata: new ReleaseMetadataRepo(opts.db, clock),
    sonicDna: new SonicDnaRepo(opts.db, clock),
    creativeMemory: new CreativeMemoryRepo(opts.db, clock),
    passports: new RecordPassportRepo(opts.db, clock),
    contributions: new ContributionRepo(opts.db, clock),
    identities: new IdentityVaultRepo(opts.db, clock),
    aiPermissions: new AiPermissionRepo(opts.db, clock),
    licenseRequests: new LicenseRequestRepo(opts.db, clock),
    serviceProviders: new ServiceProviderRepo(opts.db, clock),
    serviceOrders: new ServiceOrderRepo(opts.db, clock),
    opportunities: new OpportunityRepo(opts.db, clock),
    roomExchanges: new RoomExchangeRepo(opts.db, clock),
  }

  const deps: StudioDeps = {
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
      entitlements: opts.entitlements,
    },
  }

  return {
    repos,
    providers,
    access: new StudioAccessControl(opts.config, opts.db, opts.entitlements, repos.collaborators, repos.projects),
    projects: new StudioProjectService(deps),
    mix: new StudioMixService(deps),
    master: new StudioMasterService(deps),
    versions: new StudioVersionService(deps),
    collaboration: new StudioCollaborationService(deps),
    delivery: new StudioDeliveryService(deps),
    room: new StudioRoomService(deps),
    memory: new StudioMemoryService(deps),
    passports: new StudioPassportService(deps),
    rights: new StudioRightsService(deps),
    racks: new StudioRackService(deps),
    market: new StudioMarketService(deps),
    processing: new StudioProcessingService(deps),
  }
}
