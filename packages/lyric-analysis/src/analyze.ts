import { countSyllablesInLine, consonantDensity, rhymeKey, vowelDensity, words } from './syllables.js'

/**
 * Lyric analysis.
 *
 * Runs only on lyrics the organization supplied or transcribed from audio it
 * confirmed it controls — the caller enforces that; this module refuses to
 * guess. Everything here is structural: how long the phrases are, where the
 * title lands, how often lines repeat, how much vocabulary the verse and chorus
 * share. Nothing here judges whether a lyric is any good, because that is not a
 * measurable property.
 */

export const LYRIC_ANALYSIS_VERSION = '1.0.0'

export type LyricSource = 'user_supplied' | 'transcribed' | 'time_coded' | 'vocal_transcript'

export interface LyricLineInput {
  text: string
  /** Present for time-coded lyrics; null for a plain sheet. */
  startMs?: number | null
  endMs?: number | null
  /** Section order index this line belongs to, when known. */
  sectionOrderIndex?: number | null
  titlePhrase?: boolean
  hookPhrase?: boolean
  userConfirmed?: boolean
}

export interface LyricAnalysisInput {
  lines: LyricLineInput[]
  source: LyricSource
  /** The title, when the user has told us what it is. */
  title?: string | null
  /** Section order index → section type, for verse/chorus comparisons. */
  sectionTypes?: Record<number, string>
  /** Section order index → duration in seconds, for density-per-second. */
  sectionSeconds?: Record<number, number>
  durationSeconds?: number
}

export interface AnalyzedLyricLine {
  index: number
  text: string
  syllableCount: number
  wordCount: number
  vowelDensity: number
  consonantDensity: number
  rhymeKey: string | null
  sectionOrderIndex: number | null
  startMs: number | null
  endMs: number | null
  titlePhrase: boolean
  hookPhrase: boolean
  /** Index of the earlier line this repeats, or null. */
  repeatsLineIndex: number | null
}

export interface SectionLyricMetrics {
  sectionOrderIndex: number
  sectionType: string | null
  lineCount: number
  syllableCount: number
  syllablesPerSecond: number | null
  medianLineSyllables: number
  longestLineSyllables: number
  uniqueWordRatio: number
  titleAppearances: number
}

export interface LyricAnalysisResult {
  source: LyricSource
  analysisVersion: string
  lines: AnalyzedLyricLine[]
  sections: SectionLyricMetrics[]
  totalSyllables: number
  totalWords: number
  /** Null when no timing information is available at all. */
  syllablesPerSecond: number | null
  chorusSyllablesPerSecond: number | null
  verseSyllablesPerSecond: number | null
  medianHookLineSyllables: number | null
  titleRepetition: number
  /** Where the title lands: section label → count. */
  titlePlacement: Array<{ sectionOrderIndex: number; sectionType: string | null; count: number }>
  hookRepetition: number
  lyricRepetition: number
  verseChorusVocabularyOverlap: number | null
  /** Rhyme key → line indexes sharing it, for the rhyme-placement view. */
  rhymeGroups: Array<{ key: string; lineIndexes: number[] }>
  questionLineRatio: number
  firstPersonRatio: number
  secondPersonRatio: number
  /** Anything the analysis could not determine, named rather than zero-filled. */
  unavailable: string[]
}

const FIRST_PERSON = new Set(['i', "i'm", "i'll", "i've", "i'd", 'me', 'my', 'mine', 'we', 'us', 'our', 'ours'])
const SECOND_PERSON = new Set(['you', "you're", "you'll", "you've", "you'd", 'your', 'yours'])

export function analyzeLyrics(input: LyricAnalysisInput): LyricAnalysisResult {
  const unavailable: string[] = []
  const normalizedTitle = normalize(input.title ?? '')

  const lines: AnalyzedLyricLine[] = input.lines.map((line, index) => {
    const normalized = normalize(line.text)
    const earlier = input.lines.findIndex((candidate, candidateIndex) => candidateIndex < index && normalize(candidate.text) === normalized)
    return {
      index,
      text: line.text,
      syllableCount: countSyllablesInLine(line.text),
      wordCount: words(line.text).length,
      vowelDensity: vowelDensity(line.text),
      consonantDensity: consonantDensity(line.text),
      rhymeKey: rhymeKey(line.text),
      sectionOrderIndex: line.sectionOrderIndex ?? null,
      startMs: line.startMs ?? null,
      endMs: line.endMs ?? null,
      // An explicit user mark always wins; otherwise fall back to containment,
      // which is only meaningful once we have actually been given a title.
      titlePhrase: line.titlePhrase ?? (normalizedTitle.length > 0 && normalized.includes(normalizedTitle)),
      hookPhrase: line.hookPhrase ?? false,
      repeatsLineIndex: earlier >= 0 && normalized.length > 0 ? earlier : null,
    }
  })

  const totalSyllables = lines.reduce((sum, line) => sum + line.syllableCount, 0)
  const totalWords = lines.reduce((sum, line) => sum + line.wordCount, 0)

  const sections = sectionMetrics(lines, input)
  const timedDuration = timedSpanSeconds(lines) ?? input.durationSeconds ?? null
  if (timedDuration === null) unavailable.push('syllables_per_second')

  const sectionsOfType = (type: string) => sections.filter((section) => section.sectionType === type)
  const perSecond = (list: SectionLyricMetrics[]): number | null => {
    const usable = list.filter((section) => section.syllablesPerSecond !== null)
    if (usable.length === 0) return null
    return round(usable.reduce((sum, section) => sum + (section.syllablesPerSecond ?? 0), 0) / usable.length)
  }

  const chorusPerSecond = perSecond([...sectionsOfType('chorus'), ...sectionsOfType('final_chorus')])
  const versePerSecond = perSecond(sectionsOfType('verse'))

  const hookLines = lines.filter((line) => line.hookPhrase || line.titlePhrase)
  const repeats = lines.filter((line) => line.repeatsLineIndex !== null).length

  const overlap = vocabularyOverlap(lines, input.sectionTypes ?? {})
  if (overlap === null) unavailable.push('verse_chorus_vocabulary_overlap')

  const allWords = lines.flatMap((line) => words(line.text))

  return {
    source: input.source,
    analysisVersion: LYRIC_ANALYSIS_VERSION,
    lines,
    sections,
    totalSyllables,
    totalWords,
    syllablesPerSecond: timedDuration && timedDuration > 0 ? round(totalSyllables / timedDuration) : null,
    chorusSyllablesPerSecond: chorusPerSecond,
    verseSyllablesPerSecond: versePerSecond,
    medianHookLineSyllables: hookLines.length > 0 ? median(hookLines.map((line) => line.syllableCount)) : null,
    titleRepetition: lines.filter((line) => line.titlePhrase).length,
    titlePlacement: titlePlacement(lines, input.sectionTypes ?? {}),
    hookRepetition: lines.filter((line) => line.hookPhrase).length,
    lyricRepetition: lines.length > 0 ? round((repeats / lines.length) * 100) : 0,
    verseChorusVocabularyOverlap: overlap,
    rhymeGroups: rhymeGroups(lines),
    questionLineRatio: lines.length > 0 ? round((lines.filter((line) => line.text.trim().endsWith('?')).length / lines.length) * 100) : 0,
    firstPersonRatio: ratioOf(allWords, FIRST_PERSON),
    secondPersonRatio: ratioOf(allWords, SECOND_PERSON),
    unavailable,
  }
}

function sectionMetrics(lines: AnalyzedLyricLine[], input: LyricAnalysisInput): SectionLyricMetrics[] {
  const grouped = new Map<number, AnalyzedLyricLine[]>()
  for (const line of lines) {
    if (line.sectionOrderIndex === null) continue
    const list = grouped.get(line.sectionOrderIndex) ?? []
    list.push(line)
    grouped.set(line.sectionOrderIndex, list)
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sectionOrderIndex, sectionLines]) => {
      const syllables = sectionLines.reduce((sum, line) => sum + line.syllableCount, 0)
      const seconds = input.sectionSeconds?.[sectionOrderIndex] ?? timedSpanSeconds(sectionLines)
      const sectionWords = sectionLines.flatMap((line) => words(line.text))
      return {
        sectionOrderIndex,
        sectionType: input.sectionTypes?.[sectionOrderIndex] ?? null,
        lineCount: sectionLines.length,
        syllableCount: syllables,
        syllablesPerSecond: seconds && seconds > 0 ? round(syllables / seconds) : null,
        medianLineSyllables: median(sectionLines.map((line) => line.syllableCount)),
        longestLineSyllables: Math.max(0, ...sectionLines.map((line) => line.syllableCount)),
        uniqueWordRatio: sectionWords.length > 0 ? round(new Set(sectionWords).size / sectionWords.length) : 0,
        titleAppearances: sectionLines.filter((line) => line.titlePhrase).length,
      }
    })
}

function titlePlacement(
  lines: AnalyzedLyricLine[],
  sectionTypes: Record<number, string>,
): Array<{ sectionOrderIndex: number; sectionType: string | null; count: number }> {
  const counts = new Map<number, number>()
  for (const line of lines) {
    if (!line.titlePhrase || line.sectionOrderIndex === null) continue
    counts.set(line.sectionOrderIndex, (counts.get(line.sectionOrderIndex) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sectionOrderIndex, count]) => ({ sectionOrderIndex, sectionType: sectionTypes[sectionOrderIndex] ?? null, count }))
}

/** Jaccard overlap of verse and chorus vocabulary. Null when either is absent. */
function vocabularyOverlap(lines: AnalyzedLyricLine[], sectionTypes: Record<number, string>): number | null {
  const collect = (types: string[]) => {
    const set = new Set<string>()
    for (const line of lines) {
      if (line.sectionOrderIndex === null) continue
      if (!types.includes(sectionTypes[line.sectionOrderIndex] ?? '')) continue
      for (const word of words(line.text)) set.add(word)
    }
    return set
  }
  const verse = collect(['verse'])
  const chorus = collect(['chorus', 'final_chorus'])
  if (verse.size === 0 || chorus.size === 0) return null
  let shared = 0
  for (const word of chorus) if (verse.has(word)) shared++
  const union = new Set([...verse, ...chorus]).size
  return union > 0 ? round((shared / union) * 100) : null
}

function rhymeGroups(lines: AnalyzedLyricLine[]): Array<{ key: string; lineIndexes: number[] }> {
  const groups = new Map<string, number[]>()
  for (const line of lines) {
    if (!line.rhymeKey) continue
    const list = groups.get(line.rhymeKey) ?? []
    list.push(line.index)
    groups.set(line.rhymeKey, list)
  }
  return [...groups.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([key, lineIndexes]) => ({ key, lineIndexes }))
    .sort((a, b) => b.lineIndexes.length - a.lineIndexes.length)
}

function timedSpanSeconds(lines: AnalyzedLyricLine[]): number | null {
  const timed = lines.filter((line) => line.startMs !== null && line.endMs !== null)
  if (timed.length === 0) return null
  const start = Math.min(...timed.map((line) => line.startMs!))
  const end = Math.max(...timed.map((line) => line.endMs!))
  return end > start ? (end - start) / 1000 : null
}

function ratioOf(list: string[], set: Set<string>): number {
  if (list.length === 0) return 0
  return round((list.filter((word) => set.has(word)).length / list.length) * 100)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Splits a pasted lyric sheet into lines, honouring blank-line section breaks
 * and `[Chorus]` style headers. Headers are *hints*: the user confirms the real
 * section mapping in the structure editor, which stays authoritative.
 */
export function parseLyricSheet(text: string): Array<{ text: string; sectionHint: string | null }> {
  const out: Array<{ text: string; sectionHint: string | null }> = []
  let hint: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const header = line.match(/^[[(]([^\])]+)[\])]$/)
    if (header) {
      hint = header[1]!.trim().toLowerCase().replace(/\s+\d+$/, '').replace(/[\s-]+/g, '_')
      continue
    }
    out.push({ text: line, sectionHint: hint })
  }
  return out
}
