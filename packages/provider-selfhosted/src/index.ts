import { randomUUID } from 'node:crypto'
import { AppError, httpJson, loadConfig, usdToMicros, type AppConfig, type MicroUsd } from '@masterclip/shared'
import {
  BaseProvider,
  QUOTE_TTL_MS,
  downloadProviderOutputs,
  priceRequestHash,
  type CanonicalRenderRequest,
  type CompletedJob,
  type DownloadedAsset,
  type ModelCapabilities,
  type NormalizedModel,
  type PriceQuote,
  type ProviderDeps,
  type ProviderHealth,
  type ProviderJobStatus,
  type ProviderOutputRef,
  type SubmittedJob,
} from '@masterclip/provider-core'

const RETRIEVED_AT = '2026-08-17'

/**
 * Self-hosted ComfyUI adapter.
 *
 * Endpoints verified 2026-08-17 against ComfyUI's server routes:
 *
 *   submit   POST /api/prompt      { prompt: <workflow graph>, client_id, prompt_id }
 *   status   GET  /api/history/{prompt_id}
 *   output   GET  /api/view?filename=&subfolder=&type=output
 *   upload   POST /api/upload/image
 *   health   GET  /api/system_stats
 *
 * The `/api/*` prefix is preferred over the bare paths: both work, but `/api/*`
 * is the stable surface and does not collide with the web UI's static routes.
 *
 * PRICING: a self-hosted endpoint has no per-request price — it has an hourly
 * GPU cost. This adapter therefore prices a render as
 * `gpuUsdPerHour × observed seconds`, using the operator-supplied hourly rate
 * and a measured throughput estimate. That figure is honest only once the
 * benchmark has run, which is exactly why `SELF_HOSTED_DRAFT` is not a default
 * routing profile: see docs/cost-strategy.md on when self-hosting actually wins.
 */
export interface SelfHostedProviderOptions extends ProviderDeps {
  config?: AppConfig
  baseUrl?: string
  apiKey?: string
  /** Operator-supplied GPU price. Without it, this provider cannot quote. */
  gpuUsdPerHour?: number
  /** Measured wall-clock seconds of GPU time per second of output video. */
  secondsOfComputePerSecondOfVideo?: number
  /** Workflow graphs keyed by model id, with `{{placeholders}}` for inputs. */
  workflows?: Record<string, { displayName: string; graph: Record<string, unknown>; capabilities: ModelCapabilities }>
}

export class SelfHostedProvider extends BaseProvider {
  readonly providerId = 'selfhosted'
  readonly displayName = 'Self-hosted (ComfyUI)'

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly gpuUsdPerHour: number | null
  private readonly computeRatio: number | null
  private readonly workflows: NonNullable<SelfHostedProviderOptions['workflows']>
  private readonly clientId = randomUUID().replace(/-/g, '')

  constructor(opts: SelfHostedProviderOptions) {
    super(opts)
    const config = opts.config ?? loadConfig()
    this.baseUrl = (opts.baseUrl ?? config.COMFYUI_BASE_URL).replace(/\/+$/, '')
    this.apiKey = opts.apiKey ?? config.COMFYUI_API_KEY
    this.gpuUsdPerHour = opts.gpuUsdPerHour ?? null
    this.computeRatio = opts.secondsOfComputePerSecondOfVideo ?? null
    this.workflows = opts.workflows ?? {}
  }

  isConfigured(): boolean {
    return this.baseUrl.length > 0 && Object.keys(this.workflows).length > 0
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) }
  }

  async listModels(): Promise<NormalizedModel[]> {
    const fetchedAt = new Date(this.deps.now()).toISOString()
    return Object.entries(this.workflows).map(([modelId, workflow]) => ({
      providerId: this.providerId,
      modelId,
      displayName: workflow.displayName,
      family: 'selfhosted',
      capabilities: workflow.capabilities,
      pricing:
        this.gpuUsdPerHour !== null && this.computeRatio !== null
          ? {
              basis: 'per_second' as const,
              rateMicros: usdToMicros((this.gpuUsdPerHour / 3600) * this.computeRatio),
              dynamic: false,
              retrievedAt: RETRIEVED_AT,
              sourceUrl: 'operator-configured GPU rate',
              notes: `derived from $${this.gpuUsdPerHour}/GPU-hour × ${this.computeRatio}s compute per second of video; excludes idle time, cold starts, storage and egress`,
            }
          : null,
      enabled: true,
      raw: { workflowNodes: Object.keys(workflow.graph).length },
      fetchedAt,
      source: 'static' as const,
    }))
  }

  /**
   * Refuses to guess. A self-hosted endpoint with no measured throughput cannot
   * be priced, and quoting zero would make it win every routing decision on
   * cost — the exact failure the cost model exists to prevent.
   */
  override async quote(request: CanonicalRenderRequest): Promise<PriceQuote> {
    const now = this.deps.now()
    if (this.gpuUsdPerHour === null || this.computeRatio === null) {
      return {
        providerId: this.providerId,
        modelId: request.modelId,
        estimatedMicros: 0,
        credits: null,
        currency: 'USD',
        source: 'heuristic',
        confidence: 'unknown',
        quotedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
        requestHash: priceRequestHash(request),
        raw: { note: 'configure gpuUsdPerHour and secondsOfComputePerSecondOfVideo (run the benchmark) before routing spend here' },
      }
    }
    const micros: MicroUsd = Math.round(usdToMicros((this.gpuUsdPerHour / 3600) * this.computeRatio) * request.durationSeconds)
    return {
      providerId: this.providerId,
      modelId: request.modelId,
      estimatedMicros: micros,
      credits: null,
      currency: 'USD',
      source: 'heuristic',
      confidence: 'estimated',
      quotedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
      requestHash: priceRequestHash(request),
      raw: { gpuUsdPerHour: this.gpuUsdPerHour, computeRatio: this.computeRatio, excludes: ['idle time', 'cold start', 'storage', 'egress'] },
    }
  }

  async submit(request: CanonicalRenderRequest): Promise<SubmittedJob> {
    const workflow = this.workflows[request.modelId]
    if (!workflow) {
      throw new AppError({ kind: 'not_found', code: 'selfhosted.no_workflow', message: `no workflow registered for ${request.modelId}` })
    }
    const promptId = randomUUID()
    const graph = substitute(workflow.graph, {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt,
      width: String(request.metadata.width ?? ''),
      height: String(request.metadata.height ?? ''),
      duration: String(request.durationSeconds),
      fps: String(request.fps),
      seed: request.seed ?? String(Math.floor(Math.random() * 2 ** 31)),
      image_url: request.inputs.firstFrame?.remoteRef ?? request.inputs.firstFrame?.url ?? '',
    })

    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/api/prompt`, {
      method: 'POST',
      headers: this.headers(),
      body: { prompt: graph, client_id: this.clientId, prompt_id: promptId },
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 60_000,
    })

    const nodeErrors = response.body.node_errors as Record<string, unknown> | undefined
    if (nodeErrors && Object.keys(nodeErrors).length > 0) {
      throw new AppError({
        kind: 'provider_rejected',
        code: 'selfhosted.node_errors',
        message: `ComfyUI rejected the workflow: ${JSON.stringify(nodeErrors).slice(0, 400)}`,
      })
    }

    return {
      externalJobId: String(response.body.prompt_id ?? promptId),
      providerId: this.providerId,
      modelId: request.modelId,
      submittedAt: new Date(this.deps.now()).toISOString(),
      externalRequestId: request.requestId,
      raw: response.body,
    }
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/api/history/${encodeURIComponent(externalJobId)}`, {
      headers: this.headers(),
      provider: this.providerId,
      logger: this.deps.logger,
      timeoutMs: 30_000,
    })
    const entry = response.body[externalJobId] as Record<string, unknown> | undefined

    // An absent history entry means still queued or running: ComfyUI only
    // writes history on completion.
    if (!entry) {
      return {
        externalJobId,
        state: 'running',
        progress: null,
        outputs: [],
        error: null,
        actualMicros: null,
        actualCredits: null,
        billableSeconds: null,
        raw: response.body,
      }
    }

    const status = (entry.status ?? {}) as Record<string, unknown>
    const completed = status.completed === true
    const statusStr = String(status.status_str ?? '')

    if (statusStr === 'error') {
      return {
        externalJobId,
        state: 'failed',
        progress: null,
        outputs: [],
        error: { code: 'selfhosted.execution_error', message: JSON.stringify(status.messages ?? 'execution error').slice(0, 500), retryable: false },
        actualMicros: null,
        actualCredits: null,
        billableSeconds: null,
        raw: entry,
      }
    }

    return {
      externalJobId,
      state: completed ? 'succeeded' : 'running',
      progress: completed ? 1 : null,
      outputs: completed ? this.extractOutputs(entry) : [],
      error: null,
      actualMicros: null,
      actualCredits: null,
      billableSeconds: null,
      raw: entry,
    }
  }

  private extractOutputs(entry: Record<string, unknown>): ProviderOutputRef[] {
    const outputs = (entry.outputs ?? {}) as Record<string, Record<string, unknown>>
    const refs: ProviderOutputRef[] = []
    let index = 0
    for (const node of Object.values(outputs)) {
      for (const key of ['gifs', 'videos', 'images']) {
        const items = node[key]
        if (!Array.isArray(items)) continue
        for (const item of items as Array<Record<string, unknown>>) {
          const url = new URL(`${this.baseUrl}/api/view`)
          url.searchParams.set('filename', String(item.filename ?? ''))
          url.searchParams.set('subfolder', String(item.subfolder ?? ''))
          url.searchParams.set('type', String(item.type ?? 'output'))
          refs.push({
            url: url.toString(),
            mime: String(item.format ?? (key === 'images' ? 'image/png' : 'video/mp4')),
            index: index++,
            ...(this.apiKey ? { headers: { authorization: `Bearer ${this.apiKey}` } } : {}),
          })
        }
      }
    }
    return refs
  }

  async cancel(): Promise<void> {
    await httpJson(`${this.baseUrl}/api/interrupt`, { method: 'POST', headers: this.headers(), provider: this.providerId, timeoutMs: 15_000 })
  }

  async downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
    return downloadProviderOutputs(job, destDir)
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = new Date(this.deps.now()).toISOString()
    if (!this.baseUrl) {
      return { providerId: this.providerId, status: 'unconfigured', latencyMs: null, message: 'COMFYUI_BASE_URL is not set', checkedAt }
    }
    try {
      const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/api/system_stats`, {
        headers: this.headers(),
        provider: this.providerId,
        timeoutMs: 15_000,
      })
      const devices = (response.body.devices ?? []) as Array<Record<string, unknown>>
      const gpu = devices[0]
      return {
        providerId: this.providerId,
        status: response.latencyMs > 5_000 ? 'degraded' : 'healthy',
        latencyMs: response.latencyMs,
        message: gpu ? `${String(gpu.name ?? 'gpu')} — ${Math.round(Number(gpu.vram_free ?? 0) / 1e9)}GB VRAM free` : 'reachable',
        checkedAt,
      }
    } catch (err) {
      return { providerId: this.providerId, status: 'unavailable', latencyMs: null, message: err instanceof Error ? err.message : String(err), checkedAt }
    }
  }
}

/** Replaces `{{key}}` placeholders throughout a workflow graph. */
export function substitute(graph: Record<string, unknown>, values: Record<string, string>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in values ? values[key] ?? '' : match))
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v)
      return out
    }
    return node
  }
  return walk(graph) as Record<string, unknown>
}

export function createSelfHostedProvider(opts: SelfHostedProviderOptions): SelfHostedProvider {
  return new SelfHostedProvider(opts)
}
