import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { sha256File } from '@masterclip/shared'
import { ffmpeg, generateTestVideo, probe, replaceAudioMoment, waveformPeaks } from '@masterclip/media-tools'

let temp = ''
let song = ''
let video = ''
let silent = ''

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'motion-real-audio-test-'))
  song = join(temp, 'approved-song.wav')
  video = join(temp, 'approved-master.mp4')
  silent = join(temp, 'silent-master.mp4')
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=7', '-c:a', 'pcm_s16le', song])
  await generateTestVideo(video, { width: 320, height: 180, fps: 24, durationSeconds: 4, withAudio: true })
  await generateTestVideo(silent, { width: 320, height: 180, fps: 24, durationSeconds: 2, withAudio: false })
}, 90_000)

afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true })
})

describe('Measured waveform', () => {
  it('uses actual decoded PCM peaks with no fabricated points', async () => {
    const waveform = await waveformPeaks(song, 160)
    expect(waveform.source).toBe('decoded_pcm')
    expect(waveform.peaks).toHaveLength(160)
    expect(waveform.durationSeconds).toBeGreaterThan(6)
    expect(Math.max(...waveform.peaks)).toBeGreaterThan(0.95)
    expect(waveform.peaks.every(v => v >= 0 && v <= 1)).toBe(true)
  }, 60_000)

  it('rejects sources without an audio stream and invalid bucket counts', async () => {
    await expect(waveformPeaks(silent)).rejects.toMatchObject({ code: 'waveform.no_audio' })
    await expect(waveformPeaks(song, 12)).rejects.toMatchObject({ code: 'waveform.buckets' })
  }, 60_000)
})

describe('Native MP4 song-moment finishing', () => {
  it('writes a decodable MP4 with audio and preserves both originals', async () => {
    const dest = join(temp, 'with-song.mp4')
    const originalVideoHash = await sha256File(video)
    const originalSongHash = await sha256File(song)
    const result = await replaceAudioMoment(video, song, dest, 1.0, 3.5)
    const finished = await probe(dest)
    expect(result.path).toBe(dest)
    expect(result.codec).toBe('h264')
    expect(finished.video).not.toBeNull()
    expect(finished.audio).not.toBeNull()
    expect(finished.durationSeconds).toBeGreaterThan(2.05)
    expect(finished.durationSeconds).toBeLessThan(2.95)
    expect(await sha256File(dest)).not.toBe(originalVideoHash)
    expect(await sha256File(video)).toBe(originalVideoHash)
    expect(await sha256File(song)).toBe(originalSongHash)
  }, 90_000)

  it('rejects a song moment longer than an approved video', async () => {
    await expect(replaceAudioMoment(silent, song, join(temp, 'too-long.mp4'), 0, 3)).rejects.toMatchObject({
      code: 'song_moment.video_short',
    })
  })

  it('rejects recording overrun and inverted trims', async () => {
    await expect(replaceAudioMoment(video, song, join(temp, 'overrun.mp4'), 5, 8)).rejects.toMatchObject({
      code: 'song_moment.audio_short',
    })
    await expect(replaceAudioMoment(video, song, join(temp, 'reverse.mp4'), 5, 2)).rejects.toMatchObject({
      code: 'song_moment.range',
    })
  })
})
