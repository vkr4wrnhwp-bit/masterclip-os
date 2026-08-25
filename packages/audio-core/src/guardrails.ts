/**
 * Operator agent guardrails.
 *
 * The voice/chat agent qualifies and routes; humans decide. These checks run on
 * every outbound agent reply and every inbound user turn, in our server, so a
 * provider-side prompt failure cannot turn into a commitment Street Banker
 * never made.
 */

export interface GuardrailHit {
  code: string
  phrase: string
}

interface Rule {
  code: string
  pattern: RegExp
}

/**
 * Things the agent must never say. Matched against outbound replies; a hit
 * replaces the reply with a safe correction and flags the conversation.
 */
const FORBIDDEN_COMMITMENT_RULES: Rule[] = [
  { code: 'promise_acceptance', pattern: /\byou\s+(are|'re|have\s+been|will\s+be)\s+(accepted|approved)\b/i },
  { code: 'promise_acceptance', pattern: /\bwe\s+(accept|approve)\s+your\b/i },
  { code: 'promise_funding', pattern: /\b(guarantee|promise)\w*\s+(you\s+)?(funding|an?\s+advance|money)\b/i },
  { code: 'deal_approval', pattern: /\b(the\s+)?deal\s+is\s+(approved|done|confirmed)\b/i },
  { code: 'guarantee_streams', pattern: /\bguarantee\w*\s+(you\s+)?\d*\s*(streams|plays|listeners)\b/i },
  { code: 'guarantee_playlists', pattern: /\bguarantee\w*\s+(you\s+)?playlist/i },
  { code: 'guarantee_press', pattern: /\bguarantee\w*\s+(you\s+)?(pr|press|coverage)\b/i },
  { code: 'guarantee_recovery', pattern: /\bguarantee\w*\s+(you\s+)?(royalt\w+|recover\w+)\b/i },
  { code: 'owed_money_claim', pattern: /\byou\s+are\s+(definitely|certainly)\s+owed\b/i },
  { code: 'legal_advice', pattern: /\bthis\s+(contract|clause)\s+(means|entitles|obligates)\b/i },
]

/**
 * Signals in a user turn that route to a human. Detection is deliberately
 * generous — a false transfer costs an operator a few minutes, a missed one
 * costs the caller their trust.
 */
const ESCALATION_RULES: Rule[] = [
  { code: 'human_requested', pattern: /\b(speak|talk)\s+(to|with)\s+a?\s*(human|person|operator|someone\s+real)\b/i },
  { code: 'human_requested', pattern: /\b(real\s+person|actual\s+human)\b/i },
  { code: 'legal_interpretation', pattern: /\b(is\s+this\s+contract|clause|legally|lawyer|attorney|legal\s+advice)\b/i },
  { code: 'financial_dispute', pattern: /\b(dispute|chargeback|missing\s+(payment|royalt\w+)|didn'?t\s+get\s+paid|owed\s+money)\b/i },
  { code: 'negotiation', pattern: /\b(negotiate|counter[- ]?offer|better\s+(rate|split|terms))\b/i },
  { code: 'distress', pattern: /\b(furious|angry|scam|fraud|sue|lawsuit|unacceptable|fed\s+up)\b/i },
  { code: 'sensitive_account', pattern: /\b(change\s+my\s+(bank|payout|password)|close\s+my\s+account|tax\s+form)\b/i },
]

function findHits(text: string, rules: Rule[]): GuardrailHit[] {
  const hits: GuardrailHit[] = []
  for (const rule of rules) {
    const match = text.match(rule.pattern)
    if (match) hits.push({ code: rule.code, phrase: match[0].trim() })
  }
  return hits
}

export function screenAgentReply(reply: string): { ok: boolean; hits: GuardrailHit[] } {
  const hits = findHits(reply, FORBIDDEN_COMMITMENT_RULES)
  return { ok: hits.length === 0, hits }
}

export function detectEscalation(userTurn: string): GuardrailHit[] {
  return findHits(userTurn, ESCALATION_RULES)
}

export const SAFE_CORRECTION_REPLY =
  'I can’t make commitments like that — decisions about deals, approvals, and outcomes are made by ' +
  'Street Banker’s human team. I can collect your details and set up a conversation with an operator ' +
  'who can actually help. Would you like that?'

export const HUMAN_TRANSFER_REPLY =
  'Let me get you to a Street Banker operator. I’ll pass along what we’ve discussed so you don’t have ' +
  'to repeat yourself.'
