import { describe, expect, it } from 'vitest'
import { proposeScenePlan } from '@masterclip/shot-schema'

const base=()=>({
  audio_asset_id:'authorized-track',song_start_seconds:0,target_seconds:16,
  direction:'A solitary performer crossing a stark architectural world',
  shot_count:4,
  sections:[
    {id:'v',label:'First verse',kind:'verse' as const,start_seconds:0,end_seconds:8},
    {id:'c',label:'Hook',kind:'chorus' as const,start_seconds:8,end_seconds:16},
  ],
})
describe('MOTION section-aware scene planning',()=>{
  it('creates a reviewed draft with camera and performance treatments grounded in artist labels',()=>{
    const result=proposeScenePlan(base())
    expect(result.shots).toHaveLength(4)
    expect(result.shots[0]?.sectionKind).toBe('verse')
    expect(result.shots[2]?.sectionKind).toBe('chorus')
    expect(result.shots[0]?.cameraDirection).not.toBe(result.shots[2]?.cameraDirection)
    expect(result.shots.every(s=>s.artistReviewRequired)).toBe(true)
    expect(result.requiresApproval).toBe(true)
  })
  it('never invents chorus labels without user annotations',()=>{
    const result=proposeScenePlan({...base(),sections:[]})
    expect(result.shots.every(s=>s.sectionKind==='custom')).toBe(true)
  })
  it('refuses out-of-range target and overlapping section annotations',()=>{
    expect(()=>proposeScenePlan({...base(),target_seconds:61})).toThrow()
    const bad=base()
    bad.sections[1]!.start_seconds=7
    expect(()=>proposeScenePlan(bad)).toThrow()
  })
  it('is deterministic and leaves the artist directions unchanged',()=>{
    const input=base(),before=JSON.stringify(input)
    expect(proposeScenePlan(input)).toEqual(proposeScenePlan(input))
    expect(JSON.stringify(input)).toBe(before)
  })
})
