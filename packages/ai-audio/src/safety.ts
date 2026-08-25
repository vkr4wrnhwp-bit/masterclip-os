/**
 * Prompt safety for AI audio generation.
 *
 * Live Lab generates performance material from audio the artist owns. It must
 * not become a tool for imitating real people. These checks are heuristic and
 * deliberately err toward refusal: a blocked prompt can always be rephrased
 * with neutral musical descriptors ("dark, sparse, 90 BPM, heavy sub bass"),
 * an imitation that slips through cannot be unshipped.
 *
 * A real deployment should back this with a provider-side policy check as
 * well; this layer is the floor, not the ceiling.
 */

export interface SafetyVerdict {
  allowed: boolean
  reason: string | null
}

interface BlockedPattern {
  pattern: RegExp
  reason: string
}

const BLOCKED: BlockedPattern[] = [
  {
    pattern: /\b(in|after)\s+the\s+style\s+of\s+\S+/i,
    reason: 'describing a style by naming an artist or producer is not allowed — use neutral musical descriptors instead',
  },
  {
    pattern: /\b(sound|sounds|sounding)\s+(exactly\s+)?like\s+[A-Z][\w.$-]*/,
    reason: 'requesting audio that sounds like a named artist is not allowed — describe tempo, energy and instrumentation instead',
  },
  {
    pattern: /\btype\s*beat\b/i,
    reason: '"type beat" requests imitate a named artist — describe the musical qualities you want instead',
  },
  {
    pattern: /\b(imitate|imitating|impersonate|impersonating|mimic|mimicking)\b/i,
    reason: 'imitating a real person is not allowed',
  },
  {
    pattern: /\bvoice\s+(of|clone|cloning|like)\b/i,
    reason: 'voice cloning requires verified consent through the rights workflow, not a text prompt',
  },
  {
    pattern: /\b(clone|cloning|deepfake)\b/i,
    reason: 'cloning a real person’s voice or performance is not allowed',
  },
  {
    pattern: /\b(ai\s+)?cover\s+of\b/i,
    reason: 'recreating protected songs is not allowed — Live Lab works from audio you own',
  },
  {
    pattern: /\bremake\s+(of\s+)?["“]/i,
    reason: 'recreating protected songs is not allowed',
  },
  {
    pattern: /\b(sample|interpolate|interpolation\s+of)\s+["“]/i,
    reason: 'sampling requires cleared rights — import the cleared audio as an owned asset instead of prompting for it',
  },
  {
    pattern: /\bproduced\s+by\s+[A-Z][\w.$-]*/,
    reason: 'naming a real producer as the target sound is not allowed — describe the production qualities instead',
  },
]

export function checkPromptSafety(prompt: string): SafetyVerdict {
  const trimmed = prompt.trim()
  if (trimmed.length === 0) return { allowed: false, reason: 'prompt is empty' }
  for (const { pattern, reason } of BLOCKED) {
    if (pattern.test(trimmed)) return { allowed: false, reason }
  }
  return { allowed: true, reason: null }
}
