import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { AppError, hashObject, sha256File, silentLogger, usdToMicros, type Logger } from '@masterclip/shared'
import { generateTestVideo, type TestPattern } from '@masterclip/media-tools'
import {
  BaseProvider,
  perSecondUsd,
  quoteFromProvider,
  type AccountBalance,
  type CanonicalRenderRequest,
  type CompletedJob,
  type DownloadedAsset,
  type ModelCapabilities,
  type NormalizedModel,
  type PriceQuote,
  type ProviderDeps,
  type ProviderEvent,
  type ProviderHealth,
  type ProviderJobStatus,
  type SubmittedJob,
} from '@masterclip/provider-core'
import { frameSize, type AspectRatio, type TargetResolution } from '@masterclip/shot-schema'

const RETRIEVED_AT = '2026-08-17'
const SOURCE = 'internal://masterclip/mock-provider'

/**
 * Deterministic local provider that renders **real** MP4 files with ffmpeg.
 *
 * It exists so the entire factory — submit, poll, webhook, download, checksum,
 * technical QC, proxy build, contact sheet, review, master finishing, delivery
 * export, cost ledger — runs end to end at zero cost, and so QC's failure
 * detection can be *proven* rather than asserted: the mock deliberately emits
 * black, frozen, truncated, low-bitrate, and short outputs at a configurable
 * rate, chosen deterministically from the request id.
 *
 * Its prices are simulated and every ledger entry it produces is marked
 * `sandbox`, so nothing it does can touch the live-spend cap.
 */
export interface MockProviderOptions extends ProviderDeps {
  /** Where generated media and job state live. */
  workDir?: string
  /** Simulated provider latency before a job completes. */
  latencyMs?: number
  /** Fraction of jobs that come back defective. 0 disables defects. */
  defectRate?: number
  /** Fraction of submissions that fail outright (provider-side error). */
  failureRate?: number
}

interface MockJobState {
  externalJobId: string
  requestId: string
  modelId: string
  createdAtMs: number
  readyAtMs: number
  width: number
  height: number
  fps: number
  durationSeconds: number
  withAudio: boolean
  pattern: TestPattern
  outcome: 'succeed' | 'fail'
  variantSeed: number
  outputPath: string
  estimatedMicros: number
}

const MOCK_MODELS: Array<{
  modelId: string
  displayName: string
  family: string
  usdPerSecond: number
  capabilities: ModelCapabilities
}> = [
  {
    modelId: 'mock-draft',
    displayName: 'Mock Draft (fast, low-res)',
    family: 'mock',
    usdPerSecond: 0.012,
    capabilities: {
      modes: ['text_to_video', 'image_to_video'],
      duration: { minSeconds: 2, maxSeconds: 8, allowedSeconds: [2, 4, 5, 6, 8] },
      resolutions: ['480p', '540p', '720p'],
      aspectRatios: ['16:9', '9:16', '1:1', '4:5'],
      fps: [24],
      nativeAudio: false,
      dialogue: false,
      firstFrame: true,
      lastFrame: false,
      videoReference: false,
      extension: false,
      maxReferenceImages: 1,
      seed: true,
      negativePrompt: true,
      maxPromptChars: 1500,
      tier: 'draft',
      safetyControls: [],
    },
  },
  {
    modelId: 'mock-standard',
    displayName: 'Mock Standard (balanced)',
    family: 'mock',
    usdPerSecond: 0.05,
    capabilities: {
      modes: ['text_to_video', 'image_to_video', 'first_last_frame', 'reference_to_video'],
      duration: { minSeconds: 2, maxSeconds: 10, allowedSeconds: [4, 5, 6, 8, 10] },
      resolutions: ['480p', '540p', '720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1', '4:5', '21:9'],
      fps: [24, 30],
      nativeAudio: false,
      dialogue: false,
      firstFrame: true,
      lastFrame: true,
      videoReference: false,
      extension: false,
      maxReferenceImages: 3,
      seed: true,
      negativePrompt: true,
      maxPromptChars: 3000,
      tier: 'standard',
      safetyControls: ['person_generation'],
    },
  },
  {
    modelId: 'mock-hero',
    displayName: 'Mock Hero (premium, native audio)',
    family: 'mock',
    usdPerSecond: 0.12,
    capabilities: {
      modes: ['text_to_video', 'image_to_video', 'first_last_frame', 'reference_to_video'],
      duration: { minSeconds: 4, maxSeconds: 10, allowedSeconds: [4, 6, 8, 10] },
      resolutions: ['720p', '1080p', '1440p'],
      aspectRatios: ['16:9', '9:16', '1:1', '4:5', '21:9', '2.39:1'],
      fps: [24, 30],
      nativeAudio: true,
      dialogue: true,
      firstFrame: true,
      lastFrame: true,
      videoReference: false,
      extension: false,
      maxReferenceImages: 4,
      seed: true,
      negativePrompt: true,
      maxPromptChars: 4000,
      tier: 'premium',
      safetyControls: ['person_generation', 'celebrity_block'],
    },
  },
  {
    modelId: 'mock-edit',
    displayName: 'Mock Edit (video-to-video, extension)',
    family: 'mock',
    usdPerSecond: 0.08,
    capabilities: {
      modes: ['video_to_video', 'video_extend'],
      duration: { minSeconds: 2, maxSeconds: 12 },
      resolutions: ['720p', '1080p'],
      aspectRatios: ['16:9', '9:16', '1:1'],
      fps: [24],
      nativeAudio: false,
      dialogue: false,
      firstFrame: false,
      lastFrame: false,
      videoReference: true,
      extension: true,
      maxReferenceImages: 0,
      seed: false,
      negativePrompt: true,
      maxPromptChars: 2000,
      tier: 'standard',
      safetyControls: [],
    },
  },
]

/** Defect mix modelled on the real failure distribution these checks exist for. */
const DEFECT_PATTERNS: TestPattern[] = ['frozen', 'black', 'wrong_duration', 'low_bitrate', 'truncated']

export class MockProvider extends BaseProvider {
  readonly providerId = 'mock'
  readonly displayName = 'Mock (local ffmpeg sandbox)'

  private readonly workDir: string
  private readonly latencyMs: number
  private readonly defectRate: number
  private readonly failureRate: number
  private readonly log: Logger

  constructor(opts: MockProviderOptions) {
    super(opts)
    this.workDir = resolve(opts.workDir ?? 'var/mock-provider')
    this.latencyMs = opts.latencyMs ?? 1_500
    this.defectRate = clamp01(opts.defectRate ?? 0.25)
    this.failureRate = clamp01(opts.failureRate ?? 0.05)
    this.log = opts.logger ?? silentLogger
  }

  isConfigured(): boolean {
    return true
  }

  async listModels(): Promise<NormalizedModel[]> {
    const fetchedAt = new Date(this.deps.now()).toISOString()
    return MOCK_MODELS.map((model) => ({
      providerId: this.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
      family: model.family,
      capabilities: model.capabilities,
      pricing: perSecondUsd(model.usdPerSecond, {
        retrievedAt: RETRIEVED_AT,
        sourceUrl: SOURCE,
        notes: 'simulated sandbox pricing — never billed, always recorded as sandbox spend',
      }),
      enabled: true,
      raw: model,
      fetchedAt,
      source: 'static' as const,
    }))
  }

  override async quote(request: CanonicalRenderRequest): Promise<PriceQuote> {
    const model = MOCK_MODELS.find((m) => m.modelId === request.modelId)
    if (!model) {
      throw new AppError({ kind: 'not_found', code: 'provider.unknown_model', message: `mock has no model ${request.modelId}` })
    }
    // Exercises the same "exact quote from the provider" path the real adapters use.
    const micros = usdToMicros(model.usdPerSecond * request.durationSeconds)
    return quoteFromProvider({
      providerId: this.providerId,
      request,
      micros,
      nowMs: this.deps.now(),
      raw: { simulated: true, usdPerSecond: model.usdPerSecond, seconds: request.durationSeconds },
    })
  }

  async submit(request: CanonicalRenderRequest): Promise<SubmittedJob> {
    const validation = await this.validate(request)
    if (!validation.ok) {
      throw new AppError({
        kind: 'provider_rejected',
        code: 'mock.invalid_request',
        message: `mock rejected the request: ${validation.errors.join('; ')}`,
      })
    }

    const now = this.deps.now()
    const externalJobId = `mockjob_${hashObject({ id: request.requestId, model: request.modelId }).slice(0, 20)}`
    const { width, height } = frameSize(request.resolution as TargetResolution, request.aspectRatio as AspectRatio)
    const quote = await this.quote(request)

    // Deterministic from the request id: the same job always behaves the same
    // way, so a failing test reproduces instead of flapping.
    const roll = deterministicUnit(request.requestId, 'outcome')
    const explicit = request.metadata.mock_pattern as TestPattern | undefined
    const outcome: 'succeed' | 'fail' = explicit ? 'succeed' : roll < this.failureRate ? 'fail' : 'succeed'
    const defectRoll = deterministicUnit(request.requestId, 'defect')
    const pattern: TestPattern =
      explicit ??
      (defectRoll < this.defectRate
        ? (DEFECT_PATTERNS[Math.floor(deterministicUnit(request.requestId, 'which') * DEFECT_PATTERNS.length)] ?? 'frozen')
        : 'motion')

    const state: MockJobState = {
      externalJobId,
      requestId: request.requestId,
      modelId: request.modelId,
      createdAtMs: now,
      readyAtMs: now + this.latencyMs,
      width,
      height,
      fps: request.fps,
      durationSeconds: request.durationSeconds,
      withAudio: request.audio.mode === 'native_generated' || request.audio.mode === 'native_dialogue',
      pattern,
      outcome,
      variantSeed: Math.floor(deterministicUnit(request.requestId, 'seed') * 360),
      outputPath: join(this.workDir, externalJobId, 'output_0.mp4'),
      estimatedMicros: quote.estimatedMicros,
    }
    await this.writeState(state)
    this.log.debug('mock.submitted', { external_job_id: externalJobId, pattern, outcome })

    return {
      externalJobId,
      providerId: this.providerId,
      modelId: request.modelId,
      submittedAt: new Date(now).toISOString(),
      externalRequestId: request.requestId,
      raw: { simulated: true, pattern, outcome },
    }
  }

  async getStatus(externalJobId: string): Promise<ProviderJobStatus> {
    const state = await this.readState(externalJobId)
    const now = this.deps.now()

    if (now < state.readyAtMs) {
      return {
        externalJobId,
        state: 'running',
        progress: Math.min(0.99, (now - state.createdAtMs) / Math.max(1, state.readyAtMs - state.createdAtMs)),
        outputs: [],
        error: null,
        actualMicros: null,
        actualCredits: null,
        billableSeconds: null,
        raw: { simulated: true },
      }
    }

    if (state.outcome === 'fail') {
      return {
        externalJobId,
        state: 'failed',
        progress: null,
        outputs: [],
        error: { code: 'mock.generation_failed', message: 'simulated provider-side generation failure', retryable: true },
        actualMicros: 0,
        actualCredits: null,
        billableSeconds: null,
        raw: { simulated: true },
      }
    }

    await this.ensureRendered(state)
    const info = await stat(state.outputPath)
    return {
      externalJobId,
      state: 'succeeded',
      progress: 1,
      outputs: [
        {
          // `mock://` is resolved by this adapter's own downloadOutputs; it is
          // never handed to fetch().
          url: `mock://${externalJobId}/0`,
          mime: 'video/mp4',
          index: 0,
          bytes: info.size,
          durationSeconds: state.durationSeconds,
          width: state.width,
          height: state.height,
          hasAudio: state.withAudio,
        },
      ],
      error: null,
      actualMicros: state.estimatedMicros,
      actualCredits: null,
      billableSeconds: state.durationSeconds,
      raw: { simulated: true, pattern: state.pattern },
    }
  }

  async cancel(externalJobId: string): Promise<void> {
    const state = await this.readState(externalJobId)
    state.outcome = 'fail'
    await this.writeState(state)
  }

  async downloadOutputs(job: CompletedJob, destDir: string): Promise<DownloadedAsset[]> {
    const state = await this.readState(job.externalJobId)
    await this.ensureRendered(state)
    await mkdir(destDir, { recursive: true })
    const assets: DownloadedAsset[] = []
    for (const output of job.outputs) {
      const destPath = join(destDir, `${job.externalJobId}_${output.index}.mp4`)
      await copyFile(state.outputPath, destPath)
      const info = await stat(destPath)
      assets.push({
        localPath: destPath,
        bytes: info.size,
        sha256: await sha256File(destPath),
        mime: 'video/mp4',
        index: output.index,
      })
    }
    return assets
  }

  async getAccountBalance(): Promise<AccountBalance> {
    return { providerId: this.providerId, balanceMicros: null, credits: null, currency: 'USD', raw: { simulated: true } }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const { checkTools } = await import('@masterclip/media-tools')
    const tools = await checkTools()
    const ok = tools.ffmpeg.available && tools.ffprobe.available
    return {
      providerId: this.providerId,
      status: ok ? 'healthy' : 'unavailable',
      latencyMs: 0,
      message: ok ? 'local ffmpeg sandbox ready' : 'ffmpeg/ffprobe not available — mock renders cannot run',
      checkedAt: new Date(this.deps.now()).toISOString(),
    }
  }

  async normalizeWebhook(payload: unknown): Promise<ProviderEvent> {
    const body = (payload ?? {}) as { external_job_id?: string }
    const externalJobId = String(body.external_job_id ?? '')
    const status = await this.getStatus(externalJobId)
    return {
      providerId: this.providerId,
      externalJobId,
      dedupeKey: `${externalJobId}:${status.state}`,
      status,
      receivedAt: new Date(this.deps.now()).toISOString(),
      raw: payload,
    }
  }

  // --- internals ------------------------------------------------------------

  private statePath(externalJobId: string): string {
    const safe = externalJobId.replace(/[^A-Za-z0-9._-]/g, '_')
    return join(this.workDir, safe, 'job.json')
  }

  private async writeState(state: MockJobState): Promise<void> {
    const path = this.statePath(state.externalJobId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(state, null, 2), 'utf8')
  }

  /** State is on disk so the API and worker processes see the same jobs. */
  private async readState(externalJobId: string): Promise<MockJobState> {
    try {
      return JSON.parse(await readFile(this.statePath(externalJobId), 'utf8')) as MockJobState
    } catch {
      throw new AppError({ kind: 'not_found', code: 'mock.unknown_job', message: `mock job ${externalJobId} not found` })
    }
  }

  private async ensureRendered(state: MockJobState): Promise<void> {
    try {
      const info = await stat(state.outputPath)
      if (info.size > 0) return
    } catch {
      /* not rendered yet */
    }
    await generateTestVideo(state.outputPath, {
      width: state.width,
      height: state.height,
      fps: state.fps,
      durationSeconds: state.durationSeconds,
      pattern: state.pattern,
      withAudio: state.withAudio,
      variantSeed: state.variantSeed,
    })
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Stable pseudo-random in [0,1) derived from a string — no global RNG state. */
function deterministicUnit(seed: string, salt: string): number {
  const hex = hashObject({ seed, salt }).slice(0, 8)
  return parseInt(hex, 16) / 0xffffffff
}

export function createMockProvider(opts: MockProviderOptions): MockProvider {
  return new MockProvider(opts)
}
