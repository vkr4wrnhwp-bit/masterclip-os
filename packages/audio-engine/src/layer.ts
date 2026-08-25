import type { Db } from '@masterclip/database'
import type { DurableQueue } from '@masterclip/queue'
import type { StorageDriver } from '@masterclip/asset-storage'
import { AuditLog } from '@masterclip/domain'
import { AnthropicClient } from '@masterclip/agents'
import { systemClock, type AppConfig, type Clock, type Logger } from '@masterclip/shared'
import { AudioProviderRegistry, type StructuredReasoningProvider } from '@masterclip/audio-core'
import {
  ClaudeReasoningProvider,
  ElevenLabsClient,
  HeuristicReasoningProvider,
  createElevenLabsAudioProviders,
  createMockAudioProviders,
} from '@masterclip/audio-providers'
import {
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
import type { AudioEngineDeps, AudioRepos } from './deps.js'
import { AudioAccessControl } from './access.js'
import { AudioAssetService } from './assets.js'
import { TranscriptionService } from './transcription.js'
import { MeetingService } from './meetings.js'
import { BriefService } from './briefs.js'
import { OperatorAgentService } from './operator-agent.js'
import { GlobalReleaseService } from './global-release.js'
import { CampaignService } from './campaign.js'
import { RemixService } from './remix.js'
import { VoiceVaultService } from './voice-vault.js'
import { RetentionService } from './retention.js'
import { AudioWebhookService } from './webhooks.js'

export interface AudioLayer {
  registry: AudioProviderRegistry
  reasoning: StructuredReasoningProvider
  /** Present when ElevenLabs is registered; used for admin account-usage probes. */
  elevenLabsClient: ElevenLabsClient | null
  repos: AudioRepos
  access: AudioAccessControl
  assets: AudioAssetService
  transcription: TranscriptionService
  meetings: MeetingService
  briefs: BriefService
  operatorAgent: OperatorAgentService
  globalRelease: GlobalReleaseService
  campaigns: CampaignService
  remix: RemixService
  voiceVault: VoiceVaultService
  retention: RetentionService
  webhooks: AudioWebhookService
}

export interface CreateAudioLayerOptions {
  config: AppConfig
  logger: Logger
  db: Db
  storage: StorageDriver
  queue: DurableQueue
  clock?: Clock
  /** Registers only the mock providers — used by tests and sandbox-only runs. */
  mockOnly?: boolean
}

/**
 * Composition root for the audio layer, mirroring the platform's Runtime: one
 * place wires providers, repos and services, so the API, worker, CLI and tests
 * agree on the assembly.
 */
export function createAudioLayer(opts: CreateAudioLayerOptions): AudioLayer {
  const clock = opts.clock ?? systemClock
  const registry = new AudioProviderRegistry()
  // The mock is always registered — it is what keeps every workflow
  // exercisable with zero credentials and zero spend.
  registry.register(createMockAudioProviders())
  let elevenLabsClient: ElevenLabsClient | null = null
  if (!opts.mockOnly && opts.config.ELEVENLABS_ENABLED) {
    elevenLabsClient = new ElevenLabsClient({
      apiKey: opts.config.ELEVENLABS_API_KEY,
      baseUrl: opts.config.ELEVENLABS_BASE_URL,
      sttModelId: opts.config.ELEVENLABS_STT_MODEL,
      ttsModelId: opts.config.ELEVENLABS_TTS_MODEL,
      ttsDefaultVoiceId: opts.config.ELEVENLABS_TTS_VOICE_ID,
      musicModelId: opts.config.ELEVENLABS_MUSIC_MODEL,
      sfxModelId: opts.config.ELEVENLABS_SFX_MODEL,
      zeroRetentionCapable: opts.config.ELEVENLABS_ZERO_RETENTION_CAPABLE,
      logger: opts.logger,
    })
    registry.register(createElevenLabsAudioProviders(elevenLabsClient.opts, elevenLabsClient))
    if (opts.config.ELEVENLABS_API_KEY) {
      registry.configureDefaults(
        {
          transcription: 'elevenlabs',
          speech: 'elevenlabs',
          agent: 'elevenlabs',
          dubbing: 'elevenlabs',
          music: 'elevenlabs',
          stems: 'elevenlabs',
          isolation: 'elevenlabs',
          soundEffects: 'elevenlabs',
          voiceIdentity: 'elevenlabs',
        },
        {
          transcription: 'mock-audio',
          speech: 'mock-audio',
          agent: 'mock-audio',
          dubbing: 'mock-audio',
          music: 'mock-audio',
          stems: 'mock-audio',
          isolation: 'mock-audio',
          soundEffects: 'mock-audio',
          voiceIdentity: 'mock-audio',
        },
      )
    }
  }

  const anthropic = new AnthropicClient({ config: opts.config, logger: opts.logger })
  const reasoning: StructuredReasoningProvider = anthropic.isConfigured()
    ? new ClaudeReasoningProvider(anthropic)
    : new HeuristicReasoningProvider()

  const repos: AudioRepos = {
    policy: new AudioPolicyRepo(opts.db, clock),
    assets: new AudioAssetRepo(opts.db, clock),
    jobs: new AudioJobRepo(opts.db, clock),
    transcripts: new TranscriptRepo(opts.db, clock),
    meetings: new MeetingRepo(opts.db, clock),
    operatorDesk: new OperatorDeskRepo(opts.db, clock),
    briefs: new BriefRepo(opts.db, clock),
    agents: new AudioAgentRepo(opts.db, clock),
    consents: new ConsentRepo(opts.db, clock),
    voiceVault: new VoiceVaultRepo(opts.db, clock),
    dubbing: new DubbingRepo(opts.db, clock),
    campaigns: new CampaignRepo(opts.db, clock),
    remix: new RemixRepo(opts.db, clock),
    usage: new AudioUsageRepo(opts.db, clock),
    webhookEvents: new WebhookEventRepo(opts.db, clock),
  }

  const deps: AudioEngineDeps = {
    config: opts.config,
    logger: opts.logger,
    clock,
    db: opts.db,
    storage: opts.storage,
    queue: opts.queue,
    registry,
    reasoning,
    audit: new AuditLog(opts.db, clock),
    repos,
  }

  const assets = new AudioAssetService(deps)
  const transcription = new TranscriptionService(deps, assets)
  const operatorAgent = new OperatorAgentService(deps)
  return {
    registry,
    reasoning,
    elevenLabsClient,
    repos,
    access: new AudioAccessControl(opts.config, opts.db, repos.policy, repos.usage, registry),
    assets,
    transcription,
    meetings: new MeetingService(deps, assets, transcription),
    briefs: new BriefService(deps, assets),
    operatorAgent,
    globalRelease: new GlobalReleaseService(deps, assets, transcription),
    campaigns: new CampaignService(deps, assets),
    remix: new RemixService(deps, assets),
    voiceVault: new VoiceVaultService(deps),
    retention: new RetentionService(deps, assets),
    webhooks: new AudioWebhookService(deps, operatorAgent),
  }
}
