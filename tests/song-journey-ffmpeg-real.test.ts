import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Runtime } from '@masterclip/runtime'
import { ffmpeg } from '@masterclip/media-tools'
import { measureSongVersion, SONG_JOURNEY_LOUDNESS_METHOD } from '../apps/api/src/routes/song-journey-loudness.js'

describe('Job 45: actual FFmpeg measurement on synthetic owned audio', () => {
  it('measures complete K-weighted loudness and true peak with no network or provider spend', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-ebur128-test-'))
    try {
      const filename = join(dir, 'test-tone.wav')
      await ffmpeg([
        '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2',
        '-ac', '2', '-c:a', 'pcm_s16le', filename,
      ], { timeoutMs: 20_000 })
      const bytes = await readFile(filename)
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const runtime = {
        audio: { assets: {
          materialize: async () => ({
            asset: { id: 'tone', projectId: 'song', projectType: 'song_lab', checksum,
              deletedAt: null, fileSize: bytes.length, mimeType: 'audio/wav' },
            bytes,
          }),
        } },
      } as unknown as Runtime
      const value = await measureSongVersion(runtime, 'org', 'song', 'tone')
      expect(value?.sourceChecksum).toBe(checksum)
      expect(value?.method).toBe(SONG_JOURNEY_LOUDNESS_METHOD)
      expect(value?.integratedLufs).toBeGreaterThan(-26)
      expect(value?.integratedLufs).toBeLessThan(-15)
      expect(value?.truePeakDbtp).toBeLessThan(-10)
      expect(value?.truePeakDbtp).toBeGreaterThan(-40)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
