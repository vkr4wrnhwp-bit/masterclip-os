import { z } from 'zod/v4'
import { MotionTimelineInput, timelineDuration } from './timeline.js'
import { MusicSection, sectionAt, validateMusicSections } from './music-sections.js'

export const AutoAssemblyInput = z.object({
  name: z.string().trim().min(1).max(120).default('Suggested first cut'),
  audio_asset_id: z.string().min(1),
  song_start_seconds: z.number().finite().min(0),
  target_seconds: z.number().finite().min(2).max(60),
  pacing: z.enum(['measured', 'balanced', 'energetic']).default('balanced'),
  sources: z.array(z.object({
    master_id: z.string().min(1),
    duration_seconds: z.number().finite().min(.5).max(120),
  })).min(1).max(16),
  beats: z.array(z.number().finite().min(0)).max(1500).default([]),
  beat_confidence: z.number().finite().min(0).max(1).default(0),
  sections: z.array(MusicSection).max(32).default([]),
})
export type AutoAssemblyInput = z.infer<typeof AutoAssemblyInput>

/**
 * Predictable, reversible editing suggestion — no video creation, AI provider,
 * section detection, charge or publication. Source validations belong to the
 * API and are repeated when the user saves and later renders the edit.
 */
export function proposeFirstCut(raw: AutoAssemblyInput) {
  const input = AutoAssemblyInput.parse(raw)
  const target = input.target_seconds
  const sectionExtent = Math.max(input.song_start_seconds + target, ...input.sections.map(s => s.end_seconds))
  const sections = validateMusicSections(input.sections, sectionExtent)
  const usefulBeats = input.beat_confidence >= .3
    ? [...new Set(input.beats)].filter(t => t >= input.song_start_seconds && t <= input.song_start_seconds + target).sort((a,b)=>a-b)
    : []
  const intended = input.pacing === 'energetic' ? 1.5 : input.pacing === 'measured' ? 4 : 2.5
  const sources = input.sources
  const clips: Array<{master_id:string;source_start_seconds:number;source_end_seconds:number}> = []
  let elapsed=0
  while(elapsed < target - .49 && clips.length < 16) {
    const position=clips.length
    const source=sources[position % sources.length]!
    const remaining=target-elapsed
    const absoluteStart=input.song_start_seconds+elapsed
    const section=sectionAt(sections,absoluteStart)
    const sectionalPace=section?.kind==='chorus' ? 1.2 : section?.kind==='bridge' ? 3.5 : section?.kind==='verse' ? 2.8 : section?.kind==='intro' ? 4 : null
    const maxLength=Math.min(remaining,source.duration_seconds,60,
      section ? Math.max(.5,section.end_seconds-absoluteStart) : 60)
    if(maxLength < .5) break
    let planned=Math.min(sectionalPace??intended,maxLength)
    if(section) planned=Math.min(planned, section.end_seconds-absoluteStart)
    if(usefulBeats) {
      const absolute=input.song_start_seconds+elapsed+planned
      const candidates=usefulBeats.filter(b => {
        const length=b-input.song_start_seconds-elapsed
        return length >= .5 && length <= maxLength &&
          (!section || b <= section.end_seconds)
      })
      if(candidates.length) {
        const closest=candidates.reduce((a,b)=>Math.abs(a-absolute) <= Math.abs(b-absolute)?a:b)
        planned=closest-input.song_start_seconds-elapsed
      }
    }
    planned=Number(Math.max(.5,Math.min(maxLength,planned)).toFixed(3))
    clips.push({
      master_id:source.master_id,
      source_start_seconds:0,
      source_end_seconds:planned,
    })
    elapsed=Number((elapsed+planned).toFixed(3))
  }
  const spec=MotionTimelineInput.parse({
    name:input.name,audio_asset_id:input.audio_asset_id,
    song_start_seconds:input.song_start_seconds,clips,
  })
  const actualDuration=timelineDuration(spec)
  return {
    spec,
    durationSeconds:actualDuration,
    targetSeconds:target,
    beatAligned:usefulBeats.length>0,
    confidence:input.beat_confidence,
    structureUsed:sections.length>0,
    structureNotes:sections.length>0 ? 'User-authored song sections influenced cut pacing; no automatic structural detection.' : null,
    warnings:[
      'Suggested cuts are editable choices, not an automatically approved or rendered video.',
      ...(usefulBeats.length ? [] : ['No reliable beat grid; used even pacing instead.']),
      ...(actualDuration < target-.1 ? ['Cut is shorter than the requested target because of source/clip limits.'] : []),
    ],
  }
}
