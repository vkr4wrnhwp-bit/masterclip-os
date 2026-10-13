import type { FastifyInstance } from 'fastify'
import { AppError, hashObject } from '@masterclip/shared'
import { CanonicalShot, ReviewedSceneHandoff, toCanonicalSceneShot, validateShot } from '@masterclip/shot-schema'
import type { Runtime } from '@masterclip/runtime'
import { requireProject } from '../server.js'
import { assertMusicCueAsset } from './quick-create.js'

/**
 * One explicit human-reviewed handoff at a time. Reuse the existing
 * ProjectRepo and canonical Shot Builder schema; do not invent a parallel
 * shot store or bypass approval and budget enforcement.
 */
export async function registerSceneHandoffRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  app.post('/api/projects/:projectId/scene-plan/handoff', async request => {
    const { projectId } = request.params as {projectId:string}
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const input = ReviewedSceneHandoff.parse(request.body)
    let planned
    try {
      planned = toCanonicalSceneShot(input)
    } catch (error) {
      throw new AppError({kind:'validation',code:'handoff.invalid_song_range',message:(error as Error).message})
    }
    const parsed = validateShot(planned)
    if (!parsed.ok || !parsed.shot) {
      throw new AppError({kind:'validation',code:'handoff.invalid_shot',
        message:'planned scene failed canonical Shot Builder validation',
        details:{issues:parsed.issues}})
    }
    // Enforce the current source recording's project ownership and actual
    // consent before even returning an idempotent, previously created shot.
    await assertMusicCueAsset(runtime,projectId,parsed.shot.music_cue!)
    const shotKey=parsed.shot.shot_id
    const expected = CanonicalShot.parse({
      ...parsed.shot,project_id:projectId,scene_id:'',version:1,
    })
    const expectedHash=hashObject(expected)

    const existing = async (): Promise<{shotId:string;deduped:boolean}|null> => {
      const row=await runtime.db.get<{id:string}>(
        'SELECT id FROM shots WHERE project_id = ? AND shot_key = ?',
        [projectId,shotKey],
      )
      if (!row) return null
      // A handoff key may only ever refer to its original first version.
      // A subsequent independent Shot Builder edit is retained untouched.
      const versions=await runtime.projects.listVersions(row.id)
      const original=versions.find(version=>version.version===1)
      if (!original || original.specHash!==expectedHash) {
        throw new AppError({kind:'conflict',code:'handoff.key_conflict',
          message:'handoff ID already refers to a different initial shot; start a new reviewed handoff'})
      }
      return {shotId:row.id,deduped:true}
    }

    const prior=await existing()
    if(prior)return {...prior,rendered:false,queued:false}
    try {
      const created=await runtime.projects.createShot({
        projectId,spec:parsed.shot,createdBy:auth.userId,
        note:'Explicit artist-reviewed Scene Planning handoff. No render submitted.',
      })
      await runtime.audit.record({
        orgId:auth.orgId,projectId,actor:auth.userId,
        action:'scene_plan.canonical_shot_handoff',targetType:'shot',targetId:created.shot.id,
        data:{shotKey,audioAssetId:input.audioAssetId,
          songStartSeconds:input.songStartSeconds,songEndSeconds:input.songEndSeconds,
          humanReviewed:true,automaticRender:false},
      })
      return {shotId:created.shot.id,deduped:false,rendered:false,queued:false}
    } catch (error) {
      // Retry safety across concurrent HTTP requests; never create two
      // different shots for the same explicit user-review request key.
      const concurrent=await existing()
      if(concurrent)return {...concurrent,rendered:false,queued:false}
      throw error
    }
  })
}
