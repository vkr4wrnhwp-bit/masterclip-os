import type { ShotRequirements } from '@masterclip/shot-schema'
import type { CanonicalRenderRequest, ModelCapabilities, NormalizedModel, ValidationResult } from './types.js'

export interface CapabilityMismatch {
  field: string
  required: string
  supported: string
  /** `hard` means the model cannot do it at all; `soft` means it will be coerced. */
  severity: 'hard' | 'soft'
}

/**
 * Checks a shot's derived requirements against a model's declared capabilities.
 *
 * Every mismatch is reported rather than short-circuiting on the first, because
 * the UI shows this as "why can't I use this model" and one reason at a time is
 * a bad answer.
 */
export function matchCapabilities(requirements: ShotRequirements, capabilities: ModelCapabilities): CapabilityMismatch[] {
  const mismatches: CapabilityMismatch[] = []

  if (!capabilities.modes.includes(requirements.mode)) {
    mismatches.push({
      field: 'generation_mode',
      required: requirements.mode,
      supported: capabilities.modes.join(', '),
      severity: 'hard',
    })
  }

  const duration = capabilities.duration
  if (requirements.durationSeconds < duration.minSeconds || requirements.durationSeconds > duration.maxSeconds) {
    mismatches.push({
      field: 'duration_seconds',
      required: `${requirements.durationSeconds}s`,
      supported: `${duration.minSeconds}–${duration.maxSeconds}s`,
      severity: 'hard',
    })
  } else if (duration.allowedSeconds && !duration.allowedSeconds.includes(requirements.durationSeconds)) {
    mismatches.push({
      field: 'duration_seconds',
      required: `${requirements.durationSeconds}s`,
      supported: duration.allowedSeconds.map((s) => `${s}s`).join(', '),
      severity: 'soft',
    })
  }

  if (!capabilities.resolutions.includes(requirements.resolution)) {
    mismatches.push({
      field: 'target_resolution',
      required: requirements.resolution,
      supported: capabilities.resolutions.join(', '),
      // Resolution can be produced by rendering lower and finishing upward only
      // with real quality loss, so this is a hard stop, not a coercion.
      severity: 'hard',
    })
  }

  if (!capabilities.aspectRatios.includes(requirements.aspectRatio)) {
    mismatches.push({
      field: 'aspect_ratio',
      required: requirements.aspectRatio,
      supported: capabilities.aspectRatios.join(', '),
      severity: 'hard',
    })
  }

  if (capabilities.fps.length > 0 && !capabilities.fps.includes(requirements.fps)) {
    mismatches.push({
      field: 'fps',
      required: `${requirements.fps}`,
      supported: capabilities.fps.join(', '),
      severity: 'soft',
    })
  }

  if (requirements.needsNativeAudio && !capabilities.nativeAudio) {
    mismatches.push({ field: 'audio_mode', required: 'native audio', supported: 'silent only', severity: 'hard' })
  }
  if (requirements.needsDialogue && !capabilities.dialogue) {
    mismatches.push({ field: 'dialogue', required: 'generated dialogue', supported: 'not supported', severity: 'hard' })
  }
  if (requirements.needsFirstFrame && !capabilities.firstFrame) {
    mismatches.push({ field: 'first_frame_asset', required: 'first-frame control', supported: 'not supported', severity: 'hard' })
  }
  if (requirements.needsLastFrame && !capabilities.lastFrame) {
    mismatches.push({ field: 'last_frame_asset', required: 'last-frame control', supported: 'not supported', severity: 'hard' })
  }
  if (requirements.needsVideoReference && !capabilities.videoReference) {
    mismatches.push({ field: 'reference_video_assets', required: 'video reference', supported: 'not supported', severity: 'hard' })
  }
  if (requirements.needsExtension && !capabilities.extension) {
    mismatches.push({ field: 'generation_mode', required: 'video extension', supported: 'not supported', severity: 'hard' })
  }
  if (requirements.referenceImageCount > capabilities.maxReferenceImages) {
    mismatches.push({
      field: 'source_assets',
      required: `${requirements.referenceImageCount} reference images`,
      supported: `${capabilities.maxReferenceImages} max`,
      severity: 'soft',
    })
  }

  return mismatches
}

export function isCompatible(requirements: ShotRequirements, capabilities: ModelCapabilities): boolean {
  return matchCapabilities(requirements, capabilities).every((m) => m.severity !== 'hard')
}

export function filterCompatibleModels(requirements: ShotRequirements, models: NormalizedModel[]): NormalizedModel[] {
  return models.filter((model) => model.enabled && isCompatible(requirements, model.capabilities))
}

/**
 * Request-level validation used by adapters' `validate()`. Soft mismatches are
 * reported as adjustments so a caller can see that 8s became 10s *before* being
 * billed for 10.
 */
export function validateAgainstCapabilities(
  request: CanonicalRenderRequest,
  capabilities: ModelCapabilities,
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const adjustments: ValidationResult['adjustments'] = []

  if (!capabilities.modes.includes(request.mode)) {
    errors.push(`mode ${request.mode} is not supported (supports: ${capabilities.modes.join(', ')})`)
  }
  if (!capabilities.resolutions.includes(request.resolution)) {
    errors.push(`resolution ${request.resolution} is not supported (supports: ${capabilities.resolutions.join(', ')})`)
  }
  if (!capabilities.aspectRatios.includes(request.aspectRatio)) {
    errors.push(`aspect ratio ${request.aspectRatio} is not supported (supports: ${capabilities.aspectRatios.join(', ')})`)
  }

  const snapped = snapDuration(request.durationSeconds, capabilities)
  if (snapped === null) {
    errors.push(
      `duration ${request.durationSeconds}s is outside the supported range ${capabilities.duration.minSeconds}–${capabilities.duration.maxSeconds}s`,
    )
  } else if (snapped !== request.durationSeconds) {
    adjustments.push({
      field: 'durationSeconds',
      from: `${request.durationSeconds}`,
      to: `${snapped}`,
      reason: 'provider only accepts discrete durations',
    })
  }

  if (request.audio.mode !== 'none' && request.audio.mode !== 'post_production' && !capabilities.nativeAudio) {
    errors.push('model cannot generate audio')
  }
  if (request.inputs.firstFrame && !capabilities.firstFrame) errors.push('model does not accept a first frame')
  if (request.inputs.lastFrame && !capabilities.lastFrame) errors.push('model does not accept a last frame')
  if (request.inputs.video && !capabilities.videoReference) errors.push('model does not accept a video reference')

  if (request.inputs.references.length > capabilities.maxReferenceImages) {
    adjustments.push({
      field: 'inputs.references',
      from: `${request.inputs.references.length}`,
      to: `${capabilities.maxReferenceImages}`,
      reason: 'provider reference-image limit',
    })
    warnings.push(
      `only the ${capabilities.maxReferenceImages} highest-priority references will be sent; identity accuracy may drop`,
    )
  }

  if (request.prompt.length > capabilities.maxPromptChars) {
    adjustments.push({
      field: 'prompt',
      from: `${request.prompt.length} chars`,
      to: `${capabilities.maxPromptChars} chars`,
      reason: 'provider prompt length limit',
    })
    warnings.push('prompt exceeds the provider limit and will be compressed by the prompt compiler')
  }

  if (request.seed && !capabilities.seed) {
    warnings.push('model ignores seeds — repeat runs will not be reproducible')
  }
  if (request.negativePrompt.length > 0 && !capabilities.negativePrompt) {
    warnings.push('model has no negative prompt field — constraints will be folded into the positive prompt')
  }

  return { ok: errors.length === 0, errors, warnings, adjustments }
}

/** Nearest provider-legal duration, or null when out of range entirely. */
export function snapDuration(seconds: number, capabilities: ModelCapabilities): number | null {
  const { minSeconds, maxSeconds, allowedSeconds, step } = capabilities.duration
  // Snapping is for choosing between legal values, never for dragging an
  // out-of-range request into range: a 999s ask is a rejection, not a 10s clip.
  if (seconds < minSeconds || seconds > maxSeconds) return null
  if (allowedSeconds && allowedSeconds.length > 0) {
    const within = allowedSeconds.filter((s) => s >= minSeconds && s <= maxSeconds)
    if (within.length === 0) return null
    // Prefer the closest legal value; ties go to the longer one so a shot is
    // never silently shortened below what the edit needs.
    return within.reduce((best, candidate) =>
      Math.abs(candidate - seconds) < Math.abs(best - seconds) ||
      (Math.abs(candidate - seconds) === Math.abs(best - seconds) && candidate > best)
        ? candidate
        : best,
    )
  }
  if (step && step > 0) {
    const snapped = Math.round((seconds - minSeconds) / step) * step + minSeconds
    return Math.min(maxSeconds, Math.max(minSeconds, Number(snapped.toFixed(3))))
  }
  return seconds
}
