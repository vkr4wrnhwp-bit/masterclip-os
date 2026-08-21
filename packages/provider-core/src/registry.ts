import { AppError, silentLogger, type Logger } from '@masterclip/shared'
import type { NormalizedModel, ProviderHealth } from './types.js'
import type { VideoProvider } from './provider.js'

/**
 * Holds the live provider adapters and the merged model catalog.
 *
 * Catalog entries are cached with a TTL because listing models is a network
 * call that would otherwise happen on every routing decision; prices for
 * dynamic models are *not* served from this cache — those go back to the
 * provider per request (see cost-engine).
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, VideoProvider>()
  private catalog: NormalizedModel[] = []
  private catalogFetchedAt = 0

  constructor(
    private readonly logger: Logger = silentLogger,
    private readonly catalogTtlMs = 30 * 60_000,
  ) {}

  register(provider: VideoProvider): this {
    this.providers.set(provider.providerId, provider)
    return this
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId)
  }

  get(providerId: string): VideoProvider {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new AppError({
        kind: 'not_found',
        code: 'provider.unknown',
        message: `no provider adapter registered for "${providerId}"`,
        details: { known: [...this.providers.keys()] },
      })
    }
    return provider
  }

  list(): VideoProvider[] {
    return [...this.providers.values()]
  }

  configured(): VideoProvider[] {
    return this.list().filter((p) => p.isConfigured())
  }

  /**
   * Merged catalog across configured providers. One provider failing does not
   * blank the catalog — a broken Runway key must not stop MuAPI renders.
   */
  async models(opts: { refresh?: boolean; nowMs?: number } = {}): Promise<NormalizedModel[]> {
    const now = opts.nowMs ?? Date.now()
    if (!opts.refresh && this.catalog.length > 0 && now - this.catalogFetchedAt < this.catalogTtlMs) {
      return this.catalog
    }
    const results = await Promise.allSettled(
      this.configured().map(async (provider) => (opts.refresh ? provider.refreshCatalog() : provider.listModels())),
    )
    const merged: NormalizedModel[] = []
    results.forEach((result, index) => {
      const provider = this.configured()[index]
      if (result.status === 'fulfilled') merged.push(...result.value)
      else this.logger.warn('registry.catalog_failed', { provider: provider?.providerId, err: result.reason })
    })
    this.catalog = merged
    this.catalogFetchedAt = now
    return merged
  }

  async modelsFor(providerId: string, opts: { refresh?: boolean } = {}): Promise<NormalizedModel[]> {
    const provider = this.get(providerId)
    return opts.refresh ? provider.refreshCatalog() : provider.listModels()
  }

  async findModel(providerId: string, modelId: string): Promise<NormalizedModel> {
    const models = await this.modelsFor(providerId)
    const model = models.find((m) => m.modelId === modelId)
    if (!model) {
      throw new AppError({
        kind: 'not_found',
        code: 'provider.unknown_model',
        message: `${providerId} has no model "${modelId}"`,
      })
    }
    return model
  }

  async health(): Promise<ProviderHealth[]> {
    const results = await Promise.allSettled(this.list().map((p) => p.healthCheck()))
    return results.map((result, index) => {
      const provider = this.list()[index]
      if (result.status === 'fulfilled') return result.value
      return {
        providerId: provider?.providerId ?? 'unknown',
        status: 'unavailable' as const,
        latencyMs: null,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        checkedAt: new Date().toISOString(),
      }
    })
  }

  /** Clears the cached catalog. Called after credentials change. */
  invalidate(): void {
    this.catalog = []
    this.catalogFetchedAt = 0
  }
}
