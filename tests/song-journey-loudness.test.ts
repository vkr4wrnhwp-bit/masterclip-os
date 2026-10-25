import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Runtime } from '@masterclip/runtime'

const eburLog = `[Parsed_ebur128_0] Summary:

  Integrated loudness:
    I:         -15.7 LUFS
    Threshold: -25.7 LUFS

  Loudness range:
    LRA:        10.0 LU

  True peak:
    Peak:       -2.6 dBFS
`

vi.mock('@masterclip/media-tools', () => ({ ffmpeg: vi.fn(async () => eburLog) }))

import { ffmpeg } from '@masterclip/media-tools'
import {
  parseEbur128Summary,
  measureSongVersion,
  verifiedSongAudio,
  SONG_JOURNEY_LOUDNESS_METHOD,
} from '../apps/api/src/routes/song-journey-loudness.js'

const bytes = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])
const checksum = createHash('sha256').update(bytes).digest('hex')
function fixture(patch: Record<string, unknown> = {}, body = bytes) {
  const asset = {
    id: 'asset-a', projectType: 'song_lab', projectId: 'project-a',
    fileSize: bytes.length, checksum, deletedAt: null, ...patch,
  }
  const materialize = vi.fn(async () => ({ asset, bytes: body }))
  const signedUrl = vi.fn(async () => ({ url: '/private/audio/signed', asset }))
  const runtime = { audio: { assets: { materialize, signedUrl } } } as unknown as Runtime
  return { runtime, materialize, signedUrl }
}

describe('Job 45 exact-asset BS.1770 measurement boundary', () => {
  it('accepts a complete K-weighted FFmpeg result, not a diagnostic estimate', () => {
    expect(parseEbur128Summary(eburLog)).toEqual({ integratedLufs: -15.7, truePeakDbtp: -2.6 })
    expect(parseEbur128Summary(eburLog.replace('-15.7', '-inf'))).toBeNull()
    expect(parseEbur128Summary(eburLog.replace('-2.6', 'nan'))).toBeNull()
    expect(parseEbur128Summary('Integrated loudness: I: -14 LUFS')).toBeNull()
  })

  it('measures only the exact checksum-bound original source', async () => {
    const { runtime, signedUrl } = fixture()
    const result = await measureSongVersion(runtime, 'org-a', 'project-a', 'asset-a')
    expect(result).toMatchObject({
      assetId: 'asset-a', sourceChecksum: checksum,
      integratedLufs: -15.7, truePeakDbtp: -2.6,
      method: SONG_JOURNEY_LOUDNESS_METHOD,
    })
    expect(signedUrl).not.toHaveBeenCalled()
    expect(vi.mocked(ffmpeg)).toHaveBeenCalled()
  })


  it('requires the same checked source for the private browser audio route', async () => {
    const { runtime } = fixture()
    const verified = await verifiedSongAudio(runtime, 'org-a', 'project-a', 'asset-a')
    expect(verified?.asset.checksum).toBe(checksum)
    expect(Array.from(verified?.bytes ?? [])).toEqual(Array.from(bytes))
    expect(await verifiedSongAudio(fixture({ projectId: 'another' }).runtime, 'org-a', 'project-a', 'asset-a')).toBeNull()
  })
  it('refuses altered, deleted, cross-project, oversized and unverifiable sources before FFmpeg', async () => {
    for (const [patch, body] of [
      [{ checksum: '0'.repeat(64) }, bytes],
      [{ projectId: 'another-project' }, bytes],
      [{ projectType: 'meeting' }, bytes],
      [{ deletedAt: '2026-10-25' }, bytes],
      [{ fileSize: 500 }, bytes],
      [{}, new Uint8Array([1, 2, 3])],
    ] as Array<[Record<string, unknown>, Uint8Array]>) {
      vi.mocked(ffmpeg).mockClear()
      const { runtime, signedUrl } = fixture(patch, body)
      expect(await measureSongVersion(runtime, 'org-a', 'project-a', 'asset-a')).toBeNull()
      expect(signedUrl).not.toHaveBeenCalled()
      expect(ffmpeg).not.toHaveBeenCalled()
    }
  })

  it('does not claim a measurement if FFmpeg is missing or errors', async () => {
    vi.mocked(ffmpeg).mockRejectedValueOnce(new Error('FFmpeg unavailable'))
    const { runtime, signedUrl } = fixture()
    expect(await measureSongVersion(runtime, 'org-a', 'project-a', 'asset-a')).toBeNull()
    expect(signedUrl).not.toHaveBeenCalled()
  })
})
