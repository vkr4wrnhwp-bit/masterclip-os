import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { AppError, forbidden, sha256Hex } from '@masterclip/shared'
import { objectKey, sanitizeFilename } from '@masterclip/asset-storage'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import {
  AiSceneRequest,
  FLAGSHIP_CAPABILITIES,
  PadAssignment,
  Quantization,
  SceneType,
  SetItemType,
  StageControlSession,
  StemType,
  buildStageControlHandoff,
  defaultPadMap,
  remapPadMap,
  type LiveProject,
} from '@masterclip/performance-project'
import { checkPromptSafety } from '@masterclip/ai-audio'
import type { Runtime } from '@masterclip/runtime'
import { requireAuth, requireProject } from '../server.js'
import { sniffMime } from './assets.js'

/**
 * Live Lab — the live-performance module's HTTP surface.
 *
 * Every route is organization scoped and entitlement checked *server-side*
 * before the body runs. AI generation is queued, never executed inline. The
 * routes exist to edit and package a show; during Performance Mode the client
 * plays exclusively from its local cache and needs none of this.
 */

const RIGHTS_STATEMENT =
  'I confirm that I own or control the audio I am uploading, or have authorization from the rights holder to use it.'

export async function registerLiveLabRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  /** Auth + module entitlement + optional extra capability. */
  async function requireLiveLab(request: FastifyRequest, capability?: string) {
    const auth = await requireAuth(runtime, request)
    await runtime.entitlements.require(auth.orgId, 'live_lab.access')
    if (capability && capability !== 'live_lab.access') await runtime.entitlements.require(auth.orgId, capability)
    return auth
  }

  /** Loads a live project and proves it belongs to the caller's organization. */
  async function requireLiveProject(request: FastifyRequest, projectId: string, capability?: string): Promise<{ auth: Awaited<ReturnType<typeof requireLiveLab>>; project: LiveProject }> {
    const auth = await requireLiveLab(request, capability)
    const project = await runtime.liveLab.getProject(projectId)
    if (project.organizationId !== auth.orgId) throw forbidden('live project belongs to another organization')
    return { auth, project }
  }

  /** Loads any org-checked child record's project via its own org_id column. */
  function assertSameOrg(recordOrgId: string, orgId: string): void {
    if (recordOrgId !== orgId) throw forbidden('record belongs to another organization')
  }

  // -------------------------------------------------------- capabilities ----

  app.get('/api/live-lab/capabilities', async (request) => {
    const auth = await requireAuth(runtime, request)
    const { capabilities, limits } = await runtime.entitlements.listForOrg(auth.orgId)
    return {
      capabilities: capabilities.filter((c) => c.startsWith('live_lab.')),
      limits,
      all: [...FLAGSHIP_CAPABILITIES],
      rightsStatement: RIGHTS_STATEMENT,
      aiProvider: runtime.liveLabService.aiProviderId,
    }
  })

  // ------------------------------------------------------------ projects ----

  app.get('/api/live-lab/projects', async (request) => {
    const auth = await requireLiveLab(request)
    const projects = await runtime.liveLab.listProjects(auth.orgId)
    const summaries = await Promise.all(
      projects.map(async (project) => {
        const [items, packages] = await Promise.all([
          runtime.liveLab.listItems(project.id),
          runtime.liveLab.listPackages(project.id),
        ])
        return {
          ...project,
          songCount: items.filter((i) => i.type === 'song').length,
          itemCount: items.length,
          latestPackage: packages[0] ? { id: packages[0].id, version: packages[0].version, status: packages[0].status } : null,
        }
      }),
    )
    return { projects: summaries }
  })

  app.post('/api/live-lab/projects', async (request) => {
    const auth = await requireLiveLab(request, 'live_lab.projects')
    const body = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(4000).optional(),
        masterTempo: z.number().min(20).max(400).optional(),
        timeSignature: z.string().regex(/^\d{1,2}\/\d{1,2}$/).optional(),
        artistId: z.string().nullable().optional(),
        duplicateOf: z.string().optional(),
      })
      .parse(request.body)

    const activeCount = await runtime.liveLab.countProjects(auth.orgId)
    await runtime.entitlements.requireWithinLimit(auth.orgId, 'live_lab.max_projects', activeCount, 'active Live Lab project')

    // Resolved before anything is created. Creating the project first meant a
    // duplicate of an unreadable or foreign set left an empty project behind,
    // still counting against live_lab.max_projects.
    const source = body.duplicateOf ? await runtime.liveLab.getProject(body.duplicateOf) : null
    if (source) assertSameOrg(source.organizationId, auth.orgId)

    const project = await runtime.liveLab.createProject({
      orgId: auth.orgId,
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.masterTempo !== undefined ? { masterTempo: body.masterTempo } : {}),
      ...(body.timeSignature !== undefined ? { timeSignature: body.timeSignature } : {}),
      artistId: body.artistId ?? null,
      createdBy: auth.userId,
    })
    await runtime.liveLab.ensureDefaultOutputs(auth.orgId, project.id)

    // Duplicate an existing set: items, scenes, clips, stems and pad map are
    // copied; audio assets are shared (same storage objects, new references).
    if (source) {
      await runtime.liveLab.updateProject(project.id, { masterTempo: source.masterTempo, timeSignature: source.timeSignature })
      const [items, scenes, clips, stems, assets] = await Promise.all([
        runtime.liveLab.listItems(source.id),
        runtime.liveLab.listScenes(source.id),
        runtime.liveLab.listClips(source.id),
        runtime.liveLab.listStems(source.id),
        runtime.liveLab.listAssets(source.id),
      ])
      const assetIdMap = new Map<string, string>()
      // Every duplicated record gets a new id, so anything that referenced the
      // originals — pads, follow actions — has to be rewritten to match. Copied
      // verbatim, a duplicated set's pads all pointed back at the source
      // project's scenes and stems and were dead on the first press.
      const sceneIdMap = new Map<string, string>()
      const clipIdMap = new Map<string, string>()
      const stemIdMap = new Map<string, string>()
      for (const asset of assets) {
        const copy = await runtime.liveLab.createAsset({
          orgId: auth.orgId,
          liveProjectId: project.id,
          kind: asset.kind,
          storageKey: asset.storageKey,
          filename: asset.filename,
          mime: asset.mime,
          bytes: asset.bytes,
          sha256: asset.sha256,
          durationMs: asset.durationMs,
          metadata: asset.metadata,
          rightsOwner: asset.rightsOwner,
          rightsConfirmed: asset.rightsConfirmed,
          rightsConfirmedBy: asset.rightsConfirmedBy,
          lineage: asset.lineage,
          createdBy: auth.userId,
        })
        assetIdMap.set(asset.id, copy.id)
      }
      for (const item of items) {
        const newItem = await runtime.liveLab.createItem({
          orgId: auth.orgId,
          liveProjectId: project.id,
          type: item.type,
          title: item.title,
          sortOrder: item.sortOrder,
          sourceReleaseId: item.sourceReleaseId,
          sourceTrackId: item.sourceTrackId,
          bpm: item.bpm,
          key: item.key,
          durationMs: item.durationMs,
          notes: item.notes,
        })
        for (const scene of scenes.filter((s) => s.liveSetItemId === item.id)) {
          const newScene = await runtime.liveLab.createScene({
            orgId: auth.orgId,
            liveProjectId: project.id,
            liveSetItemId: newItem.id,
            name: scene.name,
            sceneType: scene.sceneType,
            sortOrder: scene.sortOrder,
            color: scene.color,
            bpm: scene.bpm,
            key: scene.key,
            bars: scene.bars,
            quantization: scene.quantization,
            loopEnabled: scene.loopEnabled,
            followAction: scene.followAction,
          })
          sceneIdMap.set(scene.id, newScene.id)
          for (const clip of clips.filter((c) => c.liveSceneId === scene.id)) {
            const mappedAsset = assetIdMap.get(clip.sourceAssetId)
            if (!mappedAsset) continue
            const newClip = await runtime.liveLab.createClip({
              orgId: auth.orgId,
              liveProjectId: project.id,
              liveSceneId: newScene.id,
              name: clip.name,
              sourceAssetId: mappedAsset,
              startMs: clip.startMs,
              endMs: clip.endMs,
              loopStartMs: clip.loopStartMs,
              loopEndMs: clip.loopEndMs,
              oneShot: clip.oneShot,
              gain: clip.gain,
              pan: clip.pan,
            })
            clipIdMap.set(clip.id, newClip.id)
          }
        }
        for (const stem of stems.filter((s) => s.liveSetItemId === item.id)) {
          const mappedAsset = assetIdMap.get(stem.sourceAssetId)
          if (!mappedAsset) continue
          const newStem = await runtime.liveLab.createStem({
            orgId: auth.orgId,
            liveProjectId: project.id,
            liveSetItemId: newItem.id,
            stemType: stem.stemType,
            label: stem.label,
            sourceAssetId: mappedAsset,
            gain: stem.gain,
            pan: stem.pan,
          })
          stemIdMap.set(stem.id, newStem.id)
        }
      }

      // Follow targets are rewritten in a second pass: a scene may follow one
      // created after it, so the map is only complete once every scene exists.
      // A 'target' follow whose target did not survive falls back to 'stop' —
      // the scene ends rather than queueing a scene from the source project.
      for (const scene of scenes) {
        const copyId = sceneIdMap.get(scene.id)
        if (!copyId) continue
        const target = scene.followTargetSceneId ? sceneIdMap.get(scene.followTargetSceneId) ?? null : null
        if (scene.followAction === 'target' && !target) {
          await runtime.liveLab.updateScene(copyId, { followAction: 'stop', followTargetSceneId: null })
          continue
        }
        if (target) await runtime.liveLab.updateScene(copyId, { followTargetSceneId: target })
      }

      await runtime.liveLab.updateProject(project.id, { padMap: remapPadMap(source.padMap, { sceneIdMap, clipIdMap, stemIdMap }) })
    }

    await runtime.audit.record({
      orgId: auth.orgId,
      actor: auth.userId,
      action: 'live.project.created',
      targetType: 'live_project',
      targetId: project.id,
      data: { name: project.name },
    })
    return { project: await runtime.liveLab.getProject(project.id) }
  })

  app.get('/api/live-lab/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth, project } = await requireLiveProject(request, projectId)
    const [items, scenes, clips, stems, mappings, outputs, assets, packages, aiJobs] = await Promise.all([
      runtime.liveLab.listItems(projectId),
      runtime.liveLab.listScenes(projectId),
      runtime.liveLab.listClips(projectId),
      runtime.liveLab.listStems(projectId),
      runtime.liveLab.listMappings(projectId),
      runtime.liveLab.ensureDefaultOutputs(auth.orgId, projectId),
      runtime.liveLab.listAssets(projectId),
      runtime.liveLab.listPackages(projectId),
      runtime.liveLab.listAiJobs(projectId),
    ])
    return { project, items, scenes, clips, stems, mappings, outputs, assets, packages, aiJobs }
  })

  app.patch('/api/live-lab/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireLiveProject(request, projectId, 'live_lab.projects')
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(4000).optional(),
        status: z.enum(['active', 'archived']).optional(),
        masterTempo: z.number().min(20).max(400).optional(),
        timeSignature: z.string().regex(/^\d{1,2}\/\d{1,2}$/).optional(),
        padMap: z.array(PadAssignment).max(16).optional(),
      })
      .parse(request.body)
    return { project: await runtime.liveLab.updateProject(projectId, body) }
  })

  app.delete('/api/live-lab/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.projects')
    await runtime.liveLab.deleteProject(projectId)
    await runtime.audit.record({
      orgId: auth.orgId,
      actor: auth.userId,
      action: 'live.project.deleted',
      targetType: 'live_project',
      targetId: projectId,
      data: {},
    })
    return { ok: true }
  })

  // -------------------------------------------------------------- import ----

  /**
   * Import a Street Banker release. In this codebase a "release" is the audio
   * assets of an organization project: each imported track becomes a set item
   * with a FULL SONG scene and a stereo clip, so an existing catalog turns
   * into a playable set in one call.
   */
  app.post('/api/live-lab/projects/:projectId/import-release', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth, project } = await requireLiveProject(request, projectId, 'live_lab.projects')
    const body = z.object({ sourceProjectId: z.string(), assetIds: z.array(z.string()).optional() }).parse(request.body)

    // Source access is checked with the same project-authorization used
    // everywhere else — a release from another org cannot be imported.
    await requireProject(runtime, request, body.sourceProjectId)
    const sourceAssets = (await runtime.assets.list(body.sourceProjectId, 'audio')).filter(
      (asset) => !body.assetIds || body.assetIds.includes(asset.id),
    )
    if (sourceAssets.length === 0) {
      throw new AppError({ kind: 'validation', code: 'live.import_empty', message: 'the source release has no audio assets to import' })
    }

    const created: Array<{ itemId: string; sceneId: string; assetId: string }> = []
    for (const source of sourceAssets) {
      const liveAsset = await runtime.liveLab.createAsset({
        orgId: auth.orgId,
        liveProjectId: projectId,
        kind: 'audio',
        storageKey: source.storageKey,
        filename: source.filename,
        mime: source.mime,
        bytes: source.bytes,
        sha256: source.sha256,
        durationMs: source.durationSeconds ? Math.round(source.durationSeconds * 1000) : null,
        metadata: { importedFrom: body.sourceProjectId, sourceAssetId: source.id },
        rightsOwner: source.rights.owner,
        rightsConfirmed: source.rights.authorized,
        createdBy: auth.userId,
      })
      const item = await runtime.liveLab.createItem({
        orgId: auth.orgId,
        liveProjectId: projectId,
        type: 'song',
        title: source.filename.replace(/\.[^.]+$/, '').toUpperCase(),
        sourceReleaseId: body.sourceProjectId,
        sourceTrackId: source.id,
        durationMs: source.durationSeconds ? Math.round(source.durationSeconds * 1000) : null,
      })
      const scene = await runtime.liveLab.createScene({
        orgId: auth.orgId,
        liveProjectId: projectId,
        liveSetItemId: item.id,
        name: 'FULL SONG',
        sceneType: 'custom',
        quantization: '1bar',
      })
      await runtime.liveLab.createClip({
        orgId: auth.orgId,
        liveProjectId: projectId,
        liveSceneId: scene.id,
        name: item.title,
        sourceAssetId: liveAsset.id,
      })
      created.push({ itemId: item.id, sceneId: scene.id, assetId: liveAsset.id })
    }
    await runtime.liveLab.updateProject(projectId, {
      sourceReleaseIds: [...new Set([...project.sourceReleaseIds, body.sourceProjectId])],
    })
    return { imported: created }
  })

  /**
   * Import Remix Lab outputs: alternate versions, stems and generated sections
   * living in another Live Lab project of the same organization.
   */
  app.post('/api/live-lab/projects/:projectId/import-remix', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.remix_import')
    const body = z.object({ sourceLiveProjectId: z.string(), assetIds: z.array(z.string()).min(1) }).parse(request.body)
    const source = await runtime.liveLab.getProject(body.sourceLiveProjectId)
    assertSameOrg(source.organizationId, auth.orgId)

    const imported: string[] = []
    for (const assetId of body.assetIds) {
      const asset = await runtime.liveLab.getAsset(assetId)
      assertSameOrg(asset.organizationId, auth.orgId)
      if (asset.liveProjectId !== source.id) throw forbidden('asset does not belong to the source project')
      const copy = await runtime.liveLab.createAsset({
        orgId: auth.orgId,
        liveProjectId: projectId,
        kind: asset.kind,
        storageKey: asset.storageKey,
        filename: asset.filename,
        mime: asset.mime,
        bytes: asset.bytes,
        sha256: asset.sha256,
        durationMs: asset.durationMs,
        metadata: { ...asset.metadata, remixImportedFrom: source.id },
        rightsOwner: asset.rightsOwner,
        rightsConfirmed: asset.rightsConfirmed,
        rightsConfirmedBy: asset.rightsConfirmedBy,
        lineage: asset.lineage,
        createdBy: auth.userId,
      })
      imported.push(copy.id)
    }
    return { imported }
  })

  /** Owned-audio upload. Rights confirmation is required, not optional. */
  app.post('/api/live-lab/projects/:projectId/upload', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.projects')

    const parts = request.parts()
    let fileBuffer: Buffer | null = null
    let filename = 'upload'
    const fields: Record<string, string> = {}
    for await (const part of parts) {
      if (part.type === 'file') {
        if (fileBuffer) {
          throw new AppError({ kind: 'validation', code: 'live.too_many_files', message: 'upload one audio file per request' })
        }
        filename = sanitizeFilename(part.filename ?? 'upload')
        fileBuffer = await part.toBuffer()
      } else {
        fields[part.fieldname] = String(part.value)
      }
    }
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new AppError({ kind: 'validation', code: 'live.no_file', message: 'no file was uploaded' })
    }
    if (fields.rightsConfirmed !== 'true') {
      throw new AppError({
        kind: 'validation',
        code: 'live.rights_required',
        message: `rights confirmation is required: "${RIGHTS_STATEMENT}"`,
      })
    }
    const sniffed = sniffMime(new Uint8Array(fileBuffer))
    if (sniffed !== 'audio/wav' && sniffed !== 'audio/mpeg') {
      throw new AppError({
        kind: 'validation',
        code: 'live.unsupported_audio',
        message: `unsupported audio type${sniffed ? ` (${sniffed})` : ''} — upload WAV or MP3`,
      })
    }

    const kindField = fields.kind === 'stem' || fields.kind === 'click' ? fields.kind : 'audio'
    const digest = sha256Hex(new Uint8Array(fileBuffer))
    const key = objectKey({ projectId, kind: `live-${kindField}`, id: digest.slice(0, 12), filename })
    await runtime.storage.putBuffer(key, new Uint8Array(fileBuffer), { contentType: sniffed, sha256: digest })
    const asset = await runtime.liveLab.createAsset({
      orgId: auth.orgId,
      liveProjectId: projectId,
      kind: kindField,
      storageKey: key,
      filename,
      mime: sniffed,
      bytes: fileBuffer.length,
      sha256: digest,
      metadata: { stemType: fields.stemType ?? null },
      rightsOwner: fields.rightsOwner ?? auth.displayName,
      rightsConfirmed: true,
      rightsConfirmedBy: auth.userId,
      createdBy: auth.userId,
    })
    return { asset }
  })

  app.get('/api/live-lab/assets/:assetId/url', async (request) => {
    const { assetId } = request.params as { assetId: string }
    const auth = await requireLiveLab(request)
    const asset = await runtime.liveLab.getAsset(assetId)
    assertSameOrg(asset.organizationId, auth.orgId)
    return { url: await runtime.storage.signedUrl(asset.storageKey, 3600), asset }
  })

  // ------------------------------------------------------------- setlist ----

  app.get('/api/live-lab/projects/:projectId/set', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireLiveProject(request, projectId)
    const [items, scenes, clips, stems] = await Promise.all([
      runtime.liveLab.listItems(projectId),
      runtime.liveLab.listScenes(projectId),
      runtime.liveLab.listClips(projectId),
      runtime.liveLab.listStems(projectId),
    ])
    return { items, scenes, clips, stems }
  })

  app.patch('/api/live-lab/projects/:projectId/set', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireLiveProject(request, projectId, 'live_lab.projects')
    const body = z.object({ order: z.array(z.string()).min(1) }).parse(request.body)
    await runtime.liveLab.reorderItems(projectId, body.order)
    return { items: await runtime.liveLab.listItems(projectId) }
  })

  app.post('/api/live-lab/projects/:projectId/set-items', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.projects')
    const body = z
      .object({
        type: SetItemType,
        title: z.string().min(1).max(200),
        bpm: z.number().min(20).max(400).nullable().optional(),
        key: z.string().max(12).nullable().optional(),
        durationMs: z.number().int().min(0).nullable().optional(),
        notes: z.string().max(4000).optional(),
      })
      .parse(request.body)
    const item = await runtime.liveLab.createItem({
      orgId: auth.orgId,
      liveProjectId: projectId,
      type: body.type,
      title: body.title,
      bpm: body.bpm ?? null,
      key: body.key ?? null,
      durationMs: body.durationMs ?? null,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    })
    return { item }
  })

  app.patch('/api/live-lab/set-items/:itemId', async (request) => {
    const { itemId } = request.params as { itemId: string }
    const auth = await requireLiveLab(request, 'live_lab.projects')
    const existing = await runtime.liveLab.getItem(itemId)
    assertSameOrg(existing.organizationId, auth.orgId)
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        type: SetItemType.optional(),
        bpm: z.number().min(20).max(400).nullable().optional(),
        key: z.string().max(12).nullable().optional(),
        durationMs: z.number().int().min(0).nullable().optional(),
        notes: z.string().max(4000).optional(),
      })
      .parse(request.body)
    return { item: await runtime.liveLab.updateItem(itemId, body) }
  })

  app.delete('/api/live-lab/set-items/:itemId', async (request) => {
    const { itemId } = request.params as { itemId: string }
    const auth = await requireLiveLab(request, 'live_lab.projects')
    const existing = await runtime.liveLab.getItem(itemId)
    assertSameOrg(existing.organizationId, auth.orgId)
    await runtime.liveLab.deleteItem(itemId)
    return { ok: true }
  })

  // -------------------------------------------------------------- scenes ----

  app.post('/api/live-lab/projects/:projectId/scenes', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.projects')
    const body = z
      .object({
        liveSetItemId: z.string(),
        name: z.string().min(1).max(120),
        sceneType: SceneType.optional(),
        color: z.string().max(24).optional(),
        bars: z.number().int().min(1).max(512).nullable().optional(),
        quantization: Quantization.optional(),
        loopEnabled: z.boolean().optional(),
        followAction: z.enum(['stop', 'loop', 'next_scene', 'target']).optional(),
        followTargetSceneId: z.string().nullable().optional(),
        clipAssetId: z.string().optional(),
      })
      .parse(request.body)
    const item = await runtime.liveLab.getItem(body.liveSetItemId)
    assertSameOrg(item.organizationId, auth.orgId)
    if (item.liveProjectId !== projectId) throw forbidden('set item belongs to another project')

    const scene = await runtime.liveLab.createScene({
      orgId: auth.orgId,
      liveProjectId: projectId,
      liveSetItemId: body.liveSetItemId,
      name: body.name,
      ...(body.sceneType !== undefined ? { sceneType: body.sceneType } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      bars: body.bars ?? null,
      ...(body.quantization !== undefined ? { quantization: body.quantization } : {}),
      ...(body.loopEnabled !== undefined ? { loopEnabled: body.loopEnabled } : {}),
      ...(body.followAction !== undefined ? { followAction: body.followAction } : {}),
      followTargetSceneId: body.followTargetSceneId ?? null,
    })
    if (body.clipAssetId) {
      const asset = await runtime.liveLab.getAsset(body.clipAssetId)
      assertSameOrg(asset.organizationId, auth.orgId)
      if (asset.liveProjectId !== projectId) throw forbidden('asset belongs to another project')
      await runtime.liveLab.createClip({
        orgId: auth.orgId,
        liveProjectId: projectId,
        liveSceneId: scene.id,
        name: body.name,
        sourceAssetId: asset.id,
      })
    }
    return { scene }
  })

  app.patch('/api/live-lab/scenes/:sceneId', async (request) => {
    const { sceneId } = request.params as { sceneId: string }
    const auth = await requireLiveLab(request, 'live_lab.projects')
    const existing = await runtime.liveLab.getScene(sceneId)
    assertSameOrg(existing.organizationId, auth.orgId)
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        sceneType: SceneType.optional(),
        sortOrder: z.number().int().min(0).optional(),
        color: z.string().max(24).optional(),
        bpm: z.number().min(20).max(400).nullable().optional(),
        bars: z.number().int().min(1).max(512).nullable().optional(),
        quantization: Quantization.optional(),
        loopEnabled: z.boolean().optional(),
        followAction: z.enum(['stop', 'loop', 'next_scene', 'target']).optional(),
        followTargetSceneId: z.string().nullable().optional(),
      })
      .parse(request.body)
    return { scene: await runtime.liveLab.updateScene(sceneId, body) }
  })

  app.delete('/api/live-lab/scenes/:sceneId', async (request) => {
    const { sceneId } = request.params as { sceneId: string }
    const auth = await requireLiveLab(request, 'live_lab.projects')
    const existing = await runtime.liveLab.getScene(sceneId)
    assertSameOrg(existing.organizationId, auth.orgId)
    await runtime.liveLab.deleteScene(sceneId)
    return { ok: true }
  })

  app.post('/api/live-lab/scenes/:sceneId/clips', async (request) => {
    const { sceneId } = request.params as { sceneId: string }
    const auth = await requireLiveLab(request, 'live_lab.projects')
    const scene = await runtime.liveLab.getScene(sceneId)
    assertSameOrg(scene.organizationId, auth.orgId)
    const body = z
      .object({
        name: z.string().max(120).optional(),
        sourceAssetId: z.string(),
        startMs: z.number().min(0).optional(),
        endMs: z.number().min(0).nullable().optional(),
        loopStartMs: z.number().min(0).nullable().optional(),
        loopEndMs: z.number().min(0).nullable().optional(),
        oneShot: z.boolean().optional(),
        gain: z.number().min(0).max(2).optional(),
        pan: z.number().min(-1).max(1).optional(),
      })
      .parse(request.body)
    const asset = await runtime.liveLab.getAsset(body.sourceAssetId)
    assertSameOrg(asset.organizationId, auth.orgId)
    if (asset.liveProjectId !== scene.liveProjectId) throw forbidden('asset belongs to another project')
    const clip = await runtime.liveLab.createClip({
      orgId: auth.orgId,
      liveProjectId: scene.liveProjectId,
      liveSceneId: sceneId,
      name: body.name ?? asset.filename,
      sourceAssetId: asset.id,
      ...(body.startMs !== undefined ? { startMs: body.startMs } : {}),
      endMs: body.endMs ?? null,
      loopStartMs: body.loopStartMs ?? null,
      loopEndMs: body.loopEndMs ?? null,
      ...(body.oneShot !== undefined ? { oneShot: body.oneShot } : {}),
      ...(body.gain !== undefined ? { gain: body.gain } : {}),
      ...(body.pan !== undefined ? { pan: body.pan } : {}),
    })
    return { clip }
  })

  app.delete('/api/live-lab/clips/:clipId', async (request) => {
    const { clipId } = request.params as { clipId: string }
    const auth = await requireLiveLab(request, 'live_lab.projects')
    const row = await runtime.db.get<{ org_id: string }>('SELECT org_id FROM live_clips WHERE id = ?', [clipId])
    if (!row) throw new AppError({ kind: 'not_found', message: 'clip not found' })
    assertSameOrg(String(row.org_id), auth.orgId)
    await runtime.liveLab.deleteClip(clipId)
    return { ok: true }
  })

  // --------------------------------------------------------------- stems ----

  app.post('/api/live-lab/projects/:projectId/stems', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.stems')
    const body = z
      .object({
        liveSetItemId: z.string(),
        stemType: StemType,
        label: z.string().max(60).optional(),
        sourceAssetId: z.string(),
        gain: z.number().min(0).max(2).optional(),
        pan: z.number().min(-1).max(1).optional(),
      })
      .parse(request.body)
    const item = await runtime.liveLab.getItem(body.liveSetItemId)
    assertSameOrg(item.organizationId, auth.orgId)
    if (item.liveProjectId !== projectId) throw forbidden('set item belongs to another project')
    const asset = await runtime.liveLab.getAsset(body.sourceAssetId)
    assertSameOrg(asset.organizationId, auth.orgId)
    if (asset.liveProjectId !== projectId) throw forbidden('asset belongs to another project')
    const stem = await runtime.liveLab.createStem({
      orgId: auth.orgId,
      liveProjectId: projectId,
      liveSetItemId: body.liveSetItemId,
      stemType: body.stemType,
      ...(body.label !== undefined ? { label: body.label } : {}),
      sourceAssetId: body.sourceAssetId,
      ...(body.gain !== undefined ? { gain: body.gain } : {}),
      ...(body.pan !== undefined ? { pan: body.pan } : {}),
    })
    return { stem }
  })

  app.patch('/api/live-lab/stems/:stemId', async (request) => {
    const { stemId } = request.params as { stemId: string }
    const auth = await requireLiveLab(request, 'live_lab.stems')
    const existing = await runtime.liveLab.getStem(stemId)
    assertSameOrg(existing.organizationId, auth.orgId)
    const body = z
      .object({
        label: z.string().max(60).optional(),
        gain: z.number().min(0).max(2).optional(),
        pan: z.number().min(-1).max(1).optional(),
        muted: z.boolean().optional(),
        solo: z.boolean().optional(),
        outputId: z.string().nullable().optional(),
      })
      .parse(request.body)
    return { stem: await runtime.liveLab.updateStem(stemId, body) }
  })

  app.delete('/api/live-lab/stems/:stemId', async (request) => {
    const { stemId } = request.params as { stemId: string }
    const auth = await requireLiveLab(request, 'live_lab.stems')
    const existing = await runtime.liveLab.getStem(stemId)
    assertSameOrg(existing.organizationId, auth.orgId)
    await runtime.liveLab.deleteStem(stemId)
    return { ok: true }
  })

  // ------------------------------------------------------- MIDI mappings ----

  app.get('/api/live-lab/projects/:projectId/midi-mappings', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireLiveProject(request, projectId, 'live_lab.midi')
    return { mappings: await runtime.liveLab.listMappings(projectId) }
  })

  app.post('/api/live-lab/projects/:projectId/midi-mappings', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.midi')
    const body = z
      .object({
        deviceIdentifier: z.string().min(1).max(200),
        channel: z.number().int().min(0).max(15),
        messageType: z.enum(['note_on', 'note_off', 'cc', 'program_change', 'pitch_bend']),
        noteOrController: z.number().int().min(0).max(127),
        targetType: z.enum(['pad', 'scene', 'stem_mute', 'stem_solo', 'stem_volume', 'master_volume', 'next_song', 'prev_song', 'stop', 'click', 'cue', 'macro']),
        targetId: z.string().nullable().optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        inversion: z.boolean().optional(),
        replaceDuplicate: z.boolean().optional(),
      })
      .parse(request.body)

    const existing = await runtime.liveLab.listMappings(projectId)
    const duplicate = existing.find(
      (m) =>
        m.deviceIdentifier === body.deviceIdentifier &&
        m.channel === body.channel &&
        m.messageType === body.messageType &&
        m.noteOrController === body.noteOrController,
    )
    if (duplicate && !body.replaceDuplicate) {
      throw new AppError({
        kind: 'conflict',
        code: 'live.midi_duplicate',
        message: 'this hardware control is already mapped — pass replaceDuplicate to overwrite',
        details: { duplicateId: duplicate.id, targetType: duplicate.targetType, targetId: duplicate.targetId },
      })
    }
    if (duplicate) await runtime.liveLab.deleteMapping(duplicate.id)

    const mapping = await runtime.liveLab.createMapping({
      organizationId: auth.orgId,
      liveProjectId: projectId,
      deviceIdentifier: body.deviceIdentifier,
      channel: body.channel,
      messageType: body.messageType,
      noteOrController: body.noteOrController,
      targetType: body.targetType,
      targetId: body.targetId ?? null,
      minimum: body.minimum ?? 0,
      maximum: body.maximum ?? 127,
      inversion: body.inversion ?? false,
    })
    return { mapping, replaced: duplicate?.id ?? null }
  })

  /**
   * Maps a run of consecutive notes onto a list of targets in one call — the
   * keyboard-zone operation.
   *
   * Live Lab's keyboard zones (C2-B2 FX, C3-B3 loops, and so on) were data and
   * documentation with no way to apply them: a keyboardist had to MIDI-Learn
   * every note individually, twelve per zone. This assigns the whole run.
   * Targets are verified to belong to this project before anything is written,
   * so a partially-valid request maps nothing rather than half a keyboard.
   */
  app.post('/api/live-lab/projects/:projectId/midi-mappings/bulk', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.midi')
    const body = z
      .object({
        deviceIdentifier: z.string().min(1).max(200),
        channel: z.number().int().min(0).max(15),
        startNote: z.number().int().min(0).max(127),
        targetType: z.enum(['pad', 'scene']),
        /** Assigned to startNote, startNote + 1, … in order. */
        targetIds: z.array(z.string()).min(1).max(64),
        replaceExisting: z.boolean().optional(),
      })
      .parse(request.body)

    const lastNote = body.startNote + body.targetIds.length - 1
    if (lastNote > 127) {
      throw new AppError({
        kind: 'validation',
        code: 'live.zone_overflow',
        message: `mapping ${body.targetIds.length} targets from note ${body.startNote} runs past note 127`,
      })
    }

    // Validate every target up front. A keyboard half-mapped because the
    // eighth scene belonged to another project is worse than a refusal.
    if (body.targetType === 'scene') {
      const scenes = await runtime.liveLab.listScenes(projectId)
      const known = new Set(scenes.map((scene) => scene.id))
      const unknown = body.targetIds.filter((id) => !known.has(id))
      if (unknown.length > 0) {
        throw new AppError({
          kind: 'validation',
          code: 'live.unknown_scene',
          message: `these scenes are not in this project: ${unknown.join(', ')}`,
        })
      }
    } else {
      const bad = body.targetIds.filter((id) => !/^pad:(1[0-5]|[0-9])$/.test(id))
      if (bad.length > 0) {
        throw new AppError({
          kind: 'validation',
          code: 'live.unknown_pad',
          message: `pad targets must be pad:0 … pad:15 — got ${bad.join(', ')}`,
        })
      }
    }

    const existing = await runtime.liveLab.listMappings(projectId)
    const collisions = existing.filter(
      (m) =>
        m.deviceIdentifier === body.deviceIdentifier &&
        m.channel === body.channel &&
        m.messageType === 'note_on' &&
        m.noteOrController >= body.startNote &&
        m.noteOrController <= lastNote,
    )
    if (collisions.length > 0 && !body.replaceExisting) {
      throw new AppError({
        kind: 'conflict',
        code: 'live.midi_duplicate',
        message: `${collisions.length} note(s) in this range are already mapped — pass replaceExisting to overwrite`,
        details: { notes: collisions.map((m) => m.noteOrController) },
      })
    }
    for (const collision of collisions) await runtime.liveLab.deleteMapping(collision.id)

    const mappings = []
    for (const [index, targetId] of body.targetIds.entries()) {
      mappings.push(
        await runtime.liveLab.createMapping({
          organizationId: auth.orgId,
          liveProjectId: projectId,
          deviceIdentifier: body.deviceIdentifier,
          channel: body.channel,
          messageType: 'note_on',
          noteOrController: body.startNote + index,
          targetType: body.targetType,
          targetId,
          minimum: 0,
          maximum: 127,
          inversion: false,
        }),
      )
    }
    return { mappings, replaced: collisions.map((m) => m.id) }
  })

  app.patch('/api/live-lab/midi-mappings/:mappingId', async (request) => {
    const { mappingId } = request.params as { mappingId: string }
    const auth = await requireLiveLab(request, 'live_lab.midi')
    const existing = await runtime.liveLab.getMapping(mappingId)
    assertSameOrg(existing.organizationId, auth.orgId)
    const body = z
      .object({
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        inversion: z.boolean().optional(),
        targetType: z.enum(['pad', 'scene', 'stem_mute', 'stem_solo', 'stem_volume', 'master_volume', 'next_song', 'prev_song', 'stop', 'click', 'cue', 'macro']).optional(),
        targetId: z.string().nullable().optional(),
      })
      .parse(request.body)
    return { mapping: await runtime.liveLab.updateMapping(mappingId, body) }
  })

  app.delete('/api/live-lab/midi-mappings/:mappingId', async (request) => {
    const { mappingId } = request.params as { mappingId: string }
    const auth = await requireLiveLab(request, 'live_lab.midi')
    const existing = await runtime.liveLab.getMapping(mappingId)
    assertSameOrg(existing.organizationId, auth.orgId)
    await runtime.liveLab.deleteMapping(mappingId)
    return { ok: true }
  })

  // ------------------------------------------------------------ AI scenes ----

  app.post('/api/live-lab/projects/:projectId/ai-scenes', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.ai_scene_builder')
    const body = z
      .object({
        liveSetItemId: z.string().nullable().optional(),
        sourceAssetId: z.string().nullable().optional(),
        request: AiSceneRequest,
      })
      .parse(request.body)

    // Rights confirmation is a hard gate, and prompts imitating real people
    // are refused before a job record even exists.
    if (!body.request.rightsConfirmed) {
      throw new AppError({
        kind: 'validation',
        code: 'live.rights_required',
        message: `rights confirmation is required: "${RIGHTS_STATEMENT}"`,
      })
    }
    const verdict = checkPromptSafety(body.request.prompt)
    if (!verdict.allowed) {
      throw new AppError({ kind: 'validation', code: 'live.prompt_refused', message: `prompt refused: ${verdict.reason}` })
    }
    if (body.sourceAssetId) {
      const source = await runtime.liveLab.getAsset(body.sourceAssetId)
      assertSameOrg(source.organizationId, auth.orgId)
      if (!source.rightsConfirmed) {
        throw new AppError({ kind: 'forbidden', code: 'live.rights_unconfirmed', message: 'the selected source audio has no rights confirmation' })
      }
    }

    const monthStart = new Date(runtime.clock.now())
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const used = await runtime.liveLab.countAiJobsSince(auth.orgId, monthStart.toISOString())
    await runtime.entitlements.requireWithinLimit(auth.orgId, 'live_lab.max_ai_generations_per_month', used, 'monthly AI generation')

    const job = await runtime.liveLab.createAiJob({
      orgId: auth.orgId,
      liveProjectId: projectId,
      liveSetItemId: body.liveSetItemId ?? null,
      sourceAssetId: body.sourceAssetId ?? null,
      provider: runtime.liveLabService.aiProviderId,
      operation: 'scene.generate',
      configuration: body.request,
      createdBy: auth.userId,
    })
    // Asynchronous by construction: the show stays usable while this renders.
    await runtime.queue.enqueue({
      queue: QUEUES.live,
      type: JOB_TYPES.liveAiGenerate,
      payload: { jobId: job.id },
      dedupeKey: `live-ai-${job.id}`,
    })
    // Usage tracking through the same ledger the rest of the platform uses.
    await runtime.ledger.append({
      orgId: auth.orgId,
      providerId: job.provider,
      modelId: 'live-scene',
      entryType: 'estimate',
      micros: job.estimatedCostMicros,
      sandbox: runtime.config.isSandbox,
      note: `live.ai job ${job.id}`,
      createdBy: auth.userId,
    })
    return { job }
  })

  app.get('/api/live-lab/ai-jobs/:jobId', async (request) => {
    const { jobId } = request.params as { jobId: string }
    const auth = await requireLiveLab(request, 'live_lab.ai_scene_builder')
    const job = await runtime.liveLab.getAiJob(jobId)
    assertSameOrg(job.organizationId, auth.orgId)
    const options = await Promise.all(
      job.outputAssetIds.map(async (assetId) => {
        const asset = await runtime.liveLab.getAsset(assetId)
        return { asset, url: await runtime.storage.signedUrl(asset.storageKey, 3600) }
      }),
    )
    return { job, options }
  })

  /**
   * Accepting a generated option is the only path that puts AI output into the
   * set — and even "replace" swaps a scene's clip reference, never the bytes
   * of anything currently playing.
   */
  app.post('/api/live-lab/ai-jobs/:jobId/accept', async (request) => {
    const { jobId } = request.params as { jobId: string }
    const auth = await requireLiveLab(request, 'live_lab.ai_scene_builder')
    const job = await runtime.liveLab.getAiJob(jobId)
    assertSameOrg(job.organizationId, auth.orgId)
    if (job.status !== 'ready' && job.status !== 'accepted') {
      throw new AppError({ kind: 'conflict', code: 'live.job_not_ready', message: `job is ${job.status}` })
    }
    const body = z
      .object({
        assetId: z.string(),
        mode: z.enum(['add_scene', 'replace_scene', 'assign_pad']),
        liveSetItemId: z.string().optional(),
        sceneId: z.string().optional(),
        padIndex: z.number().int().min(0).max(15).optional(),
        sceneName: z.string().max(120).optional(),
        sceneType: SceneType.optional(),
      })
      .parse(request.body)
    if (!job.outputAssetIds.includes(body.assetId)) {
      throw new AppError({ kind: 'validation', code: 'live.not_an_option', message: 'assetId is not an output of this job' })
    }
    // Validated before anything is created: a rejected request used to leave
    // behind the scene and clip it had already made.
    if ((body.mode === 'assign_pad' || body.padIndex !== undefined) && body.padIndex === undefined) {
      throw new AppError({ kind: 'validation', code: 'live.pad_required', message: 'padIndex is required to assign a pad' })
    }
    const asset = await runtime.liveLab.getAsset(body.assetId)

    let sceneId: string
    if (body.mode === 'replace_scene') {
      if (!body.sceneId) throw new AppError({ kind: 'validation', code: 'live.scene_required', message: 'sceneId is required to replace a scene' })
      const scene = await runtime.liveLab.getScene(body.sceneId)
      assertSameOrg(scene.organizationId, auth.orgId)
      // Same org is not enough, exactly as for the add path below: replacing a
      // scene in another project would delete that project's clips and, with a
      // padIndex, write a foreign scene id into this project's pad map.
      if (scene.liveProjectId !== job.liveProjectId) throw forbidden('scene belongs to another project')
      // Approval is recorded only once the request is known to be actionable;
      // stamping it before validation left rejected requests marked approved.
      await runtime.liveLab.approveAssetLineage(asset.id, auth.userId)
      const clips = (await runtime.liveLab.listClips(scene.liveProjectId)).filter((c) => c.liveSceneId === scene.id)
      for (const clip of clips) await runtime.liveLab.deleteClip(clip.id)
      await runtime.liveLab.createClip({
        orgId: auth.orgId,
        liveProjectId: scene.liveProjectId,
        liveSceneId: scene.id,
        name: `${scene.name} (generated)`,
        sourceAssetId: asset.id,
      })
      sceneId = scene.id
    } else {
      const itemId = body.liveSetItemId ?? job.liveSetItemId
      if (!itemId) throw new AppError({ kind: 'validation', code: 'live.item_required', message: 'liveSetItemId is required' })
      const item = await runtime.liveLab.getItem(itemId)
      assertSameOrg(item.organizationId, auth.orgId)
      // Same org is not enough: a set item from a *different* project would
      // produce scenes the manifest cannot resolve to a setlist entry.
      if (item.liveProjectId !== job.liveProjectId) throw forbidden('set item belongs to another project')
      await runtime.liveLab.approveAssetLineage(asset.id, auth.userId)
      const scene = await runtime.liveLab.createScene({
        orgId: auth.orgId,
        liveProjectId: job.liveProjectId,
        liveSetItemId: itemId,
        name: body.sceneName ?? `GENERATED ${String(asset.metadata.label ?? '')}`.trim(),
        sceneType: body.sceneType ?? 'custom',
        bars: job.configuration.bars ?? null,
      })
      await runtime.liveLab.createClip({
        orgId: auth.orgId,
        liveProjectId: job.liveProjectId,
        liveSceneId: scene.id,
        name: scene.name,
        sourceAssetId: asset.id,
      })
      sceneId = scene.id
    }

    if (body.padIndex !== undefined) {
      const project = await runtime.liveLab.getProject(job.liveProjectId)
      const padMap = [...project.padMap]
      padMap[body.padIndex] = {
        index: body.padIndex,
        mode: 'scene',
        label: (await runtime.liveLab.getScene(sceneId)).name.slice(0, 12),
        targetId: sceneId,
        color: '',
      }
      await runtime.liveLab.updateProject(job.liveProjectId, { padMap })
    }

    await runtime.liveLab.updateAiJob(jobId, { status: 'accepted' })
    return { sceneId, job: await runtime.liveLab.getAiJob(jobId) }
  })

  app.post('/api/live-lab/ai-jobs/:jobId/reject', async (request) => {
    const { jobId } = request.params as { jobId: string }
    const auth = await requireLiveLab(request, 'live_lab.ai_scene_builder')
    const job = await runtime.liveLab.getAiJob(jobId)
    assertSameOrg(job.organizationId, auth.orgId)
    await runtime.liveLab.updateAiJob(jobId, { status: 'rejected' })
    return { ok: true }
  })

  // ----------------------------------------------------------- set builder ----

  /**
   * BUILD MY LIVE SET. GET-like POST without `apply` returns suggestions only;
   * `apply` executes exactly the ids the artist approved. Everything is
   * additive placeholder material — original masters are never modified.
   */
  app.post('/api/live-lab/projects/:projectId/build-set', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.projects')
    const body = z
      .object({ apply: z.boolean().optional(), suggestionIds: z.array(z.string()).max(64).optional() })
      .parse(request.body ?? {})

    if (!body.apply) {
      return runtime.liveLabService.buildSetPlan(projectId)
    }
    if (!body.suggestionIds || body.suggestionIds.length === 0) {
      throw new AppError({ kind: 'validation', code: 'live.no_suggestions', message: 'apply requires the approved suggestionIds' })
    }
    const result = await runtime.liveLabService.applySetPlan(auth.orgId, projectId, auth.userId, body.suggestionIds)
    await runtime.audit.record({
      orgId: auth.orgId,
      actor: auth.userId,
      action: 'live.set_builder.applied',
      targetType: 'live_project',
      targetId: projectId,
      data: { applied: result.applied },
    })
    return result
  })

  // -------------------------------------------------- performance package ----

  app.post('/api/live-lab/projects/:projectId/performance-package', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.offline_cache')
    const { manifest, report, storageSize } = await runtime.liveLabService.buildPackage(auth.orgId, projectId)

    const maxBytes = await runtime.entitlements.limit(auth.orgId, 'live_lab.max_package_bytes')
    if (maxBytes !== null && storageSize > maxBytes) {
      throw new AppError({
        kind: 'forbidden',
        code: 'entitlement.limit',
        message: `performance package (${storageSize} bytes) exceeds the plan limit (${maxBytes})`,
      })
    }
    const versions = await runtime.liveLab.listPackages(projectId)
    const maxVersions = await runtime.entitlements.limit(auth.orgId, 'live_lab.max_package_versions')
    if (maxVersions !== null && versions.length >= maxVersions) {
      throw new AppError({ kind: 'forbidden', code: 'entitlement.limit', message: `performance package version limit reached (${maxVersions})` })
    }

    const record = await runtime.liveLab.createPackage({ orgId: auth.orgId, liveProjectId: projectId, manifest, storageSize })
    // Server-side verification runs immediately; the client re-verifies its
    // local cache and reports back before the package may claim READY.
    const status = report.status === 'ready' ? 'verifying' : 'error'
    const updated = await runtime.liveLab.updatePackage(record.id, { status })
    return { package: updated, report }
  })

  app.get('/api/live-lab/performance-packages/:packageId', async (request) => {
    const { packageId } = request.params as { packageId: string }
    const auth = await requireLiveLab(request, 'live_lab.offline_cache')
    const record = await runtime.liveLab.getPackage(packageId)
    assertSameOrg(record.organizationId, auth.orgId)
    const assets = record.manifest ? await runtime.liveLab.listAssets(record.liveProjectId) : []
    const assetById = new Map(assets.map((a) => [a.id, a]))
    const files = await Promise.all(
      (record.manifest?.requiredFiles ?? []).map(async (file) => {
        const asset = assetById.get(file.assetId)
        return { ...file, url: asset ? await runtime.storage.signedUrl(asset.storageKey, 3600) : null }
      }),
    )
    return { package: record, files }
  })

  /**
   * The client reports its on-device verification: every manifest file's local
   * checksum. SHOW READY is granted only when the device's cache matches the
   * manifest exactly — the server's own copy being fine is not enough.
   */
  app.post('/api/live-lab/performance-packages/:packageId/verify', async (request) => {
    const { packageId } = request.params as { packageId: string }
    const auth = await requireLiveLab(request, 'live_lab.offline_cache')
    const record = await runtime.liveLab.getPackage(packageId)
    assertSameOrg(record.organizationId, auth.orgId)
    if (!record.manifest) {
      throw new AppError({ kind: 'conflict', code: 'live.no_manifest', message: 'package has no manifest' })
    }
    const body = z
      .object({
        files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number().int().min(0), decodable: z.boolean() })),
      })
      .parse(request.body)

    const reported = new Map(body.files.map((f) => [f.path, f]))
    const issues: Array<{ path: string; code: string; message: string }> = []
    for (const file of record.manifest.requiredFiles) {
      const local = reported.get(file.path)
      if (!local) {
        issues.push({ path: file.path, code: 'missing_file', message: `${file.path} is not cached on the performance device` })
        continue
      }
      if (local.bytes !== file.bytes) issues.push({ path: file.path, code: 'size_mismatch', message: `${file.path} size mismatch` })
      else if (local.sha256 !== file.sha256) issues.push({ path: file.path, code: 'checksum_mismatch', message: `${file.path} checksum mismatch` })
      else if (!local.decodable) issues.push({ path: file.path, code: 'undecodable', message: `${file.path} does not decode` })
    }
    const status = issues.length === 0 ? 'ready' : 'error'
    const updated = await runtime.liveLab.updatePackage(packageId, {
      status,
      verifiedAt: issues.length === 0 ? runtime.clock.isoNow() : null,
    })
    return { package: updated, status, issues }
  })

  // --------------------------------------------------------- stage control ----

  app.get('/api/live-lab/projects/:projectId/stage-control', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth, project } = await requireLiveProject(request, projectId, 'live_lab.stage_control')
    const [items, scenes, stems, outputs] = await Promise.all([
      runtime.liveLab.listItems(projectId),
      runtime.liveLab.listScenes(projectId),
      runtime.liveLab.listStems(projectId),
      runtime.liveLab.ensureDefaultOutputs(auth.orgId, projectId),
    ])
    return {
      handoff: buildStageControlHandoff({
        project,
        artistName: project.artistId ?? auth.displayName,
        items,
        scenes,
        stems,
        outputs,
        generatedAt: runtime.clock.isoNow(),
      }),
    }
  })

  app.post('/api/live-lab/projects/:projectId/stage-control', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.stage_control')
    const session = StageControlSession.parse(request.body)
    // Stored as an audit record: Live Lab reads show/venue context from Stage
    // Control but never controls monitor or IEM levels — that stays over there.
    await runtime.audit.record({
      orgId: auth.orgId,
      actor: auth.userId,
      action: 'live.stage_control.session',
      targetType: 'live_project',
      targetId: projectId,
      data: session,
    })
    return { ok: true, session }
  })

  // ------------------------------------------------- performance analytics ----

  app.post('/api/live-lab/projects/:projectId/events', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireLiveProject(request, projectId, 'live_lab.performance_mode')
    const body = z
      .object({
        events: z
          .array(
            z.object({
              eventType: z.enum([
                'set_started',
                'set_ended',
                'song_started',
                'scene_launched',
                'pad_triggered',
                'ai_scene_used',
                'midi_connected',
                'midi_disconnected',
                'audio_device_changed',
                'error',
                'crash_recovered',
              ]),
              payload: z.record(z.string(), z.unknown()).default({}),
              localTimestamp: z.string(),
              performancePackageId: z.string().nullable().optional(),
            }),
          )
          .max(500),
      })
      .parse(request.body)
    const recorded = await runtime.liveLab.recordEvents(auth.orgId, projectId, body.events)
    return { recorded }
  })
}
