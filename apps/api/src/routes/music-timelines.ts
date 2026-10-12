import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError, newId, notFound } from '@masterclip/shared'
import { MotionTimelineInput, timelineDuration, type MotionTimelineInput as Spec } from '@masterclip/shot-schema'
import { signedReadableUrl, type Runtime } from '@masterclip/runtime'
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
