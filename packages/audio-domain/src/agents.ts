import { type Db, insertRow, parseJsonColumn, toNum, toNumOrNull, toStr, toStrOrNull } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { ConversationTurn } from '@masterclip/audio-core'

export const AGENT_TYPES = [
  'intake_orchestrator',
  'distribution_specialist',
  'royalty_specialist',
  'platform_support_specialist',
  'partnership_specialist',
] as const

export type AgentType = (typeof AGENT_TYPES)[number]

export interface AudioAgentRecord {
  id: string
  orgId: string
  provider: string
  providerAgentId: string | null
  name: string
  agentType: AgentType
  status: 'draft' | 'active' | 'disabled'
  configuration: Record<string, unknown>
  knowledgeBaseVersion: number
  disclosureVersion: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface AgentKnowledgeDocRecord {
  id: string
  agentId: string
  name: string
  content: string
  version: number
  createdBy: string
  createdAt: string
}

export interface AgentConversationRecord {
  id: string
  orgId: string
  agentId: string
  providerConversationId: string | null
  userId: string | null
  guestContact: Record<string, string>
  operatorLeadId: string | null
  channel: 'web' | 'phone'
  status: 'active' | 'ended' | 'failed'
  disclosureVersion: string
  disclosureShownAt: string
  startedAt: string
  endedAt: string | null
  durationSeconds: number | null
  transcript: ConversationTurn[]
  recordingAssetId: string | null
  humanTransferStatus: 'none' | 'requested' | 'scheduled' | 'transferred'
  summary: string
  classification: Record<string, unknown>
  retentionExpiresAt: string | null
  createdAt: string
}

export class AudioAgentRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    provider: string
    name: string
    agentType: AgentType
    configuration: Record<string, unknown>
    disclosureVersion: string
    createdBy: string
  }): Promise<AudioAgentRecord> {
    const now = this.clock.isoNow()
    const record: AudioAgentRecord = {
      id: newId('aagt', this.clock.now()),
      orgId: input.orgId,
      provider: input.provider,
      providerAgentId: null,
      name: input.name,
      agentType: input.agentType,
      status: 'draft',
      configuration: input.configuration,
      knowledgeBaseVersion: 0,
      disclosureVersion: input.disclosureVersion,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'audio_agents', {
      id: record.id,
      org_id: record.orgId,
      provider: record.provider,
      provider_agent_id: null,
      name: record.name,
      agent_type: record.agentType,
      status: record.status,
      configuration: JSON.stringify(record.configuration),
      knowledge_base_version: 0,
      disclosure_version: record.disclosureVersion,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<AudioAgentRecord> {
    const row = await this.db.get('SELECT * FROM audio_agents WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('audio agent', id)
    return mapAgent(row)
  }

  async list(orgId: string): Promise<AudioAgentRecord[]> {
    const rows = await this.db.query('SELECT * FROM audio_agents WHERE org_id = ? ORDER BY created_at', [orgId])
    return rows.map(mapAgent)
  }

  async update(orgId: string, id: string, patch: Partial<Pick<AudioAgentRecord, 'name' | 'status' | 'configuration' | 'providerAgentId' | 'disclosureVersion'>>): Promise<AudioAgentRecord> {
    const current = await this.get(orgId, id)
    const next = { ...current, ...patch, updatedAt: this.clock.isoNow() }
    await this.db.run(
      `UPDATE audio_agents SET name = ?, status = ?, configuration = ?, provider_agent_id = ?, disclosure_version = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
      [next.name, next.status, JSON.stringify(next.configuration), next.providerAgentId, next.disclosureVersion, next.updatedAt, id, orgId],
    )
    return next
  }

  async bumpKnowledgeVersion(orgId: string, id: string): Promise<number> {
    const agent = await this.get(orgId, id)
    const version = agent.knowledgeBaseVersion + 1
    await this.db.run('UPDATE audio_agents SET knowledge_base_version = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      version,
      this.clock.isoNow(),
      id,
      orgId,
    ])
    return version
  }

  async addKnowledgeDoc(input: { orgId: string; agentId: string; name: string; content: string; createdBy: string }): Promise<AgentKnowledgeDocRecord> {
    const agent = await this.get(input.orgId, input.agentId)
    const record: AgentKnowledgeDocRecord = {
      id: newId('akdc', this.clock.now()),
      agentId: agent.id,
      name: input.name,
      content: input.content,
      version: agent.knowledgeBaseVersion + 1,
      createdBy: input.createdBy,
      createdAt: this.clock.isoNow(),
    }
    await insertRow(this.db, 'agent_knowledge_docs', {
      id: record.id,
      org_id: input.orgId,
      agent_id: record.agentId,
      name: record.name,
      content: record.content,
      version: record.version,
      created_by: record.createdBy,
      created_at: record.createdAt,
    })
    await this.bumpKnowledgeVersion(input.orgId, input.agentId)
    return record
  }

  async knowledgeDocs(orgId: string, agentId: string): Promise<AgentKnowledgeDocRecord[]> {
    const rows = await this.db.query('SELECT * FROM agent_knowledge_docs WHERE agent_id = ? AND org_id = ? ORDER BY created_at', [
      agentId,
      orgId,
    ])
    return rows.map((row) => ({
      id: toStr(row.id),
      agentId: toStr(row.agent_id),
      name: toStr(row.name),
      content: toStr(row.content),
      version: toNum(row.version),
      createdBy: toStr(row.created_by),
      createdAt: toStr(row.created_at),
    }))
  }

  async removeKnowledgeDoc(orgId: string, agentId: string, docId: string): Promise<void> {
    await this.db.run('DELETE FROM agent_knowledge_docs WHERE id = ? AND agent_id = ? AND org_id = ?', [docId, agentId, orgId])
    await this.bumpKnowledgeVersion(orgId, agentId)
  }

  async createConversation(input: {
    orgId: string
    agentId: string
    channel: 'web' | 'phone'
    userId: string | null
    disclosureVersion: string
    providerConversationId?: string | null
    retentionExpiresAt: string | null
  }): Promise<AgentConversationRecord> {
    const now = this.clock.isoNow()
    const record: AgentConversationRecord = {
      id: newId('acnv', this.clock.now()),
      orgId: input.orgId,
      agentId: input.agentId,
      providerConversationId: input.providerConversationId ?? null,
      userId: input.userId,
      guestContact: {},
      operatorLeadId: null,
      channel: input.channel,
      status: 'active',
      disclosureVersion: input.disclosureVersion,
      disclosureShownAt: now,
      startedAt: now,
      endedAt: null,
      durationSeconds: null,
      transcript: [],
      recordingAssetId: null,
      humanTransferStatus: 'none',
      summary: '',
      classification: {},
      retentionExpiresAt: input.retentionExpiresAt,
      createdAt: now,
    }
    await insertRow(this.db, 'agent_conversations', {
      id: record.id,
      org_id: record.orgId,
      agent_id: record.agentId,
      provider_conversation_id: record.providerConversationId,
      user_id: record.userId,
      guest_contact: '{}',
      operator_lead_id: null,
      channel: record.channel,
      status: record.status,
      disclosure_version: record.disclosureVersion,
      disclosure_shown_at: record.disclosureShownAt,
      started_at: record.startedAt,
      ended_at: null,
      duration_seconds: null,
      transcript: '[]',
      recording_asset_id: null,
      human_transfer_status: record.humanTransferStatus,
      summary: '',
      classification: '{}',
      retention_expires_at: record.retentionExpiresAt,
      deleted_at: null,
      created_at: now,
    })
    return record
  }

  async getConversation(orgId: string, id: string): Promise<AgentConversationRecord> {
    const row = await this.db.get('SELECT * FROM agent_conversations WHERE id = ? AND org_id = ? AND deleted_at IS NULL', [id, orgId])
    if (!row) throw notFound('agent conversation', id)
    return mapConversation(row)
  }

  async getConversationAnyOrg(id: string): Promise<AgentConversationRecord> {
    const row = await this.db.get('SELECT * FROM agent_conversations WHERE id = ? AND deleted_at IS NULL', [id])
    if (!row) throw notFound('agent conversation', id)
    return mapConversation(row)
  }

  async findByProviderConversation(providerConversationId: string): Promise<AgentConversationRecord | null> {
    const row = await this.db.get('SELECT * FROM agent_conversations WHERE provider_conversation_id = ? AND deleted_at IS NULL', [
      providerConversationId,
    ])
    return row ? mapConversation(row) : null
  }

  async listConversations(orgId: string, limit = 100): Promise<AgentConversationRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM agent_conversations WHERE org_id = ? AND deleted_at IS NULL ORDER BY started_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId],
    )
    return rows.map(mapConversation)
  }

  async appendTurns(orgId: string, id: string, turns: ConversationTurn[]): Promise<AgentConversationRecord> {
    const conversation = await this.getConversation(orgId, id)
    const transcript = [...conversation.transcript, ...turns]
    await this.db.run('UPDATE agent_conversations SET transcript = ? WHERE id = ? AND org_id = ?', [JSON.stringify(transcript), id, orgId])
    return { ...conversation, transcript }
  }

  async updateConversation(orgId: string, id: string, patch: Partial<Pick<AgentConversationRecord, 'status' | 'endedAt' | 'durationSeconds' | 'transcript' | 'summary' | 'classification' | 'operatorLeadId' | 'humanTransferStatus' | 'guestContact' | 'recordingAssetId'>>): Promise<void> {
    const current = await this.getConversation(orgId, id)
    const next = { ...current, ...patch }
    await this.db.run(
      `UPDATE agent_conversations SET status = ?, ended_at = ?, duration_seconds = ?, transcript = ?, summary = ?, classification = ?, operator_lead_id = ?, human_transfer_status = ?, guest_contact = ?, recording_asset_id = ? WHERE id = ? AND org_id = ?`,
      [
        next.status,
        next.endedAt,
        next.durationSeconds,
        JSON.stringify(next.transcript),
        next.summary,
        JSON.stringify(next.classification),
        next.operatorLeadId,
        next.humanTransferStatus,
        JSON.stringify(next.guestContact),
        next.recordingAssetId,
        id,
        orgId,
      ],
    )
  }

  async listExpiredConversations(nowIso: string, limit = 100): Promise<AgentConversationRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM agent_conversations
        WHERE deleted_at IS NULL AND retention_expires_at IS NOT NULL AND retention_expires_at < ?
        ORDER BY retention_expires_at ASC LIMIT ${Math.floor(limit)}`,
      [nowIso],
    )
    return rows.map(mapConversation)
  }

  async purgeConversationContent(id: string): Promise<void> {
    await this.db.run(
      `UPDATE agent_conversations SET transcript = '[]', guest_contact = '{}', summary = '', classification = '{}', deleted_at = ? WHERE id = ?`,
      [this.clock.isoNow(), id],
    )
  }
}

function mapAgent(row: Record<string, unknown>): AudioAgentRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    provider: toStr(row.provider),
    providerAgentId: toStrOrNull(row.provider_agent_id),
    name: toStr(row.name),
    agentType: toStr(row.agent_type) as AgentType,
    status: toStr(row.status) as AudioAgentRecord['status'],
    configuration: parseJsonColumn(row.configuration, {}),
    knowledgeBaseVersion: toNum(row.knowledge_base_version),
    disclosureVersion: toStr(row.disclosure_version),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapConversation(row: Record<string, unknown>): AgentConversationRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    agentId: toStr(row.agent_id),
    providerConversationId: toStrOrNull(row.provider_conversation_id),
    userId: toStrOrNull(row.user_id),
    guestContact: parseJsonColumn(row.guest_contact, {}),
    operatorLeadId: toStrOrNull(row.operator_lead_id),
    channel: toStr(row.channel) as AgentConversationRecord['channel'],
    status: toStr(row.status) as AgentConversationRecord['status'],
    disclosureVersion: toStr(row.disclosure_version),
    disclosureShownAt: toStr(row.disclosure_shown_at),
    startedAt: toStr(row.started_at),
    endedAt: toStrOrNull(row.ended_at),
    durationSeconds: toNumOrNull(row.duration_seconds),
    transcript: parseJsonColumn(row.transcript, []),
    recordingAssetId: toStrOrNull(row.recording_asset_id),
    humanTransferStatus: toStr(row.human_transfer_status) as AgentConversationRecord['humanTransferStatus'],
    summary: toStr(row.summary),
    classification: parseJsonColumn(row.classification, {}),
    retentionExpiresAt: toStrOrNull(row.retention_expires_at),
    createdAt: toStr(row.created_at),
  }
}
