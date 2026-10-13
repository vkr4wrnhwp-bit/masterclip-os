import { describe, expect, it } from 'vitest'
import { proposeFirstCut } from '@masterclip/shot-schema'

const input = () => ({
  name:'Release cut',audio_asset_id:'song-one',song_start_seconds:0,
  target_seconds:16,pacing:'balanced' as const,
  sources:[{master_id:'first',duration_seconds:8},{master_id:'second',duration_seconds:8}],
  beats:[],beat_confidence:0,
  sections:[
    {id:'verse',label:'Verse one',kind:'verse' as const,start_seconds:0,end_seconds:8},
    {id:'chorus',label:'Chorus one',kind:'chorus' as const,start_seconds:8,end_seconds:16},
  ],
})

describe('MOTION section-aware Auto-Assembly Director',()=>{
  it('picks shorter shots in an artist-labelled chorus than in a verse',()=>{
    const result=proposeFirstCut(input())
    expect(result.structureUsed).toBe(true)
    const durations = result.spec.clips.map(c=>c.source_end_seconds-c.source_start_seconds)
    const starts:number[]=[]
    let cursor=0
    for(const time of durations){starts.push(cursor);cursor+=time}
    const verse=durations.filter((_,i)=>starts[i]!<8)
    const chorus=durations.filter((_,i)=>starts[i]!>=8)
    expect(verse.length).toBeGreaterThan(0)
    expect(chorus.length).toBeGreaterThan(0)
    expect(Math.min(...verse)).toBeGreaterThan(Math.max(...chorus))
    expect(result.durationSeconds).toBeLessThanOrEqual(16)
  })
  it('never infers song structure without artist markers',()=>{
    const result=proposeFirstCut({...input(),sections:[]})
    expect(result.structureUsed).toBe(false)
    expect(result.structureNotes).toBeNull()
  })
  it('does not mutate user section labels',()=>{
    const data=input(),before=JSON.stringify(data)
    proposeFirstCut(data)
    expect(JSON.stringify(data)).toBe(before)
  })
  it('rejects contradictory or overlapping section markers',()=>{
    const data=input()
    data.sections[1]!.start_seconds=7
    expect(()=>proposeFirstCut(data)).toThrow()
  })
})
