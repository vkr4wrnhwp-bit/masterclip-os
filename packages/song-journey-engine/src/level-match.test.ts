import { describe, expect, it } from 'vitest'
import { proposeLevelMatch, VERIFIED_LOUDNESS_METHOD, type LoudnessEvidence } from './level-match.js'

const measured = (
  name: 'a' | 'b', lufs: number, truePeakDbtp = -8,
): LoudnessEvidence => ({
  assetId: `asset-${name}`, analysisId: `analysis-${name}`,
  sourceChecksum: name.repeat(64), method: VERIFIED_LOUDNESS_METHOD,
  integratedLufs: lufs, truePeakDbtp,
})

describe('Job 45: audio measurements and safe gain plan', () => {
  it('attenuates the louder audio only; never boosts a file or replaces it', () => {
    expect(proposeLevelMatch(measured('a', -14), measured('b', -18))).toMatchObject({
      available: true, leftGainDb: -4, rightGainDb: 0, limited: false,
      basis: { leftChecksum: 'a'.repeat(64), rightChecksum: 'b'.repeat(64) },
    })
    expect(proposeLevelMatch(measured('a', -18), measured('b', -14))).toMatchObject({
      available: true, leftGainDb: 0, rightGainDb: -4, limited: false,
    })
    expect(proposeLevelMatch(measured('a', -14), measured('b', -14))).toMatchObject({
      available: true, leftGainDb: 0, rightGainDb: 0, limited: false,
    })
  })

  it('stops at 6 dB and reports an incomplete match', () => {
    expect(proposeLevelMatch(measured('a', -8), measured('b', -22))).toMatchObject({
      available: true, leftGainDb: -6, rightGainDb: 0, limited: true,
    })
    expect(proposeLevelMatch(measured('a', -22), measured('b', -8))).toMatchObject({
      available: true, leftGainDb: 0, rightGainDb: -6, limited: true,
    })
  })

  it('refuses unsafe true peak, non-standards estimates, and incomplete audio evidence', () => {
    const a = measured('a', -14)
    const b = measured('b', -18)
    for (const invalid of [
      { ...b, truePeakDbtp: -0.9 },
      { ...b, truePeakDbtp: Number.NaN },
      { ...b, truePeakDbtp: null },
      { ...b, integratedLufs: null },
      { ...b, integratedLufs: Infinity },
      { ...b, integratedLufs: 2 },
      { ...b, integratedLufs: -95 },
      { ...b, method: 'gated_block_rms_estimate' },
      { ...b, sourceChecksum: a.sourceChecksum },
      { ...b, sourceChecksum: 'not-a-sha256' },
      { ...b, analysisId: a.analysisId },
      { ...b, assetId: a.assetId },
    ] as LoudnessEvidence[]) {
      expect(proposeLevelMatch(a, invalid).available).toBe(false)
    }
  })
})
