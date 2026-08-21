import { createDb, type Db } from '@masterclip/database'
import { DurableQueue, QueueWorker, QUEUES } from '@masterclip/queue'
import { createStorage, type StorageDriver } from '@masterclip/asset-storage'
import { AuthService } from '@masterclip/auth'
import { AssetRepo, AuditLog, BibleRepo, ProjectRepo, RenderRepo } from '@masterclip/domain'
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
import { createAgentLayer, type AgentLayer } from '@masterclip/agents'
import { createLogger, loadConfig, systemClock, type AppConfig, type Clock, type Logger } from '@masterclip/shared'

export * from './render.js'
export * from './masters.js'

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

  const deps = { logger, sandbox: config.isSandbox, publicBaseUrl: config.PUBLIC_BASE_URL, now: () => clock.now() }
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
    async close() {
      await db.close()
    },
  }
}

export { QUEUES, QueueWorker }
