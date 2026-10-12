import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError, conflict, newId } from '@masterclip/shared'
import { StyleBible } from '@masterclip/shot-schema'
import type { Runtime } from '@masterclip/runtime'
import { requireProject } from '../server.js'

const NewTreatment = z.object({
  name: z.string().trim().min(1).max(80),
  look: z.enum(['performance', 'cinematic', 'editorial', 'atmosphere']),
  aspect_ratio: z.enum(['9:16', '1:1', '4:5', '16:9']),
  direction: z.string().trim().min(8).max(1600),
})

/** Owned by MOTION's project style bible, not a new catalog or service. */
export async function registerCreativeTreatments(app: FastifyInstance, runtime: Runtime): Promise<void> {
  app.get('/api/projects/:projectId/creative-treatments', async request => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const project = await runtime.projects.get(projectId)
    return { treatments: project.styleBible.saved_treatments }
  })

  app.post('/api/projects/:projectId/creative-treatments', async request => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const body = NewTreatment.parse(request.body)
    const project = await runtime.projects.get(projectId)
    const previous = project.styleBible.saved_treatments
    if (previous.length >= 24) {
      throw new AppError({ kind: 'validation', code: 'creative_looks.limit', message: 'this project has reached its 24-treatment limit' })
    }
    if (previous.some(item => item.name.toLocaleLowerCase('en-US') === body.name.toLocaleLowerCase('en-US'))) {
      throw conflict('a treatment with that name already exists in this project')
    }
    const treatment = { ...body, id: newId('key', runtime.clock.now()) }
    const parsed = StyleBible.parse({ ...project.styleBible, saved_treatments: [...previous, treatment] })
    await runtime.projects.update(projectId, { styleBible: parsed })
    await runtime.audit.record({
      orgId: auth.orgId, projectId, actor: auth.userId,
      action: 'creative_treatment.saved', targetType: 'project', targetId: projectId,
      data: { treatmentId: treatment.id, treatmentName: treatment.name, look: treatment.look },
    })
    return { treatment }
  })
}
