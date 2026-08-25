import { type Db, insertRow, toBool, toNum, toStr, toStrOrNull } from '@masterclip/database'
import { newId, systemClock, type Clock } from '@masterclip/shared'

export interface ProviderWebhookEventRecord {
  id: string
  provider: string
  externalEventId: string
  eventType: string
  signatureValid: boolean
  orgId: string | null
  payload: unknown
  status: 'received' | 'processed' | 'failed' | 'rejected'
  attempts: number
  receivedAt: string
  processedAt: string | null
  failureReason: string | null
}

/**
 * Raw webhook event store.
 *
 * Events are persisted BEFORE processing, and the (provider, externalEventId)
 * unique index makes duplicate deliveries idempotent: the second insert loses
 * the race and the caller sees `deduped: true`. Payloads never contain secrets
 * — signatures are verified against raw bytes upstream and only the verdict is
 * stored.
 */
export class WebhookEventRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async store(input: {
    provider: string
    externalEventId: string
    eventType: string
    signatureValid: boolean
    orgId: string | null
    payload: unknown
    status?: ProviderWebhookEventRecord['status']
  }): Promise<{ record: ProviderWebhookEventRecord; deduped: boolean }> {
    const record: ProviderWebhookEventRecord = {
      id: newId('pwh', this.clock.now()),
      provider: input.provider,
      externalEventId: input.externalEventId,
      eventType: input.eventType,
      signatureValid: input.signatureValid,
      orgId: input.orgId,
      payload: input.payload,
      status: input.status ?? 'received',
      attempts: 0,
      receivedAt: this.clock.isoNow(),
      processedAt: null,
      failureReason: null,
    }
    try {
      await insertRow(this.db, 'provider_webhook_events', {
        id: record.id,
        provider: record.provider,
        external_event_id: record.externalEventId,
        event_type: record.eventType,
        signature_valid: record.signatureValid ? 1 : 0,
        org_id: record.orgId,
        payload: JSON.stringify(record.payload ?? null),
        status: record.status,
        attempts: 0,
        received_at: record.receivedAt,
        processed_at: null,
        failure_reason: null,
      })
    } catch {
      const existing = await this.db.get('SELECT * FROM provider_webhook_events WHERE provider = ? AND external_event_id = ?', [
        input.provider,
        input.externalEventId,
      ])
      if (existing) return { record: mapEvent(existing), deduped: true }
      throw new Error('webhook event insert failed without a duplicate')
    }
    return { record, deduped: false }
  }

  async get(id: string): Promise<ProviderWebhookEventRecord | null> {
    const row = await this.db.get('SELECT * FROM provider_webhook_events WHERE id = ?', [id])
    return row ? mapEvent(row) : null
  }

  async markProcessed(id: string): Promise<void> {
    await this.db.run(`UPDATE provider_webhook_events SET status = 'processed', processed_at = ?, attempts = attempts + 1 WHERE id = ?`, [
      this.clock.isoNow(),
      id,
    ])
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.db.run(`UPDATE provider_webhook_events SET status = 'failed', failure_reason = ?, attempts = attempts + 1 WHERE id = ?`, [
      reason.slice(0, 1000),
      id,
    ])
  }

  async list(filter: { provider?: string; status?: string } = {}, limit = 100): Promise<ProviderWebhookEventRecord[]> {
    const clauses: string[] = []
    const params: string[] = []
    if (filter.provider) {
      clauses.push('provider = ?')
      params.push(filter.provider)
    }
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await this.db.query(
      `SELECT * FROM provider_webhook_events ${where} ORDER BY received_at DESC LIMIT ${Math.floor(limit)}`,
      params,
    )
    return rows.map(mapEvent)
  }
}

function mapEvent(row: Record<string, unknown>): ProviderWebhookEventRecord {
  let payload: unknown = null
  try {
    payload = JSON.parse(toStr(row.payload) || 'null')
  } catch {
    payload = null
  }
  return {
    id: toStr(row.id),
    provider: toStr(row.provider),
    externalEventId: toStr(row.external_event_id),
    eventType: toStr(row.event_type),
    signatureValid: toBool(row.signature_valid),
    orgId: toStrOrNull(row.org_id),
    payload,
    status: toStr(row.status) as ProviderWebhookEventRecord['status'],
    attempts: toNum(row.attempts),
    receivedAt: toStr(row.received_at),
    processedAt: toStrOrNull(row.processed_at),
    failureReason: toStrOrNull(row.failure_reason),
  }
}
