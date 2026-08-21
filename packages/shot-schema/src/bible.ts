import { z } from 'zod/v4'

/**
 * Character Bible and World Bible.
 *
 * Both are version-controlled: a render records the exact version it used, so
 * "why does she look different in shot 14" is answerable rather than arguable.
 *
 * Consent is modelled explicitly and defaults to the restrictive value.
 * Identity-preserving generation only runs against reference packs whose
 * `rights_status` is `authorized` — the system never infers permission from the
 * fact that an image was uploaded.
 */

export const RightsStatus = z.enum(['unverified', 'authorized', 'restricted', 'revoked'])
export type RightsStatus = z.infer<typeof RightsStatus>

export const ReferenceRole = z.enum([
  'face_primary',
  'face_secondary',
  'profile',
  'expression',
  'full_body',
  'hands',
  'wardrobe',
  'hair',
  'tattoo',
  'environment_wide',
  'environment_detail',
  'lighting',
  'material',
])
export type ReferenceRole = z.infer<typeof ReferenceRole>

export const BibleReference = z.object({
  asset_id: z.string(),
  role: ReferenceRole,
  /** Higher wins when a provider accepts fewer references than we hold. */
  priority: z.number().int().min(0).max(100).default(50),
  quality_rating: z.number().min(0).max(5).default(3),
  notes: z.string().default(''),
})
export type BibleReference = z.infer<typeof BibleReference>

export const CharacterRecord = z.object({
  character_key: z.string(),
  name: z.string(),
  version: z.number().int().min(1).default(1),
  rights_status: RightsStatus.default('unverified'),
  consent_notes: z.string().default(''),

  references: z.array(BibleReference).default([]),

  height_and_proportion: z.string().default(''),
  skin_tone: z.string().default(''),
  hair: z.string().default(''),
  makeup: z.string().default(''),
  wardrobe: z.array(z.string()).default([]),
  accessories: z.array(z.string()).default([]),
  hands: z.string().default(''),
  nails: z.string().default(''),
  tattoos_or_symbols: z.array(z.string()).default([]),

  performance_behavior: z.string().default(''),
  prohibited_expressions: z.array(z.string()).default([]),
  prohibited_wardrobe_changes: z.array(z.string()).default([]),
  approved_alternates: z.array(z.string()).default([]),

  locked: z.boolean().default(false),
  notes: z.string().default(''),
})
export type CharacterRecord = z.infer<typeof CharacterRecord>

export const EnvironmentRecord = z.object({
  environment_key: z.string(),
  name: z.string(),
  version: z.number().int().min(1).default(1),

  references: z.array(BibleReference).default([]),

  architectural_plan: z.string().default(''),
  primary_materials: z.array(z.string()).default([]),
  lighting_sources: z.array(z.string()).default([]),
  time_of_day: z.string().default(''),
  color_temperature: z.string().default(''),
  spatial_relationships: z.string().default(''),
  reflections: z.string().default(''),
  ground_plane: z.string().default(''),
  atmosphere: z.string().default(''),

  prohibited_changes: z.array(z.string()).default([]),
  continuity_notes: z.string().default(''),
  locked: z.boolean().default(false),
})
export type EnvironmentRecord = z.infer<typeof EnvironmentRecord>

/**
 * Project-level visual standard. The defaults below encode the locked
 * cinematic standard documented in docs/cinematic-standard.md; a project may
 * override them, but the negative constraints are appended to every compiled
 * prompt unless a shot explicitly opts out.
 */
export const StyleBible = z.object({
  visual_language: z.string().default(''),
  reference_films: z.array(z.string()).default([]),
  color_palette: z.array(z.string()).default([]),
  camera_language: z.string().default(DEFAULT_CAMERA_LANGUAGE()),
  lighting_language: z.string().default(DEFAULT_LIGHTING_LANGUAGE()),
  material_language: z.string().default(DEFAULT_MATERIAL_LANGUAGE()),
  imperfection_language: z.string().default(DEFAULT_IMPERFECTION_LANGUAGE()),
  // Lazy defaults: the constant arrays are declared below this schema, and a
  // fresh copy per parse keeps one project's edits out of another's.
  global_negative_constraints: z.array(z.string()).default(() => [...DEFAULT_NEGATIVE_CONSTRAINTS]),
  prohibited_treatments: z.array(z.string()).default(() => [...PROHIBITED_TREATMENTS]),
  enforce_cinematic_standard: z.boolean().default(true),
})
export type StyleBible = z.infer<typeof StyleBible>

function DEFAULT_CAMERA_LANGUAGE(): string {
  return 'Full-frame cinema camera. 35mm or 50mm for most shots, 85mm only where compression or portrait isolation is intentional. f/1.8–f/2.8 with real optical depth of field, natural bokeh, plausible focus breathing. Camera movement must be physically possible: dolly, handheld, crane, tracking, or vehicle mount. No floating drone moves unless explicitly requested.'
}

function DEFAULT_LIGHTING_LANGUAGE(): string {
  return 'One dominant motivated light source — neon, practical, architectural, or environmental. Natural falloff, realistic exposure, true shadow depth, environmental bounce, and correct subject-to-background light interaction.'
}

function DEFAULT_MATERIAL_LANGUAGE(): string {
  return 'Materials stay physically separate and correct: skin with pores, tonal variation and subsurface behaviour; fabric with weave, weight, seams, folds and friction; leather and latex with correct specular response and creasing; metal with imperfect reflections and wear; glass with refraction and environment-dependent reflections; hair with individual strand behaviour and natural movement.'
}

function DEFAULT_IMPERFECTION_LANGUAGE(): string {
  return 'Break synthetic perfection with controlled realism: micro-asymmetry in faces, natural eye differences, uneven posture, real spacing, imperfect reflections, subtle fabric variation, physically grounded environmental wear.'
}

/** Applied to every compiled prompt while `enforce_cinematic_standard` holds. */
export const DEFAULT_NEGATIVE_CONSTRAINTS: string[] = [
  'obvious AI-rendered appearance',
  'plastic skin',
  'wax-like faces',
  'material blending',
  'floating accessories',
  'rubber movement',
  'warped anatomy',
  'merged fingers',
  'duplicate limbs',
  'morphing props',
  'disappearing wardrobe pieces',
  'texture crawling',
  'background smearing',
  'inconsistent reflections',
  'fake depth of field',
  'impossible camera motion',
  'weightless movement',
  'flat global illumination',
  'unmotivated rim lights',
  'excessive fill',
  'artificial glow',
  'fake volumetric haze',
  'HDR appearance',
  'crushed blacks with no information',
]

/** Never added by default; only when a shot asks for them by name. */
export const PROHIBITED_TREATMENTS: string[] = [
  'graphic overlays',
  'fake film grain',
  'fake lens dirt',
  'haze',
  'HDR',
  'stylized color grading',
  'over-sharpening',
  'artificial bloom',
  'unmotivated smoke',
  'generic cyberpunk lighting',
  'empty staged posing',
]

export function defaultStyleBible(): StyleBible {
  return StyleBible.parse({})
}

/**
 * Reference selection for a provider that accepts only `limit` images.
 * Ordering is by declared role priority then quality — never arbitrary — so the
 * same shot sends the same references to the same provider every time.
 */
export function selectReferences(references: BibleReference[], limit: number, roles?: ReferenceRole[]): BibleReference[] {
  const filtered = roles ? references.filter((r) => roles.includes(r.role)) : references
  return [...filtered]
    .sort((a, b) => b.priority - a.priority || b.quality_rating - a.quality_rating || a.asset_id.localeCompare(b.asset_id))
    .slice(0, Math.max(0, limit))
}

export function isIdentityUsable(character: CharacterRecord): boolean {
  return character.rights_status === 'authorized'
}
