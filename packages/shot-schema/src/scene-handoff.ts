import { z } from 'zod/v4'
import { emptyShot, type CanonicalShot } from './shot.js'

/** Explicitly human-reviewed planning data. This is NOT a render request.
 * The user can revise every field before choosing "Create draft shot".
 */
export const ReviewedSceneHandoff = z.object({
  requestId: z.uuid(),
  reviewed: z.literal(true),
  promotionalUseAttested: z.literal(true),
  audioAssetId: z.string().min(1),
  songStartSeconds: z.number().finite().min(0),
  songEndSeconds: z.number().finite().positive(),
  title: z.string().trim().min(1).max(120),
  sectionLabel: z.string().trim().min(1).max(60),
  narrativePurpose: z.string().trim().min(1).max(1400),
  cameraDirection: z.string().trim().min(1).max(500),
  performanceDirection: z.string().trim().min(1).max(500),
  visualTreatment: z.string().trim().min(1).max(500),
  aspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']).default('9:16'),
})
export type ReviewedSceneHandoff = z.infer<typeof ReviewedSceneHandoff>

export function handoffShotKey(requestId: string): string {
  return 'PLAN-' + requestId.replace(/-/g, '').slice(0, 24).toUpperCase()
}

/** Deterministic canonical shot mapping. Preserve full pro Shot Builder tools;
 * nothing is rendered, queued or billed here. The music cue remains editing
 * metadata and is not represented as embedded audio.
 */
export function toCanonicalSceneShot(raw: ReviewedSceneHandoff): CanonicalShot {
  const input = ReviewedSceneHandoff.parse(raw)
  const seconds = input.songEndSeconds - input.songStartSeconds
  if (seconds < .5 || seconds > 60) throw new Error('song selection must last 0.5 to 60 seconds')
  return emptyShot({
    shot_id: handoffShotKey(input.requestId),
    title: input.title,
    narrative_purpose: input.narrativePurpose,
    shot_category: 'performance',
    duration_seconds: Number(seconds.toFixed(3)),
    generation_mode: 'text_to_video',
    routing_profile: 'DRAFT_MOTION',
    aspect_ratio: input.aspectRatio,
    target_resolution: '1080p',
    fps: 24,
    action: [input.narrativePurpose, 'Camera: '+input.cameraDirection,
      'Performance: '+input.performanceDirection, 'Visual treatment: '+input.visualTreatment].join('\n'),
    performance_direction: input.performanceDirection,
    camera_movement: input.cameraDirection,
    music_cue: {
      asset_id: input.audioAssetId,
      start_seconds: input.songStartSeconds,
      end_seconds: input.songEndSeconds,
      creative_look: 'cinematic',
      promotional_use_attested: true,
    },
    audio_mode: 'none',
    approval_requirements: ['human_review_required', 'director_approval'],
    candidate_count: 1,
    max_cost_usd: 2,
    notes: ['Artist-reviewed Scene Planning handoff.', 'Section: '+input.sectionLabel,
      'Original audio stays outside the generated video until verified media finishing.',
      'No provider generation, payment, license or publishing approval is granted by creating this draft.'].join('\n'),
  })
}
