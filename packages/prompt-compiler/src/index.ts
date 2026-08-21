import { AppError, hashObject } from '@masterclip/shared'
import {
  extractLockedFacts,
  selectReferences,
  type CanonicalShot,
  type CharacterRecord,
  type EnvironmentRecord,
  type StyleBible,
} from '@masterclip/shot-schema'
import type { ModelCapabilities } from '@masterclip/provider-core'

export const COMPILER_VERSION = '1.2.0'
export const TEMPLATE_VERSION = '2026-08-cinematic-1'

/**
 * Prompt dialects.
 *
 * Providers differ in what they reward: some parse a flowing cinematographic
 * paragraph, others respond better to ordered clauses, and a few impose short
 * limits. The dialect changes *phrasing*, never *facts*.
 */
export type PromptDialect = 'narrative' | 'structured' | 'concise'

export interface CompileInput {
  shot: CanonicalShot
  styleBible: StyleBible
  characters?: Map<string, CharacterRecord>
  environments?: Map<string, EnvironmentRecord>
  providerId: string
  modelId: string
  capabilities: ModelCapabilities
  dialect?: PromptDialect
  /** Batch variation: an extra directive plus a label recorded with the render. */
  variation?: { index: number; instruction: string; label: string }
}

export interface PromptSegment {
  key: string
  label: string
  text: string
  /** Higher survives compression. Locked facts are Infinity and never dropped. */
  priority: number
  locked: boolean
}

export interface CompiledPrompt {
  prompt: string
  negativePrompt: string
  segments: PromptSegment[]
  droppedSegments: string[]
  warnings: string[]
  compilerVersion: string
  templateVersion: string
  dialect: PromptDialect
  promptHash: string
  /** Every locked fact was found verbatim in the final prompt. */
  lockedFactsVerified: boolean
}

const DIALECT_BY_PROVIDER: Record<string, PromptDialect> = {
  google: 'narrative',
  muapi: 'structured',
  fal: 'structured',
  runway: 'concise',
  luma: 'narrative',
  replicate: 'structured',
  selfhosted: 'structured',
  mock: 'structured',
}

export function dialectFor(providerId: string, capabilities: ModelCapabilities): PromptDialect {
  if (capabilities.maxPromptChars <= 1000) return 'concise'
  return DIALECT_BY_PROVIDER[providerId] ?? 'structured'
}

/**
 * Compiles a canonical shot into a provider-specific prompt.
 *
 * The invariant this function exists to protect: **locked creative facts are
 * never rewritten or dropped**. Compression removes craft detail in priority
 * order and stops before it touches identity, wardrobe, props, or the locked
 * environment; if the result would violate that, compilation fails loudly
 * instead of quietly shipping a prompt that describes a different character.
 */
export function compilePrompt(input: CompileInput): CompiledPrompt {
  const { shot, styleBible, capabilities } = input
  const dialect = input.dialect ?? dialectFor(input.providerId, capabilities)
  const warnings: string[] = []
  const locked = extractLockedFacts(shot)
  const segments: PromptSegment[] = []

  const push = (key: string, label: string, text: string, priority: number, isLocked = false) => {
    const trimmed = text.trim().replace(/\s+/g, ' ')
    if (trimmed.length > 0) segments.push({ key, label, text: trimmed, priority, locked: isLocked })
  }

  // Assembly order is fixed: subject → environment → action → performance →
  // camera → lens → light → material → interaction → continuity → technical.
  // Models weight early tokens more heavily, and this ordering puts the things
  // that must not drift first.

  // 1. subject identity
  const subjectText = buildSubjects(shot, input.characters)
  push('subject', 'Subject', subjectText, Number.POSITIVE_INFINITY, locked.identities.length > 0)

  // 2. wardrobe and props (locked)
  if (locked.wardrobe.length > 0) push('wardrobe', 'Wardrobe', `Wardrobe: ${locked.wardrobe.join('; ')}.`, Number.POSITIVE_INFINITY, true)
  if (locked.props.length > 0) push('props', 'Props', `Props: ${shot.prop_locks.map(describeProp).join('; ')}.`, Number.POSITIVE_INFINITY, true)

  // 3. environment
  push('environment', 'Environment', buildEnvironment(shot, input.environments), locked.environment ? Number.POSITIVE_INFINITY : 90, Boolean(locked.environment))

  // 4. narrative action
  push('action', 'Action', shot.action, 95)
  push('purpose', 'Narrative purpose', shot.narrative_purpose, 55)

  // 5. performance and blocking
  push('performance', 'Performance', shot.performance_direction, 80)
  push('blocking', 'Blocking', shot.blocking, 75)

  // 6-7. camera
  push('camera_position', 'Camera position', shot.camera_position, 88)
  push('camera_movement', 'Camera movement', shot.camera_movement, 86)

  // 8. lens and depth
  push('lens', 'Lens', `${shot.lens_mm}mm at f/${shot.aperture.toFixed(1)}${shot.focus_behavior ? `, ${shot.focus_behavior}` : ''}`, 78)

  // 9. lighting
  push('lighting', 'Lighting', buildLighting(shot), 84)

  // 10. materials and physical behaviour
  if (shot.material_requirements.length > 0) {
    push('materials', 'Materials', shot.material_requirements.map((m) => (m.behavior ? `${m.material} (${m.behavior})` : m.material)).join('; '), 70)
  }
  if (shot.physical_motion_rules.length > 0) push('physics', 'Physical behaviour', shot.physical_motion_rules.join('; '), 68)

  // 11. environmental interaction
  if (shot.environmental_motion.length > 0) push('environmental_motion', 'Environmental motion', shot.environmental_motion.join('; '), 65)

  // 12. continuity
  push('continuity', 'Continuity', buildContinuity(shot), 72)

  // 13. house style — dropped first under pressure; it is preference, not fact.
  if (styleBible.enforce_cinematic_standard) {
    push('style_camera', 'Camera language', styleBible.camera_language, 40)
    push('style_light', 'Lighting language', styleBible.lighting_language, 38)
    push('style_material', 'Material language', styleBible.material_language, 36)
    push('style_imperfection', 'Imperfection', styleBible.imperfection_language, 34)
  }
  if (styleBible.visual_language) push('style_visual', 'Visual language', styleBible.visual_language, 45)

  // 14. audio
  if (shot.audio_mode === 'native_dialogue' && shot.dialogue) {
    push('dialogue', 'Dialogue', `Spoken line: "${shot.dialogue}"`, capabilities.dialogue ? 92 : 20)
    if (!capabilities.dialogue) warnings.push('model cannot generate dialogue — the line is included as description only')
  }
  if (shot.ambient_audio && capabilities.nativeAudio) push('ambience', 'Ambience', `Ambient sound: ${shot.ambient_audio}`, 60)

  // 15. batch variation
  if (input.variation?.instruction) push('variation', 'Variation', input.variation.instruction, 82)

  const negatives = buildNegatives(shot, styleBible)
  const supportsNegative = capabilities.negativePrompt
  if (!supportsNegative && negatives.length > 0) {
    push('negatives_inline', 'Avoid', `Avoid: ${negatives.join(', ')}.`, 50)
    warnings.push('model has no negative-prompt field — constraints were folded into the positive prompt')
  }

  const { text, dropped } = assemble(segments, dialect, capabilities.maxPromptChars)
  if (dropped.length > 0) {
    warnings.push(`prompt exceeded the ${capabilities.maxPromptChars}-character limit; dropped: ${dropped.join(', ')}`)
  }

  const missing = locked.all.filter((fact) => !containsFact(text, fact))
  if (missing.length > 0) {
    throw new AppError({
      kind: 'internal',
      code: 'compiler.locked_fact_lost',
      message: `compiled prompt lost locked creative facts: ${missing.join('; ')}`,
      details: { providerId: input.providerId, modelId: input.modelId, missing },
    })
  }

  const negativePrompt = supportsNegative ? negatives.join(', ') : ''

  return {
    prompt: text,
    negativePrompt: negativePrompt.slice(0, Math.max(0, capabilities.maxPromptChars)),
    segments,
    droppedSegments: dropped,
    warnings,
    compilerVersion: COMPILER_VERSION,
    templateVersion: TEMPLATE_VERSION,
    dialect,
    promptHash: hashObject({ text, negativePrompt, dialect, compiler: COMPILER_VERSION }),
    lockedFactsVerified: true,
  }
}

/**
 * A locked fact may be a compound string ("black leather jacket — cracked at
 * the elbow"); the compiler joins those parts into prose, so verification
 * checks each part rather than demanding the joined form survive verbatim.
 */
function containsFact(prompt: string, fact: string): boolean {
  const haystack = prompt.toLowerCase()
  return fact
    .split('—')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    .every((part) => haystack.includes(part))
}

function assemble(segments: PromptSegment[], dialect: PromptDialect, maxChars: number): { text: string; dropped: string[] } {
  const ordered = [...segments]
  const dropped: string[] = []

  const render = (list: PromptSegment[]): string => {
    if (dialect === 'structured') {
      return list.map((s) => `${s.label}: ${stripTrailingPeriod(s.text)}.`).join(' ')
    }
    if (dialect === 'concise') {
      return list.map((s) => stripTrailingPeriod(s.text)).join('. ') + '.'
    }
    return list.map((s) => stripTrailingPeriod(s.text)).join('. ') + '.'
  }

  let current = [...ordered]
  let text = render(current)
  if (text.length <= maxChars) return { text, dropped }

  // Drop the lowest-priority optional segments until it fits. Locked facts have
  // infinite priority and are never candidates.
  const droppable = current
    .filter((s) => !s.locked && Number.isFinite(s.priority))
    .sort((a, b) => a.priority - b.priority)

  for (const segment of droppable) {
    if (text.length <= maxChars) break
    current = current.filter((s) => s.key !== segment.key)
    dropped.push(segment.key)
    text = render(current)
  }

  if (text.length > maxChars) {
    // Everything left is locked. Truncating would corrupt a creative fact, so
    // the overflow is reported and the caller decides — it is not silently cut.
    throw new AppError({
      kind: 'validation',
      code: 'compiler.locked_facts_exceed_limit',
      message: `locked creative facts alone need ${text.length} characters but the model accepts ${maxChars}; reduce locks or choose another model`,
      details: { length: text.length, maxChars },
    })
  }

  return { text, dropped }
}

function stripTrailingPeriod(text: string): string {
  return text.replace(/\.\s*$/, '')
}

function buildSubjects(shot: CanonicalShot, characters?: Map<string, CharacterRecord>): string {
  if (shot.subjects.length === 0 && shot.identity_locks.length === 0) return ''
  const parts: string[] = []
  for (const lock of shot.identity_locks) {
    const record = characters?.get(lock.character_key)
    const details = record
      ? [record.name, record.hair, record.skin_tone, record.makeup, ...record.wardrobe.slice(0, 2)].filter(Boolean).join(', ')
      : lock.character_key
    parts.push(lock.must_match.length > 0 ? `${lock.character_key} — ${details}; must match: ${lock.must_match.join(', ')}` : `${lock.character_key} — ${details}`)
  }
  for (const subject of shot.subjects) {
    if (subject.character_key && shot.identity_locks.some((l) => l.character_key === subject.character_key)) continue
    if (subject.description) parts.push(subject.role === 'background' ? `background: ${subject.description}` : subject.description)
  }
  return parts.join('. ')
}

function buildEnvironment(shot: CanonicalShot, environments?: Map<string, EnvironmentRecord>): string {
  const lock = shot.environment_lock
  if (!lock) return ''
  const record = environments?.get(lock.environment_key)
  if (!record) return lock.environment_key
  return [
    lock.environment_key,
    record.name,
    record.architectural_plan,
    record.primary_materials.length > 0 ? `materials: ${record.primary_materials.join(', ')}` : '',
    record.time_of_day,
    record.atmosphere,
    record.ground_plane,
  ]
    .filter(Boolean)
    .join(', ')
}

function describeProp(prop: { prop: string; detail: string; held_by: string; hand: string }): string {
  const bits = [prop.prop, prop.detail].filter(Boolean).join(' — ')
  if (prop.hand !== 'none') return `${bits} (held in the ${prop.hand} hand${prop.held_by ? ` by ${prop.held_by}` : ''})`
  return bits
}

function buildLighting(shot: CanonicalShot): string {
  const l = shot.lighting
  const parts = [
    l.dominant_source ? `dominant motivated source: ${l.dominant_source}` : '',
    l.source_position ? `from ${l.source_position}` : '',
    l.color_temperature,
    l.falloff ? `${l.falloff} falloff` : '',
    l.shadow_behavior,
    l.practicals.length > 0 ? `practicals: ${l.practicals.map((p) => [p.fixture, p.position, p.color].filter(Boolean).join(' ')).join(', ')}` : '',
  ].filter(Boolean)
  return parts.join(', ')
}

function buildContinuity(shot: CanonicalShot): string {
  const parts: string[] = []
  if (shot.continuity_from_shot) parts.push(`continues directly from ${shot.continuity_from_shot}`)
  if (shot.screen_direction !== 'unspecified') parts.push(`screen direction ${shot.screen_direction.replace(/_/g, ' ')}`)
  if (shot.first_frame_asset) parts.push('the supplied first frame is the exact opening frame')
  if (shot.last_frame_asset) parts.push('the supplied last frame is the exact closing frame')
  return parts.join(', ')
}

function buildNegatives(shot: CanonicalShot, styleBible: StyleBible): string[] {
  const set = new Set<string>()
  for (const item of shot.negative_constraints) set.add(item)
  if (styleBible.enforce_cinematic_standard) {
    for (const item of styleBible.global_negative_constraints) set.add(item)
    for (const item of styleBible.prohibited_treatments) set.add(item)
  }
  for (const lock of shot.wardrobe_locks) {
    if (lock.strength === 'strict' && lock.item) set.add(`any wardrobe other than ${lock.item}`)
  }
  return [...set]
}

/**
 * Batch prompt variations.
 *
 * Variations perturb *direction*, never locked facts — that is what makes an
 * A/B comparison meaningful: only one axis moved.
 */
export const STANDARD_VARIATIONS: Array<{ label: string; instruction: string }> = [
  { label: 'base', instruction: '' },
  { label: 'slower', instruction: 'Slower, more deliberate motion; let the moment settle.' },
  { label: 'tighter', instruction: 'Tighter framing on the subject; less headroom.' },
  { label: 'wider', instruction: 'Wider framing; more of the environment reads.' },
  { label: 'harder-light', instruction: 'Harder key with deeper shadow separation and stronger falloff.' },
  { label: 'softer-light', instruction: 'Softer key wrapping the subject; gentler shadow edges.' },
  { label: 'more-camera', instruction: 'More camera movement, still physically motivated.' },
  { label: 'locked-off', instruction: 'Locked-off camera; all motion comes from the subject and environment.' },
]

export function variationsFor(count: number): Array<{ index: number; label: string; instruction: string }> {
  return Array.from({ length: Math.max(1, count) }, (_, index) => {
    const variation = STANDARD_VARIATIONS[index % STANDARD_VARIATIONS.length] ?? STANDARD_VARIATIONS[0]
    return { index, label: variation?.label ?? 'base', instruction: variation?.instruction ?? '' }
  })
}
