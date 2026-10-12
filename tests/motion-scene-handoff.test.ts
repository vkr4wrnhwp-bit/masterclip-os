import { describe, expect, it } from 'vitest'
import { ReviewedSceneHandoff, handoffShotKey, toCanonicalSceneShot, validateShot } from '@masterclip/shot-schema'

const input=()=>({
  requestId:'8f63fa25-cbbb-4d19-84b5-a7d1a931b71f',
  reviewed:true as const,promotionalUseAttested:true as const,
  audioAssetId:'authorized-audio',songStartSeconds:12,songEndSeconds:16.5,
  title:'Hook – silhouette tracking',
  sectionLabel:'Artist-labelled chorus',
  narrativePurpose:'Bring the performer from shadow into the central light',
  cameraDirection:'Low-angle steady tracking shot',
  performanceDirection:'Controlled forward movement and confident performance',
  visualTreatment:'Black marble and motivated blue practicals',
  aspectRatio:'9:16' as const,
})

describe('MOTION explicit scene-to-Shot Builder handoff',()=>{
  it('maps reviewed content into an existing valid canonical text-to-video draft',()=>{
    const shot=toCanonicalSceneShot(input())
    const checked=validateShot(shot)
    expect(checked.ok).toBe(true)
    expect(shot.generation_mode).toBe('text_to_video')
    expect(shot.duration_seconds).toBe(4.5)
    expect(shot.music_cue).toMatchObject({
      asset_id:'authorized-audio',start_seconds:12,end_seconds:16.5,
      promotional_use_attested:true,
    })
    expect(shot.audio_mode).toBe('none')
    expect(shot.approval_requirements).toContain('director_approval')
    expect(shot.approval_requirements).toContain('human_review_required')
    expect(shot.candidate_count).toBe(1)
    expect(shot.camera_movement).toContain('Low-angle')
    expect(shot.performance_direction).toContain('Controlled forward movement')
    expect(shot.action).toContain('Black marble')
  })
  it('rejects missing affirmative approval or promotional use confirmation',()=>{
    expect(ReviewedSceneHandoff.safeParse({...input(),reviewed:false}).success).toBe(false)
    expect(ReviewedSceneHandoff.safeParse({...input(),promotionalUseAttested:false}).success).toBe(false)
  })
  it('uses stable request identifiers and preserves the edited source values',()=>{
    const first=toCanonicalSceneShot(input())
    const second=toCanonicalSceneShot(input())
    expect(first).toEqual(second)
    expect(first.shot_id).toBe(handoffShotKey(input().requestId))
    const changed=toCanonicalSceneShot({...input(),cameraDirection:'Locked static shot'})
    expect(changed.camera_movement).toBe('Locked static shot')
    expect(changed.shot_id).toBe(first.shot_id)
  })
  it('enforces the native song-moment range before shot creation',()=>{
    expect(()=>toCanonicalSceneShot({...input(),songEndSeconds:12.3})).toThrow()
    expect(()=>toCanonicalSceneShot({...input(),songEndSeconds:74})).toThrow()
    expect(ReviewedSceneHandoff.safeParse({...input(),requestId:'not-a-uuid'}).success).toBe(false)
  })
})
