/** Job 45: bounded gain proposal from measured integrated loudness.
 * A gain proposal is NOT evidence that audio was played or level-matched.
 * The caller must independently validate the exact asset, analyzer and playback chain. */
export interface LoudnessEvidence {
  assetId: string
  analysisId: string
  integratedLufs: number | null
  /** Measured sample peak for this exact asset, in dBFS. Not true peak. */
  samplePeakDbfs: number | null
}

export type LevelMatchProposal =
  | { available: false; reason: string }
  | { available: true; leftGainDb: 0; rightGainDb: number; limited: boolean; basis: { leftAnalysisId: string; rightAnalysisId: string } }

const MAX_COMPENSATION_DB = 6
const SAMPLE_PEAK_HEADROOM_DB = 1

export function proposeLevelMatch(left: LoudnessEvidence, right: LoudnessEvidence): LevelMatchProposal {
  if (!left.assetId || !right.assetId || !left.analysisId || !right.analysisId ||
      left.assetId === right.assetId || left.analysisId === right.analysisId) {
    return { available: false, reason: 'Two distinct, identified source assets and analyses are required.' }
  }
  if (left.integratedLufs === null || right.integratedLufs === null ||
      !Number.isFinite(left.integratedLufs) || !Number.isFinite(right.integratedLufs) ||
      left.integratedLufs > 0 || right.integratedLufs > 0 ||
      left.integratedLufs < -80 || right.integratedLufs < -80) {
    return { available: false, reason: 'Both versions need valid measured integrated loudness.' }
  }
  // This is only a sample-peak guard. A verified true-peak and playback-chain
  // check is still required before gain may be applied to audible audio.
  if (left.samplePeakDbfs === null || right.samplePeakDbfs === null ||
      !Number.isFinite(left.samplePeakDbfs) || !Number.isFinite(right.samplePeakDbfs) ||
      left.samplePeakDbfs > -SAMPLE_PEAK_HEADROOM_DB || right.samplePeakDbfs > -SAMPLE_PEAK_HEADROOM_DB ||
      left.samplePeakDbfs < -160 || right.samplePeakDbfs < -160) {
    return { available: false, reason: 'Both exact assets need measured sample-peak headroom before proposing gain.' }
  }
  const delta = left.integratedLufs - right.integratedLufs
  const headroom = -SAMPLE_PEAK_HEADROOM_DB - right.samplePeakDbfs
  const bounded = Math.max(-MAX_COMPENSATION_DB, Math.min(MAX_COMPENSATION_DB, headroom, delta))
  return {
    available: true,
    leftGainDb: 0,
    rightGainDb: bounded,
    limited: Math.abs(delta - bounded) > 1e-9,
    basis: { leftAnalysisId: left.analysisId, rightAnalysisId: right.analysisId },
  }
}
