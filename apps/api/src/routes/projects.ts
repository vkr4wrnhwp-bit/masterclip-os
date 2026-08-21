import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError } from '@masterclip/shared'
import {
  CanonicalShot,
  CharacterRecord,
  EnvironmentRecord,
  StyleBible,
  csvTemplate,
  emptyShot,
  exportBundle,
  exportCsv,
  importCsv,
  importJson,
  shotJsonSchema,
  characterJsonSchema,
  environmentJsonSchema,
  validateShot,
} from '@masterclip/shot-schema'
import type { Runtime } from '@masterclip/runtime'
import { requireAuth, requireProject } from '../server.js'

/** Projects, scenes, shots, and the character/world bibles. */
export async function registerProjectRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  app.get('/api/schema/shot', async () => shotJsonSchema())
  app.get('/api/schema/character', async () => characterJsonSchema())
  app.get('/api/schema/environment', async () => environmentJsonSchema())
  app.get('/api/schema/shot-template.csv', async (_request, reply) => {
    void reply.type('text/csv')
    return csvTemplate()
  })

  // ------------------------------------------------------------ projects ----
  app.get('/api/projects', async (request) => {
    const auth = await requireAuth(runtime, request)
    return { projects: await runtime.projects.list(auth.orgId) }
  })

  app.post('/api/projects', async (request) => {
    const auth = await requireAuth(runtime, request)
    const body = z.object({ name: z.string().min(1), brief: z.string().optional(), styleBible: z.unknown().optional() }).parse(request.body)
    const project = await runtime.projects.create({
      orgId: auth.orgId,
      name: body.name,
      ...(body.brief !== undefined ? { brief: body.brief } : {}),
      ...(body.styleBible !== undefined ? { styleBible: StyleBible.parse(body.styleBible) } : {}),
      createdBy: auth.userId,
    })
    await runtime.cost.budgetStore.ensureDefaults('project', project.id)
    await runtime.audit.record({
      orgId: auth.orgId,
      projectId: project.id,
      actor: auth.userId,
      action: 'project.created',
      targetType: 'project',
      targetId: project.id,
      data: { name: project.name },
    })
    return { project }
  })

  app.get('/api/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const [project, scenes, shots, characters, environments] = await Promise.all([
      runtime.projects.get(projectId),
      runtime.projects.listScenes(projectId),
      runtime.projects.listShots(projectId),
      runtime.bibles.listCharacters(projectId),
      runtime.bibles.listEnvironments(projectId),
    ])
    return { project, scenes, shots, characters, environments }
  })

  app.patch('/api/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId, 'producer')
    const body = z
      .object({
        name: z.string().min(1).optional(),
        brief: z.string().optional(),
        styleBible: z.unknown().optional(),
        status: z.enum(['active', 'archived']).optional(),
      })
      .parse(request.body)
    return {
      project: await runtime.projects.update(projectId, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.brief !== undefined ? { brief: body.brief } : {}),
        ...(body.styleBible !== undefined ? { styleBible: StyleBible.parse(body.styleBible) } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      }),
    }
  })

  // -------------------------------------------------------------- scenes ----
  app.post('/api/projects/:projectId/scenes', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId, 'editor')
    const body = z.object({ name: z.string().min(1), synopsis: z.string().optional(), ordinal: z.number().int().optional() }).parse(request.body)
    return {
      scene: await runtime.projects.createScene({
        projectId,
        name: body.name,
        ...(body.synopsis !== undefined ? { synopsis: body.synopsis } : {}),
        ...(body.ordinal !== undefined ? { ordinal: body.ordinal } : {}),
      }),
    }
  })

  // --------------------------------------------------------------- shots ----
  app.get('/api/projects/:projectId/shots', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const shots = await runtime.projects.listShots(projectId)
    const withSpecs = await Promise.all(
      shots.map(async (shot) => ({ ...shot, spec: (await runtime.projects.currentVersion(shot.id)).spec })),
    )
    return { shots: withSpecs }
  })

  app.post('/api/projects/:projectId/shots', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const body = z.object({ spec: z.unknown(), sceneId: z.string().nullable().optional(), note: z.string().optional() }).parse(request.body)

    const validation = validateShot(body.spec)
    if (!validation.ok || !validation.shot) {
      throw new AppError({
        kind: 'validation',
        code: 'shot.invalid',
        message: 'shot failed canonical schema validation',
        details: { issues: validation.issues },
      })
    }
    const created = await runtime.projects.createShot({
      projectId,
      sceneId: body.sceneId ?? null,
      spec: validation.shot,
      createdBy: auth.userId,
      ...(body.note !== undefined ? { note: body.note } : {}),
    })
    return { ...created, warnings: validation.issues.filter((i) => i.severity === 'warning') }
  })

  app.get('/api/shots/:shotId', async (request) => {
    const { shotId } = request.params as { shotId: string }
    const shot = await runtime.projects.getShot(shotId)
    await requireProject(runtime, request, shot.projectId)
    const [version, versions, outputs] = await Promise.all([
      runtime.projects.currentVersion(shotId),
      runtime.projects.listVersions(shotId),
      runtime.renders.listOutputs({ shotId }),
    ])
    return { shot, version, versions: versions.map((v) => ({ id: v.id, version: v.version, note: v.note, createdAt: v.createdAt, locked: v.locked })), outputs }
  })

  app.post('/api/shots/:shotId/versions', async (request) => {
    const { shotId } = request.params as { shotId: string }
    const shot = await runtime.projects.getShot(shotId)
    const { auth } = await requireProject(runtime, request, shot.projectId, 'editor')
    const body = z.object({ spec: z.unknown(), note: z.string().optional() }).parse(request.body)
    const validation = validateShot(body.spec)
    if (!validation.ok || !validation.shot) {
      throw new AppError({ kind: 'validation', code: 'shot.invalid', message: 'shot failed validation', details: { issues: validation.issues } })
    }
    return {
      version: await runtime.projects.addVersion({
        shotId,
        spec: validation.shot,
        createdBy: auth.userId,
        ...(body.note !== undefined ? { note: body.note } : {}),
      }),
      warnings: validation.issues.filter((i) => i.severity === 'warning'),
    }
  })

  app.post('/api/shots/validate', async (request) => {
    await requireAuth(runtime, request)
    const validation = validateShot((request.body as { spec?: unknown })?.spec ?? request.body)
    return { ok: validation.ok, issues: validation.issues, normalized: validation.shot }
  })

  app.get('/api/shots/blank', async (request) => {
    await requireAuth(runtime, request)
    return { shot: emptyShot() }
  })

  // ------------------------------------------------------- import/export ----
  app.post('/api/projects/:projectId/shots/import', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const body = z.object({ format: z.enum(['json', 'csv']), content: z.string().min(1), dryRun: z.boolean().optional() }).parse(request.body)

    const result = body.format === 'csv' ? importCsv(body.content) : importJson(body.content)
    if (body.dryRun) return { dryRun: true, ...result }

    const created: string[] = []
    const failed: Array<{ shotId: string; reason: string }> = []
    for (const spec of result.shots) {
      try {
        const record = await runtime.projects.createShot({ projectId, spec, createdBy: auth.userId, note: 'imported' })
        created.push(record.shot.id)
      } catch (err) {
        failed.push({ shotId: spec.shot_id, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    return { created, failed, errors: result.errors, warnings: result.warnings }
  })

  app.get('/api/projects/:projectId/shots/export', async (request, reply) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const format = (request.query as { format?: string }).format ?? 'json'
    const shots = await runtime.projects.listShots(projectId)
    const specs = await Promise.all(shots.map(async (shot) => (await runtime.projects.currentVersion(shot.id)).spec))

    if (format === 'csv') {
      void reply.type('text/csv').header('content-disposition', 'attachment; filename="shots.csv"')
      return exportCsv(specs)
    }
    return exportBundle(specs, projectId, runtime.clock.isoNow())
  })

  // -------------------------------------------------------------- bibles ----
  app.post('/api/projects/:projectId/characters', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const record = CharacterRecord.parse((request.body as { record?: unknown })?.record ?? request.body)
    return { character: await runtime.bibles.createCharacter({ projectId, record, createdBy: auth.userId }) }
  })

  app.put('/api/characters/:characterId', async (request) => {
    const { characterId } = request.params as { characterId: string }
    const body = z.object({ record: z.unknown(), note: z.string().optional() }).parse(request.body)
    const record = CharacterRecord.parse(body.record)
    const row = await runtime.db.get<{ project_id: string }>('SELECT project_id FROM characters WHERE id = ?', [characterId])
    if (!row) throw new AppError({ kind: 'not_found', message: 'character not found' })
    const { auth } = await requireProject(runtime, request, String(row.project_id), 'editor')
    return {
      character: await runtime.bibles.updateCharacter({
        characterId,
        record,
        createdBy: auth.userId,
        ...(body.note !== undefined ? { note: body.note } : {}),
      }),
    }
  })

  app.get('/api/characters/:characterId/versions', async (request) => {
    const { characterId } = request.params as { characterId: string }
    const row = await runtime.db.get<{ project_id: string }>('SELECT project_id FROM characters WHERE id = ?', [characterId])
    if (!row) throw new AppError({ kind: 'not_found', message: 'character not found' })
    await requireProject(runtime, request, String(row.project_id))
    return { versions: await runtime.bibles.characterVersions(characterId) }
  })

  app.post('/api/projects/:projectId/environments', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const record = EnvironmentRecord.parse((request.body as { record?: unknown })?.record ?? request.body)
    return { environment: await runtime.bibles.createEnvironment({ projectId, record, createdBy: auth.userId }) }
  })

  app.put('/api/environments/:environmentId', async (request) => {
    const { environmentId } = request.params as { environmentId: string }
    const body = z.object({ record: z.unknown(), note: z.string().optional() }).parse(request.body)
    const record = EnvironmentRecord.parse(body.record)
    const row = await runtime.db.get<{ project_id: string }>('SELECT project_id FROM environments WHERE id = ?', [environmentId])
    if (!row) throw new AppError({ kind: 'not_found', message: 'environment not found' })
    const { auth } = await requireProject(runtime, request, String(row.project_id), 'editor')
    return {
      environment: await runtime.bibles.updateEnvironment({
        environmentId,
        record,
        createdBy: auth.userId,
        ...(body.note !== undefined ? { note: body.note } : {}),
      }),
    }
  })
}

export { CanonicalShot }
