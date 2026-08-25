import { AppError } from '@masterclip/shared'
import { QUEUES, JOB_TYPES } from '@masterclip/queue'
import {
  HUMAN_TRANSFER_REPLY,
  SAFE_CORRECTION_REPLY,
  defaultDisclosure,
  detectEscalation,
  retentionExpiresAt,
  screenAgentReply,
  type AgentToolDefinition,
  type ConversationTurn,
  type ConversationalAgentProvider,
} from '@masterclip/audio-core'
import { AGENT_TYPES, type AgentConversationRecord, type AudioAgentRecord, type AgentType } from '@masterclip/audio-domain'
import type { Actor, AudioEngineDeps } from './deps.js'

/**
 * Street Banker Operator — a narrow intake agent backed by real operators.
 *
 * The web channel runs a deterministic server-side intake flow: every outbound
 * line is composed here, screened by the commitment guardrails, and every tool
 * effect (leads, tasks, callbacks) is an authenticated server-side write. The
 * agent qualifies and routes; it approves nothing, guarantees nothing, and
 * hands over to a human on request or on any escalation signal.
 */

interface IntakeState {
  step: number
  answers: Record<string, string>
}

const INTAKE_QUESTIONS: Array<{ key: string; question: string }> = [
  { key: 'name', question: 'Can I get your name?' },
  { key: 'artistName', question: 'What name do you release music under?' },
  { key: 'email', question: 'What email should our team use to reach you?' },
  { key: 'currentDistributor', question: 'Are you currently with a distributor, and if so which one?' },
  { key: 'upcomingRelease', question: 'Do you have a release coming up? Tell me a little about it.' },
  { key: 'ownsAudio', question: 'Do you own or control the rights to the music you want to distribute?' },
  { key: 'goals', question: 'Last one — what are you hoping Street Banker can help you achieve?' },
]

/** Requests for commitments get a boundary statement, never an answer. */
const BOUNDARY_PATTERN = /\b(guarantee|am i (approved|accepted)|will (i|we|you) (be |get )?(approved|accepted|funded)|promise me)\b/i

/**
 * The tool surface a provider-hosted agent may call. Declared as client
 * tools: the provider relays the call to our server, which authenticates,
 * validates, executes, and audits — the provider never touches the database.
 */
export const OPERATOR_AGENT_TOOLS = [
  {
    name: 'create_operator_desk_lead',
    description: 'Create a Street Banker Operator Desk lead from details the caller volunteered.',
    parameters: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Lead name (artist or project name)' },
        contactName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        artistName: { type: 'string' },
      },
    },
  },
  {
    name: 'create_follow_up_task',
    description: 'File a follow-up task for a Street Banker operator.',
    parameters: {
      type: 'object',
      required: ['description'],
      properties: { description: { type: 'string' }, dueAt: { type: 'string', description: 'ISO date, optional' } },
    },
  },
  {
    name: 'request_human_callback',
    description: 'Schedule a priority callback from a human Street Banker operator.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } } },
  },
  {
    name: 'transfer_to_human',
    description: 'Transfer this conversation to a human operator now.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'end_conversation',
    description: 'End the conversation politely once the caller is done.',
    parameters: { type: 'object', properties: {} },
  },
] satisfies AgentToolDefinition[]

export class OperatorAgentService {
  constructor(private readonly deps: AudioEngineDeps) {}

  /** Creates the default orchestrator/specialist set for an org, once. */
  async ensureDefaultAgents(orgId: string, createdBy: string): Promise<AudioAgentRecord[]> {
    const existing = await this.deps.repos.agents.list(orgId)
    if (existing.length > 0) return existing
    const disclosure = defaultDisclosure('agent_disclosure')
    const names: Record<AgentType, string> = {
      intake_orchestrator: 'Street Banker Intake',
      distribution_specialist: 'Distribution Specialist',
      royalty_specialist: 'Royalty Specialist',
      platform_support_specialist: 'Platform Support',
      partnership_specialist: 'Partnerships',
    }
    const created: AudioAgentRecord[] = []
    for (const agentType of AGENT_TYPES) {
      created.push(
        await this.deps.repos.agents.create({
          orgId,
          provider: 'mock-audio',
          name: names[agentType],
          agentType,
          configuration: { scope: agentType, humanTransfer: true },
          disclosureVersion: disclosure.version,
          createdBy,
        }),
      )
    }
    return created
  }

  async startConversation(input: { actor: Actor | null; orgId: string; agentId: string; channel: 'web' | 'phone' }): Promise<{
    conversation: AgentConversationRecord
    disclosure: string
    greeting: string
  }> {
    const agent = await this.deps.repos.agents.get(input.orgId, input.agentId)
    if (agent.status === 'disabled') {
      throw new AppError({ kind: 'forbidden', code: 'agent.disabled', message: 'this agent is disabled' })
    }
    const policy = await this.deps.repos.policy.getPolicy(input.orgId)
    const disclosure = defaultDisclosure('agent_disclosure')
    const settings = await this.deps.repos.policy.getSettings(input.orgId)
    const conversation = await this.deps.repos.agents.createConversation({
      orgId: input.orgId,
      agentId: agent.id,
      channel: input.channel,
      userId: input.actor?.userId ?? null,
      disclosureVersion: agent.disclosureVersion || disclosure.version,
      retentionExpiresAt: retentionExpiresAt(policy, 'agent_conversation', this.deps.clock.now()),
    })
    const displayName = settings.whiteLabel.agentDisplayName || agent.name
    const welcome = settings.whiteLabel.welcomeMessage || `Hi — this is ${displayName}. I can explain Street Banker's services, or take your details for a distribution conversation with our team.`
    const greeting = `${welcome} ${INTAKE_QUESTIONS[0]!.question}`
    // The disclosure is part of the conversation record from turn zero.
    await this.deps.repos.agents.appendTurns(input.orgId, conversation.id, [
      { role: 'agent', text: disclosure.text },
      { role: 'agent', text: greeting },
    ])
    return { conversation, disclosure: disclosure.text, greeting }
  }

  /**
   * One inbound user turn → one screened agent reply, with side effects
   * (leads, tasks, transfer) executed server-side.
   */
  async userTurn(orgId: string, conversationId: string, text: string): Promise<{ reply: string; humanTransfer: boolean; ended: boolean }> {
    const conversation = await this.deps.repos.agents.getConversation(orgId, conversationId)
    if (conversation.status !== 'active') {
      throw new AppError({ kind: 'conflict', code: 'agent.conversation_ended', message: 'this conversation has ended' })
    }
    await this.deps.repos.agents.appendTurns(orgId, conversationId, [{ role: 'user', text }])

    const escalations = detectEscalation(text)
    if (escalations.length > 0) {
      await this.deps.repos.agents.updateConversation(orgId, conversationId, { humanTransferStatus: 'requested' })
      const reply = this.screen(HUMAN_TRANSFER_REPLY)
      await this.deps.repos.agents.appendTurns(orgId, conversationId, [{ role: 'agent', text: reply }])
      await this.endConversation(orgId, conversationId, 'human_transfer')
      return { reply, humanTransfer: true, ended: true }
    }

    const state = this.intakeState(conversation)
    let reply: string
    let ended = false

    if (BOUNDARY_PATTERN.test(text)) {
      reply = this.screen(SAFE_CORRECTION_REPLY)
    } else if (state.step < INTAKE_QUESTIONS.length) {
      const current = INTAKE_QUESTIONS[state.step]!
      state.answers[current.key] = text.trim().slice(0, 500)
      state.step += 1
      if (state.step < INTAKE_QUESTIONS.length) {
        reply = this.screen(`Got it. ${INTAKE_QUESTIONS[state.step]!.question}`)
      } else {
        reply = this.screen(
          'Thanks — that’s everything I need. A Street Banker operator will review this and follow up by email. ' +
            'Decisions about distribution deals are always made by our human team. Anything else you’d like me to pass along?',
        )
        ended = true
      }
      await this.deps.repos.agents.updateConversation(orgId, conversationId, {
        classification: { ...conversation.classification, intake: state },
        guestContact: this.contactFrom(state.answers),
      })
    } else {
      reply = this.screen('I’ve passed your details to the team. Is there anything else I can note for them?')
      ended = true
    }

    await this.deps.repos.agents.appendTurns(orgId, conversationId, [{ role: 'agent', text: reply }])
    if (ended) await this.endConversation(orgId, conversationId, 'intake_complete')
    return { reply, humanTransfer: false, ended }
  }

  /** Guardrail screen on every outbound line — a hit becomes a safe correction. */
  private screen(reply: string): string {
    const verdict = screenAgentReply(reply)
    if (verdict.ok) return reply
    this.deps.logger.warn('audio.agent_reply_blocked', { hits: verdict.hits })
    return SAFE_CORRECTION_REPLY
  }

  private intakeState(conversation: AgentConversationRecord): IntakeState {
    const raw = conversation.classification.intake as IntakeState | undefined
    return raw && typeof raw.step === 'number' ? { step: raw.step, answers: { ...raw.answers } } : { step: 0, answers: {} }
  }

  private contactFrom(answers: Record<string, string>): Record<string, string> {
    const contact: Record<string, string> = {}
    if (answers.name) contact.name = answers.name
    if (answers.artistName) contact.artistName = answers.artistName
    const email = answers.email?.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0]
    if (email) contact.email = email
    return contact
  }

  /** Ends the conversation: classify, create the lead, attach notes and follow-up. */
  async endConversation(orgId: string, conversationId: string, reason: string): Promise<void> {
    const conversation = await this.deps.repos.agents.getConversation(orgId, conversationId)
    if (conversation.status !== 'active') return
    const classification = await this.deps.reasoning.classifyAgentConversation({ orgId, turns: conversation.transcript })
    const startedMs = Date.parse(conversation.startedAt)
    const durationSeconds = Math.max(1, Math.round((this.deps.clock.now() - startedMs) / 1000))

    let leadId = conversation.operatorLeadId
    const contact = { ...conversation.guestContact, ...classification.contact }
    if (!leadId && (contact.name || contact.email || contact.artistName)) {
      const lead = await this.deps.repos.operatorDesk.createLead({
        orgId,
        name: contact.artistName || contact.name || 'Inbound conversation',
        contactName: contact.name ?? '',
        email: contact.email ?? '',
        phone: contact.phone ?? '',
        artistName: contact.artistName ?? '',
        stage: 'new',
        source: 'operator_agent',
        createdBy: 'operator-agent',
      })
      leadId = lead.id
      await this.deps.repos.operatorDesk.addNote({
        orgId,
        leadId,
        body: `Operator agent conversation (${reason}): ${classification.summary}`,
        sourceType: 'agent_conversation',
        sourceId: conversationId,
        createdBy: 'operator-agent',
      })
      if (classification.humanFollowUpRecommended || conversation.humanTransferStatus === 'requested') {
        await this.deps.repos.operatorDesk.createTask({
          orgId,
          leadId,
          description:
            conversation.humanTransferStatus === 'requested'
              ? 'Caller asked for a human operator — call back as priority'
              : 'Follow up on operator-agent conversation',
          sourceType: 'agent_conversation',
          sourceId: conversationId,
          createdBy: 'operator-agent',
        })
      }
    }

    await this.deps.repos.agents.updateConversation(orgId, conversationId, {
      status: 'ended',
      endedAt: this.deps.clock.isoNow(),
      durationSeconds,
      summary: classification.summary,
      classification: { ...conversation.classification, result: classification },
      operatorLeadId: leadId,
      guestContact: contact,
    })
    await this.deps.audit.record({
      orgId,
      actor: 'operator-agent',
      action: 'audio.conversation_ended',
      targetType: 'agent_conversation',
      targetId: conversationId,
      data: { reason, leadId, humanTransfer: conversation.humanTransferStatus },
    })
  }

  /**
   * Syncs an agent definition to the configured conversational-agent
   * provider: tenant knowledge docs are pushed provider-side and attached,
   * the system prompt carries the disclosure, and every tool stays a
   * server-side client tool. Records the provider agent id on success.
   */
  async syncToProvider(orgId: string, agentId: string): Promise<AudioAgentRecord> {
    const agent = await this.deps.repos.agents.get(orgId, agentId)
    const settings = await this.deps.repos.policy.getSettings(orgId)
    const provider = this.deps.registry.resolve<ConversationalAgentProvider>('agent', settings.defaultProviders.agent)
    const docs = await this.deps.repos.agents.knowledgeDocs(orgId, agentId)
    const disclosure = defaultDisclosure('agent_disclosure')
    const request = {
      orgId,
      name: (settings.whiteLabel.agentDisplayName || agent.name).slice(0, 100),
      systemPrompt:
        `You are the ${agent.name} for Street Banker, a music distribution and artist-services company. ` +
        'You qualify and route; humans decide. Never promise acceptance or funding, never approve or negotiate deals, ' +
        'never give legal interpretations, never guarantee streams, playlists, press, or royalty recovery, and never ' +
        'reveal internal scoring or another artist’s information. Offer a human operator whenever asked or when a ' +
        'question is outside your scope.',
      firstMessage: settings.whiteLabel.welcomeMessage || `Hi — this is ${agent.name}. How can I help today?`,
      language: settings.whiteLabel.languages?.[0] ?? 'en',
      knowledge: docs.map((doc) => ({ id: doc.id, name: doc.name, content: doc.content })),
      tools: OPERATOR_AGENT_TOOLS,
      disclosureText: disclosure.text,
    }
    const remote = agent.providerAgentId
      ? await provider.updateAgent({ ...request, providerAgentId: agent.providerAgentId })
      : await provider.createAgent(request)
    const updated = await this.deps.repos.agents.update(orgId, agentId, {
      providerAgentId: remote.providerAgentId,
      configuration: { ...agent.configuration, provider: provider.providerId, syncedKnowledgeVersion: agent.knowledgeBaseVersion },
    })
    await this.deps.db.run('UPDATE audio_agents SET provider = ? WHERE id = ? AND org_id = ?', [provider.providerId, agentId, orgId])
    await this.deps.audit.record({
      orgId,
      actor: 'agent-sync',
      action: 'audio.agent_synced',
      targetType: 'audio_agent',
      targetId: agentId,
      data: { provider: provider.providerId, providerAgentId: remote.providerAgentId, knowledgeDocs: docs.length },
    })
    return { ...updated, provider: provider.providerId }
  }

  /** Marks a live conversation for human transfer and queues the callback task. */
  async requestHumanTransfer(orgId: string, conversationId: string): Promise<void> {
    await this.deps.repos.agents.updateConversation(orgId, conversationId, { humanTransferStatus: 'requested' })
    await this.endConversation(orgId, conversationId, 'human_transfer')
  }

  /**
   * Post-call processing for provider-hosted conversations, driven by the
   * verified webhook: fetch the conversation, store the transcript, classify,
   * and route to Operator Desk exactly like a web conversation.
   */
  async runPostCall(conversationId: string): Promise<void> {
    const conversation = await this.deps.repos.agents.getConversationAnyOrg(conversationId)
    if (!conversation.providerConversationId) return
    const agent = await this.deps.repos.agents.get(conversation.orgId, conversation.agentId)
    const provider = this.deps.registry.resolve<ConversationalAgentProvider>('agent', agent.provider)
    const remote = await provider.getConversation(conversation.providerConversationId)
    await this.deps.repos.agents.updateConversation(conversation.orgId, conversationId, {
      transcript: remote.turns as ConversationTurn[],
      durationSeconds: remote.durationSeconds ?? null,
    })
    if (remote.usage) {
      await this.deps.repos.usage.record({
        orgId: conversation.orgId,
        userId: conversation.userId ?? 'operator-agent',
        projectType: 'agent',
        projectId: conversationId,
        provider: provider.providerId,
        operation: 'agent_conversation',
        model: 'conversational-agent',
        unit: remote.usage.unit,
        inputUnits: remote.usage.inputUnits,
        outputUnits: remote.usage.outputUnits,
        estimatedCostMicros: 0,
        finalCostMicros: 0,
        currency: 'USD',
        providerRequestId: remote.usage.providerRequestId ?? null,
        jobId: null,
      })
    }
    await this.endConversation(conversation.orgId, conversationId, 'provider_post_call')
  }

  async enqueuePostCall(conversationId: string): Promise<void> {
    await this.deps.queue.enqueue({
      queue: QUEUES.audio,
      type: JOB_TYPES.audioAgentPostCall,
      payload: { conversationId },
      dedupeKey: `audio-postcall:${conversationId}`,
    })
  }
}
