import type { Db } from '@masterclip/database'
import type { DurableQueue } from '@masterclip/queue'
import type { StorageDriver } from '@masterclip/asset-storage'
import type { AuditLog } from '@masterclip/domain'
import type { AppConfig, Clock, Logger } from '@masterclip/shared'
import type { AudioProviderRegistry, StructuredReasoningProvider } from '@masterclip/audio-core'
import type {
  AudioAgentRepo,
  AudioAssetRepo,
  AudioJobRepo,
  AudioPolicyRepo,
  AudioUsageRepo,
  BriefRepo,
  CampaignRepo,
  ConsentRepo,
  DubbingRepo,
  MeetingRepo,
  OperatorDeskRepo,
  RemixRepo,
  TranscriptRepo,
  VoiceVaultRepo,
  WebhookEventRepo,
} from '@masterclip/audio-domain'

export interface AudioRepos {
  policy: AudioPolicyRepo
  assets: AudioAssetRepo
  jobs: AudioJobRepo
  transcripts: TranscriptRepo
  meetings: MeetingRepo
  operatorDesk: OperatorDeskRepo
  briefs: BriefRepo
  agents: AudioAgentRepo
  consents: ConsentRepo
  voiceVault: VoiceVaultRepo
  dubbing: DubbingRepo
  campaigns: CampaignRepo
  remix: RemixRepo
  usage: AudioUsageRepo
  webhookEvents: WebhookEventRepo
}

/** Everything a service needs, built once in the audio layer composition. */
export interface AudioEngineDeps {
  config: AppConfig
  logger: Logger
  clock: Clock
  db: Db
  storage: StorageDriver
  queue: DurableQueue
  registry: AudioProviderRegistry
  reasoning: StructuredReasoningProvider
  audit: AuditLog
  repos: AudioRepos
}

export interface Actor {
  userId: string
  orgId: string
  orgRole: string
}
