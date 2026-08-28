import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpeg } from '@masterclip/media-tools'
import { AppError } from '@masterclip/shared'
import type { MasterRenderPlan, MasterStage } from './master.js'

/**
 * Rendering a master.
 *
 * The renderer reads the source and writes a *new* file. It has no API that can
 * write back to the source, which is how "the original is never modified" is a
 * structural property rather than a promise. Every rendition is a new asset and
 * a new version; nothing overwrites anything.
 *
 * Where ffmpeg is unavailable the placeholder keeps the whole product flow
 * intact — the plan, the comparison table, the approval gate — and marks the
 * output `placeholder: true` so the UI says the audio could not be produced
 * rather than playing silence and letting an artist think that is their master.
 */

export interface MasterRenderRequest {
  sourceBytes: Uint8Array
  sourceMimeType: string
  plan: MasterRenderPlan
}

export interface MasterRenderResult {
  bytes: Uint8Array
  contentType: string
  renderer: string
  rendererVersion: string
  placeholder: boolean
  /** The exact filter string applied, kept so the processing is auditable. */
  filterChain: string
  note: string
}

export interface MasterRenderer {
  readonly rendererId: string
  readonly version: string
  isAvailable(): Promise<boolean>
  renderMaster(request: MasterRenderRequest): Promise<MasterRenderResult>
}

export class FfmpegMasterRenderer implements MasterRenderer {
  readonly rendererId = 'ffmpeg'
  readonly version = '1.0.0'

  async isAvailable(): Promise<boolean> {
    try {
      await ffmpeg(['-hide_banner', '-version'])
      return true
    } catch {
      return false
    }
  }

  async renderMaster(request: MasterRenderRequest): Promise<MasterRenderResult> {
    const workDir = await mkdtemp(join(tmpdir(), 'studio-master-'))
    const sourcePath = join(workDir, 'source.audio')
    const outputPath = join(workDir, 'master.wav')
    const filterChain = buildFilterChain(request.plan)

    try {
      await writeFile(sourcePath, request.sourceBytes)
      // 24-bit output: a master delivered at the source's bit depth throws away
      // the resolution the processing just added, and 24-bit is what every DSP
      // accepts. Sample rate is preserved — resampling is a separate decision
      // nobody asked this chain to make.
      await ffmpeg([
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        sourcePath,
        '-af',
        filterChain,
        '-c:a',
        'pcm_s24le',
        outputPath,
      ])
      return {
        bytes: new Uint8Array(await readFile(outputPath)),
        contentType: 'audio/wav',
        renderer: this.rendererId,
        rendererVersion: this.version,
        placeholder: false,
        filterChain,
        note: 'Rendered from your source audio at 24-bit. The source file is unchanged.',
      }
    } catch (err) {
      throw new AppError({
        kind: 'internal',
        code: 'studio.master_render_failed',
        message: `the master could not be rendered: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}

/**
 * Translates the plan into one ffmpeg filter chain.
 *
 * Every stage maps to a filter that does what its description claims. The
 * mapping is intentionally conservative — `alimiter` rather than a loudness
 * normaliser that would silently re-target the level the plan already set, and
 * `acompressor` with an explicit makeup of 0 so the gain stage stays the only
 * thing changing the level.
 */
export function buildFilterChain(plan: MasterRenderPlan): string {
  const filters: string[] = []
  for (const stage of plan.stages) filters.push(...filterFor(stage))
  // A chain with no stages at all would make ffmpeg fail rather than copy, so
  // an explicit no-op keeps a fully-restrained plan renderable.
  return filters.length > 0 ? filters.join(',') : 'anull'
}

function filterFor(stage: MasterStage): string[] {
  const number = (key: string, fallback = 0): number => {
    const value = stage.params[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  switch (stage.stage) {
    case 'highpass':
      return [`highpass=f=${number('frequencyHz', 20)}:poles=2`]
    case 'low_shelf':
      return [`bass=g=${number('gainDb').toFixed(2)}:f=${number('frequencyHz', 120)}:width_type=q:w=${number('q', 0.7)}`]
    case 'presence':
      return [`equalizer=f=${number('frequencyHz', 3000)}:width_type=q:w=${number('q', 0.9)}:g=${number('gainDb').toFixed(2)}`]
    case 'air':
      return [`treble=g=${number('gainDb').toFixed(2)}:f=${number('frequencyHz', 12000)}:width_type=q:w=${number('q', 0.7)}`]
    case 'dynamics': {
      // makeup=1 means "no makeup gain": the level target belongs to the gain
      // stage alone, so the plan's stated ±dB is the level change that happens.
      const ratio = number('ratio', 2)
      return [
        `acompressor=threshold=${dbToLinear(number('thresholdDb', -18)).toFixed(6)}:ratio=${ratio}:attack=${number('attackMs', 30)}:release=${number('releaseMs', 200)}:makeup=1:detection=rms`,
      ]
    }
    case 'drive': {
      // Soft-clip saturation. The amount maps to a modest drive range: this is
      // harmonic colour, and a chain that can distort a master on a slider is
      // not a chain a mastering product should ship.
      const amount = Math.max(0, Math.min(1, number('amount')))
      if (amount <= 0) return []
      return [`asoftclip=type=tanh:param=${(1 + amount * 0.6).toFixed(3)}`]
    }
    case 'gain':
      return [`volume=${number('gainDb').toFixed(2)}dB`]
    case 'limiter':
      return [`alimiter=limit=${dbToLinear(number('ceilingDbtp', -1)).toFixed(6)}:attack=5:release=${number('releaseMs', 50)}:level=disabled`]
    default:
      return []
  }
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

/**
 * The renderer used where ffmpeg is absent.
 *
 * It returns the source bytes untouched and says so. Returning the source
 * rather than silence is deliberate: the comparison surface stays usable — the
 * user hears their own mix on both sides and the UI says why they are
 * identical — instead of presenting silence as a mastering result.
 */
export class PassthroughMasterRenderer implements MasterRenderer {
  readonly rendererId = 'passthrough'
  readonly version = '1.0.0'

  async isAvailable(): Promise<boolean> {
    return true
  }

  async renderMaster(request: MasterRenderRequest): Promise<MasterRenderResult> {
    return {
      bytes: request.sourceBytes,
      contentType: request.sourceMimeType || 'audio/wav',
      renderer: this.rendererId,
      rendererVersion: this.version,
      placeholder: true,
      filterChain: buildFilterChain(request.plan),
      note: 'Audio rendering is unavailable on this deployment, so no processing was applied. The plan below is real; the audio is your unprocessed mix.',
    }
  }
}

/**
 * Picks the renderer this deployment can actually run, on first use.
 *
 * Whether ffmpeg exists is not knowable when the layer is composed — the API
 * and the worker start long before anything renders, and a deployment can gain
 * or lose the binary between them. Once a real renderer is chosen its failures
 * are real failures and propagate: the fallback is for a missing binary, not
 * for papering over a chain ffmpeg could otherwise have run.
 */
export class ResilientMasterRenderer implements MasterRenderer {
  readonly rendererId = 'resilient'
  readonly version = '1.0.0'
  private resolved: MasterRenderer | null = null

  constructor(private readonly candidates: MasterRenderer[] = [new FfmpegMasterRenderer()]) {}

  async isAvailable(): Promise<boolean> {
    return true
  }

  private async pick(): Promise<MasterRenderer> {
    if (this.resolved) return this.resolved
    for (const candidate of this.candidates) {
      if (await candidate.isAvailable()) {
        this.resolved = candidate
        return candidate
      }
    }
    this.resolved = new PassthroughMasterRenderer()
    return this.resolved
  }

  async renderMaster(request: MasterRenderRequest): Promise<MasterRenderResult> {
    return (await this.pick()).renderMaster(request)
  }
}
