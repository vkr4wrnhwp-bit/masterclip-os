import { describe, expect, it } from 'vitest'
import { songMapSaveSchema } from '../apps/api/src/routes/song-map-validation.js'

describe('Song Map edit request validation', () => {
  const rename = { kind: 'rename', id: 'verse', label: 'Verse 1' }
  it('permits a bounded saved correction list', () => {
    expect(songMapSaveSchema.safeParse({ edits: [rename] }).success).toBe(true)
    expect(songMapSaveSchema.safeParse({ edits: Array.from({ length: 200 }, () => rename) }).success).toBe(true)
  })
  it('rejects more than 200 edits, invalid times and empty labels', () => {
    expect(songMapSaveSchema.safeParse({ edits: Array.from({ length: 201 }, () => rename) }).success).toBe(false)
    expect(songMapSaveSchema.safeParse({ edits: [{ kind: 'boundary', id: 'verse', endMs: -1 }] }).success).toBe(false)
    expect(songMapSaveSchema.safeParse({ edits: [{ kind: 'rename', id: 'verse', label: '' }] }).success).toBe(false)
  })
})
