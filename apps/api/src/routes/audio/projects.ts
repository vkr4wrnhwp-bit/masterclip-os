import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { requireAudio, readUpload, parseBool } from './helpers.js'

/** Global Release Pack, Campaign Audio Toolkit, and Remix Lab routes. */
export async function registerAudioProjectRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const audio = runtime.audio

  // ----- Global Release Pack ------------------------------------------------

  app.get('/api/audio/dubbing', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.global_release_pack')
    return { projects: await audio.repos.dubbing.list(actor.orgId) }
  })

  app.post('/api/audio/dubbing', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.global_release_pack', { slot: 'dubbing' })
    const { bytes, filename, fields } = await readUpload(request)
    const project = await audio.globalRelease.create({
      actor,
      name: fields.name ?? filename,
      bytes,
      filename,
      sourceLanguage: fields.sourceLanguage ?? 'en',
      targetLanguages: (fields.targetLanguages ?? '').split(',').map((l) => l.trim()).filter(Boolean),
      voiceStrategy: (fields.voiceStrategy ?? 'approved_narrator') as never,
      rightsConfirmed: parseBool(fields.rightsConfirmed),
    })
    return { project, warning }
  })

  app.get('/api/audio/dubbing/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.global_release_pack')
    const { id } = request.params as { id: string }
    const project = await audio.repos.dubbing.get(actor.orgId, id)
    const segments = project.transcriptId ? await audio.repos.transcripts.segments(actor.orgId, project.transcriptId) : []
    return { project, segments }
  })

  app.post('/api/audio/dubbing/:id/approve-transcript', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.global_release_pack')
    const { id } = request.params as { id: string }
    await audio.globalRelease.approveTranscript(actor, id)
    return { ok: true }
  })

  app.post('/api/audio/dubbing/:id/approve', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.global_release_pack', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    const body = z.object({ note: z.string().max(2000).default('') }).parse(request.body ?? {})
    await audio.globalRelease.approve(actor, id, body.note)
    return { ok: true }
  })

  app.get('/api/audio/dubbing/:id/export', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.global_release_pack')
    const { id } = request.params as { id: string }
    return { exports: await audio.globalRelease.export(actor, id) }
  })

  // ----- Campaign Audio Toolkit --------------------------------------------

  app.get('/api/audio/campaigns', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.campaign_voiceover')
    return { projects: await audio.repos.campaigns.list(actor.orgId) }
  })

  app.post('/api/audio/campaigns', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.campaign_voiceover')
    const body = z
      .object({
        name: z.string().min(1).max(200),
        templateType: z.string().min(1),
        usageContext: z.string().max(200).default('social'),
        rightsBasis: z.string().max(200).default('owned_release_assets'),
      })
      .parse(request.body)
    const project = await audio.campaigns.create({ actor, ...body })
    return { project }
  })

  app.get('/api/audio/campaigns/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.campaign_voiceover')
    const { id } = request.params as { id: string }
    const project = await audio.repos.campaigns.get(actor.orgId, id)
    const assets = await audio.repos.assets.list(actor.orgId, { projectType: 'campaign', projectId: id })
    const generations = await audio.repos.assets.generationsForProject(actor.orgId, 'campaign', id)
    const withUrls = await Promise.all(
      assets.map(async (asset) => ({ ...asset, url: await runtime.storage.signedUrl(asset.storageKey, 3600) })),
    )
    return { project, assets: withUrls, generations }
  })

  app.post('/api/audio/campaigns/:id/voiceover', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.campaign_voiceover', { slot: 'speech' })
    const { id } = request.params as { id: string }
    const body = z.object({ text: z.string().min(1).max(5000), voiceProfileId: z.string().optional() }).parse(request.body)
    const jobId = await audio.campaigns.enqueueGenerate(actor, {
      campaignId: id,
      operation: 'voiceover',
      text: body.text,
      ...(body.voiceProfileId ? { voiceProfileId: body.voiceProfileId } : {}),
    })
    return { jobId, warning }
  })

  app.post('/api/audio/campaigns/:id/sound-effect', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.sound_effects', { slot: 'soundEffects' })
    const { id } = request.params as { id: string }
    const body = z.object({ text: z.string().min(1).max(500), durationSeconds: z.number().min(0.5).max(30).optional() }).parse(request.body)
    const jobId = await audio.campaigns.enqueueGenerate(actor, {
      campaignId: id,
      operation: 'sound_effect',
      text: body.text,
      ...(body.durationSeconds !== undefined ? { durationSeconds: body.durationSeconds } : {}),
    })
    return { jobId, warning }
  })

  app.post('/api/audio/campaigns/:id/isolate-voice', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.voice_isolation', { slot: 'isolation' })
    const { id } = request.params as { id: string }
    const body = z.object({ sourceAssetId: z.string().min(1) }).parse(request.body)
    const jobId = await audio.campaigns.enqueueGenerate(actor, { campaignId: id, operation: 'voice_isolation', sourceAssetId: body.sourceAssetId })
    return { jobId, warning }
  })

  /** Source upload for campaign tools (dialogue cleanup input, references). */
  app.post('/api/audio/campaigns/:id/upload', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.campaign_voiceover')
    const { id } = request.params as { id: string }
    await audio.repos.campaigns.get(actor.orgId, id)
    const { bytes, filename } = await readUpload(request)
    const asset = await audio.assets.storeUpload({
      actor,
      bytes,
      filename,
      area: 'source',
      projectType: 'campaign',
      projectId: id,
      assetType: 'campaign_source',
      retentionKind: 'source',
      rightsStatus: 'authorized_upload',
      consentRecordId: null,
    })
    return { asset }
  })

  // ----- Remix Lab ----------------------------------------------------------

  app.get('/api/audio/remix', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.remix_lab')
    return { projects: await audio.repos.remix.list(actor.orgId) }
  })

  app.post('/api/audio/remix', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.remix_lab')
    const { bytes, filename, fields } = await readUpload(request)
    const project = await audio.remix.create({
      actor,
      name: fields.name ?? filename,
      bytes,
      filename,
      remixLane: fields.remixLane ?? 'stems',
      targetUse: fields.targetUse ?? 'social_versions',
      rightsConfirmed: parseBool(fields.rightsConfirmed),
      noImitationConfirmed: parseBool(fields.noImitationConfirmed),
    })
    return { project }
  })

  app.get('/api/audio/remix/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.remix_lab')
    const { id } = request.params as { id: string }
    const project = await audio.repos.remix.get(actor.orgId, id)
    const versions = await audio.repos.remix.versions(actor.orgId, id)
    const withUrls = await Promise.all(
      versions.map(async (version) => ({
        ...version,
        url: version.outputAssetId ? (await audio.assets.signedUrl(actor.orgId, version.outputAssetId)).url : null,
      })),
    )
    return { project, versions: withUrls }
  })

  app.post('/api/audio/remix/:id/stems', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.stem_separation', { slot: 'stems' })
    const { id } = request.params as { id: string }
    const jobId = await audio.remix.enqueueOperation(actor, { remixProjectId: id, operation: 'stems' })
    return { jobId, warning }
  })

  app.post('/api/audio/remix/:id/upload-screen', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.remix_lab', { slot: 'music' })
    const { id } = request.params as { id: string }
    const jobId = await audio.remix.enqueueOperation(actor, { remixProjectId: id, operation: 'upload_screen' })
    return { jobId }
  })

  app.post('/api/audio/remix/:id/composition-plan', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.remix_lab', { slot: 'music' })
    const { id } = request.params as { id: string }
    const jobId = await audio.remix.enqueueOperation(actor, { remixProjectId: id, operation: 'composition_plan' })
    return { jobId }
  })

  app.post('/api/audio/remix/:id/concept', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.music_generation', { slot: 'music' })
    const { id } = request.params as { id: string }
    const body = z.object({ prompt: z.string().min(1).max(2000), parentVersionId: z.string().optional() }).parse(request.body)
    const jobId = await audio.remix.enqueueOperation(actor, {
      remixProjectId: id,
      operation: 'concept',
      prompt: body.prompt,
      ...(body.parentVersionId ? { parentVersionId: body.parentVersionId } : {}),
    })
    return { jobId, warning }
  })

  app.post('/api/audio/remix/:id/inpaint', async (request) => {
    const { actor, warning } = await requireAudio(runtime, request, 'audio.music_inpainting', { slot: 'music' })
    const { id } = request.params as { id: string }
    const body = z
      .object({
        prompt: z.string().min(1).max(2000),
        rangeMs: z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(1) }).optional(),
      })
      .parse(request.body)
    const jobId = await audio.remix.enqueueOperation(actor, {
      remixProjectId: id,
      operation: 'inpaint',
      prompt: body.prompt,
      ...(body.rangeMs ? { rangeMs: body.rangeMs } : {}),
    })
    return { jobId, warning }
  })

  app.post('/api/audio/remix/:id/review-version', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.remix_lab')
    const { id } = request.params as { id: string }
    const body = z.object({ versionId: z.string().min(1), status: z.enum(['producer_reviewed', 'rejected']) }).parse(request.body)
    await audio.repos.remix.reviewVersion(actor.orgId, id, body.versionId, body.status, actor.userId)
    return { ok: true }
  })

  app.post('/api/audio/remix/:id/approve', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.remix_lab', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    const body = z.object({ status: z.enum(['producer_approved', 'release_ready']) }).parse(request.body)
    await audio.repos.remix.setApproval(actor.orgId, id, body.status, actor.userId)
    return { ok: true }
  })
}
