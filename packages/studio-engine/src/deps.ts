import type { Db } from '@masterclip/database'
import type { DurableQueue } from '@masterclip/queue'
import type { StorageDriver } from '@masterclip/asset-storage'
import type { AuditLog, EntitlementService } from '@masterclip/domain'
import type { AppConfig, Clock, Logger } from '@masterclip/shared'
import type { AudioAssetService } from '@masterclip/audio-engine'
import type { AudioAssetRepo, ConsentRepo } from '@masterclip/audio-domain'
import type { AudioProcessingRegistry, MasterRenderer } from '@masterclip/mix-analysis'
import type {
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

export interface StudioRepos {
  projects: StudioProjectRepo
  versions: StudioVersionRepo
  notes: StudioNoteRepo
  activity: StudioActivityRepo
  racks: RackRepo
  analyses: MixAnalysisRepo
  issues: MixIssueRepo
  processing: ProcessingJobRepo
  references: StudioReferenceRepo
  renditions: MasterRenditionRepo
  albums: StudioAlbumRepo
  collaborators: StudioCollaboratorRepo
  comments: StudioCommentRepo
  approvals: StudioApprovalRepo
  deliverables: StudioDeliverableRepo
  releaseMetadata: ReleaseMetadataRepo
  sonicDna: SonicDnaRepo
  creativeMemory: CreativeMemoryRepo
  passports: RecordPassportRepo
  contributions: ContributionRepo
  identities: IdentityVaultRepo
  aiPermissions: AiPermissionRepo
  licenseRequests: LicenseRequestRepo
  serviceProviders: ServiceProviderRepo
  serviceOrders: ServiceOrderRepo
  opportunities: OpportunityRepo
  roomExchanges: RoomExchangeRepo
}

/**
 * Providers, all replaceable. None is hardwired into a service.
 *
 * `processing` is the registry every service asks; `masterRenderer` is the
 * renderer the local adapter delegates to, kept separately so a test can
 * substitute one without having to assemble a provider around it.
 */
export interface StudioProviders {
  masterRenderer: MasterRenderer
  processing: AudioProcessingRegistry
}

/**
 * What Studio borrows from the platform.
 *
 * Audio storage, rights, consent and retention belong to the Audio
 * Intelligence layer, not to Studio. A second implementation of secure audio
 * storage would be a second place for a tenant-isolation bug to live, and the
 * Identity Vault deliberately points at the *existing* consent records rather
 * than inventing a parallel notion of what an artist agreed to.
 */
export interface StudioPlatform {
  audioAssets: AudioAssetService
  audioAssetRepo: AudioAssetRepo
  consents: ConsentRepo
  entitlements: EntitlementService
}

export interface StudioDeps {
  config: AppConfig
  logger: Logger
  clock: Clock
  db: Db
  storage: StorageDriver
  queue: DurableQueue
  audit: AuditLog
  repos: StudioRepos
  providers: StudioProviders
  platform: StudioPlatform
}

export interface Actor {
  userId: string
  orgId: string
  orgRole: string
  /** Used to resolve collaborator permissions, which are keyed by email. */
  email?: string
  displayName?: string
}

export function actorLabel(actor: Actor): string {
  return actor.displayName || actor.email || actor.userId
}

/**
 * The analysis engine's version, recorded on every analysis.
 *
 * Bumped when the analyzer set changes in a way that makes old and new numbers
 * incomparable. Two analyses from different versions are never diffed without
 * saying so.
 */
export const STUDIO_ANALYSIS_VERSION = '1.0.0'
