import { describe, expect, it } from 'vitest'
import { withThreadCap } from '../packages/media-tools/src/runner.js'

/**
 * Every ffmpeg run carries a thread cap (FFMPEG_THREADS), so a decode on a
 * small container is not sized to every CPU the host reports. Seen on the
 * 512 MB staging server, 2026-10-12: one 1080p render's QC and proxies got
 * the container killed for memory.
 */
describe('withThreadCap', () => {
  it('caps decoding before the first input and encoding before the output', () => {
    expect(withThreadCap(['-i', 'in.mp4', '-vf', 'signalstats', '-an', '-f', 'null', '-'], 2)).toEqual([
      '-threads', '2', '-i', 'in.mp4', '-vf', 'signalstats', '-an', '-f', 'null', '-threads', '2', '-',
    ])
    expect(withThreadCap(['-ss', '1.000', '-i', 'v.mp4', '-frames:v', '1', 'thumb.jpg'], 1)).toEqual([
      '-threads', '1', '-ss', '1.000', '-i', 'v.mp4', '-frames:v', '1', '-threads', '1', 'thumb.jpg',
    ])
  })

  it('leaves a command that sets its own threads alone', () => {
    const own = ['-i', 'in.mp4', '-threads', '8', 'out.mp4']
    expect(withThreadCap(own, 2)).toBe(own)
  })
})
