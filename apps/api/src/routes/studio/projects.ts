import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'
import { AUDIO_CAPABILITY_LABELS, AUDIO_PROCESSING_CAPABILITIES } from '@masterclip/mix-analysis'
import {
  COLLABORATOR_PERMISSIONS,
  COLLABORATOR_ROLES,
  DELIVERABLE_KIND_LABELS,
  STUDIO_CAPABILITY_INFO,
  STUDIO_RIGHTS_STATEMENT,
  STUDIO_STAGES,
  STUDIO_VERSION_TYPES,
  type StudioVersionType,
} from '@masterclip/studio-domain'
import { readUpload, parseBool } from '../audio/helpers.js'
import { requireStudio, signedUrlFor } from './helpers.js'

/** Studio home, the canonical project record, versions and the session. */
export async function registerStudioProjectRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const studio = runtime.studio

  // ----- capabilities -------------------------------------------------------

  app.get('/api/studio/capabilities', async (request) => {
    const actor = await requireStudio(runtime, request, 'studio.access')
    return {
      capabilities: await studio.access.capabilitiesFor(actor.orgId),
      catalogue: STUDIO_CAPABILITY_INFO,
      flagship: await studio.access.isFlagship(actor.orgId),
      rightsStatement: STUDIO_RIGHTS_STATEMENT,
      stages: STUDIO_STAGES,
      versionTypes: STUDIO_VERSION_TYPES,
      deliverableKinds: DELIVERABLE_KIND_LABELS,
      collaboratorRoles: COLLABORATOR_ROLES,
      collaboratorPermissions: COLLABORATOR_PERMISSIONS,
    }
  })

  /**
   * Who performs the audio work in this deployment, and whether they can.
   *
   * Read by the Master Station so a user is told, before they render, that
   * nothing here can process audio — rather than being handed a placeholder and
   * left to work out why it sounds identical.
   */
  app.get('/api/studio/processing-providers', async (request) => {
    await requireStudio(runtime, request, 'studio.access')
    return {
      capabilities: AUDIO_PROCESSING_CAPABILITIES.map((capability) => ({ key: capability, label: AUDIO_CAPABILITY_LABELS[capability] })),
      providers: await studio.providers.processing.report(),
    }
  })

  // ----- the project browser ------------------------------------------------

  /**
   * Studio home.
   *
   * Every row carries what the browser shows — stage, last version,
   * collaborators, readiness, pending actions — assembled server-side so the
   * list cannot drift from the detail views by computing the same thing twice.
   */
  app.get('/api/studio/projects', async (request) => {
    const actor = await requireStudio(runtime, request, 'studio.access')
    const query = z.object({ includeArchived: z.string().optional() }).parse(request.query ?? {})
    const projects = await studio.repos.projects.list(actor.orgId, { includeArchived: query.includeArchived === 'true' })

    const rows = []
    for (const project of projects) {
      const versions = await studio.repos.versions.list(actor.orgId, project.id)
      const current = versions.find((version) => version.id === project.currentVersionId) ?? versions.at(-1) ?? null
      const analysis = current ? await studio.repos.analyses.latestForVersion(actor.orgId, current.id) : null
      const readiness = analysis ? await readinessFor(runtime, actor.orgId, analysis.id) : null
      const collaborators = await studio.repos.collaborators.list(actor.orgId, project.id)
      const openNotes = await studio.repos.notes.countOpen(actor.orgId, project.id)
      const openIssues = analysis ? await studio.repos.issues.countOpen(actor.orgId, analysis.id) : 0
      const approvals = await studio.repos.approvals.list(actor.orgId, project.id)

      rows.push({
        project,
        artworkUrl: await signedUrlFor(runtime, actor.orgId, project.artworkAssetId),
        currentVersion: current,
        versionCount: versions.length,
        readiness,
        collaborators: collaborators.map((collaborator) => ({ id: collaborator.id, displayName: collaborator.displayName, role: collaborator.collaboratorRole })),
        approvals: approvals.filter((approval) => !approval.revokedAt).map((approval) => approval.approvalType),
        // What a person would actually do next on this record.
        pendingActions: [
          ...(versions.length === 0 ? ['Upload a mix'] : []),
          ...(current && !analysis ? ['Analysis pending'] : []),
          ...(openIssues > 0 ? [`${openIssues} open Mix Doctor finding${openIssues === 1 ? '' : 's'}`] : []),
          ...(openNotes > 0 ? [`${openNotes} open note${openNotes === 1 ? '' : 's'}`] : []),
          ...(project.approvedMixVersionId && !project.approvedMasterVersionId ? ['Master the approved mix'] : []),
        ],
      })
    }
    return { projects: rows }
  })

  app.post('/api/studio/projects', async (request) => {
    const pre = await requireStudio(runtime, request, 'studio.access')
    const current = await studio.repos.projects.countForOrg(pre.orgId)
    const actor = await requireStudio(runtime, request, 'studio.access', {
      usage: { limit: 'studio.max_projects', current, what: 'Studio project' },
    })
    const body = z
      .object({
        title: z.string().min(1).max(200),
        artistName: z.string().min(1).max(200),
        artistId: z.string().max(64).optional(),
        genre: z.string().min(1).max(64),
        notes: z.string().max(4000).optional(),
        releaseDate: z.string().max(32).optional(),
        songLabProjectId: z.string().max(64).optional(),
        rightsConfirmed: z.boolean(),
      })
      .parse(request.body)

    const project = await studio.projects.create({
      actor,
      title: body.title,
      artistName: body.artistName,
      artistId: body.artistId ?? null,
      genre: body.genre,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      releaseDate: body.releaseDate ?? null,
      songLabProjectId: body.songLabProjectId ?? null,
      rightsConfirmed: body.rightsConfirmed,
    })
    return { project }
  })

  /**
   * The Session payload: everything the control room renders in one request.
   */
  app.get('/api/studio/projects/:id', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.access', { project: { id, permission: 'view' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    const versions = await studio.repos.versions.list(actor.orgId, id)
    const query = z.object({ versionId: z.string().optional() }).parse(request.query ?? {})
    const versionId = query.versionId ?? project.currentVersionId ?? versions.at(-1)?.id ?? null
    const version = versions.find((candidate) => candidate.id === versionId) ?? null

    const report = versionId ? await studio.mix.report(actor, id, versionId) : null

    return {
      project,
      versions: await Promise.all(versions.map(async (candidate) => ({ ...candidate, url: await signedUrlFor(runtime, actor.orgId, candidate.assetId) }))),
      version,
      audioUrl: await signedUrlFor(runtime, actor.orgId, version?.assetId ?? null),
      analysis: report?.analysis ?? null,
      metrics: report?.metrics ?? [],
      curves: report?.curves ?? [],
      issues: report?.issues ?? [],
      readiness: report?.readiness ?? null,
      notes: await studio.repos.notes.list(actor.orgId, id, ...(versionId ? [{ versionId }] : [])),
      collaborators: await studio.repos.collaborators.list(actor.orgId, id),
      permissions: await studio.access.projectPermissionsFor(actor, id),
      approvals: await studio.collaboration.approvalState(actor, id),
      activity: await studio.repos.activity.list(actor.orgId, id, 50),
      // What is queued or running right now, so a screen with no numbers on it
      // can say "still measuring" rather than looking broken.
      processing: await studio.processing.active(actor, id),
    }
  })

  /**
   * The processing ledger for a project.
   *
   * Every unit of asynchronous work with the provider that performed it, what
   * it cost, how many attempts it took and how it ended. This is the screen a
   * support question is answered from.
   */
  app.get('/api/studio/projects/:id/jobs', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.access', { project: { id, permission: 'view' } })
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query ?? {})
    return { jobs: await studio.processing.list(actor, id, query.limit ?? 50) }
  })

  app.patch('/api/studio/projects/:id', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.access', { project: { id, permission: 'admin' } })
    const body = z
      .object({
        title: z.string().min(1).max(200).optional(),
        artistName: z.string().min(1).max(200).optional(),
        artistId: z.string().max(64).optional(),
        genre: z.string().min(1).max(64).optional(),
        notes: z.string().max(4000).optional(),
        releaseDate: z.string().max(32).optional(),
        songLabProjectId: z.string().max(64).optional(),
      })
      .parse(request.body ?? {})
    return { project: await studio.repos.projects.update(actor.orgId, id, body) }
  })

  app.post('/api/studio/projects/:id/stage', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.access', { project: { id, permission: 'admin' } })
    const body = z.object({ stage: z.enum(STUDIO_STAGES) }).parse(request.body)
    return { project: await studio.projects.setStage(actor, id, body.stage) }
  })

  /** Archives rather than deletes: approvals and provenance outlive the project. */
  app.post('/api/studio/projects/:id/archive', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.access', { minimumRole: 'admin', project: { id, permission: 'admin' } })
    await studio.repos.projects.archive(actor.orgId, id)
    return { project: await studio.repos.projects.get(actor.orgId, id) }
  })

  // ----- audio intake -------------------------------------------------------

  app.post('/api/studio/projects/:id/upload', async (request) => {
    const { id } = request.params as { id: string }
    const pre = await requireStudio(runtime, request, 'studio.access', { project: { id, permission: 'upload' } })
    const current = await studio.repos.versions.countForProject(pre.orgId, id)
    const actor = await requireStudio(runtime, request, 'studio.access', {
      project: { id, permission: 'upload' },
      usage: { limit: 'studio.max_versions_per_project', current, what: 'version' },
    })
    const { bytes, filename, fields } = await readUpload(request)
    return studio.projects.attachUpload({
      actor,
      projectId: id,
      bytes,
      filename,
      versionType: (fields.versionType as StudioVersionType) ?? 'mix',
      ...(fields.label ? { label: fields.label } : {}),
      ...(fields.notes ? { notes: fields.notes } : {}),
      rightsConfirmed: parseBool(fields.rightsConfirmed),
    })
  })

  /** Import an existing Street Banker release or any authorized asset in the org. */
  app.post('/api/studio/projects/:id/import', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.access', { project: { id, permission: 'upload' } })
    const body = z
      .object({ assetId: z.string().min(1), versionType: z.enum(STUDIO_VERSION_TYPES).default('mix'), label: z.string().max(200).optional() })
      .parse(request.body)
    return studio.projects.importAsset({
      actor,
      projectId: id,
      assetId: body.assetId,
      versionType: body.versionType,
      ...(body.label ? { label: body.label } : {}),
    })
  })

  /** Audio the caller could import — their organization's, and only theirs. */
  app.get('/api/studio/importable', async (request) => {
    const actor = await requireStudio(runtime, request, 'studio.access')
    const assets = await runtime.audio.repos.assets.list(actor.orgId, {}, 200)
    return {
      assets: assets
        .filter((asset) => IMPORTABLE_PROJECT_TYPES.has(asset.projectType))
        .map((asset) => ({ id: asset.id, fileName: asset.fileName, projectType: asset.projectType, durationMs: asset.durationMs, createdAt: asset.createdAt })),
    }
  })

  app.post('/api/studio/projects/:id/analyze', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.mix', { project: { id, permission: 'upload' } })
    const body = z.object({ versionId: z.string().optional() }).parse(request.body ?? {})
    return { analysisId: await studio.projects.reanalyze(actor, id, body.versionId) }
  })

  app.post('/api/studio/projects/:id/current-version', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.access', { project: { id, permission: 'view' } })
    const body = z.object({ versionId: z.string().min(1) }).parse(request.body)
    return { project: await studio.projects.setCurrentVersion(actor, id, body.versionId) }
  })

  // ----- session notes and markers -----------------------------------------

  app.get('/api/studio/projects/:id/notes', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.session', { project: { id, permission: 'view' } })
    return { notes: await studio.repos.notes.list(actor.orgId, id) }
  })

  app.post('/api/studio/projects/:id/notes', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.session', { project: { id, permission: 'comment' } })
    const body = z
      .object({
        kind: z.enum(['note', 'marker']).default('note'),
        timestampMs: z.number().int().min(0).nullable().optional(),
        endMs: z.number().int().min(0).nullable().optional(),
        category: z.enum(['mix', 'master', 'arrangement', 'vocal', 'production', 'technical', 'other']),
        body: z.string().min(1).max(4000),
        studioVersionId: z.string().optional(),
        assignedTo: z.string().max(64).optional(),
      })
      .parse(request.body)

    const note = await studio.repos.notes.create({
      orgId: actor.orgId,
      studioProjectId: id,
      studioVersionId: body.studioVersionId ?? null,
      kind: body.kind,
      timestampMs: body.timestampMs ?? null,
      endMs: body.endMs ?? null,
      category: body.category,
      body: body.body,
      assignedTo: body.assignedTo ?? null,
      origin: 'human',
      authorUserId: actor.userId,
      authorLabel: actor.displayName ?? actor.email ?? actor.userId,
    })
    return { note }
  })

  app.patch('/api/studio/projects/:id/notes/:noteId', async (request) => {
    const { id, noteId } = request.params as { id: string; noteId: string }
    const actor = await requireStudio(runtime, request, 'studio.session', { project: { id, permission: 'comment' } })
    const body = z
      .object({
        body: z.string().min(1).max(4000).optional(),
        category: z.enum(['mix', 'master', 'arrangement', 'vocal', 'production', 'technical', 'other']).optional(),
        status: z.enum(['open', 'in_progress', 'resolved', 'wont_fix']).optional(),
        assignedTo: z.string().max(64).nullable().optional(),
        timestampMs: z.number().int().min(0).nullable().optional(),
      })
      .parse(request.body ?? {})
    return { note: await studio.repos.notes.update(actor.orgId, noteId, body, actor.userId) }
  })

  app.delete('/api/studio/projects/:id/notes/:noteId', async (request) => {
    const { id, noteId } = request.params as { id: string; noteId: string }
    const actor = await requireStudio(runtime, request, 'studio.session', { project: { id, permission: 'comment' } })
    const note = await studio.repos.notes.get(actor.orgId, noteId)
    // Anyone can resolve a note; only its author or a project admin removes one.
    const permissions = await studio.access.projectPermissionsFor(actor, id)
    if (note.authorUserId !== actor.userId && !permissions.includes('admin')) {
      throw new AppError({ kind: 'forbidden', code: 'studio.note_not_yours', message: 'only the author or a project admin can delete a note' })
    }
    await studio.repos.notes.delete(actor.orgId, noteId)
    return { ok: true }
  })
}

/**
 * Which of an organization's audio Studio will offer for import.
 *
 * Songs, not everything the tenant owns. A meeting recording or a voice sample
 * is not a record to master, and listing it here would hand a Studio user a
 * route to signed URLs for audio belonging to modules they may not hold.
 */
const IMPORTABLE_PROJECT_TYPES = new Set(['song_lab', 'remix', 'library'])

/** The readiness figure for the project browser, without re-running analysis. */
async function readinessFor(runtime: Runtime, orgId: string, analysisId: string) {
  const { computeReleaseReadiness } = await import('@masterclip/mix-analysis')
  const { toMixMetrics } = await import('@masterclip/studio-engine')
  const metrics = toMixMetrics(await runtime.studio.repos.analyses.metrics(orgId, analysisId))
  const readiness = computeReleaseReadiness(metrics)
  return { score: readiness.score, bandsScored: readiness.bandsScored }
}
