import { describe, expect, it } from 'vitest'
import { MotionTimelineInput, timelineDuration } from '@masterclip/shot-schema'

const spec = () => MotionTimelineInput.parse({
  name:'Release first cut',
  audio_asset_id:'song_asset',
  song_start_seconds:7,
  clips:[
    {master_id:'approved_A',source_start_seconds:1,source_end_seconds:3.5},
    {master_id:'approved_B',source_start_seconds:0,source_end_seconds:4.5},
  ],
})

describe('MOTION native Music Video Timeline',()=>{
  it('calculates non-destructive cut duration from actual source time ranges',()=>{
    const cut=spec()
    expect(timelineDuration(cut)).toBe(7)
    expect(cut.clips[0]).toMatchObject({source_start_seconds:1,source_end_seconds:3.5})
  })
  it('refuses zero-length or reversed individual source trims',()=>{
    const cut=spec()
    cut.clips[0]!.source_end_seconds=cut.clips[0]!.source_start_seconds
    expect(()=>timelineDuration(cut)).toThrow(/positive duration/)
  })
  it('refuses a cut longer than the short-form 60-second limit',()=>{
    const cut=spec()
    cut.clips=Array.from({length:16},()=>({master_id:'approved',source_start_seconds:0,source_end_seconds:4}))
    expect(()=>timelineDuration(cut)).toThrow(/at most|between 0.5 and 60/)
  })
  it('requires at least one real video master and no more than sixteen',()=>{
    expect(MotionTimelineInput.safeParse({...spec(),clips:[]}).success).toBe(false)
    expect(MotionTimelineInput.safeParse({
      ...spec(),clips:Array.from({length:17},()=>({master_id:'A',source_start_seconds:0,source_end_seconds:1})),
    }).success).toBe(false)
  })
  it('preserves the ordered timeline after schema round-trip',()=>{
    const cut=spec()
    expect(MotionTimelineInput.parse(JSON.parse(JSON.stringify(cut)))).toEqual(cut)
  })
})
