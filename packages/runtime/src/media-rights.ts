import { AppError } from '@masterclip/shared'
import type { Asset } from '@masterclip/domain'
import type { Runtime } from './index.js'

const MAX_NODES = 512
const MAX_DEPTH = 32

/**
 * Read-time rights checks for signed media, including every recorded audio
 * ancestor of a derived song/caption delivery.
 *
 * A local signed URL is a capability to ask MOTION for the bytes, not a
 * perpetual license. A source revocation immediately refuses new server
 * reads, even if the URL signature itself has not expired.
 */
export async function assertMediaReadable(
  rt: Runtime,
  assetId: string,
): Promise<{ asset: Asset; containsAudio: boolean }> {
  const root = await rt.assets.get(assetId)
  const seen = new Set<string>([root.id])
  let frontier = [root.id]
  let depth = 0
  while (frontier.length > 0) {
    if (depth++ >= MAX_DEPTH || seen.size > MAX_NODES) {
      throw new AppError({
        kind: 'forbidden', code: 'media_rights.lineage_limit',
        message: 'media lineage exceeds the safe authorization limit',
      })
    }
    const next: string[] = []
    // A constant SQL statement with one bound child id per lookup also
    // satisfies the repository's strict interpolation security guard.
    for (const childId of frontier) {
      const rows = await rt.db.query<{ parent_asset_id: string }>(
        'SELECT parent_asset_id FROM asset_lineage WHERE child_asset_id = ?',
        [childId],
      )
      for (const row of rows) {
        if (!seen.has(row.parent_asset_id)) {
          seen.add(row.parent_asset_id)
          next.push(row.parent_asset_id)
          if (seen.size > MAX_NODES) {
            throw new AppError({
              kind: 'forbidden', code: 'media_rights.lineage_limit',
              message: 'media lineage exceeds the safe authorization limit',
            })
          }
        }
      }
    }
    frontier = next
  }

  let containsAudio = false
  const now = rt.clock.now()
  for (const id of seen) {
    const asset = id === root.id ? root : await rt.assets.get(id)
    if (asset.projectId !== root.projectId) {
      throw new AppError({
        kind: 'forbidden', code: 'media_rights.cross_project',
        message: 'a parent asset belongs to another project',
      })
    }
    const expiry = asset.rights.expiresAt ? Date.parse(asset.rights.expiresAt) : null
    if (asset.rights.consent === 'revoked' ||
        (expiry !== null && (!Number.isFinite(expiry) || expiry <= now))) {
      throw new AppError({
        kind: 'forbidden', code: 'media_rights.revoked',
        message: 'this media or a source recording has expired or revoked rights',
      })
    }
    if (asset.kind === 'audio') {
      containsAudio = true
      if (id !== root.id && (!asset.rights.authorized ||
          asset.rights.consent !== 'authorized' || !asset.rights.owner.trim())) {
        throw new AppError({
          kind: 'forbidden', code: 'media_rights.source_not_cleared',
          message: 'a source recording is not currently cleared for derived media',
        })
      }
    }
  }
  return { asset: root, containsAudio }
}

/** Do not mint an S3 presigned link after rights are revoked. New S3 links
 * involving audio are deliberately short-lived; already issued provider URLs
 * cannot be revoked by MOTION until expiry without changing the delivery path.
 */
export async function signedReadableUrl(rt: Runtime, assetId: string): Promise<string> {
  const { asset, containsAudio } = await assertMediaReadable(rt, assetId)
  return rt.storage.signedUrl(asset.storageKey, rt.storage.name === 's3' && containsAudio ? 120 : 3600)
}
