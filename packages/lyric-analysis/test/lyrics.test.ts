import { describe, expect, it } from 'vitest'
import { analyzeLyrics, countSyllables, countSyllablesInLine, parseLyricSheet, rhymeKey, vowelDensity } from '../src/index.js'

/** Syllable and structure heuristics, and the refusal to analyse nothing. */

describe('syllable counting', () => {
  it('counts common sung words correctly', () => {
    const cases: Array<[string, number]> = [
      ['fire', 2], ['the', 1], ['love', 1], ['little', 2], ['wanted', 2], ['walked', 1],
      ['everything', 4], ['signal', 2], ['tonight', 2], ['beautiful', 3], ['time', 1],
      ['table', 2], ['candle', 2], ['handle', 2],
    ]
    for (const [word, expected] of cases) expect(countSyllables(word), word).toBe(expected)
  })

  it('counts a whole line', () => {
    // sig-nal fi-re sig-nal fi-re
    expect(countSyllablesInLine('Signal fire, signal fire')).toBe(8)
  })

  it('returns zero for an empty line rather than one', () => {
    expect(countSyllablesInLine('   ')).toBe(0)
  })

  it('measures vowel density', () => {
    expect(vowelDensity('aaa')).toBe(1)
    expect(vowelDensity('bcd')).toBe(0)
  })

  it('extracts a rhyme key from the final word', () => {
    expect(rhymeKey('into the night')).toBe(rhymeKey('shining bright'))
    expect(rhymeKey('')).toBeNull()
  })
})

describe('lyric sheet parsing', () => {
  it('reads section headers as hints and drops blank lines', () => {
    const parsed = parseLyricSheet('[Verse 1]\nline one\n\nline two\n[Chorus]\nhook line')
    expect(parsed).toHaveLength(3)
    expect(parsed[0]!.sectionHint).toBe('verse')
    expect(parsed[2]!.sectionHint).toBe('chorus')
  })
})

describe('lyric analysis', () => {
  const lines = [
    { text: 'Streetlights counting down the block', sectionOrderIndex: 1 },
    { text: 'Every window holding still', sectionOrderIndex: 1 },
    { text: 'Signal fire, signal fire', sectionOrderIndex: 3, titlePhrase: true },
    { text: 'Hold the line for me tonight', sectionOrderIndex: 3 },
    { text: 'Signal fire, signal fire', sectionOrderIndex: 5, titlePhrase: true },
  ]
  const sectionTypes = { 1: 'verse', 3: 'chorus', 5: 'final_chorus' }
  const sectionSeconds = { 1: 20, 3: 15, 5: 15 }

  it('counts title appearances from the marks', () => {
    const result = analyzeLyrics({ lines, source: 'user_supplied', title: 'Signal fire', sectionTypes, sectionSeconds })
    expect(result.titleRepetition).toBe(2)
    expect(result.titlePlacement.map((entry) => entry.sectionType)).toEqual(['chorus', 'final_chorus'])
  })

  it('detects a repeated line', () => {
    const result = analyzeLyrics({ lines, source: 'user_supplied', sectionTypes, sectionSeconds })
    expect(result.lines[4]!.repeatsLineIndex).toBe(2)
    expect(result.lyricRepetition).toBeGreaterThan(0)
  })

  it('computes per-section density where timings are known', () => {
    const result = analyzeLyrics({ lines, source: 'user_supplied', sectionTypes, sectionSeconds })
    const chorus = result.sections.find((section) => section.sectionType === 'chorus')!
    expect(chorus.syllablesPerSecond).not.toBeNull()
    expect(chorus.syllableCount).toBeGreaterThan(0)
  })

  it('reports density as unavailable when there is no timing at all', () => {
    const result = analyzeLyrics({ lines: [{ text: 'one line only' }], source: 'user_supplied' })
    expect(result.syllablesPerSecond).toBeNull()
    // Named, not zero-filled.
    expect(result.unavailable).toContain('syllables_per_second')
  })

  it('reports verse/chorus overlap as unavailable when one side is missing', () => {
    const result = analyzeLyrics({
      lines: [{ text: 'chorus only', sectionOrderIndex: 3 }],
      source: 'user_supplied',
      sectionTypes: { 3: 'chorus' },
    })
    expect(result.verseChorusVocabularyOverlap).toBeNull()
    expect(result.unavailable).toContain('verse_chorus_vocabulary_overlap')
  })

  it('computes vocabulary overlap when both sides exist', () => {
    const result = analyzeLyrics({
      lines: [
        { text: 'hold the line tonight', sectionOrderIndex: 1 },
        { text: 'hold the line for me', sectionOrderIndex: 3 },
      ],
      source: 'user_supplied',
      sectionTypes: { 1: 'verse', 3: 'chorus' },
      sectionSeconds: { 1: 10, 3: 10 },
    })
    expect(result.verseChorusVocabularyOverlap).toBeGreaterThan(0)
  })

  it('records which source the lyric came from', () => {
    const result = analyzeLyrics({ lines, source: 'transcribed', sectionTypes, sectionSeconds })
    expect(result.source).toBe('transcribed')
  })

  it('detects a title from the title string when no line is marked', () => {
    const result = analyzeLyrics({
      lines: [{ text: 'Signal fire burning' }, { text: 'nothing here' }],
      source: 'user_supplied',
      title: 'Signal fire',
    })
    expect(result.titleRepetition).toBe(1)
  })

  it('finds no title when none is supplied and none is marked', () => {
    const result = analyzeLyrics({ lines: [{ text: 'some line' }], source: 'user_supplied' })
    expect(result.titleRepetition).toBe(0)
  })
})
