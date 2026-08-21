import { AppError } from '@masterclip/shared'
import { ffprobeRaw, type RunOptions } from './runner.js'

export interface VideoStreamInfo {
  index: number
  codec: string
  profile: string
  width: number
  height: number
  fps: number
  pixelFormat: string
  bitRate: number | null
  frameCount: number | null
  durationSeconds: number | null
}

export interface AudioStreamInfo {
  index: number
  codec: string
  channels: number
  sampleRate: number
  bitRate: number | null
}

export interface MediaInfo {
  path: string
  formatName: string
  durationSeconds: number
  bytes: number
  bitRate: number | null
  video: VideoStreamInfo | null
  audio: AudioStreamInfo | null
  streamCount: number
  raw: unknown
}

/** `24/1` and `30000/1001` both appear in provider output. */
export function parseFrameRate(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || value.length === 0) return 0
  const [num, den] = value.split('/')
  const numerator = Number(num)
  const denominator = den === undefined ? 1 : Number(den)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0
  return Number((numerator / denominator).toFixed(4))
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export async function probe(path: string, opts: RunOptions = {}): Promise<MediaInfo> {
  const stdout = await ffprobeRaw(
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { timeoutMs: 60_000, ...opts },
  )
  let parsed: {
    format?: Record<string, unknown>
    streams?: Array<Record<string, unknown>>
  }
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    throw new AppError({ kind: 'io', code: 'probe.invalid_json', message: 'ffprobe returned unparseable JSON', cause: err })
  }

  const streams = parsed.streams ?? []
  const videoStream = streams.find((s) => s.codec_type === 'video')
  const audioStream = streams.find((s) => s.codec_type === 'audio')
  const format = parsed.format ?? {}

  const video: VideoStreamInfo | null = videoStream
    ? {
        index: num(videoStream.index) ?? 0,
        codec: String(videoStream.codec_name ?? ''),
        profile: String(videoStream.profile ?? ''),
        width: num(videoStream.width) ?? 0,
        height: num(videoStream.height) ?? 0,
        fps: parseFrameRate(videoStream.avg_frame_rate) || parseFrameRate(videoStream.r_frame_rate),
        pixelFormat: String(videoStream.pix_fmt ?? ''),
        bitRate: num(videoStream.bit_rate),
        frameCount: num(videoStream.nb_frames),
        durationSeconds: num(videoStream.duration),
      }
    : null

  const audio: AudioStreamInfo | null = audioStream
    ? {
        index: num(audioStream.index) ?? 0,
        codec: String(audioStream.codec_name ?? ''),
        channels: num(audioStream.channels) ?? 0,
        sampleRate: num(audioStream.sample_rate) ?? 0,
        bitRate: num(audioStream.bit_rate),
      }
    : null

  return {
    path,
    formatName: String(format.format_name ?? ''),
    durationSeconds: num(format.duration) ?? video?.durationSeconds ?? 0,
    bytes: num(format.size) ?? 0,
    bitRate: num(format.bit_rate),
    video,
    audio,
    streamCount: streams.length,
    raw: parsed,
  }
}

/**
 * Full decode with error reporting. This is the check that separates "the model
 * produced a bad shot" from "the file is broken": a container can report a
 * plausible duration while its frames fail to decode.
 */
export async function decodeIntegrity(path: string, opts: RunOptions = {}): Promise<{ ok: boolean; errors: string[] }> {
  const { ffmpeg } = await import('./runner.js')
  const stderr = await ffmpeg(['-v', 'error', '-i', path, '-f', 'null', '-'], { timeoutMs: 5 * 60_000, ...opts }).catch(
    (err: unknown) => (err instanceof AppError ? err.message : String(err)),
  )
  const errors = String(stderr)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return { ok: errors.length === 0, errors: errors.slice(0, 25) }
}
