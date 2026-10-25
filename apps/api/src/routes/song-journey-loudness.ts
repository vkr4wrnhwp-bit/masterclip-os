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
export const MAX_A_B_AUDIO_BYTES = 64 * 1024 * 1024

export interface VerifiedSongLoudness {
  assetId: string
  analysisId: string
  sourceChecksum: string
  integratedLufs: number
  truePeakDbtp: number
  method: typeof SONG_JOURNEY_LOUDNESS_METHOD
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

/** Read only Song Lab's owned, undeleted source bytes and verify them. This
 * same check protects both the meter and the session-authenticated player.
 */
export async function verifiedSongAudio(
  runtime: Runtime, orgId: string, projectId: string, assetId: string,
) {
  try {
    // Check the database first: a 512 MB asset should never be downloaded
    // just to discover it exceeds the 64 MB interactive comparison limit.
    const metadata = await runtime.audio.repos.assets.get(orgId, assetId)
    if (metadata.projectType !== 'song_lab' || metadata.projectId !== projectId ||
        metadata.deletedAt !== null || !/^[a-f0-9]{64}$/i.test(metadata.checksum) ||
        !Number.isSafeInteger(metadata.fileSize) ||
        metadata.fileSize <= 0 || metadata.fileSize > MAX_A_B_AUDIO_BYTES) {
      return null
    }
    const { asset, bytes } = await runtime.audio.assets.materialize(orgId, assetId)
    if (asset.projectType !== metadata.projectType || asset.projectId !== metadata.projectId ||
        asset.checksum !== metadata.checksum || asset.fileSize !== metadata.fileSize ||
        asset.deletedAt !== null || bytes.length !== metadata.fileSize ||
        sha256Hex(Buffer.from(bytes)).toLowerCase() !== metadata.checksum.toLowerCase()) {
      return null
    }
    return { asset, bytes }
  } catch {
    return null
  }
}

export async function measureSongVersion(
  runtime: Runtime,
  orgId: string,
  projectId: string,
  assetId: string,
): Promise<VerifiedSongLoudness | null> {
  const verified = await verifiedSongAudio(runtime, orgId, projectId, assetId)
  if (!verified) return null
  const { asset, bytes } = verified
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
    return {
      assetId, analysisId: `ebur128:${assetId}:${asset.checksum}`,
      sourceChecksum: asset.checksum,
      ...result, method: SONG_JOURNEY_LOUDNESS_METHOD,
    }
  } catch {
    // Missing FFmpeg, unsupported codecs, corrupt assets and timeouts fail closed.
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
