import { execFile } from 'node:child_process'
import { AppError, loadConfig, redactString, silentLogger, type Logger } from '@masterclip/shared'

export interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
}

export function ffmpegPaths(): FfmpegPaths {
  const config = loadConfig()
  return { ffmpeg: config.FFMPEG_PATH, ffprobe: config.FFPROBE_PATH }
}

export interface RunOptions {
  timeoutMs?: number
  /** Optional isolated media work directory; never a user supplied path. */
  cwd?: string
  logger?: Logger
  /** ffmpeg writes progress to stderr; large filters can exceed the default cap. */
  maxBufferBytes?: number
}

/**
 * Runs a binary with an argument array — never a shell string.
 *
 * Prompts, filenames, and character names all flow through this layer, and any
 * of them can contain quotes, semicolons, or backticks. `execFile` with an
 * argv array makes shell metacharacters inert by construction, which is why
 * there is no string-command variant of this helper to reach for.
 */
export function run(binary: string, args: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const logger = opts.logger ?? silentLogger
  return new Promise((resolve, reject) => {
    logger.debug('media.exec', { binary, args: args.length })
    execFile(
      binary,
      args,
      {
        timeout: opts.timeoutMs ?? 10 * 60_000,
        maxBuffer: opts.maxBufferBytes ?? 32 * 1024 * 1024,
        windowsHide: true,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
          const code = (error as NodeJS.ErrnoException).code
          const permanent = isPermanentInputFailure(String(stderr))
          reject(
            new AppError({
              // A corrupt or truncated input fails identically every time.
              // Classifying it as `io` would make it transient, and the queue
              // would burn five attempts re-decoding the same broken bytes.
              kind: code === 'ENOENT' ? 'internal' : killed ? 'timeout' : permanent ? 'validation' : 'io',
              code:
                code === 'ENOENT'
                  ? 'media.binary_missing'
                  : killed
                    ? 'media.timeout'
                    : permanent
                      ? 'media.invalid_input'
                      : 'media.failed',
              message:
                code === 'ENOENT'
                  ? `${binary} not found — install ffmpeg or set FFMPEG_PATH/FFPROBE_PATH`
                  : `${binary} failed: ${redactString(String(stderr).slice(-1200))}`,
              details: { binary, exitCode: (error as { code?: number }).code, permanent },
              cause: error,
            }),
          )
          return
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

/**
 * How many ffmpeg processes one Motion process may run at once
 * (MEDIA_MAX_PARALLEL, default 1) and how many threads each may use
 * (FFMPEG_THREADS, default 2).
 *
 * Technical QC decodes a render five ways at once and the proxy build encodes
 * it alongside; each ffmpeg left to itself sizes its threads, and the frame
 * buffers that come with them, to every CPU the host reports, not the
 * container's share. On a 512 MB service a single 1080p render was enough to
 * get the container killed for memory, over and over, as the recovered job
 * ran again on each restart (staging, 2026-10-12). Queued here, the same work
 * finishes one decode at a time. Raise both on a larger instance.
 */
function mediaLimit(name: 'MEDIA_MAX_PARALLEL' | 'FFMPEG_THREADS', fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

let mediaActive = 0
const mediaWaiting: Array<() => void> = []

async function withMediaSlot<T>(work: () => Promise<T>): Promise<T> {
  while (mediaActive >= mediaLimit('MEDIA_MAX_PARALLEL', 1)) {
    await new Promise<void>((resolve) => mediaWaiting.push(resolve))
  }
  mediaActive += 1
  try {
    return await work()
  } finally {
    mediaActive -= 1
    mediaWaiting.shift()?.()
  }
}

/**
 * The ffmpeg argv with a thread cap: before the first input (decoding) and
 * before the output, which is always the last argument (encoding and the
 * filter graph feeding it). A command that sets -threads itself is left alone.
 */
export function withThreadCap(args: string[], threads: number): string[] {
  if (args.includes('-threads') || args.length === 0) return args
  const t = String(threads)
  return ['-threads', t, ...args.slice(0, -1), '-threads', t, args[args.length - 1]!]
}

export async function ffmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  const capped = withThreadCap(args, mediaLimit('FFMPEG_THREADS', 2))
  const { stderr } = await withMediaSlot(() => run(ffmpegPaths().ffmpeg, ['-hide_banner', '-nostdin', '-y', ...capped], opts))
  return stderr
}

export async function ffprobeRaw(args: string[], opts: RunOptions = {}): Promise<string> {
  const { stdout } = await run(ffmpegPaths().ffprobe, ['-hide_banner', ...args], opts)
  return stdout
}

/**
 * Distinguishes "this file is broken" from "this run went wrong".
 *
 * Truncated downloads and corrupt containers are the common case in a render
 * factory — the mock provider produces them deliberately — and retrying them
 * wastes a queue slot per attempt and then dead-letters noisily.
 */
export function isPermanentInputFailure(stderr: string): boolean {
  return [
    /moov atom not found/i,
    /Invalid data found when processing input/i,
    /No such file or directory/i,
    /Invalid argument/i,
    /Unknown encoder/i,
    /Unrecognized option/i,
    /does not contain any stream/i,
    /Decoder .* not found/i,
  ].some((pattern) => pattern.test(stderr))
}

export interface ToolAvailability {
  ffmpeg: { available: boolean; version: string; path: string }
  ffprobe: { available: boolean; version: string; path: string }
}

export async function checkTools(): Promise<ToolAvailability> {
  const paths = ffmpegPaths()
  const probeOne = async (binary: string) => {
    try {
      const { stdout } = await run(binary, ['-version'], { timeoutMs: 10_000 })
      return { available: true, version: stdout.split('\n')[0]?.trim() ?? '', path: binary }
    } catch {
      return { available: false, version: '', path: binary }
    }
  }
  const [ff, fp] = await Promise.all([probeOne(paths.ffmpeg), probeOne(paths.ffprobe)])
  return { ffmpeg: ff, ffprobe: fp }
}
