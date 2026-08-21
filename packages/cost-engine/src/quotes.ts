import { type Db, insertRow, parseJsonColumn, toNum, toNumOrNull, toStr } from '@masterclip/database'
import { newId, systemClock, type Clock } from '@masterclip/shared'
import type { PriceQuote } from '@masterclip/provider-core'

/**
 * Persisted quotes.
 *
 * A quote is stored before submission and referenced by the ledger entry, so
 * every charge can be traced back to the exact price we were shown, when it was
 * shown, and against which request hash.
 */
export class QuoteStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async save(quote: PriceQuote, context: { projectId?: string | null; shotId?: string | null } = {}): Promise<string> {
    const id = newId('quote', this.clock.now())
    await insertRow(this.db, 'price_quotes', {
      id,
      project_id: context.projectId ?? null,
      shot_id: context.shotId ?? null,
      provider_id: quote.providerId,
      model_id: quote.modelId,
      request_hash: quote.requestHash,
      estimated_micros: Math.round(quote.estimatedMicros),
      credits: quote.credits,
      currency: quote.currency,
      source: quote.source,
      confidence: quote.confidence,
      raw: JSON.stringify(quote.raw ?? null),
      quoted_at: quote.quotedAt,
      expires_at: quote.expiresAt,
    })
    return id
  }

  async get(id: string): Promise<(PriceQuote & { id: string }) | null> {
    const row = await this.db.get('SELECT * FROM price_quotes WHERE id = ?', [id])
    return row ? mapQuote(row) : null
  }

  /** Most recent unexpired quote for an identical request. Avoids re-quoting on retry. */
  async findFresh(requestHash: string, nowMs = this.clock.now()): Promise<(PriceQuote & { id: string }) | null> {
    const row = await this.db.get(
      `SELECT * FROM price_quotes WHERE request_hash = ? AND expires_at > ? ORDER BY quoted_at DESC LIMIT 1`,
      [requestHash, new Date(nowMs).toISOString()],
    )
    return row ? mapQuote(row) : null
  }
}

function mapQuote(row: Record<string, unknown>): PriceQuote & { id: string } {
  return {
    id: toStr(row.id),
    providerId: toStr(row.provider_id),
    modelId: toStr(row.model_id),
    estimatedMicros: toNum(row.estimated_micros),
    credits: toNumOrNull(row.credits),
    currency: toStr(row.currency, 'USD'),
    source: toStr(row.source) as PriceQuote['source'],
    confidence: toStr(row.confidence) as PriceQuote['confidence'],
    quotedAt: toStr(row.quoted_at),
    expiresAt: toStr(row.expires_at),
    requestHash: toStr(row.request_hash),
    raw: parseJsonColumn(row.raw, null),
  }
}
