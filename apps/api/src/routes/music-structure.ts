import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError } from '@masterclip/shared'
import { MusicSection, validateMusicSections } from '@masterclip/shot-schema'
import type { Runtime } from '@masterclip/runtime'
import { assertMediaReadable } from '@masterclip/runtime'
import { requireProject } from '../server.js'

export async function registerMusicStructureRoutes(app: FastifyInstance, rt: Runtime): Promise<void> {
  const scopedAudio = async (projectId: string, assetId: string) => {
    const audio = await rt.assets.get(assetId)
    if (audio.projectId !== projectId || audio.kind !== 'audio') {
      throw new AppError({ kind:'forbidden',code:'structure.foreign_audio',message:'audio must belong to this project' })
    }
    await assertMediaReadable(rt, audio.id)
    if (!audio.rights.authorized || audio.rights.consent !== 'authorized' ||
        !audio.rights.owner.trim() || !(audio.durationSeconds && audio.durationSeconds > 0)) {
      throw new AppError({ kind:'forbidden',code:'structure.uncleared_audio',message:'recording must be currently authorized' })
    }
    return audio
  }
  app.get('/api/projects/:projectId/music-structure/:assetId', async request => {
    const {projectId,assetId}=request.params as {projectId:string;assetId:string}
    await requireProject(rt,request,projectId)
    await scopedAudio(projectId,assetId)
    const row=await rt.db.get<{version:number;sections:string}>(
      'SELECT version, sections FROM motion_music_sections WHERE project_id = ? AND audio_asset_id = ?',
      [projectId,assetId],
    )
    return {version:row?Number(row.version):0,sections:row?JSON.parse(row.sections):[]}
  })
  app.put('/api/projects/:projectId/music-structure/:assetId', async request => {
    const {projectId,assetId}=request.params as {projectId:string;assetId:string}
    await requireProject(rt,request,projectId,'editor')
    const audio=await scopedAudio(projectId,assetId)
    const body=z.object({
      expectedVersion:z.number().int().min(0),
      sections:z.array(MusicSection).max(32),
    }).parse(request.body)
    let sections
    try { sections=validateMusicSections(body.sections,audio.durationSeconds!) }
    catch(error) {
      throw new AppError({kind:'validation',code:'structure.invalid_sections',message:(error as Error).message})
    }
    const now=rt.clock.isoNow()
    const result=await rt.db.run(
      `INSERT INTO motion_music_sections
       (project_id,audio_asset_id,version,sections,updated_at)
       VALUES (?,?,1,?,?)
       ON CONFLICT(project_id,audio_asset_id) DO UPDATE
       SET version = motion_music_sections.version + 1,
           sections = excluded.sections, updated_at = excluded.updated_at
       WHERE motion_music_sections.version = ?`,
      [projectId,assetId,JSON.stringify(sections),now,body.expectedVersion],
    )
    if(result.changes!==1)throw new AppError({
      kind:'conflict',code:'structure.version_conflict',message:'Song structure changed. Reload before overwriting annotations.',
    })
    return {version:body.expectedVersion+1,sections}
  })
}
