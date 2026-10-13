import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { objectKey } from '@masterclip/asset-storage'
import { AppError, hashObject, newId, sha256File } from '@masterclip/shared'
import { burnTimedCaptions, probe } from '@masterclip/media-tools'
import type { Runtime } from './index.js'
import { MasterService } from './masters.js'
import { withMediaFinishLease, type MediaFinishLease } from './media-finish-lease.js'

/** A second, optional and explicitly requested post-production derivative.
 * Does not mutate the original master or the clean music-video deliverable.
 */
export async function finishCaptionedSongMoment(
  rt: Runtime,
  masterId: string,
  actor: string,
  orgId: string,
  lease?: MediaFinishLease,
): Promise<{ assetId: string; url: string; reused: boolean; captionCount: number; durationSeconds: number; sandbox: boolean }> {
  if (!lease) {
    return withMediaFinishLease(rt, masterId, held =>
      finishCaptionedSongMoment(rt, masterId, actor, orgId, held))
  }
  const master = await rt.renders.getMaster(masterId)
  const output = await rt.renders.getOutput(master.outputId)
  const job = await rt.renders.getJob(output.jobId)
  if (master.projectId !== job.projectId || master.shotId !== job.shotId) {
    throw new AppError({ kind: 'forbidden', code: 'captions.mismatched_master', message: 'master and rendered shot do not match' })
  }
  const version = await rt.projects.getVersion(job.shotVersionId)
  if (version.shotId !== master.shotId || !version.spec.music_cue?.promotional_use_attested) {
    throw new AppError({ kind: 'forbidden', code: 'captions.no_approved_cue', message: 'an approved song cue is required' })
  }
  const captions = version.spec.timed_captions
  if (!captions.length) {
    throw new AppError({ kind: 'validation', code: 'captions.not_configured', message: 'this rendered shot version has no approved timed captions' })
  }

  // Always re-check the human approval and current audio rights before serving
  // even an already-created captioned derivative. This also verifies that the
  // clean music-video deliverable really exists in authorized project storage.
  const clean = await new MasterService(rt).finishWithSongMoment(masterId, actor, orgId, lease)
  const cleanAsset = await rt.assets.get(clean.assetId)
  if (cleanAsset.projectId !== master.projectId || cleanAsset.kind !== 'delivery') {
    throw new AppError({ kind: 'forbidden', code: 'captions.invalid_source', message: 'clean music-video delivery is not available in this project' })
  }

  const captionsHash = hashObject(captions)
  const prior = (await rt.renders.listDeliverables(masterId)).find(item =>
    item.spec.kind === 'captioned_song_moment' &&
    item.spec.shotVersionId === version.id &&
    item.spec.cleanAssetId === clean.assetId &&
    item.spec.captionsHash === captionsHash)
  if (prior) {
    const existing = await rt.assets.get(prior.assetId)
    if (existing.projectId === master.projectId && await rt.storage.exists(existing.storageKey)) {
      return {
        assetId: existing.id,
        url: await rt.storage.signedUrl(existing.storageKey, 3600),
        reused: true,
        captionCount: captions.length,
        durationSeconds: existing.durationSeconds ?? clean.durationSeconds,
        sandbox: job.sandbox,
      }
    }
  }

  const work = await mkdtemp(join(tmpdir(), 'motion-caption-finish-'))
  let storedKey: string | null = null
  let registered = false
  try {
    const original = rt.storage.localPath(cleanAsset.storageKey) ??
      await rt.storage.materialize(cleanAsset.storageKey, join(work, 'clean-source.mp4'))
    const outputPath = join(work, 'captioned-delivery.mp4')
    const verified = await burnTimedCaptions(original, outputPath, captions)
    const technical = await probe(outputPath)
    const assetId = newId('ast', rt.clock.now())
    const filename = 'captioned-song-' + assetId + '.mp4'
    const key = objectKey({ projectId: master.projectId, kind: 'delivery', id: assetId, filename })
    const sha = await sha256File(outputPath)
    const stored = await rt.storage.putFile(key, outputPath, { contentType: 'video/mp4', sha256: sha })
    storedKey = stored.key
    const asset = await lease.commit(async tx => {
      await lease.assertAudioStillAuthorized(tx, version.spec.music_cue!.asset_id, master.projectId)
      const created = await rt.assets.create({
        projectId: master.projectId,
        kind: 'delivery',
        storageKey: stored.key,
        filename,
        mime: 'video/mp4',
        bytes: stored.bytes,
        sha256: stored.sha256,
        width: technical.video?.width ?? null,
        height: technical.video?.height ?? null,
        fps: technical.video?.fps ?? null,
        durationSeconds: verified.durationSeconds,
        hasAudio: verified.hasAudio,
        createdBy: actor,
        rights: { ...cleanAsset.rights },
        metadata: {
          finishing: 'burned_captions',
          format: 'social_h264',
          renderedCaptionCount: captions.length,
          shotVersionId: version.id,
          cleanMusicDeliveryAssetId: clean.assetId,
          captionsHash,
          textSource: 'user-approved-timed-captions',
          note: 'Real FFmpeg burned captions on derived MP4; no automatic lyric detection or publishing',
        },
        parents: [{ assetId: clean.assetId, relation: 'delivery_of' }],
      }, tx)
      await rt.renders.addDeliverable({
        masterId,
        format: 'social_h264',
        assetId: created.id,
        spec: {
          kind: 'captioned_song_moment',
          shotVersionId: version.id,
          cleanAssetId: clean.assetId,
          captionsHash,
          captionCount: captions.length,
          captionsBurned: true,
        },
      }, tx)
      return created
    })
    registered = true
    await rt.audit.record({
      orgId, projectId: master.projectId, actor,
      action: 'master.captioned_song_finished',
      targetType: 'asset',
      targetId: asset.id,
      data: { masterId, shotVersionId: version.id, captionCount: captions.length, captionsHash, sandbox: job.sandbox },
    })
    return {
      assetId: asset.id,
      url: await rt.storage.signedUrl(asset.storageKey, 3600),
      reused: false,
      captionCount: captions.length,
      durationSeconds: verified.durationSeconds,
      sandbox: job.sandbox,
    }
  } catch (err) {
    if (!registered && storedKey) await rt.storage.delete(storedKey).catch(() => undefined)
    throw err
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
