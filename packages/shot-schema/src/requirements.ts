import type { CanonicalShot } from './shot.js'
import { frameSize, type AspectRatio, type GenerationMode, type TargetResolution } from './enums.js'

/**
 * The provider-agnostic capability demand implied by a shot.
 *
 * This is the contract between the creative side of the system and the routing
 * side: the router never reads a shot's prose, only these derived requirements.
 */
export interface ShotRequirements {
  mode: GenerationMode
  durationSeconds: number
  resolution: TargetResolution
  aspectRatio: AspectRatio
  fps: number
  width: number
  height: number
  needsNativeAudio: boolean
  needsDialogue: boolean
  needsFirstFrame: boolean
  needsLastFrame: boolean
  needsVideoReference: boolean
  needsExtension: boolean
  referenceImageCount: number
  /** Identity work raises the cost of a cheap-but-drifty model. */
  identityCritical: boolean
  continuityCritical: boolean
  actionComplexity: number
  cameraComplexity: number
  requiresHumanApproval: boolean
}

const MOVEMENT_COMPLEXITY: Array<[RegExp, number]> = [
  [/\b(lock(ed)?[- ]?off|static|still|fixed)\b/i, 0.05],
  [/\b(slow )?(push|pull|dolly|truck|track)\b/i, 0.45],
  [/\b(pan|tilt)\b/i, 0.3],
  [/\bhandheld\b/i, 0.6],
  [/\b(crane|jib|boom)\b/i, 0.7],
  [/\b(steadicam|gimbal|follow)\b/i, 0.6],
  [/\b(orbit|arc|circle|360)\b/i, 0.8],
  [/\b(whip|snap|crash|smash)\b/i, 0.9],
  [/\b(vehicle|car[- ]?mount|drone|aerial)\b/i, 0.75],
]

// Verbs are written in stem form; `VERB_SUFFIX` covers the inflections that
// appear in real shot lists ("she spins", "throwing the jacket").
const VERB_SUFFIX = '(?:s|es|ed|ing)?'
const ACTION_COMPLEXITY: Array<[RegExp, number]> = [
  [new RegExp(`\\b(stand|sit|hold|stare|gaze|look)${VERB_SUFFIX}\\b`, 'i'), 0.2],
  [new RegExp(`\\b(walk|step|turn|lean|reach)${VERB_SUFFIX}\\b`, 'i'), 0.4],
  [new RegExp(`\\b(pour|splash|smoke|flame|water|rain)${VERB_SUFFIX}\\b`, 'i'), 0.7],
  [/\b(hands?|fingers?|grips?)\b/i, 0.6],
  [new RegExp(`\\b(danc|spin|jump|run|throw|catch|swing)${VERB_SUFFIX}\\b`, 'i'), 0.75],
  [new RegExp(`\\b(fight|fall|crash|explod|shatter|collid)${VERB_SUFFIX}\\b`, 'i'), 0.95],
]

function scoreText(text: string, table: Array<[RegExp, number]>, base: number): number {
  let score = base
  for (const [pattern, weight] of table) {
    if (pattern.test(text)) score = Math.max(score, weight)
  }
  return Math.min(1, score)
}

export function deriveRequirements(shot: CanonicalShot): ShotRequirements {
  const { width, height } = frameSize(shot.target_resolution, shot.aspect_ratio)
  const referenceImages = new Set(shot.source_assets)
  if (shot.first_frame_asset) referenceImages.add(shot.first_frame_asset)
  if (shot.last_frame_asset) referenceImages.add(shot.last_frame_asset)

  const identityCritical =
    shot.identity_locks.some((lock) => lock.strength === 'strict') ||
    shot.wardrobe_locks.some((lock) => lock.strength === 'strict') ||
    shot.shot_category === 'portrait'

  const continuityCritical =
    shot.continuity_from_shot !== null ||
    shot.continuity_to_shot !== null ||
    shot.first_frame_asset !== null ||
    shot.last_frame_asset !== null ||
    shot.routing_profile === 'CONTINUITY'

  return {
    mode: shot.generation_mode,
    durationSeconds: shot.duration_seconds,
    resolution: shot.target_resolution,
    aspectRatio: shot.aspect_ratio,
    fps: shot.fps,
    width,
    height,
    needsNativeAudio: shot.audio_mode === 'native_generated' || shot.audio_mode === 'native_dialogue',
    needsDialogue: shot.audio_mode === 'native_dialogue' && shot.dialogue.trim().length > 0,
    needsFirstFrame: shot.first_frame_asset !== null || shot.generation_mode === 'first_last_frame',
    needsLastFrame: shot.last_frame_asset !== null,
    needsVideoReference: shot.reference_video_assets.length > 0 || shot.generation_mode === 'video_to_video',
    needsExtension: shot.generation_mode === 'video_extend',
    referenceImageCount: referenceImages.size,
    identityCritical,
    continuityCritical,
    actionComplexity: scoreText(`${shot.action} ${shot.performance_direction} ${shot.blocking}`, ACTION_COMPLEXITY, 0.3),
    cameraComplexity: scoreText(`${shot.camera_movement} ${shot.camera_position}`, MOVEMENT_COMPLEXITY, 0.2),
    requiresHumanApproval:
      shot.routing_profile === 'HERO' ||
      shot.approval_requirements.includes('human_review_required') ||
      shot.approval_requirements.includes('director_approval') ||
      shot.approval_requirements.includes('client_approval'),
  }
}

/**
 * The creative facts a compiled prompt may never contradict.
 *
 * The prompt compiler is allowed to rephrase, reorder, and truncate — but every
 * string in here must survive into the compiled prompt verbatim or the compile
 * is rejected. That check is what stops a "shorten this for model X" step from
 * quietly changing a character's wardrobe.
 */
export interface LockedFacts {
  identities: string[]
  wardrobe: string[]
  props: string[]
  environment: string | null
  negatives: string[]
  /** Everything above, flattened, for the compiler's verification pass. */
  all: string[]
}

export function extractLockedFacts(shot: CanonicalShot): LockedFacts {
  const identities = shot.identity_locks
    .filter((lock) => lock.strength === 'strict')
    .map((lock) => [lock.character_key, ...lock.must_match].filter(Boolean).join(' — '))
  const wardrobe = shot.wardrobe_locks
    .filter((lock) => lock.strength === 'strict')
    .map((lock) => [lock.item, lock.detail].filter(Boolean).join(' — '))
  const props = shot.prop_locks
    .filter((lock) => lock.strength === 'strict')
    .map((lock) => [lock.prop, lock.detail].filter(Boolean).join(' — '))
  const environment =
    shot.environment_lock && shot.environment_lock.strength === 'strict' ? shot.environment_lock.environment_key : null
  const negatives = [...shot.negative_constraints]

  return {
    identities,
    wardrobe,
    props,
    environment,
    negatives,
    all: [...identities, ...wardrobe, ...props, ...(environment ? [environment] : [])].filter((s) => s.length > 0),
  }
}
