import { describe, expect, it } from 'vitest'
import { blankListeningNotes, validateListeningNotes, translationEvidence } from '../src/translation-notes.js'
describe('translation listening notes', () => {
  it('starts each version with a fresh checklist', () => {
    const first = blankListeningNotes('owner', 'song', 'version-1')
    first.notes[0]!.checked = true
    first.notes[0]!.note = 'Bass disappears on phone'
    const second = blankListeningNotes('owner', 'song', 'version-2')
    expect(second.notes.every(n => !n.checked && !n.note)).toBe(true)
    expect(first.notes[0]!.checked).toBe(true)
  })
  it('keeps version and owner required', () => {
    expect(() => blankListeningNotes('', 'song', 'version')).toThrow()
    expect(() => blankListeningNotes('owner', 'song', '')).toThrow()
  })
  it('shows only measured data and explains absent readings', () => {
    const rows = translationEvidence([{ name: 'truePeak', value: -1.3, sourceFile: 'mix.wav', analyzerVersion: '1' }])
    expect(rows[0]?.value).toBe(-1.3)
    expect(rows[0]?.source).toContain('mix.wav')
    expect(rows[1]?.explanation).toMatch(/Not enough information/)
  })
  it('rejects unsupported device lists', () => {
    const notes = blankListeningNotes('owner', 'song', 'version')
    expect(() => validateListeningNotes({ ...notes, notes: notes.notes.slice(0, 3) })).toThrow()
  })
})
