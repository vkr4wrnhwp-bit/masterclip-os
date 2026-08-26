import { createDb, type Db } from '@masterclip/database'
import { DurableQueue, QueueWorker, QUEUES } from '@masterclip/queue'
import { createStorage, type StorageDriver } from '@masterclip/asset-storage'
import { AuthService } from '@masterclip/auth'
import { AssetRepo, AuditLog, BibleRepo, EntitlementService, LiveLabRepo, ProjectRepo, RenderRepo } from '@masterclip/domain'
import { ProviderRegistry } from '@masterclip/provider-core'
import { createMockProvider } from '@masterclip/provider-mock'
import { createMuapiProvider } from '@masterclip/provider-muapi'
import { createGoogleProvider } from '@masterclip/provider-google'
import { createFalProvider } from '@masterclip/provider-fal'
import { createRunwayProvider } from '@masterclip/provider-runway'
import { createLumaProvider } from '@masterclip/provider-luma'
import { createReplicateProvider } from '@masterclip/provider-replicate'
import { createSelfHostedProvider } from '@masterclip/provider-selfhosted'
import { CostController, CostLedger, MetricsService, QuoteStore } from '@masterclip/cost-engine'
import type { MusicComposer } from '@masterclip/ai-audio'
import type { AudioProviderBase } from '@masterclip/audio-core'
import { LiveLabService } from './live-lab.js'
import { createAgentLayer, type AgentLayer } from '@masterclip/agents'
import { createAudioLayer, estimateMicros, parseRateCard, type AudioLayer } from '@masterclip/audio-engine'
import { createSongLabLayer, type SongLabLayer } from '@masterclip/song-lab-engine'
import { createLogger, loadConfig, systemClock, type AppConfig, type Clock, type Logger } from '@masterclip/shared'

export * from './render.js'
export * from './masters.js'
export * from './live-lab.js'

/**
 * The composition root.
 *
 * One place builds every service, so the API, the worker, the CLI, and the
 * tests all run against exactly the same wiring. Anything constructed outside
 * this file is a second source of truth about how the system is assembled.
 */
export interface Runtime {
  config: AppConfig
  logger: Logger
  clock: Clock
  db: Db
  storage: StorageDriver
  queue: DurableQueue
  registry: ProviderRegistry
  auth: AuthService
  projects: ProjectRepo
  assets: AssetRepo
  bibles: BibleRepo
  renders: RenderRepo
  audit: AuditLog
  cost: CostController
  ledger: CostLedger
  quotes: QuoteStore
  metrics: MetricsService
  agents: AgentLayer
  audio: AudioLayer
  songLab: SongLabLayer
  liveLab: LiveLabRepo
  entitlements: EntitlementService
  liveLabService: LiveLabService
  close(): Promise<void>
}

export interface CreateRuntimeOptions {
  config?: AppConfig
  logger?: Logger
  clock?: Clock
  db?: Db
  storage?: StorageDriver
  /** Registers only the mock provider. Used by tests and by `--sandbox-only`. */
  mockOnly?: boolean
  workerId?: string
}

export async function createRuntime(opts: CreateRuntimeOptions = {}): Promise<Runtime> {
  const config = opts.config ?? loadConfig()
  const logger = opts.logger ?? createLogger({ level: config.LOG_LEVEL })
  const clock = opts.clock ?? systemClock
  const db = opts.db ?? (await createDb({}, config))
  const storage = opts.storage ?? createStorage(config)

  const queue = new DurableQueue(db, {
    clock,
    logger,
    leaseSeconds: config.JOB_LEASE_SECONDS,
    ...(opts.workerId ? { workerId: opts.workerId } : {}),
  })

  const deps = { logger, sandbox: config.isSandbox, publicBaseUrl: config.publicBaseUrl, now: () => clock.now() }
  const registry = new ProviderRegistry(logger)

  // The mock provider is always registered: it is what makes the whole factory
  // exercisable with no credentials and no spend.
  registry.register(createMockProvider({ ...deps, workDir: 'var/mock-provider' }))
  if (!opts.mockOnly) {
    registry.register(createMuapiProvider({ ...deps, config }))
    registry.register(createGoogleProvider({ ...deps, config }))
    registry.register(createFalProvider({ ...deps, config }))
    registry.register(createRunwayProvider({ ...deps, config }))
    registry.register(createLumaProvider({ ...deps, config }))
    registry.register(createReplicateProvider({ ...deps, config }))
    registry.register(createSelfHostedProvider({ ...deps, config }))
  }

  const liveLabRepo = new LiveLabRepo(db, clock)
  const entitlements = new EntitlementService(db, clock)
  const audioLayer = createAudioLayer({
    config,
    logger,
    db,
    storage,
    queue,
    clock,
    ...(opts.mockOnly !== undefined ? { mockOnly: opts.mockOnly } : {}),
  })

  return {
    config,
    logger,
    clock,
    db,
    storage,
    queue,
    registry,
    auth: new AuthService(db, clock),
    projects: new ProjectRepo(db, clock),
    assets: new AssetRepo(db, clock),
    bibles: new BibleRepo(db, clock),
    renders: new RenderRepo(db, clock),
    audit: new AuditLog(db, clock),
    cost: new CostController(db, config, clock),
    ledger: new CostLedger(db, clock),
    quotes: new QuoteStore(db, clock),
    metrics: new MetricsService(db, clock),
    agents: createAgentLayer(config, logger),
    audio: audioLayer,
    // Song Lab borrows the audio layer's asset, consent and Operator Desk
    // services rather than re-implementing secure audio storage.
    songLab: createSongLabLayer({
      config,
      logger,
      db,
      storage,
      queue,
      clock,
      entitlements,
      audio: {
        assets: audioLayer.assets,
        assetRepo: audioLayer.repos.assets,
        consents: audioLayer.repos.consents,
        operatorDesk: audioLayer.repos.operatorDesk,
        remix: audioLayer.repos.remix,
        providerRegistry: audioLayer.registry,
        transcription: audioLayer.transcription,
        transcripts: audioLayer.repos.transcripts,
      },
      ...(opts.mockOnly !== undefined ? { mockOnly: opts.mockOnly } : {}),
    }),
    liveLab: liveLabRepo,
    entitlements,
    liveLabService: new LiveLabService({
      liveLab: liveLabRepo,
      storage,
      clock,
      logger: logger.child({ component: 'live-lab' }),
      aiProviderId: config.LIVE_AI_PROVIDER,
      // Live Lab composes through the platform's music layer when this build
      // has one, so a configured ElevenLabs key serves the scene builder too
      // rather than Live Lab keeping a second, parallel provider stack.
      musicComposer: resolveMusicComposer(audioLayer, logger),
      // And its spend lands in the same ledger as every other audio purchase,
      // so an org's month-to-date figure is the whole truth rather than
      // everything except Live Lab.
      usageLedger: audioLayer.repos.usage,
      // The platform already knows what music costs — it prices its own the
      // same way. Live Lab asks rather than inventing a number, and an
      // unconfigured rate card yields zero here as it does everywhere else.
      estimateSceneCostMicros: (tracks) => estimateMicros(parseRateCard(config), 'music', { tracks }),
    }),
    async close() {
      await db.close()
    },
  }
}

/**
 * The platform's music generator, if this build registered one.
 *
 * Resolution is deliberately forgiving: an audio layer without a music slot is
 * a legitimate configuration, not an error, and Live Lab falls back to its own
 * local synthesizer. Failing to start the whole runtime because a *generative*
 * capability is absent would be the wrong trade.
 */
function resolveMusicComposer(audioLayer: AudioLayer, logger: Logger): MusicComposer | null {
  try {
    const provider = audioLayer.registry.resolve<MusicComposer & AudioProviderBase>('music')
    return provider ?? null
  } catch {
    logger.debug('live.ai.no_platform_music', { detail: 'no music provider registered; Live Lab uses its local synthesizer' })
    return null
  }
}

export { QUEUES, QueueWorker }
