import type { MicroUsd } from '@masterclip/shared'
import { AnthropicClient } from './client.js'

/**
 * Structural mirror of `@masterclip/qc-engine`'s VisionClient.
 *
 * Declared here rather than imported so the agent layer does not depend on the
 * QC engine — the dependency runs the other way, and the worker wires them
 * together.
 */
export interface VisionRequestLike {
  systemPrompt: string
  userPrompt: string
  images: Array<{ base64: string; mediaType: string; label: string }>
  tier: 'fast' | 'deep'
}

export interface VisionResponseLike {
  json: unknown
  costMicros: MicroUsd
  model: string
}

const QC_SCHEMA = {
  name: 'frame_qc',
  description: 'Score generated video frames against a shot specification.',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['creative_score', 'identity_score', 'continuity_score', 'motion_score', 'realism_score', 'hard_failures', 'warnings', 'observations', 'confidence'],
    properties: {
      creative_score: { type: 'integer', minimum: 0, maximum: 100 },
      identity_score: { type: 'integer', minimum: 0, maximum: 100 },
      continuity_score: { type: 'integer', minimum: 0, maximum: 100 },
      motion_score: { type: 'integer', minimum: 0, maximum: 100 },
      realism_score: { type: 'integer', minimum: 0, maximum: 100 },
      hard_failures: { type: 'array', items: { type: 'string' } },
      warnings: { type: 'array', items: { type: 'string' } },
      observations: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
}

export interface ClaudeVisionClientOptions {
  client: AnthropicClient
  /** Cheap model for first-pass triage over every candidate. */
  fastModel: string
  /** Stronger model, used only when triage is uncertain or the clip is expensive. */
  deepModel: string
}

/**
 * Vision QC over extracted frames.
 *
 * Triage runs on the cheap model across the whole batch; escalation to the
 * strong model is the caller's decision and applies to a small minority of
 * clips. At the published rates that difference is roughly an order of
 * magnitude per frame, which is the difference between QC being a rounding
 * error and QC being a line item.
 */
export class ClaudeVisionClient {
  readonly name = 'claude'

  constructor(private readonly opts: ClaudeVisionClientOptions) {}

  async analyze(request: VisionRequestLike): Promise<VisionResponseLike> {
    const model = request.tier === 'deep' ? this.opts.deepModel : this.opts.fastModel
    const labelled = request.images
      .map((image, index) => `${index + 1}. ${image.label}`)
      .join('\n')

    const result = await this.opts.client.complete({
      model,
      system: request.systemPrompt,
      userText: `${request.userPrompt}\n\nFRAMES SUPPLIED (chronological):\n${labelled}`,
      images: request.images.map((image) => ({ base64: image.base64, mediaType: image.mediaType })),
      jsonSchema: QC_SCHEMA,
      cacheSystem: true,
      cacheTtl: '1h',
      maxTokens: 2048,
    })

    return { json: result.json, costMicros: result.costMicros, model: result.model }
  }
}
