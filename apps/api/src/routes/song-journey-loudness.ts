import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runtime } from '@masterclip/runtime'
import { ffmpeg } from '@masterclip/media-tools'
import { sha256Hex } from '@masterclip/shared'

/**
 * Real BS.1770 K-weighted, gated integrated loudness and 4x-oversampled
 * true peak from FFmpeg's ebur128 filter. Never use Song Lab's old
 * gated-RMS "LUFS-like" diagnostic value to calculate listening gain.
 *
 * Audio is checked against its original SHA-256 before analysis. No analysis
 * bytes or temporary file survive this call. If the tool is absent or the
 * file cannot be verified in full, there is no listening-gain proposal.
 */
export const SONG_JOURNEY_LOUDNESS_METHOD = 'ffmpeg_ebur128_k_weighted_bs1770_4_true_peak'
const MAX_MEASUREMENT_BYTES = 64 * 1024 * 1024

export interface VerifiedSongLoudness {
  assetId: string
  analysisId: string
  sourceChecksum: string
  integratedLufs: number
  truePeakDbtp: number
  method: typeof SONG_JOURNEY_LOUDNESS_METHOD
  audioUrl: string
}

export function parseEbur128Summary(log: string): { integratedLufs: number; truePeakDbtp: number } | null {
  const start = log.lastIndexOf('Summary:')
  if (start < 0) return null
  const summary = log.slice(start)
  const integrated = /Integrated loudness:\s*I:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*LUFS/i.exec(summary)
  const peak = /True peak:\s*Peak:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dBFS/i.exec(summary)
  if (!integrated || !peak) return null
  const integratedLufs = Number(integrated[1])
  const truePeakDbtp = Number(peak[1])
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDbtp) ||
      integratedLufs < -80 || integratedLufs > 0 ||
      truePeakDbtp < -160 || truePeakDbtp > 6) return null
  return { integratedLufs, truePeakDbtp }
}

export async function measureSongVersion(
  runtime: Runtime,
  orgId: string,
  projectId: string,
  assetId: string,
): Promise<VerifiedSongLoudness | null> {
  let asset: Awaited<ReturnType<typeof runtime.audio.assets.materialize>>['asset']
  let bytes: Uint8Array
  try {
    const materialized = await runtime.audio.assets.materialize(orgId, assetId)
    asset = materialized.asset
    bytes = materialized.bytes
  } catch {
    return null
  }
  if (asset.projectType !== 'song_lab' || asset.projectId !== projectId ||
      asset.deletedAt !== null || !/^[a-f0-9]{64}$/i.test(asset.checksum) ||
      bytes.length === 0 || bytes.length > MAX_MEASUREMENT_BYTES ||
      bytes.length !== asset.fileSize ||
      sha256Hex(Buffer.from(bytes)).toLowerCase() !== asset.checksum.toLowerCase()) {
    return null
  }
  const dir = await mkdtemp(join(tmpdir(), 'song-journey-loudness-'))
  try {
    // A fixed local name avoids injecting any user-supplied filename into FFmpeg.
    const file = join(dir, 'source.audio')
    await writeFile(file, bytes)
    const stderr = await ffmpeg([
      '-loglevel', 'info', '-i', file, '-map', '0:a:0', '-vn',
      '-filter:a', 'ebur128=peak=true:framelog=quiet',
      '-f', 'null', '-',
    ], { timeoutMs: 90_000, maxBufferBytes: 4 * 1024 * 1024 })
    const result = parseEbur128Summary(stderr)
    if (!result) return null
    // A fresh signed URL is issued through the existing tenant-safe asset door.
    const { url } = await runtime.audio.assets.signedUrl(orgId, assetId)
    return {
      assetId, analysisId: `ebur128:${assetId}:${asset.checksum}`,
      sourceChecksum: asset.checksum,
      ...result, method: SONG_JOURNEY_LOUDNESS_METHOD, audioUrl: url,
    }
  } catch {
    // Missing FFmpeg, unsupported codecs, corrupt assets and timeouts fail closed.
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
