import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError, forbidden, newId } from '@masterclip/shared'
import { validateShot } from '@masterclip/shot-schema'
import type { Runtime } from '@masterclip/runtime'
import { requireProject } from '../server.js'
import { assertMusicCueAsset } from './quick-create.js'

const Input = z.object({
  sourceShotId: z.string().min(1),
  label: z.string().trim().min(1).max(80),
  direction: z.string().trim().min(8).max(1600),
  look: z.enum(['performance', 'cinematic', 'editorial', 'atmosphere']),
})

/** Source-linked alternative shot drafts, never automatic paid renders. */
export async function registerQuickVariants(app: FastifyInstance, runtime: Runtime): Promise<void> {
  app.post('/api/projects/:projectId/quick-variants', async request => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const input = Input.parse(request.body)
    const source = await runtime.projects.getShot(input.sourceShotId)
    if (source.projectId !== projectId) throw forbidden('source shot does not belong to this project')
    const version = await runtime.projects.currentVersion(source.id)
    const cue = version.spec.music_cue
    if (!cue || !cue.promotional_use_attested) {
      throw new AppError({ kind: 'validation', code: 'variant.source', message: 'choose an authorized music draft' })
    }
    await assertMusicCueAsset(runtime, projectId, cue)
    const references = [...version.spec.source_assets, ...version.spec.reference_video_assets]
    if (version.spec.first_frame_asset) references.push(version.spec.first_frame_asset)
    for (const assetId of new Set(references)) {
      const asset = await runtime.assets.get(assetId)
      if (asset.projectId !== projectId || !asset.rights.authorized || asset.rights.consent !== 'authorized') {
        throw forbidden('visual reference is not authorized in this project')
      }
    }
    const candidate = validateShot({
      ...version.spec, shot_id: newId('shot', runtime.clock.now()),
      title: input.label, action: input.direction, narrative_purpose: input.direction,
      music_cue: { ...cue, creative_look: input.look },
      creative_variant: { source_shot_id: source.id, label: input.label },
    })
    if (!candidate.ok || !candidate.shot) {
      throw new AppError({ kind: 'validation', code: 'variant.invalid', message: 'variant failed validation', details: { issues: candidate.issues } })
    }
    const created = await runtime.projects.createShot({
      projectId, spec: candidate.shot, createdBy: auth.userId, note: 'alternative Quick Create direction',
    })
    await runtime.audit.record({
      orgId: auth.orgId, projectId, actor: auth.userId, action: 'quick_create.variant_created',
      targetType: 'shot', targetId: created.shot.id, data: { sourceShotId: source.id, sourceVersionId: version.id },
    })
    return { shotId: created.shot.id, sourceShotId: source.id, rendered: false, status: 'draft' }
  })
}
