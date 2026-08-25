import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import type { Runtime } from '@masterclip/runtime'
import { requireAudio } from './helpers.js'
import { requireAuth } from '../../server.js'

/**
 * Street Banker Operator routes.
 *
 * Conversation turns run through the server-side orchestrator: guardrails,
 * escalation, and every tool effect execute here, authenticated and tenant
 * scoped. The provider (when configured) powers voice; it never gets database
 * access.
 */
export async function registerAudioOperatorRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const audio = runtime.audio

  app.get('/api/audio/agents', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_agent')
    return { agents: await audio.repos.agents.list(actor.orgId) }
  })

  app.post('/api/audio/agents', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_agent', { minimumRole: 'admin' })
    const agents = await audio.operatorAgent.ensureDefaultAgents(actor.orgId, actor.userId)
    return { agents }
  })

  app.patch('/api/audio/agents/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_agent', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        status: z.enum(['draft', 'active', 'disabled']).optional(),
        configuration: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(request.body)
    const agent = await audio.repos.agents.update(actor.orgId, id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.configuration !== undefined ? { configuration: body.configuration } : {}),
    })
    return { agent }
  })

  app.get('/api/audio/agents/:id/knowledge', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_agent', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    return { docs: await audio.repos.agents.knowledgeDocs(actor.orgId, id) }
  })

  app.post('/api/audio/agents/:id/knowledge', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_agent', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    const body = z.object({ name: z.string().min(1).max(200), content: z.string().min(1).max(100_000) }).parse(request.body)
    const doc = await audio.repos.agents.addKnowledgeDoc({
      orgId: actor.orgId,
      agentId: id,
      name: body.name,
      content: body.content,
      createdBy: actor.userId,
    })
    return { doc }
  })

  /** Queues a provider sync: knowledge docs pushed, tools declared, id recorded. */
  app.post('/api/audio/agents/:id/sync', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_agent', { minimumRole: 'admin', slot: 'agent' })
    const { id } = request.params as { id: string }
    const agent = await audio.repos.agents.get(actor.orgId, id)
    await runtime.queue.enqueue({
      queue: QUEUES.audio,
      type: JOB_TYPES.audioAgentSync,
      payload: { orgId: actor.orgId, agentId: id },
      dedupeKey: `audio-agent-sync:${id}:${agent.knowledgeBaseVersion}`,
    })
    return { queued: true }
  })

  app.post('/api/audio/agents/:id/session', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_web')
    const { id } = request.params as { id: string }
    const session = await audio.operatorAgent.startConversation({ actor, orgId: actor.orgId, agentId: id, channel: 'web' })
    return {
      conversationId: session.conversation.id,
      disclosure: session.disclosure,
      greeting: session.greeting,
    }
  })

  app.post('/api/audio/conversations/:id/turn', async (request) => {
    const auth = await requireAuth(runtime, request)
    const { id } = request.params as { id: string }
    const body = z.object({ text: z.string().min(1).max(4000) }).parse(request.body)
    const result = await audio.operatorAgent.userTurn(auth.orgId, id, body.text)
    return result
  })

  app.get('/api/audio/conversations', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_agent')
    return { conversations: await audio.repos.agents.listConversations(actor.orgId) }
  })

  app.get('/api/audio/conversations/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_agent')
    const { id } = request.params as { id: string }
    return { conversation: await audio.repos.agents.getConversation(actor.orgId, id) }
  })

  app.post('/api/audio/conversations/:id/human-transfer', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.operator_human_transfer')
    const { id } = request.params as { id: string }
    await audio.operatorAgent.requestHumanTransfer(actor.orgId, id)
    return { ok: true }
  })
}
