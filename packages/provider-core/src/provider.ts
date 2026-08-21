import { AppError, type Logger } from '@masterclip/shared'
import type {
  AccountBalance,
  CanonicalRenderRequest,
  CompletedJob,
  DownloadedAsset,
  ModelCapabilities,
  NormalizedModel,
  PriceQuote,
  ProviderEvent,
  ProviderHealth,
  ProviderJobStatus,
  SubmittedJob,
  ValidationResult,
} from './types.js'

/**
 * The single interface every rendering backend implements — aggregators
 * (MuAPI, fal, Replicate), direct APIs (Google, Runway, Luma), and self-hosted
 * endpoints alike. Nothing above this layer branches on provider identity.
 *
 * Optional members mark genuine capability differences, not unfinished work:
 * `cancel` and `normalizeWebhook` are absent where the provider has no such
 * endpoint, and callers must handle their absence rather than assume it.
 */
export interface VideoProvider {
  readonly providerId: string
  readonly displayName: string

  listModels(): Promise<NormalizedModel[]>
  refreshCatalog(): Promise<NormalizedModel[]>
  getCapabilities(modelId: string): Promise<ModelCapabilities>

  /**
   * Price for exactly this request. Implementations must prefer a live provider
   * estimate endpoint and only fall back to a published rate card, flagging the
   * difference through `PriceQuote.source`.
   */
  quote(request: CanonicalRenderRequest): Promise<PriceQuote>

  /** Local, free pre-flight. Must not call the provider's billable endpoints. */
  validate(request: CanonicalRenderRequest): Promise<ValidationResult>

  submit(request: CanonicalRenderRequest): Promise<SubmittedJob>
  getStatus(externalJobId: string): Promise<ProviderJobStatus>
  cancel?(externalJobId: string): Promise<void>

  normalizeWebhook?(payload: unknown, headers: Headers): Promise<ProviderEvent>

  downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]>

  getAccountBalance?(): Promise<AccountBalance>
  healthCheck(): Promise<ProviderHealth>

  /** True when credentials are present. Unconfigured providers stay listed but unusable. */
  isConfigured(): boolean
}

export interface ProviderDeps {
  logger: Logger
  sandbox: boolean
  publicBaseUrl: string
  now: () => number
}

export abstract class BaseProvider implements VideoProvider {
  abstract readonly providerId: string
  abstract readonly displayName: string

  protected constructor(protected readonly deps: ProviderDeps) {}

  abstract listModels(): Promise<NormalizedModel[]>
  abstract submit(request: CanonicalRenderRequest): Promise<SubmittedJob>
  abstract getStatus(externalJobId: string): Promise<ProviderJobStatus>
  abstract downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]>
  abstract healthCheck(): Promise<ProviderHealth>
  abstract isConfigured(): boolean

  async refreshCatalog(): Promise<NormalizedModel[]> {
    return this.listModels()
  }

  async getCapabilities(modelId: string): Promise<ModelCapabilities> {
    const models = await this.listModels()
    const model = models.find((m) => m.modelId === modelId)
    if (!model) {
      throw new AppError({
        kind: 'not_found',
        code: 'provider.unknown_model',
        message: `${this.providerId} has no model ${modelId}`,
      })
    }
    return model.capabilities
  }

  async quote(request: CanonicalRenderRequest): Promise<PriceQuote> {
    const models = await this.listModels()
    const model = models.find((m) => m.modelId === request.modelId)
    if (!model?.pricing) {
      throw new AppError({
        kind: 'validation',
        code: 'provider.no_pricing',
        message: `${this.providerId}/${request.modelId} has no published price; a live quote is required before submission`,
      })
    }
    const { estimateFromFormula } = await import('./pricing.js')
    return estimateFromFormula(this.providerId, request, model.pricing, this.deps.now())
  }

  async validate(request: CanonicalRenderRequest): Promise<ValidationResult> {
    const capabilities = await this.getCapabilities(request.modelId)
    const { validateAgainstCapabilities } = await import('./capability.js')
    return validateAgainstCapabilities(request, capabilities)
  }

  /** Convenience for adapters: the callback URL to hand the provider. */
  protected webhookUrlFor(request: CanonicalRenderRequest): string {
    return request.webhookUrl
  }
}
