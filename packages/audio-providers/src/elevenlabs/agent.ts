import type {
  ConversationSession,
  ConversationTurn,
  ConversationalAgentProvider,
  CreateAgentRequest,
  CreateConversationSessionRequest,
  ProviderAgentDefinition,
  ProviderConversation,
  ProviderHealth,
  UpdateAgentRequest,
} from '@masterclip/audio-core'
import { ELEVENLABS_PROVIDER_ID, usageFrom, type ElevenLabsClient } from './client.js'
import { elevenLabsHealth } from './transcription.js'

interface ConvaiAgentResponse {
  agent_id: string
}

interface ConvaiConversationResponse {
  conversation_id: string
  status?: string
  transcript?: Array<{ role?: string; message?: string | null; time_in_call_secs?: number; tool_calls?: unknown[] }>
  metadata?: { call_duration_secs?: number; cost?: number }
}

/**
 * ElevenAgents (ConvAI) adapter.
 *
 * The agent body follows the documented `conversation_config` structure. Every
 * client tool the agent may call is declared here but executed on OUR server
 * behind authentication — the provider only ever sees tool names and JSON
 * schemas, never credentials or database access.
 */
export class ElevenLabsAgentAdapter implements ConversationalAgentProvider {
  readonly providerId = ELEVENLABS_PROVIDER_ID

  constructor(private readonly client: ElevenLabsClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured()
  }

  supportsZeroRetention(): boolean {
    // Conversation transcripts and recordings live provider-side by design;
    // retention there is an account-level agreement, not a request flag.
    return false
  }

  private agentBody(input: CreateAgentRequest, knowledgeBase: Array<{ id: string; name: string }>): Record<string, unknown> {
    return {
      name: input.name,
      conversation_config: {
        agent: {
          first_message: input.firstMessage,
          language: input.language,
          prompt: {
            prompt: `${input.disclosureText}\n\n${input.systemPrompt}`,
            tools: input.tools.map((tool) => ({
              type: 'client',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
            ...(knowledgeBase.length > 0
              ? { knowledge_base: knowledgeBase.map((doc) => ({ type: 'text', id: doc.id, name: doc.name })) }
              : {}),
          },
        },
        ...(input.voiceRef ? { tts: { voice_id: input.voiceRef } } : {}),
      },
    }
  }

  /**
   * Pushes tenant knowledge documents to the provider KB — `POST
   * v1/convai/knowledge-base/text` — and returns locators to attach to the
   * agent prompt. Documents were curated tenant-side; nothing here decides
   * what the agent may know.
   */
  private async pushKnowledge(input: CreateAgentRequest): Promise<Array<{ id: string; name: string }>> {
    const locators: Array<{ id: string; name: string }> = []
    for (const doc of input.knowledge) {
      const { body } = await this.client.json<{ id: string; name?: string }>('v1/convai/knowledge-base/text', {
        method: 'POST',
        body: { text: doc.content, name: doc.name },
      })
      locators.push({ id: body.id, name: body.name ?? doc.name })
    }
    return locators
  }

  async createAgent(input: CreateAgentRequest): Promise<ProviderAgentDefinition> {
    const knowledgeBase = await this.pushKnowledge(input)
    const { body } = await this.client.json<ConvaiAgentResponse>('v1/convai/agents/create', {
      method: 'POST',
      body: this.agentBody(input, knowledgeBase),
    })
    return { providerAgentId: body.agent_id, raw: body }
  }

  async updateAgent(input: UpdateAgentRequest): Promise<ProviderAgentDefinition> {
    const knowledgeBase = await this.pushKnowledge(input)
    const { body } = await this.client.json<ConvaiAgentResponse>(`v1/convai/agents/${encodeURIComponent(input.providerAgentId)}`, {
      method: 'PATCH',
      body: this.agentBody(input, knowledgeBase),
    })
    return { providerAgentId: body.agent_id ?? input.providerAgentId, raw: body }
  }

  async createConversationSession(input: CreateConversationSessionRequest): Promise<ConversationSession> {
    const { body } = await this.client.json<{ signed_url?: string; token?: string }>('v1/convai/conversation/get-signed-url', {
      query: { agent_id: input.providerAgentId },
    })
    if (body.signed_url) return { providerConversationId: null, mode: 'signed_url', value: body.signed_url }
    return { providerConversationId: null, mode: 'token', value: body.token ?? '' }
  }

  async getConversation(providerConversationId: string): Promise<ProviderConversation> {
    const { body, requestId } = await this.client.json<ConvaiConversationResponse>(
      `v1/convai/conversations/${encodeURIComponent(providerConversationId)}`,
    )
    const turns: ConversationTurn[] = (body.transcript ?? []).map((turn) => ({
      role: turn.role === 'agent' ? 'agent' : 'user',
      text: turn.message ?? '',
      ...(turn.time_in_call_secs !== undefined ? { atMs: Math.round(turn.time_in_call_secs * 1000) } : {}),
    }))
    const durationSeconds = body.metadata?.call_duration_secs
    return {
      providerConversationId: body.conversation_id,
      status: body.status === 'done' || body.status === 'ended' ? 'ended' : body.status === 'failed' ? 'failed' : 'active',
      turns,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      usage: usageFrom('seconds', durationSeconds ?? 0, 0, requestId),
      raw: body,
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    return elevenLabsHealth(this.client)
  }
}
