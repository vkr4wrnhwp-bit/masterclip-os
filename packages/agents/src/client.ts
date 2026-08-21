import { AppError, httpJson, loadConfig, silentLogger, type AppConfig, type Logger, type MicroUsd } from '@masterclip/shared'

/**
 * Anthropic Messages API client.
 *
 * Built directly on the REST surface rather than the SDK, for two reasons that
 * matter here: the worker bundles must stay small and dependency-pinned, and
 * every call has to report its exact token usage into the same cost ledger as
 * the video providers. An LLM call that does not land in the ledger is spend
 * the cost dashboard cannot see.
 *
 * Pricing table retrieved 2026-08-17 from platform.claude.com/docs pricing.
 */
export interface ModelPricing {
  inputPerMTokUsd: number
  outputPerMTokUsd: number
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-fable-5': { inputPerMTokUsd: 10, outputPerMTokUsd: 50 },
  'claude-opus-5': { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  'claude-sonnet-5': { inputPerMTokUsd: 2, outputPerMTokUsd: 10 },
  'claude-haiku-4-5': { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
  'claude-haiku-4-5-20251001': { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
  'claude-opus-4-8': { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  'claude-sonnet-4-6': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
}

/**
 * Cache-write and cache-read multipliers on the input rate. A 5-minute cache
 * write costs 1.25× input; a 1-hour write costs 2×; reads are 0.1×.
 */
export const CACHE_WRITE_MULTIPLIER_5M = 1.25
export const CACHE_WRITE_MULTIPLIER_1H = 2
export const CACHE_READ_MULTIPLIER = 0.1

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export function costMicros(model: string, usage: Usage, cacheTtl: '5m' | '1h' = '5m'): MicroUsd {
  const pricing = MODEL_PRICING[model]
  // An unknown model id must not silently cost zero — that would hide spend.
  if (!pricing) return -1
  const writeMultiplier = cacheTtl === '1h' ? CACHE_WRITE_MULTIPLIER_1H : CACHE_WRITE_MULTIPLIER_5M
  const usd =
    (usage.inputTokens * pricing.inputPerMTokUsd +
      usage.outputTokens * pricing.outputPerMTokUsd +
      usage.cacheCreationTokens * pricing.inputPerMTokUsd * writeMultiplier +
      usage.cacheReadTokens * pricing.inputPerMTokUsd * CACHE_READ_MULTIPLIER) /
    1_000_000
  return Math.round(usd * 1_000_000)
}

export interface ImageInput {
  base64: string
  mediaType: string
}

export interface CompletionRequest {
  model?: string
  system: string
  userText: string
  images?: ImageInput[]
  maxTokens?: number
  temperature?: number
  /**
   * Forces the model to answer through a tool with this JSON Schema, so the
   * result is validated structure rather than prose that has to be parsed.
   */
  jsonSchema?: { name: string; description: string; schema: Record<string, unknown> }
  /** Marks the system prompt as cacheable — worth it for repeated agent calls. */
  cacheSystem?: boolean
  cacheTtl?: '5m' | '1h'
  timeoutMs?: number
}

export interface CompletionResult<T = unknown> {
  json: T | null
  text: string
  usage: Usage
  costMicros: MicroUsd
  model: string
  stopReason: string
  latencyMs: number
}

export interface AnthropicClientOptions {
  config?: AppConfig
  apiKey?: string
  baseUrl?: string
  logger?: Logger
  defaultModel?: string
}

export class AnthropicClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly logger: Logger
  private readonly defaultModel: string

  constructor(opts: AnthropicClientOptions = {}) {
    const config = opts.config ?? loadConfig()
    this.apiKey = opts.apiKey ?? config.ANTHROPIC_API_KEY
    this.baseUrl = (opts.baseUrl ?? config.ANTHROPIC_BASE_URL).replace(/\/+$/, '')
    this.logger = opts.logger ?? silentLogger
    this.defaultModel = opts.defaultModel ?? config.ANTHROPIC_MODEL
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0
  }

  async complete<T = unknown>(request: CompletionRequest): Promise<CompletionResult<T>> {
    if (!this.isConfigured()) {
      throw new AppError({
        kind: 'unauthorized',
        code: 'anthropic.no_key',
        message: 'ANTHROPIC_API_KEY is not set — the Claude agent layer is unavailable',
      })
    }

    const model = request.model ?? this.defaultModel
    const content: Array<Record<string, unknown>> = []
    for (const image of request.images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } })
    }
    content.push({ type: 'text', text: request.userText })

    const system = request.cacheSystem
      ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral', ...(request.cacheTtl === '1h' ? { ttl: '1h' } : {}) } }]
      : request.system

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      system,
      messages: [{ role: 'user', content }],
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.jsonSchema) {
      body.tools = [
        {
          name: request.jsonSchema.name,
          description: request.jsonSchema.description,
          input_schema: request.jsonSchema.schema,
        },
      ]
      body.tool_choice = { type: 'tool', name: request.jsonSchema.name }
    }

    const response = await httpJson<Record<string, unknown>>(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
      provider: 'anthropic',
      logger: this.logger,
      timeoutMs: request.timeoutMs ?? 180_000,
    })

    const usageRaw = (response.body.usage ?? {}) as Record<string, unknown>
    const usage: Usage = {
      inputTokens: Number(usageRaw.input_tokens ?? 0),
      outputTokens: Number(usageRaw.output_tokens ?? 0),
      cacheCreationTokens: Number(usageRaw.cache_creation_input_tokens ?? 0),
      cacheReadTokens: Number(usageRaw.cache_read_input_tokens ?? 0),
    }

    const blocks = (response.body.content ?? []) as Array<Record<string, unknown>>
    const toolBlock = blocks.find((b) => b.type === 'tool_use')
    const textBlock = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n')

    return {
      json: (toolBlock?.input as T) ?? (textBlock ? tryParseJson<T>(textBlock) : null),
      text: textBlock,
      usage,
      costMicros: costMicros(model, usage, request.cacheTtl ?? '5m'),
      model,
      stopReason: String(response.body.stop_reason ?? ''),
      latencyMs: response.latencyMs,
    }
  }
}

/** Models sometimes wrap JSON in prose or a fenced block; recover both. */
function tryParseJson<T>(text: string): T | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  try {
    return JSON.parse(candidate) as T
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as T
      } catch {
        return null
      }
    }
    return null
  }
}
