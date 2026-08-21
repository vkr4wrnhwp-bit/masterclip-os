import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateTestVideo, type TestPattern } from '@masterclip/media-tools'
import { emptyShot } from '@masterclip/shot-schema'
import { HeuristicVisionClient, decide, runTechnicalQc, runVisualQc, type TechnicalQcResult, type VisionClient } from '../src/index.js'

/**
 * These tests render **real** defective MP4s with ffmpeg and assert that QC
 * catches each failure. That is the difference between "QC exists" and "QC
 * works": every defect below is one this system is specifically built to
 * reject before a human ever looks at it.
 */
let dir: string
const shot = emptyShot({ generation_mode: 'text_to_video', action: 'x', duration_seconds: 3, target_resolution: '480p', fps: 24 })

async function render(pattern: TestPattern, seconds = 3): Promise<string> {
  const path = join(dir, `${pattern}-${seconds}.mp4`)
  await generateTestVideo(path, { width: 854, height: 480, fps: 24, durationSeconds: seconds, pattern, variantSeed: 5 })
  return path
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'masterclip-qc-test-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('technical QC — real defective media', () => {
  it('passes a healthy clip', async () => {
    const result = await runTechnicalQc(await render('motion'), shot)
    expect(result.pass).toBe(true)
    expect(result.hardFailures).toHaveLength(0)
    expect(result.measurements.durationSeconds).toBeCloseTo(3, 0)
    expect(result.measurements.motionMean).toBeGreaterThan(1)
  })

  it('rejects a clip that is a still image held for the full duration', async () => {
    const result = await runTechnicalQc(await render('frozen'), shot)
    expect(result.pass).toBe(false)
    expect(result.hardFailures.map((f) => f.code)).toContain('content.frozen')
  })

  it('rejects an all-black clip', async () => {
    const result = await runTechnicalQc(await render('black'), shot)
    expect(result.pass).toBe(false)
    const codes = result.hardFailures.map((f) => f.code)
    expect(codes.some((code) => code === 'content.all_black' || code === 'content.frozen')).toBe(true)
  })

  it('rejects a clip the provider delivered at the wrong length', async () => {
    const result = await runTechnicalQc(await render('wrong_duration'), shot)
    expect(result.pass).toBe(false)
    const failure = result.hardFailures.find((f) => f.code === 'duration.mismatch')
    expect(failure).toBeDefined()
    expect(failure?.measured).toMatch(/1\.5/)
  })

  it('rejects a clip too compressed to be usable', async () => {
    const result = await runTechnicalQc(await render('low_bitrate'), shot)
    expect(result.pass).toBe(false)
    expect(result.hardFailures.map((f) => f.code)).toContain('bitrate.too_low')
  })

  it('reports a truncated download as a container failure, not a bad render', async () => {
    const result = await runTechnicalQc(await render('truncated'), shot)
    expect(result.pass).toBe(false)
    expect(result.hardFailures.map((f) => f.code)).toContain('container.unreadable')
    expect(result.hardFailures[0]?.message).toMatch(/failed download/)
  })

  it('rejects a byte-identical duplicate of a sibling render', async () => {
    const path = await render('motion')
    const first = await runTechnicalQc(path, shot)
    const duplicate = await runTechnicalQc(path, shot, { siblingHashes: [first.measurements.sha256] })
    expect(duplicate.pass).toBe(false)
    expect(duplicate.hardFailures.map((f) => f.code)).toContain('output.duplicate')
  })

  it('fails a silent clip when native audio was requested', async () => {
    const audioShot = { ...shot, audio_mode: 'native_generated' as const }
    const result = await runTechnicalQc(await render('motion'), audioShot)
    expect(result.hardFailures.map((f) => f.code)).toContain('audio.missing')
  })

  it('warns about a resolution mismatch that preserves the aspect ratio', async () => {
    const bigger = { ...shot, target_resolution: '720p' as const }
    const result = await runTechnicalQc(await render('motion'), bigger)
    const warning = result.warnings.find((w) => w.code === 'resolution.size_mismatch')
    expect(warning).toBeDefined()
    // Same shape at a different size is a warning; a different shape is fatal.
    expect(result.hardFailures.map((f) => f.code)).not.toContain('resolution.aspect_mismatch')
  })

  it('reports a missing file rather than throwing', async () => {
    const result = await runTechnicalQc(join(dir, 'does-not-exist.mp4'), shot)
    expect(result.pass).toBe(false)
    expect(result.hardFailures[0]?.code).toBe('file.missing')
  })
})

describe('QC decisions', () => {
  const passing: TechnicalQcResult = {
    pass: true,
    hardFailures: [],
    warnings: [],
    measurements: {
      bytes: 1000,
      sha256: 'a'.repeat(64),
      durationSeconds: 8,
      width: 1280,
      height: 720,
      fps: 24,
      codec: 'h264',
      container: 'mov,mp4',
      bitRate: 2_000_000,
      hasAudio: false,
      blackIntervals: 0,
      blackSeconds: 0,
      freezeIntervals: 0,
      freezeSeconds: 0,
      motionMean: 4,
      motionMax: 6,
      lumaMean: 120,
      lumaStdev: 12,
      decodeErrors: [],
    },
  }

  const visual = (overrides: Record<string, unknown> = {}) => ({
    creativeScore: 80,
    identityScore: 85,
    continuityScore: 80,
    motionScore: 75,
    realismScore: 80,
    hardFailures: [] as string[],
    warnings: [] as string[],
    observations: [] as string[],
    confidence: 0.8,
    engine: 'test',
    costMicros: 0,
    ...overrides,
  })

  it('auto-rejects a demonstrated technical failure with near-certainty', () => {
    const failed: TechnicalQcResult = {
      ...passing,
      pass: false,
      hardFailures: [{ code: 'content.frozen', message: 'the clip is a still image', severity: 'hard' }],
    }
    const report = decide({ shot, technical: failed, visual: null })
    expect(report.recommended_action).toBe('AUTO_REJECT')
    expect(report.confidence).toBeGreaterThan(0.9)
    expect(report.correction).toMatch(/continuous physical action/)
  })

  it('treats a broken download as a re-fetch, not a rejected render', () => {
    const broken: TechnicalQcResult = {
      ...passing,
      pass: false,
      hardFailures: [{ code: 'container.unreadable', message: 'not a readable container', severity: 'hard' }],
    }
    const report = decide({ shot, technical: broken, visual: null })
    expect(report.recommended_action).toBe('REGENERATE_WITH_CORRECTION')
    expect(report.rationale).toMatch(/Delivery failure/)
    expect(report.rationale).toMatch(/do not count this against the model/)
  })

  it('never auto-promotes — a master always needs a person', () => {
    const strong = decide({ shot, technical: passing, visual: visual({ creativeScore: 96, confidence: 0.95 }) })
    expect(strong.recommended_action).not.toBe('PROMOTE_TO_FINAL')
    expect(strong.recommended_action).toBe('APPROVE_FOR_DRAFT')

    const hero = decide({ shot: { ...shot, routing_profile: 'HERO' }, technical: passing, visual: visual({ creativeScore: 96, confidence: 0.95 }) })
    expect(hero.recommended_action).toBe('HUMAN_REVIEW')
  })

  it('sends identity drift back for regeneration rather than rejecting outright', () => {
    const drifting = { ...shot, identity_locks: [{ character_key: 'NOVA', character_version: 0, strength: 'strict' as const, must_match: [] }] }
    const report = decide({ shot: drifting, technical: passing, visual: visual({ identityScore: 35 }) })
    expect(report.recommended_action).toBe('REGENERATE_WITH_CORRECTION')
    expect(report.correction).toMatch(/identity references/)
  })

  it('routes a realism floor to a different model, since prompting will not fix it', () => {
    const report = decide({ shot, technical: passing, visual: visual({ realismScore: 30 }) })
    expect(report.recommended_action).toBe('SEND_TO_DIFFERENT_MODEL')
  })

  it('sends an uncertain verdict to a human instead of guessing', () => {
    const report = decide({ shot, technical: passing, visual: visual({ confidence: 0.2 }) })
    expect(report.recommended_action).toBe('HUMAN_REVIEW')
  })

  it('does not pass creatively weak work just because nothing measurable is wrong', () => {
    const report = decide({ shot, technical: passing, visual: visual({ creativeScore: 45 }) })
    expect(report.recommended_action).toBe('HUMAN_REVIEW')
    expect(report.rationale).toMatch(/not clearly a winner/)
  })
})

describe('visual QC without a vision model', () => {
  it('reports honestly that nothing was assessed instead of inventing scores', async () => {
    const technical = await runTechnicalQc(await render('motion'), shot)
    const client: VisionClient = new HeuristicVisionClient(() => technical)
    const result = await runVisualQc(client, { shot, technical, framePaths: [] })

    expect(result.engine).toContain('heuristic-no-vision-model')
    expect(result.creativeScore).toBe(0)
    expect(result.confidence).toBeLessThan(0.1)
    expect(result.warnings.join(' ')).toMatch(/no vision model configured/)
    // Low confidence must land on human review, never on an automatic pass.
    expect(decide({ shot, technical, visual: result }).recommended_action).toBe('HUMAN_REVIEW')
  })
})

describe('ffmpeg failure classification', () => {
  it('treats a corrupt container as permanent, not as a transient I/O error', async () => {
    // Retrying a truncated download five times just burns queue slots: the
    // bytes are broken and will fail identically every time.
    const truncated = await render('truncated')
    const failure = await import('@masterclip/media-tools').then(({ probe }) => probe(truncated).then(() => null, (err) => err))
    expect(failure).toBeTruthy()
    expect((failure as { kind: string }).kind).toBe('validation')
    expect((failure as { code: string }).code).toBe('media.invalid_input')
    const { isTransient } = await import('@masterclip/shared')
    expect(isTransient(failure)).toBe(false)
  })

  it('recognises the permanent-input signatures ffmpeg actually emits', async () => {
    const { isPermanentInputFailure } = await import('@masterclip/media-tools')
    expect(isPermanentInputFailure('moov atom not found')).toBe(true)
    expect(isPermanentInputFailure('Invalid data found when processing input')).toBe(true)
    expect(isPermanentInputFailure('No such file or directory')).toBe(true)
    // A genuinely transient condition must not be swallowed by this.
    expect(isPermanentInputFailure('Connection reset by peer')).toBe(false)
    expect(isPermanentInputFailure('Resource temporarily unavailable')).toBe(false)
  })
})
