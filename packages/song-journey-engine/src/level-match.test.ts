import { describe, expect, it } from 'vitest'
import { proposeLevelMatch, type LoudnessEvidence } from './level-match.js'

const evidence = (assetId: string, analysisId: string, integratedLufs: number | null, samplePeakDbfs = -12): LoudnessEvidence =>
  ({ assetId, analysisId, integratedLufs, samplePeakDbfs })

describe('Job 45 bounded loudness proposal', () => {
  it('proposes a correction toward the left reference without claiming playback', () => {
    expect(proposeLevelMatch(evidence('left', 'a1', -14), evidence('right', 'a2', -18))).toEqual({
      available: true, leftGainDb: 0, rightGainDb: 4, limited: false,
      basis: { leftAnalysisId: 'a1', rightAnalysisId: 'a2' },
    })
    expect(proposeLevelMatch(evidence('left', 'a1', -18), evidence('right', 'a2', -14))).toMatchObject({
      available: true, rightGainDb: -4, limited: false,
    })
  })

  it('caps compensation at 6 dB in either direction', () => {
    expect(proposeLevelMatch(evidence('left', 'a1', -10), evidence('right', 'a2', -30))).toMatchObject({
      available: true, rightGainDb: 6, limited: true,
    })
    expect(proposeLevelMatch(evidence('left', 'a1', -30), evidence('right', 'a2', -10))).toMatchObject({
      available: true, rightGainDb: -6, limited: true,
    })
  })

  it('reduces proposed gain when sample-peak headroom is insufficient', () => {
    expect(proposeLevelMatch(evidence('left', 'a1', -14), evidence('right', 'a2', -18, -2))).toMatchObject({
      available: true, rightGainDb: 1, limited: true,
    })
    expect(proposeLevelMatch(evidence('left', 'a1', -14), evidence('right', 'a2', -18, -0.5)).available).toBe(false)
    expect(proposeLevelMatch(evidence('left', 'a1', -14), evidence('right', 'a2', -18, Number.NaN)).available).toBe(false)
  })

  it('refuses missing, invalid, non-finite and unidentifiable measurements', () => {
    const left = evidence('left', 'a1', -14)
    for (const right of [
      evidence('right', 'a2', null),
      evidence('right', 'a2', Number.NaN),
      evidence('right', 'a2', Number.POSITIVE_INFINITY),
      evidence('right', 'a2', 2),
      evidence('right', 'a2', -90),
      evidence('left', 'a2', -18),
      evidence('right', 'a1', -18),
      evidence('', 'a2', -18),
    ]) {
      expect(proposeLevelMatch(left, right).available).toBe(false)
    }
  })
})
