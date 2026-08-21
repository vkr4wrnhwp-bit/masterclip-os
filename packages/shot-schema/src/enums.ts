import { z } from 'zod/v4'

/**
 * Generation modes, normalized across providers. Adapters declare which of
 * these they support; the router will not offer a model that cannot perform
 * the mode a shot asks for.
 */
export const GenerationMode = z.enum([
  'text_to_video',
  'image_to_video',
  'first_last_frame',
  'reference_to_video',
  'video_to_video',
  'video_extend',
])
export type GenerationMode = z.infer<typeof GenerationMode>

export const AspectRatio = z.enum(['16:9', '9:16', '1:1', '4:5', '4:3', '3:4', '21:9', '2.39:1'])
export type AspectRatio = z.infer<typeof AspectRatio>

export const TargetResolution = z.enum(['480p', '540p', '720p', '1080p', '1440p', '2160p'])
export type TargetResolution = z.infer<typeof TargetResolution>

export const AudioMode = z.enum(['none', 'native_generated', 'native_dialogue', 'ambient_only', 'post_production'])
export type AudioMode = z.infer<typeof AudioMode>

/**
 * Routing profiles are the shot's *intent*, not a model choice. The router maps
 * a profile plus the shot's hard requirements onto an actual model, which is
 * what lets a project switch providers without rewriting its shot list.
 */
export const RoutingProfile = z.enum([
  'STORYBOARD',
  'DRAFT_MOTION',
  'BALANCED',
  'HERO',
  'CONTINUITY',
  'NATIVE_AUDIO',
  'VIDEO_EDIT',
  'SELF_HOSTED_DRAFT',
])
export type RoutingProfile = z.infer<typeof RoutingProfile>

export const ScreenDirection = z.enum([
  'left_to_right',
  'right_to_left',
  'toward_camera',
  'away_from_camera',
  'static',
  'unspecified',
])
export type ScreenDirection = z.infer<typeof ScreenDirection>

/** Drives acceptance statistics: a model good at portraits may be bad at action. */
export const ShotCategory = z.enum([
  'performance',
  'portrait',
  'action',
  'product',
  'environment',
  'insert_detail',
  'transition',
  'crowd',
  'vehicle',
  'abstract',
])
export type ShotCategory = z.infer<typeof ShotCategory>

export const LockStrength = z.enum(['strict', 'guided'])
export type LockStrength = z.infer<typeof LockStrength>

export const ApprovalRequirement = z.enum([
  'human_review_required',
  'director_approval',
  'client_approval',
  'legal_clearance',
  'identity_verification',
  'continuity_check',
])
export type ApprovalRequirement = z.infer<typeof ApprovalRequirement>

/**
 * The rejection taxonomy. Fixed rather than free text because it is the input
 * to routing: "this model drifts identity" is only learnable if everyone
 * records drift the same way.
 */
export const RejectionReason = z.enum([
  'character_drift',
  'wrong_face',
  'wrong_wardrobe',
  'wrong_camera',
  'too_static',
  'too_much_motion',
  'artificial_lighting',
  'ai_appearance',
  'bad_hands',
  'bad_physics',
  'weak_narrative',
  'wrong_environment',
  'poor_framing',
  'texture_flicker',
  'not_commercially_usable',
  'technical_failure',
  'other',
])
export type RejectionReason = z.infer<typeof RejectionReason>

export const RESOLUTION_PIXELS: Record<TargetResolution, { width: number; height: number }> = {
  '480p': { width: 854, height: 480 },
  '540p': { width: 960, height: 540 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
}

export const ASPECT_VALUES: Record<AspectRatio, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '21:9': 21 / 9,
  '2.39:1': 2.39,
}

/**
 * Frame size for a resolution/aspect pair, rounded to even numbers for H.264.
 *
 * The resolution label names the **short edge**, which is the industry
 * convention in both orientations: "1080p" landscape is 1920×1080 and "1080p"
 * vertical is 1080×1920. Treating the label as the height in both cases would
 * make every vertical delivery silently low-resolution.
 */
export function frameSize(resolution: TargetResolution, aspect: AspectRatio): { width: number; height: number } {
  const shortEdge = RESOLUTION_PIXELS[resolution].height
  const ratio = ASPECT_VALUES[aspect]
  const even = (value: number) => Math.round(value / 2) * 2

  if (ratio >= 1) {
    // Landscape or square: the short edge is the height.
    return { width: even(shortEdge * ratio), height: even(shortEdge) }
  }
  // Portrait: the short edge is the width.
  return { width: even(shortEdge), height: even(shortEdge / ratio) }
}
