import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import {
  AI_PERMISSIONS,
  COLLABORATOR_PERMISSIONS,
  COLLABORATOR_ROLES,
  CONTRIBUTION_TYPES,
  DELIVERABLE_KINDS,
  IDENTITY_SUBJECTS,
  RACK_STAGE_DESCRIPTIONS,
  RACK_STAGE_LABELS,
  RACK_STAGES,
  RACK_TYPES,
  SONIC_DNA_ATTRIBUTES,
  STUDIO_SERVICES,
} from '@masterclip/studio-domain'
import { RACK_MODULES, artistKeyOf } from '@masterclip/studio-engine'
import { requireStudio, signedUrlFor } from './helpers.js'

/** Rack, versions, collaboration, delivery, memory, passport, rights, market. */
export async function registerStudioWorkflowRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const studio = runtime.studio

  // ----- rack ---------------------------------------------------------------

  /** The module catalogue. Street Banker's own vocabulary, not anybody's plug-ins. */
  app.get('/api/studio/rack-modules', async (request) => {
    await requireStudio(runtime, request, 'studio.rack')
    return {
      stages: RACK_STAGES.map((stage) => ({ key: stage, label: RACK_STAGE_LABELS[stage], description: RACK_STAGE_DESCRIPTIONS[stage] })),
      modules: RACK_MODULES,
      rackTypes: RACK_TYPES,
    }
  })

  app.get('/api/studio/projects/:id/racks', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.rack', { project: { id, permission: 'view' } })
    return { racks: await studio.racks.list(actor, id), presets: await studio.racks.presets(actor, id) }
  })

  app.post('/api/studio/projects/:id/racks', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.rack', { project: { id, permission: 'upload' } })
    const body = z
      .object({ rackType: z.enum(RACK_TYPES), name: z.string().max(120).optional(), versionId: z.string().optional(), fromPresetId: z.string().optional() })
      .parse(request.body)
    return studio.racks.create({
      actor,
      projectId: id,
      rackType: body.rackType,
      ...(body.name ? { name: body.name } : {}),
      versionId: body.versionId ?? null,
      ...(body.fromPresetId ? { fromPresetId: body.fromPresetId } : {}),
    })
  })

  app.get('/api/studio/projects/:id/racks/:rackId', async (request) => {
    const { id, rackId } = request.params as { id: string; rackId: string }
    const actor = await requireStudio(runtime, request, 'studio.rack', { project: { id, permission: 'view' } })
    return studio.racks.get(actor, rackId)
  })

  app.put('/api/studio/projects/:id/racks/:rackId/modules', async (request) => {
    const { id, rackId } = request.params as { id: string; rackId: string }
    const actor = await requireStudio(runtime, request, 'studio.rack', { project: { id, permission: 'upload' } })
    const body = z
      .object({
        action: z.string().max(80).optional(),
        modules: z.array(
          z.object({
            stage: z.enum(RACK_STAGES),
            moduleType: z.string().min(1).max(64),
            orderIndex: z.number().int().min(0),
            bypassed: z.boolean(),
            params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
          }),
        ),
      })
      .parse(request.body)
    return { modules: await studio.racks.setModules({ actor, chainId: rackId, modules: body.modules, ...(body.action ? { action: body.action } : {}) }) }
  })

  for (const direction of ['undo', 'redo'] as const) {
    app.post(`/api/studio/projects/:id/racks/:rackId/${direction}`, async (request) => {
      const { id, rackId } = request.params as { id: string; rackId: string }
      const actor = await requireStudio(runtime, request, 'studio.rack', { project: { id, permission: 'upload' } })
      return studio.racks.step(actor, rackId, direction)
    })
  }

  app.post('/api/studio/projects/:id/racks/:rackId/alternative', async (request) => {
    const { id, rackId } = request.params as { id: string; rackId: string }
    const actor = await requireStudio(runtime, request, 'studio.rack', { project: { id, permission: 'upload' } })
    return studio.racks.createAlternative(actor, rackId)
  })

  app.post('/api/studio/projects/:id/racks/:rackId/preset', async (request) => {
    const { id, rackId } = request.params as { id: string; rackId: string }
    const actor = await requireStudio(runtime, request, 'studio.rack', { project: { id, permission: 'upload' } })
    const body = z.object({ name: z.string().min(1).max(120), scope: z.enum(['project', 'artist', 'org']).default('project') }).parse(request.body)
    return { preset: await studio.racks.savePreset({ actor, chainId: rackId, name: body.name, scope: body.scope }) }
  })

  app.delete('/api/studio/projects/:id/racks/:rackId', async (request) => {
    const { id, rackId } = request.params as { id: string; rackId: string }
    const actor = await requireStudio(runtime, request, 'studio.rack', { project: { id, permission: 'upload' } })
    await studio.racks.delete(actor, rackId)
    return { ok: true }
  })

  // ----- versions -----------------------------------------------------------

  app.get('/api/studio/projects/:id/versions', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.versions', { project: { id, permission: 'view' } })
    const versions = await studio.versions.list(actor, id)
    return {
      versions: await Promise.all(versions.map(async (version) => ({ ...version, url: await signedUrlFor(runtime, actor.orgId, version.assetId) }))),
    }
  })

  /** The difference engine. */
  app.get('/api/studio/projects/:id/versions/compare', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.versions', { project: { id, permission: 'view' } })
    const query = z.object({ a: z.string().min(1), b: z.string().min(1) }).parse(request.query)
    const comparison = await studio.versions.compare(actor, id, query.a, query.b)
    return {
      ...comparison,
      a: { ...comparison.a, url: await signedUrlFor(runtime, actor.orgId, comparison.a.version.assetId) },
      b: { ...comparison.b, url: await signedUrlFor(runtime, actor.orgId, comparison.b.version.assetId) },
    }
  })

  // ----- collaborate --------------------------------------------------------

  app.get('/api/studio/projects/:id/collaborate', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.collaborate', { project: { id, permission: 'view' } })
    return {
      collaborators: await studio.repos.collaborators.list(actor.orgId, id, { includeRevoked: true }),
      threads: await studio.collaboration.threads(actor, id),
      approvals: await studio.collaboration.approvalState(actor, id),
      activity: await studio.repos.activity.list(actor.orgId, id),
      roles: COLLABORATOR_ROLES,
      permissions: COLLABORATOR_PERMISSIONS,
    }
  })

  app.post('/api/studio/projects/:id/collaborators', async (request) => {
    const { id } = request.params as { id: string }
    const pre = await requireStudio(runtime, request, 'studio.collaborate', { project: { id, permission: 'admin' } })
    const current = await studio.repos.collaborators.countActive(pre.orgId, id)
    const actor = await requireStudio(runtime, request, 'studio.collaborate', {
      project: { id, permission: 'admin' },
      usage: { limit: 'studio.max_collaborators_per_project', current, what: 'collaborator' },
    })
    const body = z
      .object({
        email: z.string().email().max(320),
        displayName: z.string().min(1).max(200),
        role: z.enum(COLLABORATOR_ROLES),
        permissions: z.array(z.enum(COLLABORATOR_PERMISSIONS)).optional(),
      })
      .parse(request.body)
    return {
      collaborator: await studio.collaboration.invite({
        actor,
        projectId: id,
        email: body.email,
        displayName: body.displayName,
        role: body.role,
        ...(body.permissions ? { permissions: body.permissions } : {}),
      }),
    }
  })

  app.patch('/api/studio/projects/:id/collaborators/:collaboratorId', async (request) => {
    const { id, collaboratorId } = request.params as { id: string; collaboratorId: string }
    const actor = await requireStudio(runtime, request, 'studio.collaborate', { project: { id, permission: 'admin' } })
    const body = z.object({ permissions: z.array(z.enum(COLLABORATOR_PERMISSIONS)) }).parse(request.body)
    return { collaborator: await studio.collaboration.setPermissions(actor, id, collaboratorId, body.permissions) }
  })

  app.delete('/api/studio/projects/:id/collaborators/:collaboratorId', async (request) => {
    const { id, collaboratorId } = request.params as { id: string; collaboratorId: string }
    const actor = await requireStudio(runtime, request, 'studio.collaborate', { project: { id, permission: 'admin' } })
    await studio.collaboration.revoke(actor, id, collaboratorId)
    return { ok: true }
  })

  app.post('/api/studio/projects/:id/comments', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.collaborate', { project: { id, permission: 'comment' } })
    const body = z
      .object({
        body: z.string().min(1).max(4000),
        timestampMs: z.number().int().min(0).nullable().optional(),
        versionId: z.string().optional(),
        parentCommentId: z.string().optional(),
      })
      .parse(request.body)
    return {
      comment: await studio.collaboration.comment({
        actor,
        projectId: id,
        body: body.body,
        timestampMs: body.timestampMs ?? null,
        versionId: body.versionId ?? null,
        parentCommentId: body.parentCommentId ?? null,
      }),
    }
  })

  app.post('/api/studio/projects/:id/comments/:commentId/resolve', async (request) => {
    const { id, commentId } = request.params as { id: string; commentId: string }
    const actor = await requireStudio(runtime, request, 'studio.collaborate', { project: { id, permission: 'comment' } })
    await studio.repos.comments.resolve(actor.orgId, commentId, actor.userId)
    return { threads: await studio.collaboration.threads(actor, id) }
  })

  // ----- approvals ----------------------------------------------------------

  /**
   * Formal approval.
   *
   * Gated on `studio.approve` *and* the collaborator `approve` permission —
   * the one action that decides what a record is never rides along on a
   * broader grant. Approving a master is also the single moment Sonic DNA
   * learns anything.
   */
  app.post('/api/studio/projects/:id/approve', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.approve', { project: { id, permission: 'approve' } })
    const body = z
      .object({ versionId: z.string().min(1), approvalType: z.enum(['mix', 'master', 'delivery']), comments: z.string().max(4000).optional() })
      .parse(request.body)

    const approval = await studio.collaboration.approve({
      actor,
      projectId: id,
      versionId: body.versionId,
      approvalType: body.approvalType,
      ...(body.comments ? { comments: body.comments } : {}),
    })

    let learned: unknown[] = []
    if (body.approvalType === 'master' && runtime.config.STUDIO_SONIC_DNA_ENABLED) {
      learned = await studio.memory.learnFromApproval(actor, id, body.versionId)
    }
    return { approval, sonicDna: learned }
  })

  app.post('/api/studio/projects/:id/approvals/:approvalId/revoke', async (request) => {
    const { id, approvalId } = request.params as { id: string; approvalId: string }
    const actor = await requireStudio(runtime, request, 'studio.approve', { project: { id, permission: 'approve' } })
    const body = z.object({ reason: z.string().min(1).max(1000) }).parse(request.body)
    await studio.collaboration.revokeApproval(actor, id, approvalId, body.reason)
    return { approvals: await studio.collaboration.approvalState(actor, id) }
  })

  // ----- deliver ------------------------------------------------------------

  app.get('/api/studio/projects/:id/deliver', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.deliver', { project: { id, permission: 'view' } })
    const deliverables = await studio.repos.deliverables.list(actor.orgId, id)
    return {
      deliverables: await Promise.all(
        deliverables.map(async (deliverable) => ({
          deliverable,
          checks: await studio.repos.deliverables.checks(actor.orgId, deliverable.id),
          url: await signedUrlFor(runtime, actor.orgId, deliverable.assetId),
        })),
      ),
      metadata: await studio.repos.releaseMetadata.get(actor.orgId, id),
      approvals: await studio.collaboration.approvalState(actor, id),
      kinds: DELIVERABLE_KINDS,
    }
  })

  app.put('/api/studio/projects/:id/release-metadata', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.deliver', { project: { id, permission: 'admin' } })
    const body = z
      .object({
        isrc: z.string().max(32).nullable().optional(),
        upc: z.string().max(32).nullable().optional(),
        primaryArtist: z.string().max(200).optional(),
        featuredArtists: z.string().max(400).optional(),
        labelName: z.string().max(200).optional(),
        explicit: z.enum(['explicit', 'clean', 'not_explicit', 'undeclared']).optional(),
        language: z.string().max(32).optional(),
        genre: z.string().max(64).optional(),
        secondaryGenre: z.string().max(64).optional(),
        copyrightLine: z.string().max(400).optional(),
        publishingLine: z.string().max(400).optional(),
        artworkAssetId: z.string().max(64).nullable().optional(),
        credits: z.array(z.object({ name: z.string().max(200), role: z.string().max(120), detail: z.string().max(400).optional() })).optional(),
        splits: z
          .array(
            z.object({
              name: z.string().max(200),
              role: z.string().max(120),
              percentage: z.number().min(0).max(100),
              publisher: z.string().max(200).optional(),
              ipi: z.string().max(32).optional(),
            }),
          )
          .optional(),
      })
      .parse(request.body ?? {})
    return { metadata: await studio.repos.releaseMetadata.upsert(actor.orgId, id, body, actor.userId) }
  })

  app.post('/api/studio/projects/:id/deliverables', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.deliver', { project: { id, permission: 'upload' } })
    const body = z.object({ versionId: z.string().min(1), assetKind: z.enum(DELIVERABLE_KINDS), fileName: z.string().max(200).optional() }).parse(request.body)
    return {
      deliverable: await studio.delivery.createDeliverable({
        actor,
        projectId: id,
        versionId: body.versionId,
        assetKind: body.assetKind,
        ...(body.fileName ? { fileName: body.fileName } : {}),
      }),
    }
  })

  app.post('/api/studio/projects/:id/deliverables/:deliverableId/check', async (request) => {
    const { id, deliverableId } = request.params as { id: string; deliverableId: string }
    const actor = await requireStudio(runtime, request, 'studio.deliver', { project: { id, permission: 'view' } })
    return studio.delivery.runChecks(actor, deliverableId)
  })

  /** SEND TO RELEASE — into Street Banker's existing release workflow. */
  app.post('/api/studio/projects/:id/deliverables/:deliverableId/send', async (request) => {
    const { id, deliverableId } = request.params as { id: string; deliverableId: string }
    const actor = await requireStudio(runtime, request, 'studio.deliver', { project: { id, permission: 'approve' } })
    const body = z.object({ releaseId: z.string().min(1).max(64) }).parse(request.body)
    return { deliverable: await studio.delivery.sendToRelease(actor, deliverableId, body.releaseId) }
  })

  // ----- sonic DNA and creative memory ---------------------------------------

  app.get('/api/studio/projects/:id/sonic-dna', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.sonic_dna', { project: { id, permission: 'view' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    return { ...(await studio.memory.profile(actor, artistKeyOf(project))), attributes: SONIC_DNA_ATTRIBUTES }
  })

  app.post('/api/studio/projects/:id/sonic-dna', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.sonic_dna', { project: { id, permission: 'admin' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    const body = z.object({ attribute: z.enum(SONIC_DNA_ATTRIBUTES), valueText: z.string().min(1).max(500) }).parse(request.body)
    return { entry: await studio.memory.state(actor, artistKeyOf(project), body.attribute, body.valueText) }
  })

  app.patch('/api/studio/projects/:id/sonic-dna/:entryId', async (request) => {
    const { id, entryId } = request.params as { id: string; entryId: string }
    const actor = await requireStudio(runtime, request, 'studio.sonic_dna', { project: { id, permission: 'admin' } })
    const body = z.object({ status: z.enum(['proposed', 'active', 'dismissed']) }).parse(request.body)
    return { entry: await studio.memory.setStatus(actor, entryId, body.status) }
  })

  /** A real reset. The product promises one, so this deletes rather than hides. */
  app.post('/api/studio/projects/:id/sonic-dna/reset', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.sonic_dna', { project: { id, permission: 'admin' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    return studio.memory.reset(actor, artistKeyOf(project))
  })

  for (const action of ['promote', 'dismiss'] as const) {
    app.post(`/api/studio/projects/:id/memory/:entryId/${action}`, async (request) => {
      const { id, entryId } = request.params as { id: string; entryId: string }
      const actor = await requireStudio(runtime, request, 'studio.sonic_dna', { project: { id, permission: 'admin' } })
      const body = z.object({ statement: z.string().max(500).optional() }).parse(request.body ?? {})
      return {
        entry: action === 'promote' ? await studio.memory.promoteMemory(actor, entryId, body.statement ?? null) : await studio.memory.dismissMemory(actor, entryId),
      }
    })
  }

  // ----- record passport and the creation ledger ------------------------------

  app.get('/api/studio/projects/:id/passport', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.record_passport', { project: { id, permission: 'view' } })
    const passport = await studio.repos.passports.latestForProject(actor.orgId, id)
    return {
      passport,
      verification: passport ? await studio.passports.verify(actor, passport.id) : null,
      contributions: await studio.repos.contributions.list(actor.orgId, id),
      contributionTypes: CONTRIBUTION_TYPES,
    }
  })

  app.post('/api/studio/projects/:id/passport', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.record_passport', { project: { id, permission: 'admin' } })
    const body = z
      .object({
        declarations: z.array(z.string().max(1000)).optional(),
        samples: z
          .array(
            z.object({
              description: z.string().max(500),
              source: z.string().max(500),
              cleared: z.boolean().nullable(),
              licenseReference: z.string().max(200).nullable(),
            }),
          )
          .optional(),
        generativeUse: z.array(z.string().max(500)).optional(),
        voiceModelUse: z.array(z.string().max(500)).optional(),
        externalProfile: z.string().max(64).nullable().optional(),
      })
      .parse(request.body ?? {})
    return { passport: await studio.passports.build({ actor, projectId: id, ...body }) }
  })

  app.post('/api/studio/projects/:id/passport/:passportId/finalize', async (request) => {
    const { id, passportId } = request.params as { id: string; passportId: string }
    const actor = await requireStudio(runtime, request, 'studio.record_passport', { project: { id, permission: 'approve' } })
    const body = z.object({ versionId: z.string().min(1) }).parse(request.body)
    return { passport: await studio.passports.finalize(actor, passportId, body.versionId) }
  })

  app.post('/api/studio/projects/:id/contributions', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.record_passport', { project: { id, permission: 'comment' } })
    const body = z
      .object({
        contributionType: z.enum(CONTRIBUTION_TYPES),
        performedBy: z.string().min(1).max(200),
        instrument: z.string().max(120).nullable().optional(),
        detail: z.string().max(1000).optional(),
        human: z.boolean(),
        aiTool: z.string().max(200).nullable().optional(),
        aiRole: z.string().max(500).nullable().optional(),
        versionId: z.string().optional(),
      })
      .parse(request.body)
    return {
      contribution: await studio.repos.contributions.create({
        orgId: actor.orgId,
        studioProjectId: id,
        studioVersionId: body.versionId ?? null,
        contributionType: body.contributionType,
        performedBy: body.performedBy,
        instrument: body.instrument ?? null,
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        human: body.human,
        aiTool: body.aiTool ?? null,
        aiRole: body.aiRole ?? null,
        declaredBy: actor.userId,
      }),
    }
  })

  // ----- identity vault and AI licensing --------------------------------------

  app.get('/api/studio/projects/:id/rights', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.ai_licensing', { project: { id, permission: 'view' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    return {
      permissions: await studio.rights.aiPermissions(actor, id),
      identity: await studio.rights.identityProfile(actor, artistKeyOf(project)),
      catalogue: { aiPermissions: AI_PERMISSIONS, identitySubjects: IDENTITY_SUBJECTS },
    }
  })

  app.post('/api/studio/projects/:id/rights/ai', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.ai_licensing', { project: { id, permission: 'admin' } })
    const body = z
      .object({
        assetScope: z.enum(['master', 'stems', 'acapella', 'instrumental', 'all']),
        permission: z.enum(AI_PERMISSIONS),
        granted: z.boolean(),
        revocable: z.boolean().optional(),
        territories: z.array(z.string().max(8)).optional(),
        termEnd: z.string().max(32).nullable().optional(),
        conditions: z.string().max(2000).optional(),
        contractReference: z.string().max(200).nullable().optional(),
      })
      .parse(request.body)
    return { permission: await studio.rights.setAiPermission({ actor, projectId: id, ...body }) }
  })

  app.post('/api/studio/projects/:id/rights/ai/:permissionId/revoke', async (request) => {
    const { id, permissionId } = request.params as { id: string; permissionId: string }
    const actor = await requireStudio(runtime, request, 'studio.ai_licensing', { project: { id, permission: 'admin' } })
    const body = z.object({ reason: z.string().min(1).max(1000) }).parse(request.body)
    return { permission: await studio.rights.revokeAiPermission(actor, permissionId, body.reason) }
  })

  app.post('/api/studio/projects/:id/rights/identity', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.identity_vault', { project: { id, permission: 'admin' } })
    const project = await studio.repos.projects.get(actor.orgId, id)
    const body = z
      .object({
        subject: z.enum(IDENTITY_SUBJECTS),
        control: z.enum(['prohibited', 'consent_required', 'permitted']),
        approvedModelIds: z.array(z.string().max(120)).optional(),
        permittedUses: z.array(z.string().max(200)).optional(),
        prohibitedUses: z.array(z.string().max(200)).optional(),
        territories: z.array(z.string().max(8)).optional(),
        termStart: z.string().max(32).nullable().optional(),
        termEnd: z.string().max(32).nullable().optional(),
        pricing: z.string().max(500).optional(),
        consentRecordId: z.string().max(64).nullable().optional(),
      })
      .parse(request.body)
    return { entry: await studio.rights.setIdentity({ actor, artistKey: artistKeyOf(project), ...body }) }
  })

  // ----- marketplace and opportunities ----------------------------------------

  app.get('/api/studio/projects/:id/services', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.marketplace', { project: { id, permission: 'view' } })
    return { ...(await studio.market.catalogue(actor)), orders: await studio.market.orders(actor, id), serviceKeys: STUDIO_SERVICES }
  })

  app.post('/api/studio/projects/:id/services', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.marketplace', { project: { id, permission: 'admin' } })
    const body = z
      .object({ serviceKey: z.enum(STUDIO_SERVICES), providerId: z.string().min(1), brief: z.string().max(4000), rush: z.boolean().optional(), versionId: z.string().optional() })
      .parse(request.body)
    return {
      order: await studio.market.order({
        actor,
        projectId: id,
        serviceKey: body.serviceKey,
        providerId: body.providerId,
        brief: body.brief,
        ...(body.rush !== undefined ? { rush: body.rush } : {}),
        versionId: body.versionId ?? null,
      }),
    }
  })

  app.get('/api/studio/projects/:id/opportunities', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.opportunities', { project: { id, permission: 'view' } })
    return { opportunities: await studio.market.opportunities(actor, id) }
  })

  app.post('/api/studio/projects/:id/opportunities', async (request) => {
    const { id } = request.params as { id: string }
    const actor = await requireStudio(runtime, request, 'studio.opportunities', { project: { id, permission: 'view' } })
    return { opportunities: await studio.market.generate(actor, id) }
  })
}
