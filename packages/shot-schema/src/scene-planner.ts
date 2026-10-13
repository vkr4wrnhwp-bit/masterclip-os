import { z } from 'zod/v4'
import { MusicSection, sectionAt, validateMusicSections } from './music-sections.js'

export const ScenePlanInput = z.object({
  audio_asset_id: z.string().min(1),
  song_start_seconds: z.number().finite().min(0),
  target_seconds: z.number().finite().min(2).max(60),
  direction: z.string().trim().min(1).max(800),
  sections: z.array(MusicSection).max(32).default([]),
  shot_count: z.number().int().min(1).max(12).default(6),
})
export type ScenePlanInput = z.infer<typeof ScenePlanInput>

export interface ScenePlanShot {
  ordinal: number
  sectionLabel: string
  sectionKind: string
  songStartSeconds: number
  songEndSeconds: number
  title: string
  narrativePurpose: string
  cameraDirection: string
  performanceDirection: string
  visualTreatment: string
  artistReviewRequired: true
}
const techniques: Record<string, { camera: string; performance: string; treatment: string }> = {
  intro: { camera:'Wide establishing composition; slow deliberate push', performance:'Introduce presence before full action', treatment:'Establish the world, silhouette and palette' },
  verse: { camera:'Medium close-up with controlled lateral motion', performance:'Prioritize expression and lyrical delivery', treatment:'Intimate detail, controlled visual progression' },
  pre_chorus: { camera:'Gradual move inward; increase foreground motion', performance:'Build anticipation and intensity', treatment:'Add contrast and emerging movement' },
  chorus: { camera:'Energetic tracking or strong low-angle composition', performance:'Full-energy hook performance', treatment:'Hero imagery, expanded staging and stronger visual contrast' },
  bridge: { camera:'Locked-off tableau or gentle orbit', performance:'Expose a change in emotional register', treatment:'Distinct setting or restrained visual reset' },
  outro: { camera:'Slow pullback to a held final frame', performance:'Resolve the performance without a sudden stop', treatment:'Visual closure referencing the opening world' },
  instrumental: { camera:'Rhythmic tracking around instrumental details', performance:'Focus on movement and musicianship', treatment:'Graphic accents, texture and physical choreography' },
  custom: { camera:'Artist-selected angle; confirm before generation', performance:'Artist-directed action', treatment:'Preserve the chosen visual world' },
}

/** One deterministic human-reviewable shot plan; no model calls, inferred
 * section labels, render spending, timeline edits or canonical shot writes.
 */
export function proposeScenePlan(input: ScenePlanInput) {
  const spec=ScenePlanInput.parse(input)
  const sections=validateMusicSections(spec.sections, Math.max(spec.song_start_seconds+spec.target_seconds,
    ...spec.sections.map(section=>section.end_seconds)))
  const sequence:ScenePlanShot[]=[]
  const interval=spec.target_seconds/spec.shot_count
  for(let index=0;index<spec.shot_count;index++){
    const start=Number((spec.song_start_seconds+index*interval).toFixed(3))
    const end=Number((spec.song_start_seconds+(index+1)*interval).toFixed(3))
    const section=sectionAt(sections,start)
    const kind=section?.kind??'custom'
    const guide=techniques[kind]??techniques.custom!
    sequence.push({
      ordinal:index+1,sectionLabel:section?.label??'Unlabelled passage',
      sectionKind:kind,songStartSeconds:start,songEndSeconds:end,
      title:`Shot ${index+1} — ${section?.label??'Artist scene'}`,
      narrativePurpose:`Interpret the artist direction for this passage: ${spec.direction}`,
      cameraDirection:guide.camera,performanceDirection:guide.performance,
      visualTreatment:guide.treatment,artistReviewRequired:true,
    })
  }
  return {
    audioAssetId:spec.audio_asset_id,shots:sequence,
    source:'artist_sections_and_direction' as const,
    requiresApproval:true as const,
    warning:'Creative camera/performance ideas only. No canonical shots created, media generated or costs incurred.',
  }
}
