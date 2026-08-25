import type {
  AgentConversationClassification,
  AgentConversationClassificationRequest,
  ExtractedActionItem,
  ExtractedDate,
  ExtractedDealVariable,
  ExtractedDecision,
  ExtractedPerson,
  MeetingIntelligenceExtractionRequest,
  MeetingIntelligenceResult,
  SignalBriefRequest,
  SignalBriefResult,
  StructuredReasoningProvider,
  TranscriptSegmentData,
} from '@masterclip/audio-core'

/**
 * Deterministic, offline meeting extraction.
 *
 * This is the floor, not the ceiling: pattern-based extraction that makes demo
 * mode, tests, and credential-free deployments work end to end. Everything it
 * emits is conservatively labelled — deal variables it pattern-matches are
 * `inferred` at best, never `explicit`, because a regex cannot know a term was
 * agreed. The Claude-backed provider replaces it when configured; the human
 * approval gate applies to both equally.
 */
export class HeuristicReasoningProvider implements StructuredReasoningProvider {
  readonly providerId = 'heuristic'

  async extractMeetingIntelligence(input: MeetingIntelligenceExtractionRequest): Promise<MeetingIntelligenceResult> {
    const segments = input.transcript.segments
    const text = input.transcript.fullText

    const actionItems = extractActionItems(segments)
    const dealVariables = extractDealVariables(segments)
    const risks = extractRisks(segments)
    const dates = extractDates(segments)
    const decisions = extractDecisions(segments)
    const people = extractPeople(input.speakerNames)
    const openQuestions = extractOpenQuestions(segments)

    const firstSentence = text.split(/(?<=[.!?])\s+/)[0] ?? 'Conversation recorded.'
    return {
      summary:
        `${input.meetingType} conversation with ${segments.filter((s) => s.speakerKey).map((s) => s.speakerKey).filter((v, i, a) => a.indexOf(v) === i).length || 1} ` +
        `speaker(s). Opens with: "${firstSentence.slice(0, 160)}" — ${actionItems.length} draft action item(s), ` +
        `${dealVariables.length} possible deal variable(s), ${risks.length} flagged risk(s). Heuristic extraction; verify before relying on it.`,
      purpose: `Recorded ${input.meetingType.toLowerCase()} conversation`,
      situation: 'Extracted offline by the heuristic engine — treat every field as a draft needing review.',
      opportunity: dealVariables.length > 0 ? 'Possible deal terms were discussed; confirm them with the participants.' : 'No deal terms detected.',
      blockers: risks.slice(0, 3),
      people,
      dealVariables,
      dates,
      actionItems,
      decisions,
      risks,
      openQuestions,
      engine: 'heuristic',
      costMicros: 0,
    }
  }

  async generateSignalBrief(input: SignalBriefRequest): Promise<SignalBriefResult> {
    const lines: string[] = [
      `${input.title}. This is your ${input.briefType.replace(/_/g, ' ')} from Street Banker.`,
    ]
    for (const item of input.items) {
      // Confidence language survives verbatim — an audio brief must not turn
      // "needs verification" into a stated fact.
      const qualifier =
        item.confidence === 'confirmed' ? '' : item.confidence === 'likely' ? 'Likely, not yet confirmed: ' : 'Needs verification: '
      lines.push(`${qualifier}${item.statement}`)
    }
    lines.push('That is the brief. Details and sources are in your Street Banker dashboard.')
    const script = lines.join(' ')
    return { script, wordCount: script.split(/\s+/).length, engine: 'heuristic', costMicros: 0 }
  }

  async classifyAgentConversation(input: AgentConversationClassificationRequest): Promise<AgentConversationClassification> {
    const userText = input.turns.filter((t) => t.role === 'user').map((t) => t.text).join(' ')
    const email = userText.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0]
    const phone = userText.match(/\+?\d[\d\s().-]{7,}\d/)?.[0]
    const distribution = /\b(distribut|release|single|album|ep|catalog)\b/i.test(userText)
    const royalties = /\b(royalt|owed|payment|collect)\b/i.test(userText)
    const intent = distribution ? 'distribution' : royalties ? 'royalties' : 'general'
    const signals = [email, phone, distribution || royalties ? 'topic' : null].filter(Boolean).length
    return {
      intent,
      leadQuality: signals >= 2 ? 'medium' : 'unknown',
      humanFollowUpRecommended: royalties || /human|operator|person/i.test(userText),
      summary: `Inbound ${intent} conversation, ${input.turns.length} turns.`,
      contact: { ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
      engine: 'heuristic',
      costMicros: 0,
    }
  }
}

const ACTION_PATTERNS = [
  /\baction (?:for|item)[:\s]/i,
  /\b(?:i|we|you)(?:'ll| will| need to| should| must)\s+(send|check|confirm|share|prepare|schedule|follow up|review|draft|get)\b/i,
  /\bneed (?:the|a|an)\s+.{3,40}\bby\b/i,
]

function extractActionItems(segments: TranscriptSegmentData[]): ExtractedActionItem[] {
  const items: ExtractedActionItem[] = []
  for (const segment of segments) {
    for (const sentence of splitSentences(segment.text)) {
      if (ACTION_PATTERNS.some((p) => p.test(sentence))) {
        items.push({
          description: sentence.trim(),
          confidence: 0.5,
          sourceStartMs: segment.startMs,
          sourceEndMs: segment.endMs,
        })
        break
      }
    }
  }
  return items.slice(0, 20)
}

const DEAL_PATTERNS: Array<{ type: string; pattern: RegExp }> = [
  { type: 'fee', pattern: /\b(\d{1,2})\s*(?:percent|%)\s*(?:distribution\s+)?fee\b/i },
  { type: 'fee', pattern: /\bfee\s+of\s+(\d{1,2})\s*(?:percent|%)/i },
  { type: 'term', pattern: /\b(one|two|three|four|five|\d+)\s*[- ]?year\s+(?:license|term|deal)\b/i },
  { type: 'territory', pattern: /\b(worldwide|global|north america|europe|latin america|asia|[A-Z]{2,3} territory)\b/i },
  { type: 'advance', pattern: /\badvance\s+of\s+([$€£]?[\d,]+k?)/i },
  { type: 'marketing_spend', pattern: /\bmarketing\s+(?:spend|budget)\b/i },
  { type: 'ownership', pattern: /\b(own|keep|retain)\w*\s+(?:the\s+)?(masters?|rights|\d{1,3}\s*(?:percent|%))\b/i },
  { type: 'recoupment', pattern: /\brecoup\w*\b/i },
  { type: 'publishing', pattern: /\bpublishing\s+(?:share|split|deal)\b/i },
  { type: 'sync', pattern: /\bsync\s+(?:license|rights|deal)\b/i },
]

function extractDealVariables(segments: TranscriptSegmentData[]): ExtractedDealVariable[] {
  const found: ExtractedDealVariable[] = []
  const seen = new Set<string>()
  for (const segment of segments) {
    for (const { type, pattern } of DEAL_PATTERNS) {
      const match = segment.text.match(pattern)
      if (!match) continue
      const key = `${type}:${match[0].toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({
        variableType: type,
        value: match[0].trim(),
        // A pattern match is never an agreed term.
        extractionType: /\bpropos|would|could|maybe|thinking\b/i.test(segment.text) ? 'needs_verification' : 'inferred',
        confidence: 0.45,
        sourceStartMs: segment.startMs,
        sourceEndMs: segment.endMs,
      })
    }
  }
  return found.slice(0, 20)
}

const RISK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'rights issue', pattern: /\b(content id|claim|rights issue|clearance|uncleared|sample)\b/i },
  { label: 'split issue', pattern: /\b(split|percentage disagreement|who gets)\b/i },
  { label: 'distributor issue', pattern: /\b(old distributor|previous distributor|takedown|still claims)\b/i },
  { label: 'deadline risk', pattern: /\b(tight deadline|running late|slip|delay)\b/i },
  { label: 'missing information', pattern: /\b(need.{0,20}(isrc|upc|contract|paperwork)|missing)\b/i },
]

function extractRisks(segments: TranscriptSegmentData[]): string[] {
  const risks: string[] = []
  for (const segment of segments) {
    for (const { label, pattern } of RISK_PATTERNS) {
      if (pattern.test(segment.text)) {
        risks.push(`${label}: "${segment.text.slice(0, 120)}"`)
        break
      }
    }
  }
  return [...new Set(risks)].slice(0, 10)
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december'

function extractDates(segments: TranscriptSegmentData[]): ExtractedDate[] {
  const dates: ExtractedDate[] = []
  const pattern = new RegExp(`\\b(?:by |on |before |in )?((?:${MONTHS})(?:\\s+\\d{1,2})?|friday|monday|tuesday|wednesday|thursday|saturday|sunday|next week|q[1-4])\\b`, 'gi')
  for (const segment of segments) {
    for (const match of segment.text.matchAll(pattern)) {
      dates.push({ label: segment.text.slice(0, 100), date: match[1]!, kind: /release/i.test(segment.text) ? 'release' : /tour/i.test(segment.text) ? 'tour' : 'follow_up' })
    }
  }
  return dates.slice(0, 10)
}

function extractDecisions(segments: TranscriptSegmentData[]): ExtractedDecision[] {
  const decisions: ExtractedDecision[] = []
  for (const segment of segments) {
    if (/\b(agreed|we(?:'ll| will) go with|decided|confirmed|deal)\b/i.test(segment.text) && !/\bnot\b/i.test(segment.text)) {
      decisions.push({
        decision: segment.text.slice(0, 160),
        participants: segment.speakerKey ? [segment.speakerKey] : [],
        status: /\bcould|maybe|probably\b/i.test(segment.text) ? 'tentative' : 'agreed',
        sourceStartMs: segment.startMs,
      })
    }
  }
  return decisions.slice(0, 10)
}

function extractPeople(speakerNames: Record<string, string>): ExtractedPerson[] {
  return Object.entries(speakerNames).map(([, name]) => ({ name, role: 'participant' }))
}

function extractOpenQuestions(segments: TranscriptSegmentData[]): string[] {
  const questions: string[] = []
  for (const segment of segments) {
    for (const sentence of splitSentences(segment.text)) {
      if (sentence.trim().endsWith('?') || /\bneeds verification|unconfirmed|not sure|tbd\b/i.test(sentence)) {
        questions.push(sentence.trim().slice(0, 160))
      }
    }
  }
  return [...new Set(questions)].slice(0, 10)
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/)
}
