import { describe,expect,it } from 'vitest'
import { validateMusicSections,sectionAt } from '@masterclip/shot-schema'

const sample=()=>[
  {id:'a',label:'Intro',kind:'intro' as const,start_seconds:0,end_seconds:8},
  {id:'b',label:'First verse',kind:'verse' as const,start_seconds:8,end_seconds:24},
  {id:'c',label:'First chorus',kind:'chorus' as const,start_seconds:24,end_seconds:40},
]

describe('MOTION artist-authoritative song sections',()=>{
  it('accepts explicit chronological section markers and locates labels',()=>{
    const sections=validateMusicSections(sample(),65)
    expect(sectionAt(sections,25)?.kind).toBe('chorus')
    expect(sectionAt(sections,62)).toBeNull()
  })
  it('refuses overlaps, duplicate IDs, negative and out-of-track timing',()=>{
    expect(()=>validateMusicSections([{...sample()[0]!,end_seconds:10},sample()[1]!],65)).toThrow()
    expect(()=>validateMusicSections([sample()[0]!,{...sample()[1]!,id:'a'}],65)).toThrow()
    expect(()=>validateMusicSections([{...sample()[0]!,end_seconds:70}],65)).toThrow()
    expect(()=>validateMusicSections([{...sample()[0]!,start_seconds:-1}],65)).toThrow()
  })
  it('never invents verse/chorus labels from decoded beats',()=>{
    expect(sectionAt([],10)).toBeNull()
    expect(validateMusicSections([],120)).toEqual([])
  })
})
