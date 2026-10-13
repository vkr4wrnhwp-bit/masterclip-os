import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captionSrt, burnTimedCaptions, ffmpeg, generateTestVideo, probe } from '@masterclip/media-tools'
import { sha256File } from '@masterclip/shared'

let root = ''
let original = ''
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'motion-caption-test-'))
  original = join(root, 'clean.mp4')
  await generateTestVideo(original, {
    width: 320, height: 180, fps: 24, durationSeconds: 3, pattern: 'black', withAudio: true,
  })
}, 90_000)
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('Native MOTION caption finishing', () => {
  it('makes literal, correctly timed SRT data without passing user text as a filter', () => {
    const srt = captionSrt([
      { start_seconds: 0.2, end_seconds: 1.3, text: 'First\nline; : [test]' },
      { start_seconds: 1.5, end_seconds: 2.4, text: 'Final phrase' },
    ], 3)
    expect(srt).toContain('00:00:00,200 --> 00:00:01,300')
    expect(srt).toContain('First line; : [test]')
    expect(srt).toContain('00:00:01,500 --> 00:00:02,400')
    expect(srt).not.toContain('First\nline')
  })

  it('refuses captions outside the video and overlapping lines', () => {
    expect(() => captionSrt([{ start_seconds: 2, end_seconds: 3.5, text: 'Overrun' }], 3)).toThrow()
    expect(() => captionSrt([
      { start_seconds: 0, end_seconds: 2, text: 'First' },
      { start_seconds: 1, end_seconds: 2.5, text: 'Overlap' },
    ], 3)).toThrow()
    expect(() => captionSrt([{ start_seconds: 0, end_seconds: 1, text: '   ' }], 3)).toThrow()
  })

  it('produces a real visible captioned MP4, preserves source audio, and never alters original', async () => {
    const originalHash = await sha256File(original)
    const out = join(root, 'captioned.mp4')
    const result = await burnTimedCaptions(original, out, [
      { start_seconds: 0.25, end_seconds: 2.5, text: 'MOVE TONIGHT' },
    ])
    const info = await probe(out)
    expect(result.path).toBe(out)
    expect(info.video).not.toBeNull()
    expect(info.audio).not.toBeNull()
    expect(info.durationSeconds).toBeGreaterThan(2.5)
    expect(info.durationSeconds).toBeLessThan(3.5)
    expect(await sha256File(original)).toBe(originalHash)
    expect(await sha256File(out)).not.toBe(originalHash)

    // Extract a frame in the caption's active window; the original is a black
    // frame, so visible white lettering produces genuine bright pixels.
    const rgbPath = join(root, 'caption-active.rgb')
    await ffmpeg(['-ss', '1.0', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', rgbPath])
    const rgb = await readFile(rgbPath)
    let brightPixels = 0
    for (let i = 0; i + 2 < rgb.length; i += 3) {
      if (rgb[i]! > 150 && rgb[i + 1]! > 150 && rgb[i + 2]! > 150) brightPixels++
    }
    expect(brightPixels).toBeGreaterThan(30)
  }, 90_000)

  it('refuses a captioned output path equal to original', async () => {
    await expect(burnTimedCaptions(original, original, [{ start_seconds: 0, end_seconds: 1, text: 'No overwrite' }]))
      .rejects.toMatchObject({ code: 'captions.overwrite' })
  })
})
