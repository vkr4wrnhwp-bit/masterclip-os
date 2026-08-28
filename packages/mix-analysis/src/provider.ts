import { AppError } from '@masterclip/shared'
import { analyzeMix, type MixAnalysisOutput, type MixAnalysisRequest } from './analyze.js'
import { ResilientMasterRenderer, type MasterRenderRequest, type MasterRenderResult, type MasterRenderer } from './renderer.js'

/**
 * The audio-processing seam.
 *
 * Everything that touches audio bytes goes through a provider, and a provider
 * says three things about itself: what it can do, whether it is configured to
 * do it here, and who it is. The last one matters more than it looks — a result
 * with no attribution can be mistaken for a hosted professional service, and
 * the local adapter names itself precisely so that it cannot be.
 *
 * There is one implementation today. That is the point of the interface rather
 * than an argument against it: a vendor adapter registers alongside the local
 * one, and every caller already asks the registry rather than reaching for a
 * renderer it constructed itself.
 */

export const AUDIO_PROCESSING_CAPABILITIES = ['analyze_mix', 'render_master', 'transcode', 'separate_stems'] as const

export type AudioProcessingCapability = (typeof AUDIO_PROCESSING_CAPABILITIES)[number]

export const AUDIO_CAPABILITY_LABELS: Record<AudioProcessingCapability, string> = {
  analyze_mix: 'Measure a mix',
  render_master: 'Render a master',
  transcode: 'Convert between formats',
  separate_stems: 'Separate stems',
}

/**
 * Three states, not two.
 *
 * `degraded` is the one that earns its keep: the local renderer with no ffmpeg
 * can still answer, but only with a clearly labelled placeholder — the
 * customer's own unprocessed audio. Collapsing that into "ready" would let a
 * settings screen claim mastering works here when it does not; collapsing it
 * into "unavailable" would throw away the fallback that keeps the plan, the
 * comparison table and the approval gate usable.
 */
export type AudioProviderReadiness = 'ready' | 'degraded' | 'unavailable'

export interface AudioProviderStatus {
  provider: string
  adapter: string
  capability: AudioProcessingCapability
  /** Whether this deployment holds what the provider needs — a binary, a key, an endpoint. */
  readiness: AudioProviderReadiness
  reason: string | null
  /**
   * True when the work happens on this machine rather than at a vendor. Surfaced
   * so a UI can say where a customer's audio went.
   */
  local: boolean
}

export interface AudioProcessingProvider {
  readonly provider: string
  readonly adapter: string
  readonly local: boolean
  readonly capabilities: readonly AudioProcessingCapability[]
  /** Cheap enough to call on a settings screen; may probe for a binary or ping an endpoint. */
  status(capability: AudioProcessingCapability): Promise<AudioProviderStatus>
  analyzeMix?(request: MixAnalysisRequest): Promise<MixAnalysisOutput>
  renderMaster?(request: MasterRenderRequest): Promise<MasterRenderResult>
}

/**
 * Raised when nothing registered can perform the work here.
 *
 * Deliberately not a generic failure: "no provider is configured for this" is a
 * fact about the deployment that an operator can fix, and it must never be
 * presented to a user as their file being at fault.
 */
export class AudioProviderNotConfiguredError extends AppError {
  constructor(capability: AudioProcessingCapability, detail?: string) {
    super({
      kind: 'validation',
      code: 'studio.processing_provider_not_configured',
      message: detail ?? `no configured provider can ${AUDIO_CAPABILITY_LABELS[capability].toLowerCase()} in this deployment`,
      details: { capability },
    })
  }
}

/**
 * Street Banker's own processing, performed on this machine.
 *
 * Analysis is always ready: WAV is decoded in process. Rendering needs ffmpeg
 * and reports itself *degraded* without it — the renderer still falls back to
 * passthrough so the plan, the comparison and the approval gate survive, and
 * the status is what a settings screen reads, so it says plainly that no
 * processing is happening here.
 */
export class LocalAudioProcessingProvider implements AudioProcessingProvider {
  readonly provider = 'street-banker'
  readonly adapter = 'local-dsp'
  readonly local = true
  readonly capabilities = ['analyze_mix', 'render_master'] as const

  constructor(private readonly renderer: MasterRenderer = new ResilientMasterRenderer()) {}

  async status(capability: AudioProcessingCapability): Promise<AudioProviderStatus> {
    const base = { provider: this.provider, adapter: this.adapter, capability, local: true }
    if (capability === 'analyze_mix') {
      return { ...base, readiness: 'ready', reason: null }
    }
    if (capability === 'render_master') {
      const available = await this.renderer.isAvailable()
      return {
        ...base,
        adapter: this.renderer.rendererId,
        readiness: available ? 'ready' : 'degraded',
        reason: available
          ? null
          : 'ffmpeg is not installed, so nothing can be processed here — a master request returns your unprocessed mix, clearly marked, rather than silence. Set FFMPEG_PATH or install it.',
      }
    }
    return { ...base, readiness: 'unavailable', reason: 'the local adapter does not perform this work' }
  }

  async analyzeMix(request: MixAnalysisRequest): Promise<MixAnalysisOutput> {
    return analyzeMix(request)
  }

  async renderMaster(request: MasterRenderRequest): Promise<MasterRenderResult> {
    return this.renderer.renderMaster(request)
  }
}

/**
 * Which provider performs which work.
 *
 * Registration order is preference order among equals: the first registered
 * provider that declares a capability and reports itself ready wins, and a
 * degraded provider is used only when nothing is ready. The local adapter is
 * registered last so a configured vendor is preferred, and so removing that
 * vendor's key falls back to local processing rather than to nothing.
 */
export class AudioProcessingRegistry {
  private readonly providers: AudioProcessingProvider[] = []

  register(provider: AudioProcessingProvider): this {
    this.providers.push(provider)
    return this
  }

  /** Every provider that declares the capability, ready or not. */
  candidates(capability: AudioProcessingCapability): AudioProcessingProvider[] {
    return this.providers.filter((provider) => provider.capabilities.includes(capability))
  }

  /**
   * The provider that will actually be used, or null when nothing can answer.
   *
   * Ready beats degraded, always: a deployment with both a working vendor and a
   * placeholder-only local adapter must never pick the placeholder. Degraded is
   * chosen only when nothing is ready, which is what keeps the product flow
   * intact on a machine with no ffmpeg.
   */
  async resolve(capability: AudioProcessingCapability): Promise<AudioProcessingProvider | null> {
    let degraded: AudioProcessingProvider | null = null
    for (const provider of this.candidates(capability)) {
      const status = await provider.status(capability).catch(() => null)
      if (status?.readiness === 'ready') return provider
      if (status?.readiness === 'degraded' && !degraded) degraded = provider
    }
    return degraded
  }

  /**
   * The provider, or a refusal.
   *
   * Callers that would otherwise have to decide what to do with a null get a
   * typed refusal carrying the capability, which is what turns "nothing
   * happened" into a message an operator can act on.
   */
  async require(capability: AudioProcessingCapability): Promise<AudioProcessingProvider> {
    const provider = await this.resolve(capability)
    if (!provider) {
      const reasons = (await this.report(capability)).map((status) => status.reason).filter((reason): reason is string => Boolean(reason))
      throw new AudioProviderNotConfiguredError(capability, reasons[0])
    }
    return provider
  }

  /** Status of every registered provider, for a settings or health screen. */
  async report(capability?: AudioProcessingCapability): Promise<AudioProviderStatus[]> {
    const wanted = capability ? [capability] : AUDIO_PROCESSING_CAPABILITIES
    const out: AudioProviderStatus[] = []
    for (const provider of this.providers) {
      for (const cap of wanted) {
        if (!provider.capabilities.includes(cap)) continue
        out.push(
          await provider.status(cap).catch((err: unknown) => ({
            provider: provider.provider,
            adapter: provider.adapter,
            capability: cap,
            readiness: 'unavailable' as const,
            local: provider.local,
            reason: err instanceof Error ? err.message : String(err),
          })),
        )
      }
    }
    return out
  }
}
