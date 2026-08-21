import { CanonicalShot, type CanonicalShotInput } from './shot.js'

export interface ValidationIssue {
  path: string
  message: string
  severity: 'error' | 'warning'
  code: string
}

export interface ShotValidation {
  ok: boolean
  shot: CanonicalShot | null
  issues: ValidationIssue[]
}

/**
 * Two-stage validation.
 *
 * Stage 1 is the zod schema: shape and ranges. Stage 2 is the semantic rules
 * that a type system cannot express — a `first_last_frame` shot with no last
 * frame parses fine and is still meaningless, and finding that out from a
 * provider's 422 costs a round trip and sometimes a charge.
 */
export function validateShot(input: CanonicalShotInput | unknown): ShotValidation {
  const parsed = CanonicalShot.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      shot: null,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
        severity: 'error' as const,
        code: `schema.${issue.code}`,
      })),
    }
  }

  const shot = parsed.data
  const issues: ValidationIssue[] = []
  const error = (path: string, code: string, message: string) =>
    issues.push({ path, code, message, severity: 'error' })
  const warn = (path: string, code: string, message: string) =>
    issues.push({ path, code, message, severity: 'warning' })

  // --- inputs required by the generation mode -------------------------------
  switch (shot.generation_mode) {
    case 'image_to_video':
      if (!shot.first_frame_asset && shot.source_assets.length === 0) {
        error('source_assets', 'mode.missing_source_image', 'image_to_video requires a source image or first_frame_asset')
      }
      break
    case 'first_last_frame':
      if (!shot.first_frame_asset) error('first_frame_asset', 'mode.missing_first_frame', 'first_last_frame requires first_frame_asset')
      if (!shot.last_frame_asset) error('last_frame_asset', 'mode.missing_last_frame', 'first_last_frame requires last_frame_asset')
      break
    case 'video_to_video':
    case 'video_extend':
      if (shot.reference_video_assets.length === 0) {
        error('reference_video_assets', 'mode.missing_source_video', `${shot.generation_mode} requires at least one reference video`)
      }
      break
    case 'reference_to_video':
      if (shot.source_assets.length === 0) {
        error('source_assets', 'mode.missing_references', 'reference_to_video requires at least one reference asset')
      }
      break
    case 'text_to_video':
      if (shot.action.trim().length === 0 && shot.narrative_purpose.trim().length === 0) {
        error('action', 'mode.empty_prompt', 'text_to_video requires an action or narrative purpose to describe')
      }
      if (shot.identity_locks.some((lock) => lock.strength === 'strict')) {
        warn(
          'identity_locks',
          'mode.identity_without_reference',
          'strict identity locks on a text_to_video shot cannot be enforced by any current model — use image_to_video or reference_to_video',
        )
      }
      break
  }

  // --- audio ----------------------------------------------------------------
  if (shot.audio_mode === 'native_dialogue' && shot.dialogue.trim().length === 0) {
    error('dialogue', 'audio.missing_dialogue', 'native_dialogue requires dialogue text')
  }
  if (shot.audio_mode === 'none' && shot.dialogue.trim().length > 0) {
    warn('dialogue', 'audio.dialogue_ignored', 'dialogue is set but audio_mode is none — the dialogue will not be generated')
  }

  // --- continuity -----------------------------------------------------------
  if (shot.continuity_from_shot && shot.continuity_from_shot === shot.shot_id) {
    error('continuity_from_shot', 'continuity.self_reference', 'a shot cannot continue from itself')
  }
  if (shot.continuity_from_shot && !shot.first_frame_asset && shot.generation_mode === 'text_to_video') {
    warn(
      'continuity_from_shot',
      'continuity.unenforceable',
      'continuity is declared but no first frame is supplied — nothing enforces the match',
    )
  }

  // --- routing and budget ---------------------------------------------------
  if (shot.routing_profile === 'NATIVE_AUDIO' && shot.audio_mode === 'none') {
    error('routing_profile', 'routing.audio_mismatch', 'NATIVE_AUDIO profile requires an audio mode other than none')
  }
  if (shot.routing_profile === 'VIDEO_EDIT' && shot.generation_mode !== 'video_to_video' && shot.generation_mode !== 'video_extend') {
    warn('routing_profile', 'routing.edit_mismatch', 'VIDEO_EDIT profile normally pairs with video_to_video or video_extend')
  }
  if (shot.routing_profile === 'HERO' && shot.candidate_count > 4) {
    warn('candidate_count', 'routing.expensive_hero_batch', `${shot.candidate_count} HERO candidates will be expensive — consider drafting first`)
  }
  if (shot.max_cost_usd <= 0) {
    error('max_cost_usd', 'budget.zero_cap', 'max_cost_usd must be greater than zero')
  }

  const excluded = new Set(shot.excluded_models)
  const conflicting = shot.preferred_models.filter((m) => excluded.has(m))
  if (conflicting.length > 0) {
    error('preferred_models', 'routing.conflicting_models', `models both preferred and excluded: ${conflicting.join(', ')}`)
  }

  // --- craft warnings -------------------------------------------------------
  if (shot.lighting.dominant_source.trim().length === 0) {
    warn('lighting.dominant_source', 'craft.no_motivated_light', 'no dominant light source declared — output will tend toward flat global illumination')
  }
  if (shot.camera_position.trim().length === 0) {
    warn('camera_position', 'craft.no_camera_position', 'no camera position declared — framing will be arbitrary')
  }
  if (shot.duration_seconds > 10 && shot.routing_profile !== 'VIDEO_EDIT') {
    warn('duration_seconds', 'craft.long_single_generation', 'most current models degrade past ~10s in a single generation; consider chaining with CONTINUITY')
  }

  return { ok: issues.every((i) => i.severity !== 'error'), shot, issues }
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.path}: ${i.message} [${i.code}]`).join('\n')
}
