import { describe, expect, it } from 'vitest'
import { proposeFirstCut } from '@masterclip/shot-schema'

const base = () => ({
  name:'Artist first cut', audio_asset_id:'authorized-song',
  song_start_seconds:4,target_seconds:12,pacing:'balanced' as const,
  sources:[
    {master_id:'approved-one',duration_seconds:4},
    {master_id:'approved-two',duration_seconds:5},
  ],
  beats:Array.from({length:40},(_,i)=>i*.5),
  beat_confidence:.9,
})

describe('MOTION Auto-Assembly Director',()=>{
  it('proposes a bounded, ordered, editable sequence with measured beat cuts',()=>{
    const draft=proposeFirstCut(base())
    expect(draft.spec.clips.length).toBeGreaterThan(1)
    expect(draft.spec.clips.length).toBeLessThanOrEqual(16)
    expect(draft.durationSeconds).toBeLessThanOrEqual(12)
    expect(draft.beatAligned).toBe(true)
    expect(draft.spec.clips.map(c=>c.master_id).slice(0,2)).toEqual(['approved-one','approved-two'])
    expect(draft.warnings.join(' ')).toMatch(/editable/)
  })
  it('makes an even-pacing proposal when analysis is inconclusive',()=>{
    const draft=proposeFirstCut({...base(),beats:[],beat_confidence:0})
    expect(draft.beatAligned).toBe(false)
    expect(draft.warnings.join(' ')).toMatch(/No reliable beat grid/)
  })
  it('never suggests source trims beyond approved video length',()=>{
    const draft=proposeFirstCut({
      ...base(),target_seconds:18,pacing:'measured',
      sources:[{master_id:'short',duration_seconds:1.1}],
    })
    expect(draft.spec.clips.every(c=>c.source_end_seconds<=1.1)).toBe(true)
    expect(draft.durationSeconds).toBeLessThanOrEqual(18)
  })
  it('rejects missing approved sources or invalid target durations',()=>{
    expect(()=>proposeFirstCut({...base(),sources:[]})).toThrow()
    expect(()=>proposeFirstCut({...base(),target_seconds:61})).toThrow()
  })
  it('never mutates the approved sources provided to the planner',()=>{
    const input=base()
    const before=JSON.stringify(input)
    proposeFirstCut(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
