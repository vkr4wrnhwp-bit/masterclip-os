import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyzeOnsetEnvelope, beatAnalysis, ffmpeg } from '@masterclip/media-tools'

let root = ''
let clickTrack = ''
let silence = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'motion-beat-analysis-'))
  clickTrack = join(root, '120bpm.wav')
  silence = join(root, 'silence.wav')
  // Physical 120-BPM click track at half-second intervals, not a fake
  // waveform. Decoding and beat estimation run on actual file bytes.
  await ffmpeg(['-f', 'lavfi', '-i',
    'aevalsrc=if(lt(mod(t\,0.5)\,0.025)\,0.8*sin(2*PI*900*t)\,0):s=8000:d=12',
    '-c:a', 'pcm_s16le', clickTrack])
  await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '5', '-c:a', 'pcm_s16le', silence])
}, 90_000)

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('MOTION native Beat Intelligence', () => {
  it('detects rhythmic energy from actual decoded recorded audio', async () => {
    const result = await beatAnalysis(clickTrack)
    expect(result.source).toBe('decoded_pcm_onset')
    expect(result.analysisVersion).toBe(1)
    expect(result.bpm).not.toBeNull()
    expect(result.bpm ?? 0).toBeGreaterThan(115)
    expect(result.bpm ?? 0).toBeLessThan(125)
    expect(result.confidence).toBeGreaterThan(0.3)
    expect(result.beats.length).toBeGreaterThan(15)
    expect(result.beats.every(time => time >= 0 && time <= result.durationSeconds)).toBe(true)
  }, 90_000)

  it('does not invent beat timing from silent sources', async () => {
    const result = await beatAnalysis(silence)
    expect(result.bpm).toBeNull()
    expect(result.confidence).toBe(0)
    expect(result.beats).toEqual([])
  }, 60_000)

  it('does not overclaim meter, sections or downbeats', () => {
    const energies = Array.from({ length: 200 }, (_, index) => index % 10 === 0 ? 1 : .05)
    const result = analyzeOnsetEnvelope(energies, .05, 10)
    expect(result.source).toBe('decoded_pcm_onset')
    expect(result.bpm).toBe(120)
    expect(result.limitation).toMatch(/No meter, downbeat or section detection/)
  })
})
