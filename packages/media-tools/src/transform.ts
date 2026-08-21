import { mkdir, rm, truncate, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AppError } from '@masterclip/shared'
import { ffmpeg, type RunOptions } from './runner.js'
import { probe } from './probe.js'

export interface FrameExtraction {
  path: string
  timeSeconds: number
  index: number
}

/**
 * Extracts frames at explicit timestamps.
 *
 * Quality is capped at JPEG q=2 rather than re-encoding through a video codec:
 * these frames become continuity references and vision-QC inputs, and a
 * second generation loss would be graded as model error.
 */
export async function extractFrames(
  videoPath: string,
  timestamps: number[],
  destDir: string,
  opts: { width?: number; prefix?: string } & RunOptions = {},
): Promise<FrameExtraction[]> {
  await mkdir(destDir, { recursive: true })
  const prefix = (opts.prefix ?? 'frame').replace(/[^A-Za-z0-9._-]/g, '_')
  const out: FrameExtraction[] = []
  for (const [index, time] of timestamps.entries()) {
    const path = join(destDir, `${prefix}_${String(index).padStart(3, '0')}.jpg`)
    const scale = opts.width ? ['-vf', `scale=${Math.round(opts.width)}:-2`] : []
    await ffmpeg(['-ss', time.toFixed(3), '-i', videoPath, '-frames:v', '1', ...scale, '-q:v', '2', path], opts)
    out.push({ path, timeSeconds: time, index })
  }
  return out
}

/** Evenly spaced sample times, inset from both ends to avoid head/tail black. */
export function sampleTimestamps(durationSeconds: number, count: number): number[] {
  if (durationSeconds <= 0 || count <= 0) return []
  if (count === 1) return [durationSeconds / 2]
  const inset = Math.min(0.15, durationSeconds * 0.03)
  const start = inset
  const end = Math.max(inset, durationSeconds - inset)
  const step = (end - start) / (count - 1)
  return Array.from({ length: count }, (_, i) => Number((start + step * i).toFixed(3)))
}

export async function contactSheet(
  videoPath: string,
  destPath: string,
  opts: { columns?: number; rows?: number; tileWidth?: number } & RunOptions = {},
): Promise<string> {
  const columns = opts.columns ?? 4
  const rows = opts.rows ?? 3
  const tileWidth = opts.tileWidth ?? 320
  const info = await probe(videoPath, opts)
  const frames = columns * rows
  const duration = info.durationSeconds > 0 ? info.durationSeconds : 1
  // fps is chosen so the tile grid spans the whole clip rather than its first second.
  const fps = Math.max(0.05, frames / duration)
  await mkdir(dirname(destPath), { recursive: true })
  await ffmpeg(
    ['-i', videoPath, '-vf', `fps=${fps.toFixed(4)},scale=${tileWidth}:-2,tile=${columns}x${rows}`, '-frames:v', '1', '-q:v', '3', destPath],
    opts,
  )
  return destPath
}

export async function makeThumbnail(videoPath: string, destPath: string, opts: { width?: number } & RunOptions = {}): Promise<string> {
  const info = await probe(videoPath, opts)
  const at = Math.min(1, Math.max(0, info.durationSeconds * 0.35))
  await mkdir(dirname(destPath), { recursive: true })
  await ffmpeg(['-ss', at.toFixed(3), '-i', videoPath, '-frames:v', '1', '-vf', `scale=${opts.width ?? 640}:-2`, '-q:v', '3', destPath], opts)
  return destPath
}

export type DeliveryFormat = 'review_h264' | 'delivery_h264' | 'delivery_h265' | 'prores_422hq' | 'prores_4444' | 'social_h264'

export interface TranscodeOptions extends RunOptions {
  format: DeliveryFormat
  width?: number
  height?: number
  fps?: number
  /** Strips audio when the master is silent by design. */
  dropAudio?: boolean
}

const FORMAT_ARGS: Record<DeliveryFormat, string[]> = {
  review_h264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
  delivery_h264: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
  delivery_h265: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-movflags', '+faststart'],
  prores_422hq: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'],
  prores_4444: ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0', '-pix_fmt', 'yuva444p10le'],
  social_h264: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
}

/**
 * Format conversion only.
 *
 * Transcoding never adds detail — a 720p source encoded as a 1080p ProRes is
 * still a 720p image in a larger container. The finishing pipeline calls this
 * for delivery wrappers and says so in the sidecar rather than implying an
 * uplift.
 */
export async function transcode(sourcePath: string, destPath: string, opts: TranscodeOptions): Promise<string> {
  const filters: string[] = []
  if (opts.width || opts.height) {
    filters.push(`scale=${opts.width ?? -2}:${opts.height ?? -2}:flags=lanczos`)
  }
  await mkdir(dirname(destPath), { recursive: true })
  await ffmpeg(
    [
      '-i',
      sourcePath,
      ...(filters.length ? ['-vf', filters.join(',')] : []),
      ...(opts.fps ? ['-r', String(opts.fps)] : []),
      ...FORMAT_ARGS[opts.format],
      ...(opts.dropAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', '192k']),
      destPath,
    ],
    opts,
  )
  return destPath
}

export type ReframeMode = 'crop' | 'pad'

/**
 * Aspect-ratio conversion for alternate deliveries.
 *
 * `mode` is always an explicit caller choice: cropping loses framing the
 * director approved, padding changes the composition. The system will not pick
 * for you.
 */
export async function reframe(
  sourcePath: string,
  destPath: string,
  opts: { targetWidth: number; targetHeight: number; mode: ReframeMode; padColor?: string } & RunOptions,
): Promise<string> {
  const { targetWidth: w, targetHeight: h, mode } = opts
  const filter =
    mode === 'crop'
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${opts.padColor ?? 'black'}`
  await mkdir(dirname(destPath), { recursive: true })
  await ffmpeg(['-i', sourcePath, '-vf', filter, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', destPath], opts)
  return destPath
}

/**
 * Concatenation via the demuxer list format. The list file is written by us
 * with quoted paths; source paths are never interpolated into a filter string.
 */
export async function concat(sourcePaths: string[], destPath: string, opts: RunOptions & { reencode?: boolean } = {}): Promise<string> {
  if (sourcePaths.length === 0) {
    throw new AppError({ kind: 'validation', code: 'media.concat_empty', message: 'concat requires at least one input' })
  }
  await mkdir(dirname(destPath), { recursive: true })
  const listPath = `${destPath}.concat.txt`
  const body = sourcePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
  await writeFile(listPath, body, 'utf8')
  try {
    await ffmpeg(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        ...(opts.reencode === false
          ? ['-c', 'copy']
          : ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k']),
        destPath,
      ],
      opts,
    )
  } finally {
    await rm(listPath, { force: true })
  }
  return destPath
}

export async function replaceAudio(
  videoPath: string,
  audioPath: string,
  destPath: string,
  opts: { normalize?: boolean } & RunOptions = {},
): Promise<string> {
  await mkdir(dirname(destPath), { recursive: true })
  await ffmpeg(
    [
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      ...(opts.normalize ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : []),
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      destPath,
    ],
    opts,
  )
  return destPath
}

export async function extractAudio(videoPath: string, destPath: string, opts: RunOptions = {}): Promise<string> {
  await mkdir(dirname(destPath), { recursive: true })
  await ffmpeg(['-i', videoPath, '-vn', '-c:a', 'pcm_s16le', '-ar', '48000', destPath], opts)
  return destPath
}

export type TestPattern = 'motion' | 'black' | 'frozen' | 'truncated' | 'low_bitrate' | 'wrong_duration'

export interface TestVideoOptions extends RunOptions {
  width: number
  height: number
  fps: number
  durationSeconds: number
  pattern?: TestPattern
  withAudio?: boolean
  /** Varies hue/pattern so a batch of candidates is visually distinguishable. */
  variantSeed?: number
}

/**
 * Renders a real, decodable MP4 with ffmpeg — including deliberately defective
 * ones.
 *
 * This is what makes the sandbox pipeline honest: the mock provider returns
 * actual video files, so download verification, technical QC, proxy building,
 * contact sheets, and master finishing all run for real with zero spend. The
 * defect patterns exist so QC can be proven to catch failures rather than
 * assumed to.
 */
export async function generateTestVideo(destPath: string, opts: TestVideoOptions): Promise<string> {
  const { width, height, fps } = opts
  const duration = Math.max(0.5, opts.durationSeconds)
  const pattern = opts.pattern ?? 'motion'
  const seed = opts.variantSeed ?? 0
  const hue = (seed * 47) % 360
  await mkdir(dirname(destPath), { recursive: true })

  const encode = (inputArgs: string[], filters: string[], extra: string[] = [], outDuration = duration): Promise<string> =>
    ffmpeg(
      [
        ...inputArgs,
        ...(opts.withAudio ? ['-f', 'lavfi', '-i', `sine=frequency=${220 + (seed % 8) * 55}:duration=${outDuration}`] : []),
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-t',
        outDuration.toFixed(3),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        ...extra,
        ...(opts.withAudio ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : ['-an']),
        destPath,
      ],
      opts,
    ).then(() => destPath)

  switch (pattern) {
    case 'black':
      return encode(['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${duration}`], [])

    case 'frozen': {
      // A single generated frame held for the full duration: decodes cleanly,
      // has a correct duration, and contains no motion whatsoever.
      const stillPath = `${destPath}.still.png`
      await ffmpeg(
        ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}:d=1`, '-frames:v', '1', `-vf`, `hue=h=${hue}`, stillPath],
        opts,
      )
      try {
        return await encode(['-loop', '1', '-framerate', String(fps), '-i', stillPath], [])
      } finally {
        await rm(stillPath, { force: true })
      }
    }

    case 'low_bitrate':
      return encode(
        ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}:d=${duration}`],
        [`hue=h=${hue}`],
        ['-b:v', '18k', '-maxrate', '20k', '-bufsize', '40k', '-x264-params', 'nal-hrd=cbr'],
      )

    case 'wrong_duration':
      // Half the requested length — the provider under-delivered.
      return encode(
        ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}:d=${duration}`],
        [`hue=h=${hue}`],
        [],
        Math.max(0.5, duration / 2),
      )

    case 'truncated': {
      await encode(['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}:d=${duration}`], [`hue=h=${hue}`])
      const info = await stat(destPath)
      // Cut the tail so the moov/mdat pairing is incomplete: a real truncated download.
      await truncate(destPath, Math.max(1024, Math.floor(info.size * 0.55)))
      return destPath
    }

    case 'motion':
    default:
      return encode(
        ['-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=${fps}:d=${duration}`],
        [`hue=h=${hue}`, `rotate=a=0.02*t:c=none:ow=${width}:oh=${height}`],
      )
  }
}
