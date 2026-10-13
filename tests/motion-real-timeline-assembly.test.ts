import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assembleMusicTimeline, ffmpeg, generateTestVideo, probe } from '@masterclip/media-tools'
import { sha256File } from '@masterclip/shared'

let dir=''
let first=''
let second=''
let song=''

beforeAll(async()=>{
  dir=await mkdtemp(join(tmpdir(),'motion-real-timeline-test-'))
  first=join(dir,'approved-one.mp4')
  second=join(dir,'approved-two.mp4')
  song=join(dir,'authorized-track.wav')
  await generateTestVideo(first,{width:320,height:180,fps:24,durationSeconds:3,pattern:'motion',withAudio:false})
  await generateTestVideo(second,{width:180,height:320,fps:30,durationSeconds:4,pattern:'motion',withAudio:false})
  await ffmpeg(['-f','lavfi','-i','sine=frequency=650:duration=8','-c:a','pcm_s16le',song])
},90_000)
afterAll(async()=>{if(dir)await rm(dir,{recursive:true,force:true})})

describe('MOTION actual approved music-video montage assembly',()=>{
  it('creates a real MP4, joins trimmed clips, adds original song and leaves sources intact',async()=>{
    const firstHash=await sha256File(first)
    const songHash=await sha256File(song)
    const target=join(dir,'combined.mp4')
    const result=await assembleMusicTimeline({
      clips:[
        {path:first,source_start_seconds:.5,source_end_seconds:2},
        {path:second,source_start_seconds:1,source_end_seconds:3},
      ],
      audioPath:song,songStartSeconds:2,outputPath:target,
    })
    const media=await probe(target)
    expect(result.audioEmbedded).toBe(true)
    expect(media.video?.codec).toBe('h264')
    expect(media.audio).not.toBeNull()
    expect(media.durationSeconds).toBeGreaterThan(3.0)
    expect(media.durationSeconds).toBeLessThan(4.0)
    expect(media.video?.width).toBe(result.width)
    expect(media.video?.height).toBe(result.height)
    expect(await sha256File(first)).toBe(firstHash)
    expect(await sha256File(song)).toBe(songHash)
    expect(await sha256File(target)).not.toBe(firstHash)
  },120_000)

  it('rejects negative trims and timelines longer than 60 seconds',async()=>{
    await expect(assembleMusicTimeline({
      clips:[{path:first,source_start_seconds:2,source_end_seconds:1}],
      audioPath:song,songStartSeconds:0,outputPath:join(dir,'invalid.mp4'),
    })).rejects.toMatchObject({code:'timeline.assembly_trim'})
    await expect(assembleMusicTimeline({
      clips:Array.from({length:16},()=>({path:first,source_start_seconds:0,source_end_seconds:4})),
      audioPath:song,songStartSeconds:0,outputPath:join(dir,'long.mp4'),
    })).rejects.toMatchObject({code:'timeline.assembly_length'})
  })
})
