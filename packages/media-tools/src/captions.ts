import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AppError } from '@masterclip/shared'
import { ffmpeg, type RunOptions } from './runner.js'
import { probe } from './probe.js'

export interface TimedCaptionInput {
  start_seconds: number
  end_seconds: number
  text: string
}

function timestamp(seconds: number): string {
  const rounded = Math.round(seconds * 1000)
  const hours = Math.floor(rounded / 3600000)
  const minutes = Math.floor((rounded % 3600000) / 60000)
  const secs = Math.floor((rounded % 60000) / 1000)
  const millis = rounded % 1000
  return [hours, minutes, secs].map(n => String(n).padStart(2, '0')).join(':') + ',' + String(millis).padStart(3, '0')
}

/**
 * Generate literal SRT data; user text is NEVER interpolated into FFmpeg
 * arguments or filter expressions. Each line is constrained to one entry.
 */
export function captionSrt(captions: readonly TimedCaptionInput[], durationSeconds: number): string {
  if (captions.length === 0 || captions.length > 32 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60.5) {
    throw new AppError({ kind: 'validation', code: 'captions.input', message: 'use 1–32 timed captions inside a valid sixty-second clip' })
  }
  let lastEnd = 0
  const parts: string[] = []
  for (const [index, caption] of captions.entries()) {
    const { start_seconds: start, end_seconds: end } = caption
    const content = caption.text.replace(/[\r\n\t]+/g, ' ').trim()
    if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > durationSeconds + 0.04 ||
        start < lastEnd || !content || content.length > 160) {
      throw new AppError({ kind: 'validation', code: 'captions.timing', message: 'caption lines must be non-overlapping, nonempty and within the approved clip' })
    }
    lastEnd = end
    parts.push(String(index + 1) + '\n' + timestamp(start) + ' --> ' + timestamp(end) + '\n' + content + '\n')
  }
  return parts.join('\n') + '\n'
}

/**
 * Burn approved user-timed text into an actual MP4. Does not synthesize
 * lyrics, infer timing, modify source media, or invoke a billable provider.
 * The subtitle filter reads the fixed relative name in a fresh temporary cwd,
 * avoiding injectable absolute paths and Windows drive-letter escaping.
 */
export async function burnTimedCaptions(
  sourcePath: string,
  outputPath: string,
  captions: readonly TimedCaptionInput[],
  opts: RunOptions = {},
): Promise<{ path: string; durationSeconds: number; hasAudio: boolean }> {
  if (resolve(sourcePath) === resolve(outputPath)) {
    throw new AppError({ kind: 'validation', code: 'captions.overwrite', message: 'caption render must not overwrite its original video' })
  }
  const media = await probe(sourcePath, opts)
  if (!media.video || media.durationSeconds <= 0 || media.durationSeconds > 60.5) {
    throw new AppError({ kind: 'validation', code: 'captions.source', message: 'a valid short-form video is required' })
  }
  const srt = captionSrt(captions, media.durationSeconds)
  const work = await mkdtemp(join(tmpdir(), 'motion-caption-work-'))
  try {
    await writeFile(join(work, 'captions.srt'), srt, { encoding: 'utf8', flag: 'wx' })
    // The exact visual treatment is deterministic; no user-provided filter
    // strings. Captions are justified at the bottom with an actual outline.
    const style = "FontName=DejaVu Sans,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=40"
    await mkdir(dirname(outputPath), { recursive: true })
    await ffmpeg([
      '-i', sourcePath,
      '-map', '0:v:0', ...(media.audio ? ['-map', '0:a:0'] : []),
      '-vf', "subtitles=captions.srt:force_style='" + style + "'",
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      ...(media.audio ? ['-c:a', 'copy'] : ['-an']),
      '-movflags', '+faststart',
      outputPath,
    ], { ...opts, cwd: work, timeoutMs: opts.timeoutMs ?? 240_000 })
    const result = await probe(outputPath, opts)
    if (!result.video || Boolean(result.audio) !== Boolean(media.audio) ||
        Math.abs(result.durationSeconds - media.durationSeconds) > 0.4) {
      throw new AppError({ kind: 'io', code: 'captions.invalid_output', message: 'captioned output did not pass stream and duration verification' })
    }
    return { path: outputPath, durationSeconds: result.durationSeconds, hasAudio: Boolean(result.audio) }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
