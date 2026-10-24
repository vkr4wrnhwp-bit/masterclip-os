import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { applySongMapEdits, songMapEvidence } from '../src/song-map.js'

const original = [
  { id: 'a', label: 'Verse', startMs: 0, endMs: 10000, confidence: 0.8 },
  { id: 'b', label: 'Chorus', startMs: 10000, endMs: 22000, confidence: 0.7 },
]

describe('song map corrections', () => {
  it('preserves original analysis and applies edits to a separate projection', () => {
    const checksum = createHash('sha256').update(JSON.stringify(original)).digest('hex')
    const revised = applySongMapEdits(original, [
      { kind: 'rename', id: 'a', label: 'Opening Verse' },
      { kind: 'boundary', id: 'a', endMs: 9500 },
      { kind: 'split', id: 'b', atMs: 16000, newId: 'c', label: 'Hook' },
      { kind: 'merge', leftId: 'a', rightId: 'b', label: 'First half' },
    ])
    expect(revised).toHaveLength(2)
    expect(revised[0]?.endMs).toBe(16000)
    expect(revised[1]?.label).toBe('Hook')
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe(checksum)
  })
  it('rejects invalid boundaries', () => {
    expect(() => applySongMapEdits(original, [{ kind: 'boundary', id: 'a', endMs: -1 }])).toThrow()
  })
  it('explains missing and failed analysis without invented readings', () => {
    expect(songMapEvidence(null, original).message).toMatch(/Not enough information/)
    expect(songMapEvidence({ status: 'failed' }, original).sections).toEqual([])
    const partial = songMapEvidence({ status: 'complete', engineVersion: 'test' }, original)
    expect(partial.tempo).toMatch(/Not enough information/)
    expect(partial.key).toMatch(/Not enough information/)
    expect(partial.nextActions).toEqual([])
  })
})
