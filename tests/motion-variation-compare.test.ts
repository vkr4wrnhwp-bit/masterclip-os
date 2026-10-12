import { describe, expect, it } from 'vitest'
import type { Shot } from '../apps/web/src/api.js'
import { areRelatedVariants, variationRoot } from '../apps/web/src/views/variant-model.js'

const shot = (id: string, parent: string | null = null): Shot => ({
  id, projectId: 'project-one', sceneId: null, shotKey: id, title: id,
  currentVersion: 1, ordinal: 1, spec: {
    music_cue: { asset_id: 'song', start_seconds: 0, end_seconds: 4 },
    creative_variant: parent ? { source_shot_id: parent, label: 'Variation' } : null,
  },
})

describe('MOTION creative comparison lineage', () => {
  it('compares a source with direct and nested alternatives', () => {
    const files = [shot('original'), shot('b', 'original'), shot('c', 'b')]
    expect(variationRoot('c', files)).toBe('original')
    expect(areRelatedVariants('original', 'c', files)).toBe(true)
    expect(areRelatedVariants('b', 'c', files)).toBe(true)
    expect(areRelatedVariants('b', 'b', files)).toBe(false)
  })

  it('does not fabricate a relationship for missing parents or cycles', () => {
    const files = [shot('orphan', 'missing'), shot('a', 'b'), shot('b', 'a'), shot('another')]
    expect(variationRoot('orphan', files)).toBe('orphan')
    expect(areRelatedVariants('orphan', 'another', files)).toBe(false)
    expect(areRelatedVariants('a', 'b', files)).toBe(false)
  })
})
