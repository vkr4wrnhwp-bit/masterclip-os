import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpeg } from '@masterclip/media-tools'
import { ANALYSIS_SAMPLE_RATE } from './frames.js'
import { decodeWav, isWav, type PcmAudio } from './pcm.js'

/**
 * Getting PCM out of whatever the artist uploaded.
 *
 * WAV is decoded in-process. Everything else goes through ffmpeg, which the
 * platform already requires for video work — but the *degradation* matters: if
 * ffmpeg is missing, analysis of a non-WAV upload must fail with a clear reason
 * rather than silently returning invented numbers about a file it never read.
 */

export class DecodeUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'DecodeUnavailableError'
  }
}

export interface DecodeOptions {
  /** Target rate for analysis. Both channels are preserved when present. */
  sampleRate?: number
  /** Cap on analysed length. Long uploads are analysed from the top. */
  maxSeconds?: number
}

export async function decodeToPcm(bytes: Uint8Array, mimeType: string, opts: DecodeOptions = {}): Promise<PcmAudio> {
  const sampleRate = opts.sampleRate ?? ANALYSIS_SAMPLE_RATE
  if (isWav(bytes)) return decodeWav(bytes)

  const workDir = await mkdtemp(join(tmpdir(), 'song-lab-decode-'))
  const inputPath = join(workDir, `source${extensionFor(mimeType)}`)
  const outputPath = join(workDir, 'analysis.wav')
  try {
    await writeFile(inputPath, bytes)
    const args = ['-hide_banner', '-nostdin', '-y', '-i', inputPath, '-vn', '-ac', '2', '-ar', String(sampleRate), '-c:a', 'pcm_s16le']
    if (opts.maxSeconds) args.push('-t', String(opts.maxSeconds))
    args.push(outputPath)
    await ffmpeg(args)
    return decodeWav(new Uint8Array(await readFile(outputPath)))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/ENOENT|not found|spawn/i.test(message)) {
      throw new DecodeUnavailableError('ffmpeg is not available, so this file format cannot be decoded for analysis')
    }
    throw new DecodeUnavailableError(`could not decode the uploaded audio: ${message}`)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'audio/mpeg':
      return '.mp3'
    case 'audio/mp4':
      return '.m4a'
    case 'audio/flac':
      return '.flac'
    case 'audio/ogg':
      return '.ogg'
    case 'video/mp4':
      return '.mp4'
    case 'video/quicktime':
      return '.mov'
    default:
      return '.bin'
  }
}
