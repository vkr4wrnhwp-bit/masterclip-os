import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AppError, formatUsd, newId, sha256File } from '@masterclip/shared'
import { objectKey, sanitizeFilename } from '@masterclip/asset-storage'
import { AUDIT_ACTIONS } from '@masterclip/domain'
import { buildEdl, buildFcpXml, probe, reframe, replaceAudioMoment, transcode, type DeliveryFormat } from '@masterclip/media-tools'
import { frameSize, type AspectRatio, type TargetResolution } from '@masterclip/shot-schema'
import type { Runtime } from './index.js'
import { withMediaFinishLease, type MediaFinishLease } from './media-finish-lease.js'

const execFileAsync = promisify(execFile)

export interface DeliverySpec {
  format: DeliveryFormat
  /** Alternate aspect ratio. Requires an explicit crop/pad choice. */
  aspectRatio?: AspectRatio
  resolution?: TargetResolution
  reframeMode?: 'crop' | 'pad'
  label?: string
}

export interface MasterPackage {
  masterId: string
  directory: string
  files: string[]
  manifestPath: string
}

/**
 * Master promotion, finishing, and delivery.
 *
 * Three rules are structural here, not stylistic:
 *
 *  - the untouched provider output is preserved forever as `original/`; every
 *    deliverable is derived from it and says so in its provenance;
 *  - transcoding never claims to add detail, and AI upscaling / frame
 *    interpolation are never applied by default — a 720p source in a 1080p
 *    ProRes wrapper is recorded as exactly that;
 *  - reframing to a new aspect ratio requires an explicit crop-or-pad choice
 *    from the caller, because both lose something the director approved.
 */
export class MasterService {
  constructor(private readonly rt: Runtime) {}

  /**
   * Promotes an approved output to a master.
   *
   * Requires a human approval decision on the record: QC can reject, but only a
   * person promotes.
   */
  async promote(input: { outputId: string; name: string; approvedBy: string; orgId: string }): Promise<string> {
    const output = await this.rt.renders.getOutput(input.outputId)
    const review = await this.rt.renders.latestReview(input.outputId)
    if (!review || (review.decision !== 'approve' && review.decision !== 'promote')) {
      throw new AppError({
        kind: 'validation',
        code: 'master.no_human_approval',
        message: 'an output must carry a human approval before it can become a master',
      })
    }

    const job = await this.rt.renders.getJob(output.jobId)
    const master = await this.rt.renders.promoteToMaster({
      projectId: output.projectId,
      sceneId: job.sceneId,
      shotId: output.shotId,
      outputId: output.id,
      name: input.name,
      sourceAssetId: output.assetId,
      approvedBy: input.approvedBy,
      metadata: {
        provider: output.providerId,
        model: output.modelId,
        shot_version_id: job.shotVersionId,
        compiled_prompt: job.compiledPrompt,
        seed: job.seed,
        approved_by: input.approvedBy,
      },
    })

    await this.rt.audit.record({
      orgId: input.orgId,
      projectId: output.projectId,
      actor: input.approvedBy,
      action: AUDIT_ACTIONS.masterPromoted,
      targetType: 'master',
      targetId: master.id,
      data: { outputId: output.id, provider: output.providerId, model: output.modelId },
    })
    return master.id
  }

  /** Renders the requested delivery formats from the approved source. */
  async finish(masterId: string, specs: DeliverySpec[], actor: string): Promise<string[]> {
    const master = await this.rt.renders.getMaster(masterId)
    const source = await this.rt.assets.get(master.sourceAssetId)
    const { path: localPath, cleanup } = await this.localCopy(source.storageKey)
    const workDir = await mkdtemp(join(tmpdir(), 'masterclip-finish-'))
    const created: string[] = []

    try {
      const info = await probe(localPath)
      for (const spec of specs) {
        // The label names files in the scratch folder, so it is reduced to one
        // plain file-name segment: a label like "../../x" used to write outside it.
        const label = sanitizeFilename(
          spec.label ?? `${spec.format}${spec.aspectRatio ? `_${spec.aspectRatio.replace(/[:.]/g, '')}` : ''}`,
        ).slice(0, 80)
        const extension = spec.format.startsWith('prores') ? 'mov' : 'mp4'
        const outPath = join(workDir, `${label}.${extension}`)

        if (spec.aspectRatio) {
          if (!spec.reframeMode) {
            throw new AppError({
              kind: 'validation',
              code: 'master.reframe_mode_required',
              message: `delivering ${spec.aspectRatio} needs an explicit reframeMode ("crop" loses framing, "pad" changes composition) — the system will not choose for you`,
            })
          }
          const target = frameSize(spec.resolution ?? '1080p', spec.aspectRatio)
          const reframed = join(workDir, `${label}_reframed.mp4`)
          await reframe(localPath, reframed, {
            targetWidth: target.width,
            targetHeight: target.height,
            mode: spec.reframeMode,
          })
          await transcode(reframed, outPath, { format: spec.format, dropAudio: !info.audio })
        } else {
          await transcode(localPath, outPath, { format: spec.format, dropAudio: !info.audio })
        }

        const assetId = newId('ast', this.rt.clock.now())
        const key = objectKey({ projectId: master.projectId, kind: 'delivery', id: assetId, filename: `${label}.${extension}` })
        const sha = await sha256File(outPath)
        const stored = await this.rt.storage.putFile(key, outPath, { contentType: extension === 'mov' ? 'video/quicktime' : 'video/mp4', sha256: sha })
        const outInfo = await probe(outPath).catch(() => null)

        const asset = await this.rt.assets.create({
          projectId: master.projectId,
          kind: 'delivery',
          storageKey: stored.key,
          filename: `${label}.${extension}`,
          mime: extension === 'mov' ? 'video/quicktime' : 'video/mp4',
          bytes: stored.bytes,
          sha256: stored.sha256,
          width: outInfo?.video?.width ?? null,
          height: outInfo?.video?.height ?? null,
          durationSeconds: outInfo?.durationSeconds ?? null,
          fps: outInfo?.video?.fps ?? null,
          hasAudio: Boolean(outInfo?.audio),
          metadata: {
            format: spec.format,
            reframe: spec.reframeMode ?? null,
            // Stated plainly so nobody reads a container change as a quality gain.
            source_resolution: `${info.video?.width ?? 0}x${info.video?.height ?? 0}`,
            note: 'container/codec conversion only — no upscaling or interpolation was applied',
          },
          rights: { owner: 'generated', source: 'finished from approved master', license: 'inherits source', consent: 'not_applicable', authorized: true },
          createdBy: actor,
          parents: [{ assetId: master.sourceAssetId, relation: 'delivery_of' }],
        })

        await this.rt.renders.addDeliverable({
          masterId,
          format: spec.format,
          assetId: asset.id,
          spec: { ...spec, sourceResolution: `${info.video?.width}x${info.video?.height}` },
        })
        created.push(asset.id)
      }

      const primary = created[0]
      if (primary) await this.rt.renders.setMasterAsset(masterId, primary, 'finished')
    } finally {
      await rm(workDir, { recursive: true, force: true })
      await cleanup()
    }
    return created
  }

  /**
   * Locally finishes an approved Quick Create video with the authorized song
   * moment locked to the rendered shot version. This is NOT generation, a
   * provider call, mastering, publishing or a permission grant.
   */
  async finishWithSongMoment(masterId: string, actor: string, orgId: string, lease?: MediaFinishLease):
    Promise<{ assetId: string; url: string; durationSeconds: number; reused: boolean; sandbox: boolean }> {
    if (!lease) {
      return withMediaFinishLease(this.rt, masterId, held =>
        this.finishWithSongMoment(masterId, actor, orgId, held))
    }
    const master = await this.rt.renders.getMaster(masterId)
    if (master.status === 'archived') {
      throw new AppError({ kind: 'validation', code: 'song_moment.archived', message: 'archived masters cannot be finished' })
    }
    const output = await this.rt.renders.getOutput(master.outputId)
    const job = await this.rt.renders.getJob(output.jobId)
    if (master.projectId !== job.projectId || master.shotId !== job.shotId || master.sourceAssetId !== output.assetId) {
      throw new AppError({ kind: 'forbidden', code: 'song_moment.mismatched_master', message: 'master source and render job do not match' })
    }
    const review = await this.rt.renders.latestReview(master.outputId)
    if (!review || !['approve', 'promote'].includes(review.decision)) {
      throw new AppError({ kind: 'forbidden', code: 'song_moment.review_required', message: 'human approval is required before embedding a recording' })
    }
    const shotVersion = await this.rt.projects.getVersion(job.shotVersionId)
    const cue = shotVersion.spec.music_cue
    if (shotVersion.shotId !== master.shotId || !cue) {
      throw new AppError({ kind: 'validation', code: 'song_moment.no_cue', message: 'approved shot version has no saved song moment' })
    }
    if (!cue.promotional_use_attested) {
      throw new AppError({ kind: 'forbidden', code: 'song_moment.consent_required', message: 'promotional use was not confirmed for this shot version' })
    }

    const song = await this.rt.assets.get(cue.asset_id)
    if (song.projectId !== master.projectId || song.kind !== 'audio' ||
        song.rights.consent !== 'authorized' || !song.rights.authorized || !song.rights.owner.trim() ||
        (song.rights.expiresAt && (!Number.isFinite(Date.parse(song.rights.expiresAt)) ||
          Date.parse(song.rights.expiresAt) <= this.rt.clock.now()))) {
      throw new AppError({ kind: 'forbidden', code: 'song_moment.rights', message: 'recording is not rights-cleared for this MOTION project' })
    }

    // Version-bound idempotency: re-clicking after success returns the existing
    // verified derivative rather than writing duplicate media.
    const prior = (await this.rt.renders.listDeliverables(masterId)).find(d =>
      d.spec.kind === 'song_moment' && d.spec.shotVersionId === shotVersion.id &&
      d.spec.audioAssetId === song.id &&
      d.spec.startSeconds === cue.start_seconds && d.spec.endSeconds === cue.end_seconds)
    if (prior) {
      const derivative = await this.rt.assets.get(prior.assetId)
      if (derivative.projectId === master.projectId && await this.rt.storage.exists(derivative.storageKey)) {
        return { assetId: derivative.id, url: await this.rt.storage.signedUrl(derivative.storageKey, 3600),
          durationSeconds: derivative.durationSeconds ?? cue.end_seconds - cue.start_seconds,
          reused: true, sandbox: job.sandbox }
      }
    }

    const sourceVideo = await this.rt.assets.get(master.sourceAssetId)
    if (sourceVideo.projectId !== master.projectId || !['generated_video', 'master', 'delivery'].includes(sourceVideo.kind)) {
      throw new AppError({ kind: 'forbidden', code: 'song_moment.video_source', message: 'master video is not an authorized output in this project' })
    }
    const dir = await mkdtemp(join(tmpdir(), 'masterclip-song-finish-'))
    let storedKey: string | null = null
    let registered = false
    try {
      const videoPath = this.rt.storage.localPath(sourceVideo.storageKey) ??
        await this.rt.storage.materialize(sourceVideo.storageKey, join(dir, 'video-input'))
      const songPath = this.rt.storage.localPath(song.storageKey) ??
        await this.rt.storage.materialize(song.storageKey, join(dir, 'audio-input'))
      const outPath = join(dir, 'song-moment.mp4')
      const verified = await replaceAudioMoment(videoPath, songPath, outPath, cue.start_seconds, cue.end_seconds)
      const assetId = newId('ast', this.rt.clock.now())
      const name = `song-moment-${assetId}.mp4`
      const key = objectKey({ projectId: master.projectId, kind: 'delivery', id: assetId, filename: name })
      const sha = await sha256File(outPath)
      const stored = await this.rt.storage.putFile(key, outPath, { contentType: 'video/mp4', sha256: sha })
      storedKey = stored.key
      // Register the asset, lineage and delivery together. The lock row is
      // checked under the same database transaction; an expired worker cannot
      // commit another completed delivery, even after its FFmpeg run finishes.
      const asset = await lease.commit(async tx => {
        await lease.assertAudioStillAuthorized(tx, song.id, master.projectId)
        const created = await this.rt.assets.create({
          projectId: master.projectId, kind: 'delivery', storageKey: stored.key,
          filename: name, mime: 'video/mp4', bytes: stored.bytes, sha256: stored.sha256,
          durationSeconds: verified.durationSeconds, hasAudio: true,
          metadata: {
            format: 'social_h264', finishing: 'song_moment', audioEmbedded: true,
            shotVersionId: shotVersion.id, sourceMasterId: masterId,
            sourceAudioAssetId: song.id, startSeconds: cue.start_seconds,
            endSeconds: cue.end_seconds, videoCodec: verified.codec,
            note: 'Actual MP4 with trimmed audio, source video unchanged; publishing rights and platform clearance not inferred.',
          },
          rights: { ...song.rights, source: `song moment from ${song.id}; video from approved master ${masterId}` },
          createdBy: actor,
          parents: [
            { assetId: sourceVideo.id, relation: 'delivery_of' },
            { assetId: song.id, relation: 'generated_from' },
          ],
        }, tx)
        await this.rt.renders.addDeliverable({
          masterId, format: 'social_h264', assetId: created.id,
          spec: { kind: 'song_moment', shotVersionId: shotVersion.id, audioAssetId: song.id,
            startSeconds: cue.start_seconds, endSeconds: cue.end_seconds, audioEmbedded: true },
        }, tx)
        return created
      })
      registered = true
      await this.rt.audit.record({
        orgId, projectId: master.projectId, actor,
        action: 'master.song_moment_finished', targetType: 'asset', targetId: asset.id,
        data: { masterId, shotVersionId: shotVersion.id, audioAssetId: song.id,
          startSeconds: cue.start_seconds, endSeconds: cue.end_seconds, sandbox: job.sandbox },
      })
      return { assetId: asset.id, url: await this.rt.storage.signedUrl(asset.storageKey, 3600),
        durationSeconds: verified.durationSeconds, reused: false, sandbox: job.sandbox }
    } catch (error) {
      // Delete only unregistered output bytes; never orphan a registered asset.
      if (!registered && storedKey) await this.rt.storage.delete(storedKey).catch(() => undefined)
      throw error
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * Builds the delivery package on disk in the documented layout, then tars it.
   *
   * The provenance sidecar and the cost ledger travel with the media — a
   * master that cannot say which model made it, from which prompt, at what
   * cost, is not a finished deliverable.
   */
  async buildPackage(masterId: string, destRoot?: string): Promise<MasterPackage> {
    const master = await this.rt.renders.getMaster(masterId)
    const output = await this.rt.renders.getOutput(master.outputId)
    const job = await this.rt.renders.getJob(output.jobId)
    const version = await this.rt.projects.getVersion(job.shotVersionId)
    const project = await this.rt.projects.get(master.projectId)
    const deliverables = await this.rt.renders.listDeliverables(masterId)
    const qc = await this.rt.renders.qcFor(output.id)
    const reviews = await this.rt.renders.reviewsFor(output.id)
    const variance = await this.rt.ledger.variance(job.id)

    const root = destRoot ?? (await mkdtemp(join(tmpdir(), 'masterclip-package-')))
    const dir = join(root, sanitize(master.name || masterId))
    for (const sub of ['original', 'review', 'frames', 'finished', 'deliveries', 'metadata']) {
      await mkdir(join(dir, sub), { recursive: true })
    }

    const files: string[] = []
    const copyAsset = async (assetId: string | null, subdir: string, filename?: string) => {
      if (!assetId) return
      const asset = await this.rt.assets.find(assetId)
      if (!asset) return
      const target = join(dir, subdir, filename ?? asset.filename)
      const { path, cleanup } = await this.localCopy(asset.storageKey)
      await cp(path, target)
      await cleanup()
      files.push(target)
    }

    await copyAsset(master.sourceAssetId, 'original')
    await copyAsset(output.proxyAssetId, 'review')
    await copyAsset(output.thumbnailAssetId, 'frames')
    await copyAsset(output.contactSheetAssetId, 'frames')
    for (const deliverable of deliverables) await copyAsset(deliverable.assetId, 'deliveries')

    const provenance = {
      master: { id: master.id, name: master.name, approvedBy: master.approvedBy, approvedAt: master.approvedAt, status: master.status },
      project: { id: project.id, name: project.name },
      shot: { id: output.shotId, versionId: job.shotVersionId, version: version.version, specHash: version.specHash },
      generation: {
        provider: output.providerId,
        model: output.modelId,
        externalJobId: job.externalJobId,
        compiledPrompt: job.compiledPrompt,
        seed: job.seed,
        routingProfile: job.routingProfile,
        sandbox: job.sandbox,
        submittedAt: job.submittedAt,
        completedAt: job.completedAt,
      },
      canonicalShot: version.spec,
      technical: {
        durationSeconds: output.durationSeconds,
        resolution: `${output.width}x${output.height}`,
        fps: output.fps,
        hasAudio: output.hasAudio,
        sha256: output.sha256,
      },
      qc,
      reviews,
      cost: {
        estimated: formatUsd(variance.estimated),
        charged: formatUsd(variance.charged),
        varianceMicros: variance.deltaMicros,
        sandbox: job.sandbox,
      },
      deliverables: deliverables.map((d) => ({ format: d.format, assetId: d.assetId, spec: d.spec })),
      // Stated explicitly so a downstream reader never infers an uplift.
      disclaimers: [
        'Deliverables are container/codec conversions of the original provider output. No AI upscaling or frame interpolation was applied.',
        'Any resolution above the source resolution in a deliverable reflects the wrapper, not added image detail.',
      ],
      generatedAt: this.rt.clock.isoNow(),
    }

    const manifestPath = join(dir, 'metadata', 'provenance.json')
    await writeFile(manifestPath, JSON.stringify(provenance, null, 2), 'utf8')
    files.push(manifestPath)

    const ledgerCsv = [
      'entry_type,provider,model,micros,usd,billable_seconds,sandbox,created_at',
      ...(await this.rt.ledger.entriesFor(master.projectId, 1000))
        .filter((row) => row.job_id === job.id)
        .map((row) =>
          [row.entry_type, row.provider_id, row.model_id, row.micros, formatUsd(Number(row.micros)), row.billable_seconds, row.sandbox, row.created_at].join(
            ',',
          ),
        ),
    ].join('\n')
    const ledgerPath = join(dir, 'metadata', 'cost-ledger.csv')
    await writeFile(ledgerPath, ledgerCsv + '\n', 'utf8')
    files.push(ledgerPath)

    return { masterId, directory: dir, files, manifestPath }
  }

  /** Sequence exports for handing an approved cut to an editor. */
  async buildSequence(projectId: string, masterIds: string[]): Promise<{ edl: string; fcpxml: string }> {
    const project = await this.rt.projects.get(projectId)
    const clips = []
    for (const masterId of masterIds) {
      const master = await this.rt.renders.getMaster(masterId)
      // The caller was checked against projectId only; a master id from any
      // other project used to be listed, name, file and format included.
      if (master.projectId !== projectId) {
        throw new AppError({ kind: 'forbidden', code: 'sequence.other_project', message: 'a master in this sequence belongs to another project' })
      }
      const output = await this.rt.renders.getOutput(master.outputId)
      const asset = await this.rt.assets.get(master.sourceAssetId)
      clips.push({
        name: master.name,
        file: asset.filename,
        durationSeconds: output.durationSeconds ?? 0,
        fps: output.fps ?? 24,
        width: output.width ?? 1920,
        height: output.height ?? 1080,
      })
    }
    return { edl: buildEdl(project.name, clips), fcpxml: buildFcpXml(project.name, clips) }
  }

  /** Tars a package directory for download. */
  async archive(packageDir: string, destPath: string): Promise<string> {
    await execFileAsync('tar', ['-czf', destPath, '-C', join(packageDir, '..'), packageDir.split('/').pop() ?? '.'], {
      maxBuffer: 8 * 1024 * 1024,
    })
    return destPath
  }

  private async localCopy(storageKey: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const direct = this.rt.storage.localPath(storageKey)
    if (direct) return { path: direct, cleanup: async () => {} }
    const dir = await mkdtemp(join(tmpdir(), 'masterclip-master-'))
    const path = await this.rt.storage.materialize(storageKey, join(dir, 'file.bin'))
    return { path, cleanup: async () => rm(dir, { recursive: true, force: true }) }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'master'
}
