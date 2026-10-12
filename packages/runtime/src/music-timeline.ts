import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError, hashObject, newId, sha256File } from '@masterclip/shared'
import { objectKey } from '@masterclip/asset-storage'
import { assembleMusicTimeline, probe } from '@masterclip/media-tools'
import { MotionTimelineInput, timelineDuration, type MotionTimelineInput as Spec } from '@masterclip/shot-schema'
import type { Runtime } from './index.js'
import { assertMediaReadable, signedReadableUrl } from './media-rights.js'

type ExportRecord = { id:string;asset_id:string;version:number;created_at:string }

export async function listTimelineExports(rt:Runtime,projectId:string,timelineId:string) {
  const rows = await rt.db.query<ExportRecord>(
    `SELECT e.id,e.asset_id,e.version,e.created_at FROM motion_timeline_exports e
     JOIN motion_music_timelines t ON t.id = e.timeline_id
     WHERE e.timeline_id = ? AND t.project_id = ? ORDER BY e.version DESC`,
    [timelineId,projectId],
  )
  const entries=[]
  for(const row of rows){
    const asset=await rt.assets.get(row.asset_id)
    entries.push({
      id:row.id,assetId:asset.id,version:Number(row.version),createdAt:row.created_at,
      durationSeconds:asset.durationSeconds,
      url:await signedReadableUrl(rt,asset.id).catch(()=>null),
    })
  }
  return entries
}

/** Immutable version-bound native timeline render.
 * Produces a real MP4 from actual approved clips and authorized source song,
 * without provider spend. The immutable saved job payload protects earlier
 * versions if the editor saves a newer draft during rendering.
 */
export async function assembleApprovedTimeline(rt:Runtime,request:{
  projectId:string;timelineId:string;version:number;spec:Spec;actor:string;orgId:string;
}):Promise<{assetId:string;reused:boolean;durationSeconds:number}>{
  const {projectId,timelineId,version,actor,orgId}=request
  const spec=MotionTimelineInput.parse(request.spec)
  const fullDuration=timelineDuration(spec)
  const timeline=await rt.db.get<{project_id:string}>(
    'SELECT project_id FROM motion_music_timelines WHERE id = ?', [timelineId],
  )
  if(!timeline||timeline.project_id!==projectId){
    throw new AppError({kind:'forbidden',code:'timeline.foreign',message:'timeline belongs to another project'})
  }
  const existing=await rt.db.get<{asset_id:string}>(
    'SELECT asset_id FROM motion_timeline_exports WHERE timeline_id = ? AND version = ?',
    [timelineId,version],
  )
  if(existing){
    const asset=await rt.assets.get(existing.asset_id)
    await assertMediaReadable(rt,asset.id)
    return {assetId:asset.id,reused:true,durationSeconds:asset.durationSeconds??fullDuration}
  }
  const song=await rt.assets.get(spec.audio_asset_id)
  const expiration=song.rights.expiresAt?Date.parse(song.rights.expiresAt):null
  if(song.projectId!==projectId||song.kind!=='audio'||
    !song.rights.authorized||song.rights.consent!=='authorized'||!song.rights.owner.trim()||
    (expiration!==null&&(!Number.isFinite(expiration)||expiration<=rt.clock.now()))||
    song.durationSeconds===null||song.durationSeconds+.05<spec.song_start_seconds+fullDuration){
    throw new AppError({kind:'forbidden',code:'timeline.song_rights',message:'recording is not currently cleared for the selected timeline'})
  }
  const sources=[]
  for(const clip of spec.clips){
    const master=await rt.renders.getMaster(clip.master_id)
    if(master.projectId!==projectId||master.status==='archived'){
      throw new AppError({kind:'forbidden',code:'timeline.master_scope',message:'selected master is not available in this project'})
    }
    const review=await rt.renders.latestReview(master.outputId)
    if(!review||!['approve','promote'].includes(review.decision)){
      throw new AppError({kind:'forbidden',code:'timeline.master_review',message:'selected master lacks current human approval'})
    }
    const asset=await rt.assets.get(master.sourceAssetId)
    await assertMediaReadable(rt,asset.id)
    if(asset.projectId!==projectId||asset.kind!=='generated_video'||
      asset.durationSeconds===null||asset.durationSeconds+.05<clip.source_end_seconds){
      throw new AppError({kind:'validation',code:'timeline.video_source',message:'video source lacks the selected material'})
    }
    sources.push({asset,clip})
  }

  const dir=await mkdtemp(join(tmpdir(),'motion-timeline-delivery-'))
  let storedKey:string|null=null
  let registered=false
  try {
    const localSong=rt.storage.localPath(song.storageKey) ??
      await rt.storage.materialize(song.storageKey,join(dir,'music-input'))
    const clips=[]
    for(const [index,item] of sources.entries()){
      const input=rt.storage.localPath(item.asset.storageKey) ??
        await rt.storage.materialize(item.asset.storageKey,join(dir,'video-'+index))
      clips.push({...item.clip,path:input})
    }
    const outputPath=join(dir,'finished-music-timeline.mp4')
    const rendered=await assembleMusicTimeline({
      clips,audioPath:localSong,songStartSeconds:spec.song_start_seconds,outputPath,
    })
    const info=await probe(outputPath)
    const id=newId('ast',rt.clock.now())
    const filename='music-timeline-'+id+'.mp4'
    const key=objectKey({projectId,kind:'delivery',id,filename})
    const stored=await rt.storage.putFile(key,outputPath,{
      contentType:'video/mp4',sha256:await sha256File(outputPath),
    })
    storedKey=stored.key
    // Unique export version is the final cross-worker gate. Concurrent
    // render workers can compute but only one transaction can publish the
    // asset and its lineage. The loser cleans up its unregistered bytes.
    const asset=await rt.db.transaction(async tx=>{
      const rawRights=await tx.get<{
        project_id:string;rights_consent:string;rights_owner:string;
        rights_authorized:number;rights_expires_at:string|null
      }>('SELECT project_id,rights_consent,rights_owner,rights_authorized,rights_expires_at FROM assets WHERE id = ?'
          +(tx.dialect==='postgres'?' FOR UPDATE':''),[song.id])
      const expiry=rawRights?.rights_expires_at?Date.parse(rawRights.rights_expires_at):null
      if(!rawRights||rawRights.project_id!==projectId||rawRights.rights_consent!=='authorized'||
        Number(rawRights.rights_authorized)!==1||!rawRights.rights_owner.trim()||
        (expiry!==null&&(!Number.isFinite(expiry)||expiry<=rt.clock.now()))){
        throw new AppError({kind:'forbidden',code:'timeline.rights_changed',message:'song authorization changed before assembly could finish'})
      }
      const created=await rt.assets.create({
        projectId,kind:'delivery',storageKey:stored.key,filename,mime:'video/mp4',
        bytes:stored.bytes,sha256:stored.sha256,
        width:info.video?.width??null,height:info.video?.height??null,
        fps:info.video?.fps??null,durationSeconds:rendered.durationSeconds,hasAudio:true,
        metadata:{
          finishing:'music_timeline_assembly',timelineId,version,approvedMasterIds:spec.clips.map(c=>c.master_id),
          sourceCuts:spec.clips,songStartSeconds:spec.song_start_seconds,
          specHash:hashObject(spec),audioEmbedded:true,
          note:'Actual FFmpeg straight-cut music video; framing letterboxed and no provider billing or auto publishing',
        },
        rights:{...song.rights,source:'user-directed approved video montage with original authorized soundtrack'},
        createdBy:actor,parents:[
          ...[...new Set(sources.map(item=>item.asset.id))].map(assetId=>({assetId,relation:'delivery_of' as const})),
          {assetId:song.id,relation:'generated_from' as const},
        ],
      },tx)
      await tx.run(
        `INSERT INTO motion_timeline_exports
         (id,timeline_id,version,asset_id,created_by,created_at) VALUES (?,?,?,?,?,?)`,
        [newId('del',rt.clock.now()),timelineId,version,created.id,actor,rt.clock.isoNow()],
      )
      return created
    })
    registered=true
    await rt.audit.record({
      orgId,projectId,actor,action:'music_timeline.assembled',
      targetType:'asset',targetId:asset.id,
      data:{timelineId,version,clipCount:spec.clips.length,sourceAudioAssetId:song.id},
    })
    return {assetId:asset.id,reused:false,durationSeconds:rendered.durationSeconds}
  }catch(error){
    if(!registered&&storedKey) await rt.storage.delete(storedKey).catch(()=>undefined)
    // Another worker may have committed this version while the rendering job
    // was running. Report the one real winner, never a second fake delivery.
    const published=await rt.db.get<{asset_id:string}>(
      'SELECT asset_id FROM motion_timeline_exports WHERE timeline_id = ? AND version = ?',
      [timelineId,version],
    )
    if(published){
      const asset=await rt.assets.get(published.asset_id)
      await assertMediaReadable(rt,asset.id)
      return {assetId:asset.id,reused:true,durationSeconds:asset.durationSeconds??fullDuration}
    }
    throw error
  }finally{await rm(dir,{recursive:true,force:true})}
}
