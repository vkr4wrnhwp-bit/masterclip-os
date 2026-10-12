import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beatAnalysis } from '@masterclip/media-tools'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError, newId, notFound } from '@masterclip/shared'
import { ScenePlanInput, proposeScenePlan, AutoAssemblyInput, proposeFirstCut, MotionTimelineInput, timelineDuration, type MotionTimelineInput as Spec } from '@masterclip/shot-schema'
import { requireNativeFinishing, listTimelineExports, signedReadableUrl, type Runtime } from '@masterclip/runtime'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import { requireProject } from '../server.js'
import { assertMusicCueAsset } from './quick-create.js'

type TimelineRow = {
  id: string; project_id: string; name: string; version: number; spec: string
  created_by: string; created_at: string; updated_at: string
}

function mapTimeline(row: TimelineRow) {
  return {
    id: row.id, projectId: row.project_id, name: row.name, version: Number(row.version),
    spec: MotionTimelineInput.parse(JSON.parse(row.spec)) as Spec,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

async function validateTimeline(rt: Runtime, projectId: string, spec: Spec): Promise<number> {
  let duration: number
  try { duration = timelineDuration(spec) }
  catch (error) {
    throw new AppError({ kind: 'validation', code: 'timeline.duration', message: (error as Error).message })
  }
  await assertMusicCueAsset(rt, projectId, {
    asset_id: spec.audio_asset_id, start_seconds: spec.song_start_seconds,
    end_seconds: spec.song_start_seconds + duration,
    promotional_use_attested: true, creative_look: 'cinematic',
  })
  for (const clip of spec.clips) {
    const master = await rt.renders.getMaster(clip.master_id)
    if (master.projectId !== projectId || master.status === 'archived') {
      throw new AppError({ kind: 'forbidden', code: 'timeline.foreign_master', message: 'clip master is not approved for this project' })
    }
    const review = await rt.renders.latestReview(master.outputId)
    if (!review || !['approve','promote'].includes(review.decision)) {
      throw new AppError({ kind: 'forbidden', code: 'timeline.no_review', message: 'a selected clip is no longer human-approved' })
    }
    const asset = await rt.assets.get(master.sourceAssetId)
    if (asset.projectId !== projectId || asset.kind !== 'generated_video') {
      throw new AppError({ kind: 'forbidden', code: 'timeline.invalid_video', message: 'a clip is not from a valid project video' })
    }
    if (asset.durationSeconds === null || clip.source_end_seconds > asset.durationSeconds + .05 ||
        clip.source_end_seconds <= clip.source_start_seconds) {
      throw new AppError({ kind: 'validation', code: 'timeline.outside_master', message: 'clip in/out points exceed its approved master duration' })
    }
  }
  return duration
}

export async function registerMusicTimelineRoutes(app: FastifyInstance, rt: Runtime): Promise<void> {
  // Advisory shot planning, grounded only in this project's saved human
  // annotations. An untrusted caller cannot provide arbitrary section labels.
  app.post('/api/projects/:projectId/music-timelines/scene-plan', async request => {
    const {projectId}=request.params as {projectId:string}
    await requireProject(rt,request,projectId,'editor')
    const requested=ScenePlanInput.pick({
      audio_asset_id:true,song_start_seconds:true,target_seconds:true,
      direction:true,shot_count:true,
    }).parse(request.body)
    const audio=await rt.assets.get(requested.audio_asset_id)
    await assertMusicCueAsset(rt,projectId,{
      asset_id:audio.id,start_seconds:requested.song_start_seconds,
      end_seconds:requested.song_start_seconds+requested.target_seconds,
      creative_look:'cinematic',promotional_use_attested:true,
    })
    const saved=await rt.db.get<{sections:string}>(
      'SELECT sections FROM motion_music_sections WHERE project_id = ? AND audio_asset_id = ?',
      [projectId,audio.id],
    )
    const sections=saved ? JSON.parse(saved.sections) as unknown : []
    return proposeScenePlan({...requested,sections:Array.isArray(sections)?sections:[]})
  })

  // A server-authored first-cut suggestion. Never trust client-supplied BPM,
  // beat markers, duration or master approval. Decode the real local recording
  // and evaluate only sources that remain human-approved in this project.
  app.post('/api/projects/:projectId/music-timelines/propose', async request => {
    const {projectId}=request.params as {projectId:string}
    await requireProject(rt,request,projectId,'editor')
    const requested=AutoAssemblyInput.pick({
      name:true,audio_asset_id:true,song_start_seconds:true,
      target_seconds:true,pacing:true,
    }).parse(request.body)
    const song=await rt.assets.get(requested.audio_asset_id)
    const end=requested.song_start_seconds+requested.target_seconds
    await assertMusicCueAsset(rt,projectId,{
      asset_id:song.id,start_seconds:requested.song_start_seconds,end_seconds:end,
      creative_look:'cinematic',promotional_use_attested:true,
    })
    const masters=await rt.renders.listMasters(projectId)
    const sources=[]
    for(const master of masters) {
      if(master.status==='archived')continue
      const review=await rt.renders.latestReview(master.outputId)
      if(!review||!['approve','promote'].includes(review.decision))continue
      const asset=await rt.assets.get(master.sourceAssetId)
      if(asset.projectId!==projectId||asset.kind!=='generated_video'||
        !(asset.durationSeconds&&asset.durationSeconds>=.5))continue
      sources.push({master_id:master.id,duration_seconds:asset.durationSeconds})
      if(sources.length>=16)break
    }
    if(!sources.length){
      throw new AppError({kind:'validation',code:'auto_assembly.no_masters',
        message:'approve and promote a MOTION video master before proposing a cut'})
    }
    const dir=await mkdtemp(join(tmpdir(),'motion-auto-cut-'))
    let analysis:{beats:number[];confidence:number;bpm:number|null}|null=null
    try {
      const path=rt.storage.localPath(song.storageKey)??
        await rt.storage.materialize(song.storageKey,join(dir,'authorized-audio'))
      analysis=await beatAnalysis(path)
    }catch(error){
      rt.logger.warn('auto_assembly.beat_unavailable',{code:'beat_analysis_unavailable'})
    }finally {await rm(dir,{recursive:true,force:true})}
    // Read only annotations saved for this exact authorized recording.
    // A client cannot invent section labels or a beat map in this endpoint.
    const annotation=await rt.db.get<{sections:string}>(
      'SELECT sections FROM motion_music_sections WHERE project_id = ? AND audio_asset_id = ?',
      [projectId,song.id],
    )
    const sections=annotation ? JSON.parse(annotation.sections) as unknown : []
    return proposeFirstCut({
      ...requested,sources,
      beats:analysis?.beats??[],
      beat_confidence:analysis?.confidence??0,
      sections: Array.isArray(sections) ? sections : [],
    })
  })

  // Build the editor from genuine human-approved masters and currently
  // authorized recordings. Do not expose unrelated project media.
  app.get('/api/projects/:projectId/music-timelines/sources', async request => {
    const { projectId } = request.params as {projectId:string}
    await requireProject(rt, request, projectId)
    const masters = await rt.renders.listMasters(projectId)
    const videos = []
    for (const master of masters) {
      if (master.status === 'archived') continue
      const review = await rt.renders.latestReview(master.outputId)
      if (!review || !['approve','promote'].includes(review.decision)) continue
      const asset = await rt.assets.get(master.sourceAssetId)
      if (asset.projectId !== projectId || asset.kind !== 'generated_video' ||
          !(asset.durationSeconds && asset.durationSeconds > 0)) continue
      const videoUrl = await signedReadableUrl(rt, asset.id).catch(() => null)
      if (videoUrl) videos.push({ masterId:master.id, name:master.name, durationSeconds:asset.durationSeconds, videoUrl })
    }
    const assets = await rt.assets.list(projectId, 'audio')
    const audio = []
    for (const asset of assets) {
      if (!asset.rights.authorized || asset.rights.consent !== 'authorized' ||
          !asset.rights.owner.trim() || !(asset.durationSeconds && asset.durationSeconds > 0)) continue
      const audioUrl = await signedReadableUrl(rt, asset.id).catch(() => null)
      if (audioUrl) audio.push({ id:asset.id, filename:asset.filename, durationSeconds:asset.durationSeconds, audioUrl })
    }
    return { videos, audio }
  })

  app.get('/api/projects/:projectId/music-timelines', async request => {
    const { projectId } = request.params as {projectId:string}
    await requireProject(rt, request, projectId)
    const rows = await rt.db.query<TimelineRow>(
      'SELECT * FROM motion_music_timelines WHERE project_id = ? ORDER BY updated_at DESC LIMIT 100', [projectId],
    )
    return { timelines: rows.map(mapTimeline) }
  })

  app.post('/api/projects/:projectId/music-timelines', async request => {
    const { projectId } = request.params as {projectId:string}
    const {auth} = await requireProject(rt, request, projectId, 'editor')
    const spec = MotionTimelineInput.parse(request.body)
    await validateTimeline(rt, projectId, spec)
    const id = newId('run', rt.clock.now())
    const now = rt.clock.isoNow()
    await rt.db.run(
      `INSERT INTO motion_music_timelines
       (id, project_id, name, version, spec, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, spec.name, 1, JSON.stringify(spec), auth.userId, now, now],
    )
    return { timelineId: id, version: 1, status: 'saved' as const, rendered: false }
  })

  app.put('/api/projects/:projectId/music-timelines/:timelineId', async request => {
    const { projectId, timelineId } = request.params as {projectId:string;timelineId:string}
    await requireProject(rt, request, projectId, 'editor')
    const body = z.object({ expectedVersion:z.number().int().positive(), spec:MotionTimelineInput }).parse(request.body)
    await validateTimeline(rt, projectId, body.spec)
    const result = await rt.db.run(
      `UPDATE motion_music_timelines SET name = ?, spec = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND project_id = ? AND version = ?`,
      [body.spec.name, JSON.stringify(body.spec), rt.clock.isoNow(), timelineId, projectId, body.expectedVersion],
    )
    if (result.changes !== 1) {
      throw new AppError({ kind: 'conflict', code: 'timeline.version_conflict', message: 'timeline changed or is unavailable; reload before saving' })
    }
    return { timelineId, version: body.expectedVersion + 1, status: 'saved' as const, rendered: false }
  })

  // Render the saved, immutable version snapshot in the durable media worker.
  // Creation itself never runs FFmpeg or spends provider credits.
  app.post('/api/projects/:projectId/music-timelines/:timelineId/assemble', async request => {
    requireNativeFinishing(rt.config)
    const {projectId,timelineId}=request.params as {projectId:string;timelineId:string}
    const {auth}=await requireProject(rt,request,projectId,'director')
    const row=await rt.db.get<TimelineRow>(
      'SELECT * FROM motion_music_timelines WHERE id = ? AND project_id = ?',[timelineId,projectId],
    )
    if(!row)throw notFound('music timeline',timelineId)
    const draft=mapTimeline(row)
    await validateTimeline(rt,projectId,draft.spec)
    const queued=await rt.queue.enqueue({
      queue:QUEUES.media,type:JOB_TYPES.assembleMusicTimeline,
      payload:{projectId,timelineId,version:draft.version,spec:draft.spec,actor:auth.userId,orgId:auth.orgId},
      dedupeKey:'motion:timeline:'+timelineId+':v'+draft.version,
      maxAttempts:2,
    })
    return {jobId:queued.id,version:draft.version,status:'queued' as const,deduped:queued.deduped}
  })

  app.get('/api/projects/:projectId/music-timelines/:timelineId/exports', async request => {
    const {projectId,timelineId}=request.params as {projectId:string;timelineId:string}
    await requireProject(rt,request,projectId)
    const row=await rt.db.get<TimelineRow>(
      'SELECT * FROM motion_music_timelines WHERE id = ? AND project_id = ?',[timelineId,projectId],
    )
    if(!row)throw notFound('music timeline',timelineId)
    const query=rt.db.dialect==='postgres'
      ?`SELECT id,status FROM queue_jobs WHERE queue_name = ? AND job_type = ?
        AND (payload::jsonb ->> 'timelineId') = ? ORDER BY created_at DESC LIMIT 1`
      :`SELECT id,status FROM queue_jobs WHERE queue_name = ? AND job_type = ?
        AND json_valid(payload) = 1 AND json_extract(payload, '$.timelineId') = ?
        ORDER BY created_at DESC LIMIT 1`
    const latestJob=await rt.db.get<{id:string;status:string}>(
      query,[QUEUES.media,JOB_TYPES.assembleMusicTimeline,timelineId],
    )
    return {exports:await listTimelineExports(rt,projectId,timelineId),
      latestJob:latestJob?{id:latestJob.id,status:latestJob.status}:null}
  })

  app.get('/api/projects/:projectId/music-timelines/:timelineId/jobs/:jobId', async request => {
    const {projectId,timelineId,jobId}=request.params as {projectId:string;timelineId:string;jobId:string}
    await requireProject(rt,request,projectId)
    const row=await rt.db.get<TimelineRow>(
      'SELECT * FROM motion_music_timelines WHERE id = ? AND project_id = ?',[timelineId,projectId],
    )
    if(!row)throw notFound('music timeline',timelineId)
    const job=await rt.queue.get(jobId)
    const payload=job?.payload as {timelineId?:string;projectId?:string}|null
    if(!job||job.type!==JOB_TYPES.assembleMusicTimeline||payload?.timelineId!==timelineId||
      payload?.projectId!==projectId)throw notFound('assembly job',jobId)
    return {jobId,status:job.status,
      error:job.status==='dead'?'Timeline assembly failed. Check your approved sources or contact support.':null}
  })

  app.get('/api/projects/:projectId/music-timelines/:timelineId/preview', async request => {
    const { projectId, timelineId } = request.params as {projectId:string;timelineId:string}
    await requireProject(rt, request, projectId)
    const row = await rt.db.get<TimelineRow>(
      'SELECT * FROM motion_music_timelines WHERE id = ? AND project_id = ?', [timelineId, projectId],
    )
    if (!row) throw notFound('music timeline', timelineId)
    const timeline = mapTimeline(row)
    const duration = await validateTimeline(rt, projectId, timeline.spec)
    const audio = await rt.assets.get(timeline.spec.audio_asset_id)
    const audioUrl = await signedReadableUrl(rt, audio.id)
    const clips = []
    for (const clip of timeline.spec.clips) {
      const master = await rt.renders.getMaster(clip.master_id)
      const asset = await rt.assets.get(master.sourceAssetId)
      clips.push({
        ...clip, masterName: master.name,
        videoUrl: await signedReadableUrl(rt, asset.id),
        durationSeconds: asset.durationSeconds,
      })
    }
    return { timeline, durationSeconds:duration, audioUrl, clips, rendered:false }
  })
}
