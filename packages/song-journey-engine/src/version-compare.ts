import type { SongVersionRecord } from '@masterclip/song-lab-domain'

/** Job 45: metadata-only version selection. Never claim an audio A/B is level matched
 * without a verified measurement from the exact version assets. */
export interface VersionPair {
  left: SongVersionRecord
  right: SongVersionRecord
  sameAsset: boolean
  playback: { available: false; reason: string }
  approval: { available: false; reason: string }
}

export function selectVersionPair(
  orgId: string,
  projectId: string,
  versions: readonly SongVersionRecord[],
  leftId: string,
  rightId: string,
): VersionPair {
  if (!orgId || !projectId || !leftId || !rightId || leftId === rightId) {
    throw new Error('Select two different versions from one authorized project.')
  }
  const left = versions.find(v => v.id === leftId && v.orgId === orgId && v.songLabProjectId === projectId)
  const right = versions.find(v => v.id === rightId && v.orgId === orgId && v.songLabProjectId === projectId)
  if (!left || !right) throw new Error('One or both versions were not found in this workspace and project.')
  return {
    left,
    right,
    sameAsset: Boolean(left.sourceAssetId && left.sourceAssetId === right.sourceAssetId),
    playback: {
      available: false,
      reason: 'Level-matched A/B requires both authorized audio assets and verified loudness measurements.',
    },
    approval: {
      available: false,
      reason: 'Approval requires a separate authenticated, version-pinned review receipt.',
    },
  }
}
