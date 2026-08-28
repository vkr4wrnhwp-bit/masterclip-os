import { insertRow, toBool, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import type {
  OpportunityRecord,
  OpportunityType,
  RoomAction,
  RoomExchangeRecord,
  ServiceOrderRecord,
  ServiceOrderStatus,
  ServiceProviderRecord,
  StudioService,
} from './types.js'

/**
 * The human engineer marketplace.
 *
 * Providers are data and the service catalogue is code, so an empty provider
 * table means the marketplace has nothing to offer — which is the correct state
 * until real engineers are configured. Nothing here can be ordered from a
 * provider that does not exist.
 */
export class ServiceProviderRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: { orgId: string; displayName: string; services: StudioService[]; active?: boolean }): Promise<ServiceProviderRecord> {
    const now = this.clock.isoNow()
    const record: ServiceProviderRecord = {
      id: newId('stso', this.clock.now()),
      orgId: input.orgId,
      displayName: input.displayName,
      services: input.services,
      active: input.active ?? false,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_service_providers', {
      id: record.id,
      org_id: record.orgId,
      display_name: record.displayName,
      services: toJson(record.services),
      active: record.active ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<ServiceProviderRecord> {
    const row = await this.db.get('SELECT * FROM studio_service_providers WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('service provider', id)
    return mapProvider(row)
  }

  async listActive(orgId: string): Promise<ServiceProviderRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_service_providers WHERE org_id = ? AND active = 1 ORDER BY display_name ASC', [orgId])
    return rows.map(mapProvider)
  }

  async list(orgId: string): Promise<ServiceProviderRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_service_providers WHERE org_id = ? ORDER BY display_name ASC', [orgId])
    return rows.map(mapProvider)
  }

  async setActive(orgId: string, id: string, active: boolean): Promise<void> {
    await this.db.run('UPDATE studio_service_providers SET active = ?, updated_at = ? WHERE id = ? AND org_id = ?', [active ? 1 : 0, this.clock.isoNow(), id, orgId])
  }
}

export class ServiceOrderRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    studioVersionId?: string | null
    serviceKey: StudioService
    providerId?: string | null
    feeMicros?: number
    platformCommissionMicros?: number
    engineerPayoutMicros?: number
    rush?: boolean
    rushFeeMicros?: number
    brief?: string
    createdBy: string
  }): Promise<ServiceOrderRecord> {
    const now = this.clock.isoNow()
    const record: ServiceOrderRecord = {
      id: newId('stso', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      serviceKey: input.serviceKey,
      providerId: input.providerId ?? null,
      status: 'draft',
      feeMicros: input.feeMicros ?? 0,
      platformCommissionMicros: input.platformCommissionMicros ?? 0,
      engineerPayoutMicros: input.engineerPayoutMicros ?? 0,
      rush: input.rush ?? false,
      rushFeeMicros: input.rushFeeMicros ?? 0,
      tipMicros: 0,
      brief: input.brief ?? '',
      deliveredVersionId: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_service_orders', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      service_key: record.serviceKey,
      provider_id: record.providerId,
      status: record.status,
      fee_micros: record.feeMicros,
      platform_commission_micros: record.platformCommissionMicros,
      engineer_payout_micros: record.engineerPayoutMicros,
      rush: record.rush ? 1 : 0,
      rush_fee_micros: record.rushFeeMicros,
      tip_micros: 0,
      brief: record.brief,
      delivered_version_id: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<ServiceOrderRecord> {
    const row = await this.db.get('SELECT * FROM studio_service_orders WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('service order', id)
    return mapOrder(row)
  }

  async list(orgId: string, projectId: string): Promise<ServiceOrderRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_service_orders WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at DESC', [orgId, projectId])
    return rows.map(mapOrder)
  }

  async setStatus(orgId: string, id: string, status: ServiceOrderStatus, deliveredVersionId?: string | null): Promise<ServiceOrderRecord> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_service_orders SET status = ?, delivered_version_id = COALESCE(?, delivered_version_id), updated_at = ? WHERE id = ? AND org_id = ?', [
      status,
      deliveredVersionId ?? null,
      this.clock.isoNow(),
      id,
      orgId,
    ])
    return this.get(orgId, id)
  }
}

/**
 * The Opportunity Engine's store.
 *
 * `whyItMatches` and `confidenceBasis` are not optional columns and are not
 * allowed to be empty by the service that writes them. A recommendation whose
 * reasoning cannot be shown is a recommendation nobody should act on.
 */
export class OpportunityRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    opportunityType: OpportunityType
    headline: string
    whyItMatches: string
    evidence: string[]
    expectedValueMicros?: number | null
    expectedCostMicros?: number | null
    confidence?: number | null
    confidenceBasis: string
  }): Promise<OpportunityRecord> {
    const now = this.clock.isoNow()
    const record: OpportunityRecord = {
      id: newId('stopp', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      opportunityType: input.opportunityType,
      headline: input.headline,
      whyItMatches: input.whyItMatches,
      evidence: input.evidence,
      expectedValueMicros: input.expectedValueMicros ?? null,
      expectedCostMicros: input.expectedCostMicros ?? null,
      confidence: input.confidence ?? null,
      confidenceBasis: input.confidenceBasis,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_opportunities', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      opportunity_type: record.opportunityType,
      headline: record.headline,
      why_it_matches: record.whyItMatches,
      evidence: toJson(record.evidence),
      expected_value_micros: record.expectedValueMicros,
      expected_cost_micros: record.expectedCostMicros,
      confidence: record.confidence,
      confidence_basis: record.confidenceBasis,
      status: record.status,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<OpportunityRecord> {
    const row = await this.db.get('SELECT * FROM studio_opportunities WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('opportunity', id)
    return mapOpportunity(row)
  }

  async list(orgId: string, projectId: string): Promise<OpportunityRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_opportunities WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at DESC', [orgId, projectId])
    return rows.map(mapOpportunity)
  }

  async setStatus(orgId: string, id: string, status: 'open' | 'accepted' | 'dismissed'): Promise<OpportunityRecord> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_opportunities SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?', [status, this.clock.isoNow(), id, orgId])
    return this.get(orgId, id)
  }

  async clearFor(orgId: string, projectId: string): Promise<void> {
    await this.db.run("DELETE FROM studio_opportunities WHERE org_id = ? AND studio_project_id = ? AND status = 'open'", [orgId, projectId])
  }
}

/** Ask the Room exchanges, kept so an answer can be re-read with its context. */
export class RoomExchangeRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    studioVersionId?: string | null
    question: string
    answer: string
    responder: string
    contextUsed: string[]
    actions: RoomAction[]
    confidence: 'high' | 'moderate' | 'low' | 'insufficient'
    basis?: Record<string, unknown> | null
    askedBy: string
  }): Promise<RoomExchangeRecord> {
    const now = this.clock.isoNow()
    const record: RoomExchangeRecord = {
      id: newId('stask', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      question: input.question,
      answer: input.answer,
      responder: input.responder,
      contextUsed: input.contextUsed,
      actions: input.actions,
      confidence: input.confidence,
      basis: input.basis ?? null,
      askedBy: input.askedBy,
      createdAt: now,
    }
    await insertRow(this.db, 'studio_room_exchanges', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      question: record.question,
      answer: record.answer,
      responder: record.responder,
      context_used: toJson(record.contextUsed),
      actions: toJson(record.actions),
      confidence: record.confidence,
      basis: record.basis ? toJson(record.basis) : null,
      asked_by: record.askedBy,
      created_at: now,
    })
    return record
  }

  async list(orgId: string, projectId: string, limit = 50): Promise<RoomExchangeRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM studio_room_exchanges WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId, projectId],
    )
    return rows.map((row) => ({
      id: toStr(row.id),
      orgId: toStr(row.org_id),
      studioProjectId: toStr(row.studio_project_id),
      studioVersionId: toStrOrNull(row.studio_version_id),
      question: toStr(row.question),
      answer: toStr(row.answer),
      responder: toStr(row.responder),
      contextUsed: parseJson<string[]>(row.context_used, []),
      actions: parseJson<RoomAction[]>(row.actions, []),
      confidence: toStr(row.confidence) as RoomExchangeRecord['confidence'],
      basis: row.basis === null || row.basis === undefined ? null : parseJson<Record<string, unknown>>(row.basis, {}),
      askedBy: toStr(row.asked_by),
      createdAt: toStr(row.created_at),
    }))
  }
}

function mapProvider(row: Row): ServiceProviderRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    displayName: toStr(row.display_name),
    services: parseJson<StudioService[]>(row.services, []),
    active: toBool(row.active),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapOrder(row: Row): ServiceOrderRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    studioVersionId: toStrOrNull(row.studio_version_id),
    serviceKey: toStr(row.service_key) as StudioService,
    providerId: toStrOrNull(row.provider_id),
    status: toStr(row.status) as ServiceOrderStatus,
    feeMicros: toNum(row.fee_micros),
    platformCommissionMicros: toNum(row.platform_commission_micros),
    engineerPayoutMicros: toNum(row.engineer_payout_micros),
    rush: toBool(row.rush),
    rushFeeMicros: toNum(row.rush_fee_micros),
    tipMicros: toNum(row.tip_micros),
    brief: toStr(row.brief),
    deliveredVersionId: toStrOrNull(row.delivered_version_id),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapOpportunity(row: Row): OpportunityRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    opportunityType: toStr(row.opportunity_type) as OpportunityType,
    headline: toStr(row.headline),
    whyItMatches: toStr(row.why_it_matches),
    evidence: parseJson<string[]>(row.evidence, []),
    expectedValueMicros: toNumOrNull(row.expected_value_micros),
    expectedCostMicros: toNumOrNull(row.expected_cost_micros),
    confidence: toNumOrNull(row.confidence),
    confidenceBasis: toStr(row.confidence_basis),
    status: toStr(row.status) as OpportunityRecord['status'],
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
