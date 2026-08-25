/**
 * Keyterm dictionary assembly.
 *
 * Organizations maintain a dictionary of music-industry terms (artists,
 * managers, labels, distributors, venues, ISRCs, release names, deal
 * terminology…) used to bias transcription. Two constraints shape this file:
 * the provider's documented limits (term length, word count, forbidden
 * characters, total count), and the tenant's privacy — terms marked private
 * never leave the platform, they exist only for internal search and display.
 */

export type KeytermSensitivity = 'shareable' | 'private'

export interface KeytermEntry {
  term: string
  category: string
  sensitivity: KeytermSensitivity
}

/** Provider-documented limits for keyterm prompting. */
export const KEYTERM_LIMITS = {
  maxTerms: 1000,
  maxLength: 50,
  maxWords: 5,
} as const

const FORBIDDEN_CHARS = /[<>{}[\]\\]/g

export function sanitizeKeyterm(raw: string): string | null {
  const cleaned = raw.replace(FORBIDDEN_CHARS, '').replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0 || cleaned.length > KEYTERM_LIMITS.maxLength) return null
  if (cleaned.split(' ').length > KEYTERM_LIMITS.maxWords) return null
  return cleaned
}

/**
 * Builds the provider-bound keyterm list: shareable terms only, sanitised,
 * de-duplicated case-insensitively, capped at the provider limit.
 */
export function assembleKeyterms(entries: KeytermEntry[], extra: string[] = []): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const candidates = [
    ...entries.filter((e) => e.sensitivity === 'shareable').map((e) => e.term),
    ...extra,
  ]
  for (const candidate of candidates) {
    const term = sanitizeKeyterm(candidate)
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= KEYTERM_LIMITS.maxTerms) break
  }
  return out
}

export const KEYTERM_CATEGORIES = [
  'artist',
  'manager',
  'company',
  'label',
  'distributor',
  'publisher',
  'venue',
  'city',
  'isrc',
  'upc',
  'release',
  'product',
  'deal_term',
  'acronym',
  'other',
] as const

export type KeytermCategory = (typeof KEYTERM_CATEGORIES)[number]

/** Deal and platform vocabulary every org starts with. All shareable, all generic. */
export const BASE_INDUSTRY_KEYTERMS: KeytermEntry[] = [
  ...['advance', 'recoupment', 'flow-through', 'reversion', 'buyout', 'sync license', 'mechanical royalties', 'neighboring rights', 'Content ID', 'split sheet', 'master rights', 'publishing share', 'territory carve-out', 'MFN clause', 'distribution fee'].map(
    (term) => ({ term, category: 'deal_term', sensitivity: 'shareable' as const }),
  ),
  ...['ISRC', 'UPC', 'DSP', 'PRO', 'A&R', 'EPK', 'DIY', 'one-sheet'].map((term) => ({
    term,
    category: 'acronym',
    sensitivity: 'shareable' as const,
  })),
  ...['Street Banker', 'Royalty Sweep', 'Operator Desk', 'Remix Lab', 'Signal Brief', 'Global Release Pack'].map((term) => ({
    term,
    category: 'product',
    sensitivity: 'shareable' as const,
  })),
]
