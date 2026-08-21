import { describe, expect, it } from 'vitest'
import { CharacterRecord, EnvironmentRecord, defaultStyleBible, emptyShot } from '@masterclip/shot-schema'
import type { ModelCapabilities } from '@masterclip/provider-core'
import { compilePrompt, dialectFor, variationsFor } from '../src/index.js'

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    modes: ['text_to_video'],
    duration: { minSeconds: 4, maxSeconds: 10 },
    resolutions: ['720p'],
    aspectRatios: ['16:9'],
    fps: [24],
    nativeAudio: false,
    dialogue: false,
    firstFrame: false,
    lastFrame: false,
    videoReference: false,
    extension: false,
    maxReferenceImages: 0,
    seed: true,
    negativePrompt: true,
    maxPromptChars: 4000,
    tier: 'standard',
    safetyControls: [],
    ...overrides,
  }
}

const characters = new Map([
  [
    'NOVA',
    CharacterRecord.parse({
      character_key: 'NOVA',
      name: 'Nova',
      hair: 'wet dark bob',
      skin_tone: 'warm mid brown',
      wardrobe: ['black leather jacket'],
    }),
  ],
])

const environments = new Map([
  ['ALLEY', EnvironmentRecord.parse({ environment_key: 'ALLEY', name: 'Rain alley', primary_materials: ['wet brick'], time_of_day: '01:40' })],
])

const lockedShot = emptyShot({
  shot_id: 'S02',
  generation_mode: 'text_to_video',
  action: 'she turns toward the street',
  camera_position: 'medium, chest height',
  camera_movement: 'slow dolly in',
  identity_locks: [{ character_key: 'NOVA', character_version: 0, strength: 'strict', must_match: ['jaw scar'] }],
  wardrobe_locks: [{ character_key: 'NOVA', item: 'black leather jacket', detail: 'cracked left elbow', strength: 'strict' }],
  prop_locks: [{ prop: 'brass lighter', detail: 'engraved', held_by: 'Nova', hand: 'left', strength: 'strict' }],
  environment_lock: { environment_key: 'ALLEY', environment_version: 0, strength: 'strict' },
  lighting: {
    dominant_source: 'magenta neon sign',
    source_position: 'high camera left',
    color_temperature: 'magenta key',
    falloff: 'rapid',
    shadow_behavior: 'hard-edged under the jaw',
    practicals: [],
  },
})

function compile(shot = lockedShot, capabilities = caps()) {
  return compilePrompt({
    shot,
    styleBible: defaultStyleBible(),
    characters,
    environments,
    providerId: 'mock',
    modelId: 'test',
    capabilities,
  })
}

describe('prompt compilation', () => {
  it('carries every locked creative fact into the compiled prompt', () => {
    const compiled = compile()
    const prompt = compiled.prompt.toLowerCase()
    expect(prompt).toContain('nova')
    expect(prompt).toContain('jaw scar')
    expect(prompt).toContain('black leather jacket')
    expect(prompt).toContain('cracked left elbow')
    expect(prompt).toContain('brass lighter')
    expect(prompt).toContain('alley')
    expect(compiled.lockedFactsVerified).toBe(true)
  })

  it('puts the subject first, because models weight early tokens most', () => {
    const compiled = compile()
    expect(compiled.segments[0]?.key).toBe('subject')
    const order = compiled.segments.map((s) => s.key)
    expect(order.indexOf('subject')).toBeLessThan(order.indexOf('camera_position'))
    expect(order.indexOf('action')).toBeLessThan(order.indexOf('style_camera'))
  })

  it('records which hand holds a locked prop', () => {
    expect(compile().prompt).toMatch(/held in the left hand/)
  })

  it('applies the cinematic standard as negative constraints', () => {
    const compiled = compile()
    expect(compiled.negativePrompt).toContain('plastic skin')
    expect(compiled.negativePrompt).toContain('flat global illumination')
    expect(compiled.negativePrompt).toContain('fake film grain')
  })

  it('folds negatives into the positive prompt when the model has no negative field', () => {
    const compiled = compile(lockedShot, caps({ negativePrompt: false }))
    expect(compiled.negativePrompt).toBe('')
    expect(compiled.prompt).toMatch(/Avoid:/)
    expect(compiled.warnings.join(' ')).toMatch(/no negative-prompt field/)
  })

  it('drops craft detail before locked facts when compressing', () => {
    const compiled = compile(lockedShot, caps({ maxPromptChars: 700 }))
    expect(compiled.prompt.length).toBeLessThanOrEqual(700)
    expect(compiled.droppedSegments.length).toBeGreaterThan(0)
    // House style is preference and goes first; identity is fact and stays.
    expect(compiled.droppedSegments).toContain('style_camera')
    expect(compiled.prompt.toLowerCase()).toContain('black leather jacket')
    expect(compiled.lockedFactsVerified).toBe(true)
  })

  it('fails loudly rather than truncating when locked facts alone exceed the limit', () => {
    expect(() => compile(lockedShot, caps({ maxPromptChars: 60 }))).toThrow(/locked creative facts alone need/)
  })

  it('varies phrasing by dialect without changing the facts', () => {
    const structured = compilePrompt({
      shot: lockedShot,
      styleBible: defaultStyleBible(),
      characters,
      environments,
      providerId: 'fal',
      modelId: 't',
      capabilities: caps(),
      dialect: 'structured',
    })
    const narrative = compilePrompt({
      shot: lockedShot,
      styleBible: defaultStyleBible(),
      characters,
      environments,
      providerId: 'google',
      modelId: 't',
      capabilities: caps(),
      dialect: 'narrative',
    })
    expect(structured.prompt).not.toBe(narrative.prompt)
    expect(structured.prompt).toMatch(/Camera position:/)
    expect(narrative.prompt).not.toMatch(/Camera position:/)
    for (const prompt of [structured.prompt, narrative.prompt]) {
      expect(prompt.toLowerCase()).toContain('black leather jacket')
    }
  })

  it('selects a concise dialect for short-limit models', () => {
    expect(dialectFor('google', caps({ maxPromptChars: 500 }))).toBe('concise')
    expect(dialectFor('google', caps())).toBe('narrative')
    expect(dialectFor('fal', caps())).toBe('structured')
  })

  it('hashes the compiled output so a prompt change is detectable', () => {
    const a = compile()
    const b = compile()
    expect(a.promptHash).toBe(b.promptHash)
    const changed = compile({ ...lockedShot, action: 'she walks away instead' })
    expect(changed.promptHash).not.toBe(a.promptHash)
  })

  it('includes a batch variation without disturbing the locks', () => {
    const compiled = compilePrompt({
      shot: lockedShot,
      styleBible: defaultStyleBible(),
      characters,
      environments,
      providerId: 'mock',
      modelId: 't',
      capabilities: caps(),
      variation: { index: 1, label: 'slower', instruction: 'Slower, more deliberate motion.' },
    })
    expect(compiled.prompt).toContain('Slower, more deliberate motion')
    expect(compiled.prompt.toLowerCase()).toContain('brass lighter')
  })

  it('describes dialogue but flags it when the model cannot speak', () => {
    const speaking = emptyShot({
      generation_mode: 'text_to_video',
      action: 'she speaks',
      audio_mode: 'native_dialogue',
      dialogue: 'we are not done',
    })
    const compiled = compile(speaking, caps({ dialogue: false }))
    expect(compiled.warnings.join(' ')).toMatch(/cannot generate dialogue/)
  })
})

describe('batch variations', () => {
  it('produces distinct, labelled variations that cycle predictably', () => {
    const variations = variationsFor(6)
    expect(variations).toHaveLength(6)
    expect(variations[0]?.label).toBe('base')
    expect(variations[0]?.instruction).toBe('')
    expect(new Set(variations.map((v) => v.label)).size).toBe(6)
  })

  it('never returns an empty set', () => {
    expect(variationsFor(0)).toHaveLength(1)
  })
})
