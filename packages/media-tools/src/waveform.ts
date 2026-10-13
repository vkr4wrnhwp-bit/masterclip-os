import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AppError } from '@masterclip/shared'
import { ffmpegPaths } from './runner.js'
import { probe } from './probe.js'

const execFileAsync = promisify(execFile)

/** A single MP3/WAV is decoded to actual mono PCM, then reduced to truthful
 * maximum amplitudes. No synthetic waveforms, input alterations, or user paths.
 * 600s guard keeps a GET request from turning into an unbounded render job.
 */
export async function waveformPeaks(path: string, buckets = 160): Promise<{ peaks: number[]; durationSeconds: number; source: 'decoded_pcm' }> {
  if (!Number.isInteger(buckets) || buckets < 32 || buckets > 512) {
    throw new AppError({ kind: 'validation', code: 'waveform.buckets', message: 'waveform resolution must be between 32 and 512 peaks' })
  }
  const info = await probe(path)
  if (!info.audio || !Number.isFinite(info.durationSeconds) || info.durationSeconds <= 0) {
    throw new AppError({ kind: 'validation', code: 'waveform.no_audio', message: 'source has no decodable audio or usable duration' })
  }
  if (info.durationSeconds > 600) {
    throw new AppError({ kind: 'validation', code: 'waveform.too_long', message: 'waveform is available for audio up to ten minutes; manual trim remains available' })
  }

  let pcm: Buffer
  try {
    const result = await execFileAsync(ffmpegPaths().ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', path, '-map', '0:a:0', '-vn',
      '-ac', '1', '-ar', '2000', '-f', 's16le', 'pipe:1',
    ], { encoding: 'buffer', timeout: 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    pcm = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
  } catch {
    throw new AppError({ kind: 'validation', code: 'waveform.decode_failed', message: 'could not decode a waveform from this audio source' })
  }

  const totalSamples = Math.floor(pcm.byteLength / 2)
  if (totalSamples === 0) {
    throw new AppError({ kind: 'validation', code: 'waveform.empty', message: 'audio did not produce waveform samples' })
  }
  const raw = Array.from({ length: buckets }, (_, bucket) => {
    const first = Math.floor(bucket * totalSamples / buckets)
    const last = Math.min(totalSamples, Math.ceil((bucket + 1) * totalSamples / buckets))
    let peak = 0
    for (let sample = first; sample < last; sample++) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(sample * 2)))
    }
    return peak
  })
  const maximum = Math.max(1, ...raw)
  return {
    // Relative amplitudes normalized against the loudest actual sample.
    peaks: raw.map(v => Number((v / maximum).toFixed(3))),
    durationSeconds: info.durationSeconds,
    source: 'decoded_pcm',
  }
}
