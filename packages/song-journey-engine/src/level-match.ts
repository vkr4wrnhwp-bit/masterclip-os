/** A gain plan based only on the exact, measured audio bytes.
 * Compare at the quieter file's level: attenuation never pushes source audio
 * above full scale and works with the existing HTML audio playback engine.
 */
export const VERIFIED_LOUDNESS_METHOD = 'ffmpeg_ebur128_k_weighted_bs1770_4_true_peak'

export interface LoudnessEvidence {
  assetId: string
  analysisId: string
  sourceChecksum: string
  method: typeof VERIFIED_LOUDNESS_METHOD
  integratedLufs: number
  truePeakDbtp: number
}

export type LevelMatchProposal =
  | { available: false; reason: string }
  | { available: true; leftGainDb: number; rightGainDb: number; limited: boolean;
      basis: { leftAnalysisId: string; rightAnalysisId: string; leftChecksum: string; rightChecksum: string } }

const MAX_ATTENUATION_DB = 6
const SOURCE_TRUE_PEAK_CEILING_DBTP = -1

export function proposeLevelMatch(left: LoudnessEvidence, right: LoudnessEvidence): LevelMatchProposal {
  if (!left.assetId || !right.assetId || !left.analysisId || !right.analysisId ||
      left.assetId === right.assetId || left.sourceChecksum === right.sourceChecksum ||
      left.analysisId === right.analysisId ||
      ![left.sourceChecksum, right.sourceChecksum].every(v => /^[a-f0-9]{64}$/i.test(v))) {
    return { available: false, reason: 'Choose two different audio files with verified checksums.' }
  }
  if (left.method !== VERIFIED_LOUDNESS_METHOD || right.method !== VERIFIED_LOUDNESS_METHOD ||
      ![left.integratedLufs, right.integratedLufs].every(v => Number.isFinite(v) && v >= -80 && v <= 0)) {
    return { available: false, reason: 'Both versions need measured K-weighted integrated loudness.' }
  }
  // Decoded playback can be resampled by a device. Stay below a conservative
  // source ceiling; do not claim a certified hardware-output true peak.
  if (![left.truePeakDbtp, right.truePeakDbtp].every(v =>
      Number.isFinite(v) && v >= -160 && v <= SOURCE_TRUE_PEAK_CEILING_DBTP)) {
    return { available: false, reason: 'One source lacks the required -1 dBTP true-peak headroom.' }
  }

  const difference = left.integratedLufs - right.integratedLufs
  const attenuationDb = Math.min(MAX_ATTENUATION_DB, Math.abs(difference))
  const leftGainDb = difference > 0 ? -attenuationDb : 0
  const rightGainDb = difference < 0 ? -attenuationDb : 0
  return {
    available: true,
    leftGainDb,
    rightGainDb,
    limited: Math.abs(difference) > MAX_ATTENUATION_DB + 1e-9,
    basis: {
      leftAnalysisId: left.analysisId,
      rightAnalysisId: right.analysisId,
      leftChecksum: left.sourceChecksum,
      rightChecksum: right.sourceChecksum,
    },
  }
}
