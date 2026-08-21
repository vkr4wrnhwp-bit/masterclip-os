import type { AspectRatio, AudioMode, GenerationMode, TargetResolution } from '@masterclip/shot-schema'
import type { MicroUsd } from '@masterclip/shared'

/** Cost tier, used by routing profiles and by the cost controller's guard rails. */
export type ModelTier = 'draft' | 'standard' | 'premium'

export interface DurationSupport {
  minSeconds: number
  maxSeconds: number
  /** Providers that only accept fixed lengths (e.g. 5 or 10 seconds). */
  allowedSeconds?: number[]
  step?: number
}

export interface ModelCapabilities {
  modes: GenerationMode[]
  duration: DurationSupport
  resolutions: TargetResolution[]
  aspectRatios: AspectRatio[]
  fps: number[]
  nativeAudio: boolean
  dialogue: boolean
  firstFrame: boolean
  lastFrame: boolean
  videoReference: boolean
  extension: boolean
  maxReferenceImages: number
  seed: boolean
  negativePrompt: boolean
  maxPromptChars: number
  tier: ModelTier
  /** Provider-declared safety controls we must pass through, e.g. person generation. */
  safetyControls: string[]
}

/**
 * Pricing is expressed as a formula, not a number, because video pricing is
 * per-second (and sometimes per-second-per-resolution). `source` records where
 * the figure came from so the UI can distinguish a live provider quote from a
 * rate card we scraped into a doc.
 */
export type PriceBasis = 'per_second' | 'per_video' | 'per_megapixel_second' | 'per_credit' | 'unknown'

export interface PriceFormula {
  basis: PriceBasis
  /** Micro-USD per unit of `basis`. */
  rateMicros: MicroUsd
  /** Additional per-second charge when native audio is requested. */
  audioSurchargeMicros?: MicroUsd
  /** Rate overrides keyed by resolution, when the provider prices per tier. */
  perResolutionMicros?: Partial<Record<TargetResolution, MicroUsd>>
  minimumMicros?: MicroUsd
  notes?: string
  /** When true, the published rate is indicative and a live quote is required. */
  dynamic: boolean
  retrievedAt: string
  sourceUrl: string
}

export interface NormalizedModel {
  providerId: string
  modelId: string
  displayName: string
  family: string
  capabilities: ModelCapabilities
  pricing: PriceFormula | null
  enabled: boolean
  /** Untouched provider payload, kept for debugging and schema archaeology. */
  raw: unknown
  fetchedAt: string
  /** `catalog` = live provider API, `static` = compiled-in fallback descriptor. */
  source: 'catalog' | 'static'
}

export interface ProviderInputAsset {
  assetId: string
  sha256: string
  mime: string
  bytes: number
  /** Present when the file is on local disk (needed for multipart uploads). */
  localPath?: string
  /** Present when the provider can fetch it directly. */
  url?: string
  /** Provider-side handle from a previous upload — reused to avoid re-uploading. */
  remoteRef?: string
  width?: number
  height?: number
  durationSeconds?: number
}

/**
 * A render request in our vocabulary. Adapters translate this into provider
 * payloads; nothing above this layer knows a provider's field names.
 */
export interface CanonicalRenderRequest {
  requestId: string
  projectId: string
  shotId: string
  shotVersionId: string
  providerId: string
  modelId: string
  mode: GenerationMode
  prompt: string
  negativePrompt: string
  durationSeconds: number
  resolution: TargetResolution
  aspectRatio: AspectRatio
  fps: number
  seed: string | null
  audio: { mode: AudioMode; dialogue: string; ambient: string }
  inputs: {
    firstFrame?: ProviderInputAsset
    lastFrame?: ProviderInputAsset
    references: ProviderInputAsset[]
    video?: ProviderInputAsset
  }
  /** Absolute callback URL, already signed. Empty when polling is used. */
  webhookUrl: string
  sandbox: boolean
  maxCostMicros: MicroUsd
  metadata: Record<string, string>
}

export type QuoteSource = 'provider_quote' | 'published_rate_card' | 'heuristic'
export type QuoteConfidence = 'exact' | 'estimated' | 'unknown'

export interface PriceQuote {
  providerId: string
  modelId: string
  estimatedMicros: MicroUsd
  credits: number | null
  currency: string
  source: QuoteSource
  confidence: QuoteConfidence
  quotedAt: string
  expiresAt: string
  requestHash: string
  raw: unknown
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  /** Values the adapter had to change to satisfy the provider (e.g. 8s → 10s). */
  adjustments: Array<{ field: string; from: string; to: string; reason: string }>
}

export interface SubmittedJob {
  externalJobId: string
  providerId: string
  modelId: string
  submittedAt: string
  /** Provider-side request identifier, when distinct from the job id. */
  externalRequestId?: string
  /** Cost the provider reported at submission, when it reports one. */
  chargedMicros?: MicroUsd
  raw: unknown
}

export type ProviderJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface ProviderOutputRef {
  /** Direct download URL, or a provider-scheme reference the adapter resolves. */
  url: string
  mime: string
  index: number
  bytes?: number
  durationSeconds?: number
  width?: number
  height?: number
  hasAudio?: boolean
  /** Extra headers required to fetch the URL (auth-scoped download links). */
  headers?: Record<string, string>
}

export interface ProviderJobStatus {
  externalJobId: string
  state: ProviderJobState
  progress: number | null
  outputs: ProviderOutputRef[]
  error: { code: string; message: string; retryable: boolean } | null
  /** Actual charge, when the provider exposes it. */
  actualMicros: MicroUsd | null
  actualCredits: number | null
  billableSeconds: number | null
  raw: unknown
}

export interface CompletedJob {
  externalJobId: string
  outputs: ProviderOutputRef[]
}

export interface DownloadedAsset {
  localPath: string
  bytes: number
  sha256: string
  mime: string
  index: number
}

export interface AccountBalance {
  providerId: string
  balanceMicros: MicroUsd | null
  credits: number | null
  currency: string
  raw: unknown
}

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unconfigured'

export interface ProviderHealth {
  providerId: string
  status: HealthStatus
  latencyMs: number | null
  message: string
  checkedAt: string
}

/** Normalized webhook payload. Adapters map provider callbacks onto this. */
export interface ProviderEvent {
  providerId: string
  externalJobId: string
  /** Stable per-delivery id used to reject duplicate webhook deliveries. */
  dedupeKey: string
  status: ProviderJobStatus
  receivedAt: string
  raw: unknown
}

export interface ProviderContext {
  /** Sandbox forces mock/test modes and forbids billable calls. */
  sandbox: boolean
  publicBaseUrl: string
}
