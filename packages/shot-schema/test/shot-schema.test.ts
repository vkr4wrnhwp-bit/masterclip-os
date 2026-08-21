import { describe, expect, it } from 'vitest'
import {
  deriveRequirements,
  emptyShot,
  exportCsv,
  extractLockedFacts,
  frameSize,
  importCsv,
  importJson,
  parseCsv,
  selectReferences,
  shotJsonSchema,
  validateShot,
} from '../src/index.js'

describe('canonical shot schema', () => {
  it('fills every documented field with a usable default', () => {
    const shot = emptyShot()
    expect(shot.duration_seconds).toBe(8)
    expect(shot.aspect_ratio).toBe('16:9')
    expect(shot.generation_mode).toBe('image_to_video')
    expect(shot.routing_profile).toBe('DRAFT_MOTION')
    expect(shot.lighting.practicals).toEqual([])
    expect(shot.max_cost_usd).toBe(2)
  })

  it('lifts bare strings into structured locks so spreadsheet imports work', () => {
    const shot = emptyShot({ identity_locks: ['NOVA'], wardrobe_locks: ['black leather jacket'], subjects: ['a woman in the rain'] })
    expect(shot.identity_locks[0]).toMatchObject({ character_key: 'NOVA', strength: 'strict' })
    expect(shot.wardrobe_locks[0]).toMatchObject({ item: 'black leather jacket' })
    expect(shot.subjects[0]).toMatchObject({ description: 'a woman in the rain', role: 'primary' })
  })

  it('publishes a JSON Schema generated from the same definition it validates with', () => {
    const schema = shotJsonSchema()
    const properties = schema.properties as Record<string, unknown>
    expect(properties.duration_seconds).toBeDefined()
    expect(properties.identity_locks).toBeDefined()
    expect(properties.lighting).toBeDefined()
    expect(Object.keys(properties).length).toBeGreaterThan(40)
  })
})

describe('semantic validation', () => {
  it('rejects a first_last_frame shot missing its last frame', () => {
    const result = validateShot(emptyShot({ generation_mode: 'first_last_frame', first_frame_asset: 'ast_1' }))
    expect(result.ok).toBe(false)
    expect(result.issues.map((i) => i.code)).toContain('mode.missing_last_frame')
  })

  it('rejects image_to_video with nothing to animate', () => {
    const result = validateShot(emptyShot({ generation_mode: 'image_to_video' }))
    expect(result.issues.map((i) => i.code)).toContain('mode.missing_source_image')
  })

  it('warns that a strict identity lock is unenforceable on text_to_video', () => {
    const result = validateShot(emptyShot({ generation_mode: 'text_to_video', action: 'she turns', identity_locks: ['NOVA'] }))
    const warning = result.issues.find((i) => i.code === 'mode.identity_without_reference')
    expect(warning?.severity).toBe('warning')
    // A warning must not block the save; only errors do.
    expect(result.ok).toBe(true)
  })

  it('catches a NATIVE_AUDIO profile with audio switched off', () => {
    const result = validateShot(emptyShot({ generation_mode: 'text_to_video', action: 'x', routing_profile: 'NATIVE_AUDIO', audio_mode: 'none' }))
    expect(result.issues.map((i) => i.code)).toContain('routing.audio_mismatch')
  })

  it('catches a model both preferred and excluded', () => {
    const result = validateShot(
      emptyShot({ generation_mode: 'text_to_video', action: 'x', preferred_models: ['fal/wan'], excluded_models: ['fal/wan'] }),
    )
    expect(result.issues.map((i) => i.code)).toContain('routing.conflicting_models')
  })

  it('refuses a shot that cannot continue from itself', () => {
    const result = validateShot(emptyShot({ generation_mode: 'text_to_video', action: 'x', shot_id: 'S01', continuity_from_shot: 'S01' }))
    expect(result.issues.map((i) => i.code)).toContain('continuity.self_reference')
  })
})

describe('derived requirements', () => {
  it('translates a shot into the capability demand the router consumes', () => {
    const shot = emptyShot({
      generation_mode: 'first_last_frame',
      first_frame_asset: 'ast_a',
      last_frame_asset: 'ast_b',
      audio_mode: 'native_dialogue',
      dialogue: 'we are not done',
      identity_locks: ['NOVA'],
      target_resolution: '1080p',
      aspect_ratio: '9:16',
    })
    const requirements = deriveRequirements(shot)
    expect(requirements.needsFirstFrame).toBe(true)
    expect(requirements.needsLastFrame).toBe(true)
    expect(requirements.needsNativeAudio).toBe(true)
    expect(requirements.needsDialogue).toBe(true)
    expect(requirements.identityCritical).toBe(true)
    expect(requirements.continuityCritical).toBe(true)
    // 1080p vertical is 1080 wide by 1920 tall — the label names the short edge.
    expect(requirements.width).toBe(1080)
    expect(requirements.height).toBe(1920)
  })

  it('scores inflected action verbs, not just stems', () => {
    const still = deriveRequirements(emptyShot({ action: 'she stands and looks at the sign' }))
    const busy = deriveRequirements(emptyShot({ action: 'she spins and throws the jacket' }))
    const violent = deriveRequirements(emptyShot({ action: 'the window shatters as the car crashes' }))
    expect(still.actionComplexity).toBeLessThan(busy.actionComplexity)
    expect(busy.actionComplexity).toBeLessThan(violent.actionComplexity)
  })

  it('scores camera complexity from movement language', () => {
    expect(deriveRequirements(emptyShot({ camera_movement: 'locked off' })).cameraComplexity).toBeLessThan(
      deriveRequirements(emptyShot({ camera_movement: 'handheld orbit around the subject' })).cameraComplexity,
    )
  })

  it('marks HERO shots as requiring human approval', () => {
    expect(deriveRequirements(emptyShot({ routing_profile: 'HERO' })).requiresHumanApproval).toBe(true)
    expect(deriveRequirements(emptyShot({ routing_profile: 'DRAFT_MOTION' })).requiresHumanApproval).toBe(false)
  })
})

describe('locked facts', () => {
  it('extracts only strict locks — guided locks are preferences, not facts', () => {
    const shot = emptyShot({
      identity_locks: [{ character_key: 'NOVA', character_version: 2, strength: 'strict', must_match: ['jaw scar'] }],
      wardrobe_locks: [
        { item: 'black leather jacket', detail: 'cracked left elbow', strength: 'strict', character_key: 'NOVA' },
        { item: 'silver hoops', detail: '', strength: 'guided', character_key: 'NOVA' },
      ],
      environment_lock: { environment_key: 'ALLEY', environment_version: 0, strength: 'strict' },
    })
    const locked = extractLockedFacts(shot)
    expect(locked.identities).toEqual(['NOVA — jaw scar'])
    expect(locked.wardrobe).toEqual(['black leather jacket — cracked left elbow'])
    expect(locked.environment).toBe('ALLEY')
    expect(locked.all).not.toContain('silver hoops')
  })
})

describe('frame geometry', () => {
  it('produces even dimensions for every aspect ratio, as H.264 requires', () => {
    for (const aspect of ['16:9', '9:16', '1:1', '4:5', '21:9', '2.39:1'] as const) {
      const size = frameSize('1080p', aspect)
      expect(size.width % 2).toBe(0)
      expect(size.height % 2).toBe(0)
    }
  })
})

describe('import and export', () => {
  it('parses RFC 4180 CSV including quotes, commas and embedded newlines', () => {
    const rows = parseCsv('a,b\n"has, comma","has ""quotes"""\n"line\nbreak",z\n')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toEqual(['has, comma', 'has "quotes"'])
    expect(rows[2]?.[0]).toBe('line\nbreak')
  })

  it('round-trips a shot through CSV without losing structured locks', () => {
    const original = emptyShot({
      shot_id: 'S07',
      title: 'Rooftop turn',
      generation_mode: 'text_to_video',
      action: 'she turns into the wind',
      identity_locks: ['NOVA'],
      wardrobe_locks: ['black leather jacket'],
      negative_constraints: ['plastic skin', 'warped anatomy'],
      lighting: {
        dominant_source: 'sodium street lamp',
        source_position: 'below frame left',
        color_temperature: '2200K',
        falloff: 'fast',
        shadow_behavior: 'hard',
        practicals: [],
      },
    })
    const result = importCsv(exportCsv([original]))
    expect(result.errors).toHaveLength(0)
    const restored = result.shots[0]
    expect(restored?.shot_id).toBe('S07')
    expect(restored?.identity_locks[0]?.character_key).toBe('NOVA')
    expect(restored?.wardrobe_locks[0]?.item).toBe('black leather jacket')
    expect(restored?.negative_constraints).toEqual(['plastic skin', 'warped anatomy'])
    expect(restored?.lighting.dominant_source).toBe('sodium street lamp')
  })

  it('reports the row and reason for every rejected import instead of dropping it', () => {
    const csv = 'shot_id,generation_mode,duration_seconds,action\nS01,text_to_video,8,she turns\nS02,first_last_frame,8,\n'
    const result = importCsv(csv)
    expect(result.shots).toHaveLength(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.shotId).toBe('S02')
    expect(result.errors[0]?.issues.map((i) => i.code)).toContain('mode.missing_first_frame')
  })

  it('refuses prototype-polluting column names', () => {
    const result = importCsv('shot_id,__proto__.polluted,generation_mode,action\nS01,yes,text_to_video,x\n')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(result.shots).toHaveLength(1)
  })

  it('accepts a JSON bundle or a bare array', () => {
    const shot = emptyShot({ shot_id: 'S01', generation_mode: 'text_to_video', action: 'x' })
    expect(importJson(JSON.stringify({ shots: [shot] })).shots).toHaveLength(1)
    expect(importJson(JSON.stringify([shot])).shots).toHaveLength(1)
    expect(importJson('not json').errors[0]?.issues[0]?.code).toBe('import.invalid_json')
  })
})

describe('reference selection', () => {
  it('is deterministic and honours priority then quality', () => {
    const references = [
      { asset_id: 'c', role: 'face_primary' as const, priority: 50, quality_rating: 5, notes: '' },
      { asset_id: 'a', role: 'face_primary' as const, priority: 90, quality_rating: 3, notes: '' },
      { asset_id: 'b', role: 'full_body' as const, priority: 50, quality_rating: 2, notes: '' },
    ]
    const picked = selectReferences(references, 2)
    expect(picked.map((r) => r.asset_id)).toEqual(['a', 'c'])
    expect(selectReferences(references, 2).map((r) => r.asset_id)).toEqual(picked.map((r) => r.asset_id))
  })
})
