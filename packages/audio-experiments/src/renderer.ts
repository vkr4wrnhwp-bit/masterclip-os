import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpeg } from '@masterclip/media-tools'
import { AppError } from '@masterclip/shared'
import { projectEdl, type EdlOutcome, type ExperimentEdit } from './edl.js'

/**
 * Experiment rendering.
 *
 * The renderer reads the source and writes a *new* preview asset. It has no API
 * that can write back to the source, which is how "the original is never
 * modified" is enforced structurally rather than by convention.
 */

export interface SongExperimentRenderRequest {
  experimentId: string
  sourceBytes: Uint8Array
  sourceMimeType: string
  sourceDurationMs: number
  editDecisionList: ExperimentEdit[]
}

export interface AudioExperimentResult {
  bytes: Uint8Array
  contentType: string
  durationMs: number
  /** Source→output mapping so section markers follow the edit. */
  outcome: EdlOutcome
  renderer: string
  rendererVersion: string
  /** Set when the preview is a placeholder rather than real rendered audio. */
  placeholder: boolean
  /** Human-readable note shown next to the player. */
  note: string
}

export interface AudioExperimentRenderer {
  readonly rendererId: string
  readonly version: string
  isAvailable(): Promise<boolean>
  renderExperiment(input: SongExperimentRenderRequest): Promise<AudioExperimentResult>
}

/**
 * ffmpeg renderer.
 *
 * Builds one filter graph: each kept span becomes a trimmed stream, the spans
 * are concatenated in order, and a tempo experiment applies `atempo` — which
 * preserves pitch — chained where the ratio exceeds a single stage's range.
 */
export class FfmpegExperimentRenderer implements AudioExperimentRenderer {
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

  async renderExperiment(input: SongExperimentRenderRequest): Promise<AudioExperimentResult> {
    const outcome = projectEdl(input.editDecisionList, input.sourceDurationMs)
    const workDir = await mkdtemp(join(tmpdir(), 'song-lab-experiment-'))
    const sourcePath = join(workDir, 'source.audio')
    const outputPath = join(workDir, 'preview.wav')

    try {
      await writeFile(sourcePath, input.sourceBytes)
      const { filter, output } = buildFilterGraph(outcome, input.editDecisionList)
      const gain = input.editDecisionList.find((edit) => edit.type === 'gain_change' && edit.sourceStartMs === undefined)

      const args = ['-hide_banner', '-nostdin', '-y', '-i', sourcePath, '-filter_complex', filter, '-map', `[${output}]`]
      if (gain?.value) args.push('-af', `volume=${gain.value}dB`)
      args.push('-c:a', 'pcm_s16le', '-ar', '44100', outputPath)

      await ffmpeg(args)
      const bytes = new Uint8Array(await readFile(outputPath))
      return {
        bytes,
        contentType: 'audio/wav',
        durationMs: outcome.durationMs,
        outcome,
        renderer: this.rendererId,
        rendererVersion: this.version,
        placeholder: false,
        note: 'Preview rendered from your source audio. The original is unchanged.',
      }
    } catch (err) {
      throw new AppError({
        kind: 'internal',
        code: 'song_lab.render_failed',
        message: `the experiment preview could not be rendered: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }
}

function buildFilterGraph(outcome: EdlOutcome, edits: ExperimentEdit[]): { filter: string; output: string } {
  const parts: string[] = []
  const labels: string[] = []

  outcome.segments.forEach((segment, index) => {
    const label = `s${index}`
    const start = segment.sourceStartMs / 1000
    const end = segment.sourceEndMs / 1000
    parts.push(`[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS[${label}]`)
    labels.push(label)
  })

  const concatLabel = 'cat'
  parts.push(`${labels.map((label) => `[${label}]`).join('')}concat=n=${labels.length}:v=0:a=1[${concatLabel}]`)

  const stretch = edits.find((edit) => edit.type === 'time_stretch')?.value
  if (stretch && Math.abs(stretch - 1) > 0.005) {
    // atempo accepts 0.5–2.0 per stage; chain if the request falls outside it.
    // atempo preserves pitch, which is the entire point of a tempo experiment.
    const stages = atempoStages(stretch)
    parts.push(`[${concatLabel}]${stages.map((rate) => `atempo=${rate.toFixed(4)}`).join(',')}[out]`)
    return { filter: parts.join(';'), output: 'out' }
  }

  return { filter: parts.join(';'), output: concatLabel }
}

export function atempoStages(ratio: number): number[] {
  const stages: number[] = []
  let remaining = ratio
  while (remaining > 2) {
    stages.push(2)
    remaining /= 2
  }
  while (remaining < 0.5) {
    stages.push(0.5)
    remaining /= 0.5
  }
  stages.push(remaining)
  return stages
}

/**
 * The placeholder renderer.
 *
 * Where ffmpeg is unavailable, an experiment still gets created, stored,
 * compared and accepted — the whole product flow stays intact — but the preview
 * it produces is a short silent WAV, and `placeholder: true` travels with it so
 * the UI shows "preview unavailable on this deployment" rather than playing
 * silence and letting the artist think that is their edit.
 */
export class PlaceholderExperimentRenderer implements AudioExperimentRenderer {
  readonly rendererId = 'placeholder'
  readonly version = '1.0.0'

  async isAvailable(): Promise<boolean> {
    return true
  }

  async renderExperiment(input: SongExperimentRenderRequest): Promise<AudioExperimentResult> {
    const outcome = projectEdl(input.editDecisionList, input.sourceDurationMs)
    return {
      bytes: silentWav(1),
      contentType: 'audio/wav',
      durationMs: outcome.durationMs,
      outcome,
      renderer: this.rendererId,
      rendererVersion: this.version,
      placeholder: true,
      note: 'Audio rendering is unavailable on this deployment, so no preview was produced. The edit list and the predicted timings are real.',
    }
  }
}

function silentWav(seconds: number): Uint8Array {
  const sampleRate = 22050
  const frames = sampleRate * seconds
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(frames * 2, 40)
  return new Uint8Array(buffer)
}

/** Picks the best renderer this deployment can actually run. */
export async function selectRenderer(candidates: AudioExperimentRenderer[]): Promise<AudioExperimentRenderer> {
  for (const candidate of candidates) {
    if (await candidate.isAvailable()) return candidate
  }
  return new PlaceholderExperimentRenderer()
}

/**
 * Renderer that degrades instead of failing.
 *
 * Whether ffmpeg exists cannot be known when the layer is composed — the API
 * and the worker start before anything is rendered, and a deployment can gain
 * or lose the binary between them. So the choice is made on first render and
 * cached: with ffmpeg the preview is real audio; without it the placeholder
 * takes over, the experiment still reaches `ready`, and `placeholder: true`
 * tells the UI to say the preview is unavailable rather than playing silence.
 *
 * A missing binary is a deployment fact, not an artist's problem — it should
 * not put an experiment in a dead-letter queue.
 */
export class ResilientExperimentRenderer implements AudioExperimentRenderer {
  readonly rendererId = 'resilient'
  readonly version = '1.0.0'
  private resolved: AudioExperimentRenderer | null = null

  constructor(private readonly candidates: AudioExperimentRenderer[] = [new FfmpegExperimentRenderer()]) {}

  async isAvailable(): Promise<boolean> {
    return true
  }

  private async pick(): Promise<AudioExperimentRenderer> {
    if (!this.resolved) this.resolved = await selectRenderer(this.candidates)
    return this.resolved
  }

  async renderExperiment(input: SongExperimentRenderRequest): Promise<AudioExperimentResult> {
    // Once a real renderer is selected, its failures are real failures and
    // propagate: the fallback exists for a missing binary, not to paper over a
    // broken edit on a file ffmpeg could otherwise have handled.
    return (await this.pick()).renderExperiment(input)
  }
}
