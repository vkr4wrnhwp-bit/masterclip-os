/**
 * Prompt moderation for Remix Lab and the Campaign Audio Toolkit.
 *
 * The platform refuses imitation of real people and protected works up front,
 * in our own request path, before a provider ever sees the prompt. Neutral
 * musical descriptors (tempo, energy, mood, era, structure…) pass; references
 * that use a real artist, song, label or voice as the thing to copy do not.
 *
 * The refusal is a policy message, never an accusation — a blocked prompt means
 * "this platform does not do that", not "you are infringing".
 */

export interface ModerationHit {
  code: string
  phrase: string
}

export interface ModerationVerdict {
  allowed: boolean
  hits: ModerationHit[]
  /** User-facing, non-accusatory explanation when blocked. */
  message: string | null
}

interface Rule {
  code: string
  pattern: RegExp
}

/**
 * Imitation phrasing. Matched case-insensitively against the whole prompt.
 * Kept deliberately blunt: a false positive costs a reworded prompt, a false
 * negative costs an artist their voice.
 */
const IMITATION_RULES: Rule[] = [
  { code: 'style_imitation', pattern: /\bsounds?\s+(exactly\s+)?like\b/i },
  { code: 'style_imitation', pattern: /\bin\s+the\s+style\s+of\b/i },
  { code: 'style_imitation', pattern: /\bstyle\s+of\s+[A-Z]/ },
  { code: 'voice_imitation', pattern: /\buse\s+(his|her|their|its)\s+voice\b/i },
  { code: 'voice_imitation', pattern: /\bclone\s+(his|her|their|a|the|.{0,30}?)\s*voice\b/i },
  { code: 'voice_imitation', pattern: /\bvoice\s+clone\b/i },
  { code: 'style_imitation', pattern: /\bsame\s+flow\s+as\b/i },
  { code: 'lyric_copy', pattern: /\bsame\s+lyrics\s+as\b/i },
  { code: 'ai_cover', pattern: /\bai\s+cover\b/i },
  { code: 'impersonation', pattern: /\bimpersonat\w*/i },
  { code: 'impersonation', pattern: /\bdeep\s*fake\w*/i },
  { code: 'recording_recreation', pattern: /\brecreate\s+(the\s+)?(song|track|record|recording|beat)\b/i },
  { code: 'style_imitation', pattern: /\btype\s+beat\b/i },
]

/** Political / endorsement misuse for voiceover prompts. */
const VOICE_MISUSE_RULES: Rule[] = [
  { code: 'impersonation', pattern: /\bimpersonat\w*/i },
  { code: 'impersonation', pattern: /\bdeep\s*fake\w*/i },
  { code: 'false_endorsement', pattern: /\bendorse(s|d|ment)?\s+by\b/i },
  { code: 'news_impersonation', pattern: /\bbreaking\s+news\b/i },
  { code: 'voice_imitation', pattern: /\b(sound|talk|speak)s?\s+(exactly\s+)?like\s+[A-Z]/ },
]

export const BLOCKED_PROMPT_MESSAGE =
  'This request was not sent to the provider. Remix Lab works from your own audio and neutral musical ' +
  'descriptors — tempo, energy, instrumentation, rhythm, structure, era, mood, texture, intended use. It does ' +
  'not imitate a real artist, producer, songwriter, song, album, label, voice, flow, or lyrics. Remove the ' +
  'reference and describe the sound you want instead.'

export const BLOCKED_VOICE_MESSAGE =
  'This request was not sent to the provider. Campaign audio uses Street Banker-approved catalog voices or ' +
  'verified voices from the Artist Voice Vault. It does not imitate public figures, imply endorsements, or ' +
  'present generated speech as news.'

function findHits(prompt: string, rules: Rule[]): ModerationHit[] {
  const hits: ModerationHit[] = []
  for (const rule of rules) {
    const match = prompt.match(rule.pattern)
    if (match) hits.push({ code: rule.code, phrase: match[0].trim() })
  }
  return hits
}

/**
 * Matches org-configured protected names (artists on roster, producers,
 * labels, publishers) used as references. Plain word-boundary matching — a
 * roster name inside a prompt for generation is a reference we refuse to
 * imitate regardless of surrounding words.
 */
function findProtectedNames(prompt: string, protectedNames: string[]): ModerationHit[] {
  const hits: ModerationHit[] = []
  const lower = prompt.toLowerCase()
  for (const name of protectedNames) {
    const needle = name.trim().toLowerCase()
    if (needle.length < 3) continue
    const index = lower.indexOf(needle)
    if (index === -1) continue
    const before = index === 0 ? ' ' : lower[index - 1]!
    const after = index + needle.length >= lower.length ? ' ' : lower[index + needle.length]!
    if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue
    hits.push({ code: 'protected_name', phrase: name.trim() })
  }
  return hits
}

export function screenRemixPrompt(prompt: string, opts: { protectedNames?: string[] } = {}): ModerationVerdict {
  const hits = [...findHits(prompt, IMITATION_RULES), ...findProtectedNames(prompt, opts.protectedNames ?? [])]
  return { allowed: hits.length === 0, hits, message: hits.length === 0 ? null : BLOCKED_PROMPT_MESSAGE }
}

export function screenVoicePrompt(prompt: string, opts: { protectedNames?: string[] } = {}): ModerationVerdict {
  const hits = [...findHits(prompt, VOICE_MISUSE_RULES), ...findProtectedNames(prompt, opts.protectedNames ?? [])]
  return { allowed: hits.length === 0, hits, message: hits.length === 0 ? null : BLOCKED_VOICE_MESSAGE }
}

/**
 * Screening shown when a provider declines an owned-audio upload. The wording
 * is deliberate: the provider result is recorded, the artist is not accused,
 * and the paths forward (human review, documentation) are stated.
 */
export const PROVIDER_RIGHTS_REVIEW_MESSAGE =
  'Provider rights review required. The audio provider declined to process this upload automatically. ' +
  'Your rights confirmation is on record. A Street Banker reviewer will look at it, and you can attach ' +
  'ownership documentation to speed that up. Nothing about this result is a finding about your rights.'
