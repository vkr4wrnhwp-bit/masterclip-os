/**
 * Syllable counting.
 *
 * A vowel-group heuristic with the exception rules that matter most in sung
 * English (silent terminal `e`, `-le` endings, `-ed` past tense, dipthong
 * pairs). It is a heuristic and is labelled as one: syllable *architecture* —
 * whether one line is much denser than another — survives a small per-word
 * error, whereas an absolute claim about a single line would not.
 */

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y'])

/** Words the heuristic reliably gets wrong, and the counts they actually have. */
const EXCEPTIONS: Record<string, number> = {
  the: 1, are: 1, were: 1, gone: 1, come: 1, some: 1, love: 1, live: 1, give: 1, have: 1,
  once: 1, twice: 1, though: 1, through: 1, thought: 1, world: 1, girl: 1, fire: 2, hour: 1,
  our: 1, every: 3, everything: 4, everyone: 3, being: 2, doing: 2, going: 2, million: 3,
  radio: 3, real: 1, really: 2, quiet: 2, science: 2, poem: 2, idea: 3, area: 3, create: 2,
}

export function countSyllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z']/g, '')
  if (clean.length === 0) return 0
  const known = EXCEPTIONS[clean]
  if (known !== undefined) return known
  if (clean.length <= 3) return 1

  let count = 0
  let previousWasVowel = false
  for (let i = 0; i < clean.length; i++) {
    const isVowel = VOWELS.has(clean[i]!)
    if (isVowel && !previousWasVowel) count++
    previousWasVowel = isVowel
  }

  // Silent terminal `e` ("time" is one syllable), unless the word ends `-le`
  // after a consonant ("little" is two) — there the `e` is sounded, and the
  // vowel-group pass has already counted it, so the exception is to *skip* the
  // decrement rather than to add anything back.
  if (clean.endsWith('e') && !clean.endsWith('le') && count > 1) count--
  // `-ed` is only its own syllable after t or d ("wanted", not "walked").
  if (clean.endsWith('ed') && !/[td]ed$/.test(clean) && count > 1) count--
  return Math.max(1, count)
}

export function countSyllablesInLine(line: string): number {
  return words(line).reduce((total, word) => total + countSyllables(word), 0)
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Vowel-sound share — a rough proxy for how open and singable a line is. */
export function vowelDensity(line: string): number {
  const letters = line.toLowerCase().replace(/[^a-z]/g, '')
  if (letters.length === 0) return 0
  let vowels = 0
  for (const character of letters) if (VOWELS.has(character)) vowels++
  return Math.round((vowels / letters.length) * 1000) / 1000
}

export function consonantDensity(line: string): number {
  const density = vowelDensity(line)
  return density === 0 ? 0 : Math.round((1 - density) * 1000) / 1000
}

/**
 * The rhyme key: the terminal vowel group plus everything after it.
 *
 * Orthographic, not phonetic — it catches `night`/`light` and misses
 * `night`/`bite`. Good enough to show rhyme *placement* patterns, which is what
 * the lyric view claims to show.
 */
export function rhymeKey(line: string): string | null {
  const list = words(line)
  const last = list[list.length - 1]
  if (!last) return null
  const clean = last.replace(/[^a-z]/g, '')
  const match = clean.match(/([aeiouy]+[^aeiouy]*)$/)
  return match?.[1] ?? null
}
