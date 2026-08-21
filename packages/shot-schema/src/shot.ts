import { z } from 'zod/v4'
import {
  ApprovalRequirement,
  AspectRatio,
  AudioMode,
  GenerationMode,
  LockStrength,
  RoutingProfile,
  ScreenDirection,
  ShotCategory,
  TargetResolution,
} from './enums.js'

/**
 * The canonical shot specification: the single source of truth for what a shot
 * *is*, expressed without reference to any provider.
 *
 * Provider prompts are compiled from this and are never edited back into it.
 * That direction is the whole point — it is what allows the same shot to be
 * re-rendered on a different model years later and still mean the same thing.
 */

/** Accepts a bare string where an object is expected, so CSV/spreadsheet imports stay ergonomic. */
const looseObject = <T extends z.ZodTypeAny>(schema: T, lift: (value: string) => unknown) =>
  z.preprocess((value) => (typeof value === 'string' ? lift(value) : value), schema)

export const Subject = looseObject(
  z.object({
    /** Links to a Character Bible entry. Empty for unnamed background subjects. */
    character_key: z.string().default(''),
    description: z.string().default(''),
    role: z.enum(['primary', 'secondary', 'background']).default('primary'),
  }),
  (description) => ({ character_key: '', description, role: 'primary' }),
)
export type Subject = z.infer<typeof Subject>

export const IdentityLock = looseObject(
  z.object({
    character_key: z.string(),
    /** Pin to an exact Character Bible version. 0 means "current at render time". */
    character_version: z.number().int().min(0).default(0),
    strength: LockStrength.default('strict'),
    must_match: z.array(z.string()).default([]),
  }),
  (character_key) => ({ character_key, character_version: 0, strength: 'strict', must_match: [] }),
)
export type IdentityLock = z.infer<typeof IdentityLock>

export const WardrobeLock = looseObject(
  z.object({
    character_key: z.string().default(''),
    item: z.string(),
    detail: z.string().default(''),
    strength: LockStrength.default('strict'),
  }),
  (item) => ({ character_key: '', item, detail: '', strength: 'strict' }),
)
export type WardrobeLock = z.infer<typeof WardrobeLock>

export const PropLock = looseObject(
  z.object({
    prop: z.string(),
    detail: z.string().default(''),
    /** Continuity detail that survives across shots: which hand holds it. */
    held_by: z.string().default(''),
    hand: z.enum(['left', 'right', 'both', 'none']).default('none'),
    strength: LockStrength.default('strict'),
  }),
  (prop) => ({ prop, detail: '', held_by: '', hand: 'none', strength: 'strict' }),
)
export type PropLock = z.infer<typeof PropLock>

export const EnvironmentLock = looseObject(
  z.object({
    environment_key: z.string(),
    environment_version: z.number().int().min(0).default(0),
    strength: LockStrength.default('strict'),
  }),
  (environment_key) => ({ environment_key, environment_version: 0, strength: 'strict' }),
)
export type EnvironmentLock = z.infer<typeof EnvironmentLock>

export const Practical = looseObject(
  z.object({
    fixture: z.string(),
    position: z.string().default(''),
    color: z.string().default(''),
    intensity: z.enum(['subtle', 'moderate', 'dominant']).default('moderate'),
  }),
  (fixture) => ({ fixture, position: '', color: '', intensity: 'moderate' }),
)
export type Practical = z.infer<typeof Practical>

export const Lighting = z.object({
  /** One motivated dominant source is the project standard; see docs/cinematic-standard.md. */
  dominant_source: z.string().default(''),
  source_position: z.string().default(''),
  color_temperature: z.string().default(''),
  falloff: z.string().default(''),
  shadow_behavior: z.string().default(''),
  practicals: z.array(Practical).default([]),
})
export type Lighting = z.infer<typeof Lighting>

export const MaterialRequirement = looseObject(
  z.object({
    material: z.string(),
    behavior: z.string().default(''),
  }),
  (material) => ({ material, behavior: '' }),
)
export type MaterialRequirement = z.infer<typeof MaterialRequirement>

export const CanonicalShot = z.object({
  // --- identity ------------------------------------------------------------
  project_id: z.string().default(''),
  scene_id: z.string().default(''),
  shot_id: z.string().default(''),
  version: z.number().int().min(1).default(1),
  title: z.string().default(''),
  narrative_purpose: z.string().default(''),
  shot_category: ShotCategory.default('performance'),

  // --- format --------------------------------------------------------------
  duration_seconds: z.number().min(0.5).max(120).default(8),
  aspect_ratio: AspectRatio.default('16:9'),
  target_resolution: TargetResolution.default('1080p'),
  fps: z.number().int().min(8).max(60).default(24),
  generation_mode: GenerationMode.default('image_to_video'),

  // --- who and what is locked ---------------------------------------------
  subjects: z.array(Subject).default([]),
  identity_locks: z.array(IdentityLock).default([]),
  wardrobe_locks: z.array(WardrobeLock).default([]),
  prop_locks: z.array(PropLock).default([]),
  environment_lock: EnvironmentLock.nullable().default(null),

  // --- inputs --------------------------------------------------------------
  /** Asset ids. Role is positional-free: first/last frame have dedicated fields. */
  source_assets: z.array(z.string()).default([]),
  first_frame_asset: z.string().nullable().default(null),
  last_frame_asset: z.string().nullable().default(null),
  reference_video_assets: z.array(z.string()).default([]),

  // --- direction -----------------------------------------------------------
  performance_direction: z.string().default(''),
  action: z.string().default(''),
  blocking: z.string().default(''),
  camera_position: z.string().default(''),
  camera_movement: z.string().default(''),
  lens_mm: z.number().min(8).max(400).default(50),
  aperture: z.number().min(0.7).max(32).default(2.0),
  focus_behavior: z.string().default(''),
  lighting: Lighting.default({
    dominant_source: '',
    source_position: '',
    color_temperature: '',
    falloff: '',
    shadow_behavior: '',
    practicals: [],
  }),
  material_requirements: z.array(MaterialRequirement).default([]),
  environmental_motion: z.array(z.string()).default([]),
  physical_motion_rules: z.array(z.string()).default([]),

  // --- continuity ----------------------------------------------------------
  continuity_from_shot: z.string().nullable().default(null),
  continuity_to_shot: z.string().nullable().default(null),
  screen_direction: ScreenDirection.default('unspecified'),

  // --- audio ---------------------------------------------------------------
  audio_mode: AudioMode.default('none'),
  dialogue: z.string().default(''),
  ambient_audio: z.string().default(''),

  // --- constraints and routing --------------------------------------------
  negative_constraints: z.array(z.string()).default([]),
  preferred_models: z.array(z.string()).default([]),
  excluded_models: z.array(z.string()).default([]),
  routing_profile: RoutingProfile.default('DRAFT_MOTION'),
  candidate_count: z.number().int().min(1).max(64).default(6),
  /** Per-shot ceiling in USD. Enforced by the cost engine before submission. */
  max_cost_usd: z.number().min(0).max(10_000).default(2.0),
  approval_requirements: z.array(ApprovalRequirement).default([]),

  /** Free-form notes that never reach a prompt. */
  notes: z.string().default(''),
})

export type CanonicalShot = z.infer<typeof CanonicalShot>
export type CanonicalShotInput = z.input<typeof CanonicalShot>

export const SHOT_SCHEMA_VERSION = '1.0.0'

export function parseShot(input: unknown): CanonicalShot {
  return CanonicalShot.parse(input)
}

export function safeParseShot(input: unknown) {
  return CanonicalShot.safeParse(input)
}

/** A fully-defaulted shot, used as the starting point in the Shot Builder. */
export function emptyShot(overrides: Partial<CanonicalShotInput> = {}): CanonicalShot {
  return CanonicalShot.parse({ ...overrides })
}
