/** Job 45: bounded gain proposal from measured integrated loudness.
 * A gain proposal is NOT evidence that audio was played or level-matched.
 * The caller must independently validate the exact asset, analyzer and playback chain. */
export interface LoudnessEvidence {
  assetId: string
  analysisId: string
  integratedLufs: number | null
}

export type LevelMatchProposal =
  | { available: false; reason: string }
  | { available: true; leftGainDb: 0; rightGainDb: number; limited: boolean; basis: { leftAnalysisId: string; rightAnalysisId: string } }

const MAX_COMPENSATION_DB = 6

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
  const delta = left.integratedLufs - right.integratedLufs
  const bounded = Math.max(-MAX_COMPENSATION_DB, Math.min(MAX_COMPENSATION_DB, delta))
  return {
    available: true,
    leftGainDb: 0,
    rightGainDb: bounded,
    limited: Math.abs(delta) > MAX_COMPENSATION_DB,
    basis: { leftAnalysisId: left.analysisId, rightAnalysisId: right.analysisId },
  }
}
