import type { AnthropicClient } from '@masterclip/agents'
import type {
  AgentConversationClassification,
  AgentConversationClassificationRequest,
  MeetingIntelligenceExtractionRequest,
  MeetingIntelligenceResult,
  SignalBriefRequest,
  SignalBriefResult,
  StructuredReasoningProvider,
} from '@masterclip/audio-core'
import { HeuristicReasoningProvider } from './heuristic.js'

/**
 * Claude-backed structured reasoning.
 *
 * Extraction quality comes from the model; safety comes from the schema and the
 * prompts: every deal variable must be labelled explicit / inferred /
 * needs_verification, briefs must preserve confidence language, and nothing
 * here bypasses the human approval gate. Falls back to the heuristic engine on
 * any model failure so a provider outage never breaks the meeting pipeline.
 */
export class ClaudeReasoningProvider implements StructuredReasoningProvider {
  readonly providerId = 'claude'
  private readonly fallback = new HeuristicReasoningProvider()

  constructor(
    private readonly client: AnthropicClient,
    private readonly model?: string,
  ) {}

  async extractMeetingIntelligence(input: MeetingIntelligenceExtractionRequest): Promise<MeetingIntelligenceResult> {
    if (!this.client.isConfigured()) return this.fallback.extractMeetingIntelligence(input)
    try {
      const transcriptText = input.transcript.segments
        .map((s) => `[${msToClock(s.startMs)}] ${s.speakerKey ? (input.speakerNames[s.speakerKey] ?? s.speakerKey) : 'sound'}: ${s.text}`)
        .join('\n')
      const result = await this.client.complete<Omit<MeetingIntelligenceResult, 'engine' | 'costMicros'>>({
        ...(this.model ? { model: this.model } : {}),
        system:
          'You extract structured intelligence from music-industry meeting transcripts for the Street Banker ' +
          'Operator Desk. Rules that are not negotiable: (1) every deal variable carries extractionType ' +
          '"explicit" only when the transcript states it plainly, "inferred" when you concluded it, ' +
          '"needs_verification" when it is ambiguous — never present an inferred term as agreed; (2) do not ' +
          'invent people, dates, or numbers absent from the transcript; (3) risks include rights, split, ' +
          'distributor, deal, fraud, and deadline concerns; (4) open questions list missing documents, ' +
          'contacts, unconfirmed rights, unresolved terms; (5) all output is a DRAFT a human will review.',
        userText: `Meeting type: ${input.meetingType}\n${input.leadContext ? `Lead: ${input.leadContext.name}\n` : ''}Transcript:\n${transcriptText}`,
        maxTokens: 4096,
        cacheSystem: true,
        jsonSchema: {
          name: 'meeting_intelligence',
          description: 'Structured meeting extraction',
          schema: MEETING_SCHEMA,
        },
      })
      if (!result.json) return this.fallback.extractMeetingIntelligence(input)
      return { ...result.json, engine: result.model, costMicros: result.costMicros }
    } catch {
      return this.fallback.extractMeetingIntelligence(input)
    }
  }

  async generateSignalBrief(input: SignalBriefRequest): Promise<SignalBriefResult> {
    if (!this.client.isConfigured()) return this.fallback.generateSignalBrief(input)
    try {
      const result = await this.client.complete<{ script: string }>({
        ...(this.model ? { model: this.model } : {}),
        system:
          'You write short spoken briefing scripts for music-industry executives. Rules: use ONLY the facts ' +
          'provided; keep each item\'s confidence language — an item marked "likely" is said as likely, an ' +
          'item marked "needs_verification" is said as needing verification, never as fact; no contract ' +
          'language, no sensitive personal data, no hype. 150-300 words, natural to read aloud.',
        userText: JSON.stringify({ title: input.title, briefType: input.briefType, audience: input.audience, items: input.items }),
        maxTokens: 1200,
        cacheSystem: true,
        jsonSchema: {
          name: 'brief_script',
          description: 'Spoken brief script',
          schema: { type: 'object', required: ['script'], properties: { script: { type: 'string' } } },
        },
      })
      const script = result.json?.script
      if (!script) return this.fallback.generateSignalBrief(input)
      return { script, wordCount: script.split(/\s+/).length, engine: result.model, costMicros: result.costMicros }
    } catch {
      return this.fallback.generateSignalBrief(input)
    }
  }

  async classifyAgentConversation(input: AgentConversationClassificationRequest): Promise<AgentConversationClassification> {
    if (!this.client.isConfigured()) return this.fallback.classifyAgentConversation(input)
    try {
      const result = await this.client.complete<Omit<AgentConversationClassification, 'engine' | 'costMicros'>>({
        ...(this.model ? { model: this.model } : {}),
        system:
          'You classify inbound conversations for a music distribution intake desk. Extract only contact ' +
          'details the user volunteered. leadQuality is "unknown" unless there is concrete evidence. ' +
          'Recommend human follow-up for disputes, legal questions, negotiations, or distress.',
        userText: input.turns.map((t) => `${t.role}: ${t.text}`).join('\n'),
        maxTokens: 800,
        jsonSchema: {
          name: 'conversation_classification',
          description: 'Intake conversation classification',
          schema: CLASSIFY_SCHEMA,
        },
      })
      if (!result.json) return this.fallback.classifyAgentConversation(input)
      return { ...result.json, engine: result.model, costMicros: result.costMicros }
    } catch {
      return this.fallback.classifyAgentConversation(input)
    }
  }
}

function msToClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

const MEETING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['summary', 'purpose', 'situation', 'opportunity', 'blockers', 'people', 'dealVariables', 'dates', 'actionItems', 'decisions', 'risks', 'openQuestions'],
  properties: {
    summary: { type: 'string' },
    purpose: { type: 'string' },
    situation: { type: 'string' },
    opportunity: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    people: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'role'],
        properties: { name: { type: 'string' }, role: { type: 'string' }, company: { type: 'string' } },
      },
    },
    dealVariables: {
      type: 'array',
      items: {
        type: 'object',
        required: ['variableType', 'value', 'extractionType', 'confidence'],
        properties: {
          variableType: { type: 'string' },
          value: { type: 'string' },
          extractionType: { type: 'string', enum: ['explicit', 'inferred', 'needs_verification'] },
          confidence: { type: 'number' },
          sourceStartMs: { type: 'number' },
          sourceEndMs: { type: 'number' },
        },
      },
    },
    dates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'date', 'kind'],
        properties: { label: { type: 'string' }, date: { type: 'string' }, kind: { type: 'string' } },
      },
    },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description', 'confidence'],
        properties: {
          description: { type: 'string' },
          owner: { type: 'string' },
          dueAt: { type: 'string' },
          confidence: { type: 'number' },
          sourceStartMs: { type: 'number' },
          sourceEndMs: { type: 'number' },
        },
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['decision', 'participants', 'status'],
        properties: {
          decision: { type: 'string' },
          participants: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['agreed', 'tentative', 'deferred'] },
          sourceStartMs: { type: 'number' },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const CLASSIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['intent', 'leadQuality', 'humanFollowUpRecommended', 'summary', 'contact'],
  properties: {
    intent: { type: 'string' },
    leadQuality: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    humanFollowUpRecommended: { type: 'boolean' },
    summary: { type: 'string' },
    contact: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        artistName: { type: 'string' },
      },
    },
  },
}
