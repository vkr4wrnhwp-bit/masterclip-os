import { insertRow, toNum, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { hashObject, newId, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'

/**
 * The provenance chain.
 *
 * `studio_activity` records what happened. It cannot show that nothing was
 * *removed* — delete a row and the log reads as though the event never
 * occurred. Each event here carries the hash of its predecessor, so the
 * sequence checks itself: removing an event breaks the link at the next one,
 * and editing one changes its hash and breaks the link too.
 *
 * **Tamper-evident, not tamper-proof.** Nothing is signed. Anyone who can write
 * to this table can recompute the whole chain and it will verify. What this
 * defends against is the realistic failure — one inconvenient row edited or
 * removed and the rest left alone — and no surface in the product describes it
 * as anything more than that.
 */

export const PROVENANCE_EVENT_TYPES = [
  'project.created',
  'rights.confirmed',
  'version.added',
  'analysis.completed',
  'master.rendered',
  'approval.granted',
  'approval.revoked',
  'delivery.sent',
  'passport.finalized',
] as const

export type ProvenanceEventType = (typeof PROVENANCE_EVENT_TYPES)[number]

export const PROVENANCE_STATEMENT =
  'Each event carries the hash of the one before it, so a removed or altered event breaks the chain at the next link. This is tamper-evident, not cryptographic proof: nothing here is signed, and a party with database access could rebuild the chain.'

export interface ProvenanceEventRecord {
  id: string
  orgId: string
  studioProjectId: string
  sequence: number
  eventType: ProvenanceEventType
  subjectType: string
  subjectId: string
  actorUserId: string | null
  actorLabel: string
  payload: Record<string, unknown>
  previousHash: string | null
  hash: string
  recordedAt: string
}

export interface ProvenanceVerification {
  intact: boolean
  events: number
  /** The sequence number where the chain first fails, or null when it holds. */
  brokenAt: number | null
  reason: string | null
  /** The hash of the last event. What a passport pins itself to. */
  headHash: string | null
  statement: string
}

export class ProvenanceRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Appends one event.
   *
   * The sequence and the previous hash are read inside this method rather than
   * passed in, so a caller cannot accidentally (or deliberately) write an event
   * that links to the wrong predecessor. The unique index on
   * `(org_id, project, sequence)` is the backstop: two concurrent appends race
   * and one fails rather than both claiming the same position.
   */
  async append(input: {
    orgId: string
    studioProjectId: string
    eventType: ProvenanceEventType
    subjectType: string
    subjectId: string
    actorUserId?: string | null
    actorLabel: string
    payload?: Record<string, unknown>
  }): Promise<ProvenanceEventRecord> {
    const head = await this.head(input.orgId, input.studioProjectId)
    const sequence = (head?.sequence ?? 0) + 1
    const recordedAt = this.clock.isoNow()
    const payload = input.payload ?? {}

    const record: ProvenanceEventRecord = {
      id: newId('stpe', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      sequence,
      eventType: input.eventType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      actorUserId: input.actorUserId ?? null,
      actorLabel: input.actorLabel,
      payload,
      previousHash: head?.hash ?? null,
      hash: '',
      recordedAt,
    }
    record.hash = hashEvent(record)

    await insertRow(this.db, 'studio_provenance_events', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      sequence: record.sequence,
      event_type: record.eventType,
      subject_type: record.subjectType,
      subject_id: record.subjectId,
      actor_user_id: record.actorUserId,
      actor_label: record.actorLabel,
      payload: toJson(record.payload),
      previous_hash: record.previousHash,
      hash: record.hash,
      recorded_at: recordedAt,
    })
    return record
  }

  async list(orgId: string, projectId: string): Promise<ProvenanceEventRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM studio_provenance_events WHERE org_id = ? AND studio_project_id = ? ORDER BY sequence ASC',
      [orgId, projectId],
    )
    return rows.map(mapEvent)
  }

  async head(orgId: string, projectId: string): Promise<ProvenanceEventRecord | null> {
    const row = await this.db.get(
      'SELECT * FROM studio_provenance_events WHERE org_id = ? AND studio_project_id = ? ORDER BY sequence DESC',
      [orgId, projectId],
    )
    return row ? mapEvent(row) : null
  }

  /**
   * Walks the chain and re-derives every hash.
   *
   * Three things can fail, and the answer says which: a gap in the sequence (an
   * event was removed), a link that does not match its predecessor's hash, and
   * a hash that does not match its own content (an event was edited). Reporting
   * "the chain is broken" without the position would make the check useless for
   * actually finding out what happened.
   */
  async verify(orgId: string, projectId: string): Promise<ProvenanceVerification> {
    const events = await this.list(orgId, projectId)
    if (events.length === 0) {
      return { intact: true, events: 0, brokenAt: null, reason: null, headHash: null, statement: PROVENANCE_STATEMENT }
    }

    let previousHash: string | null = null
    for (const [index, event] of events.entries()) {
      const expectedSequence = index + 1
      if (event.sequence !== expectedSequence) {
        return {
          intact: false,
          events: events.length,
          brokenAt: expectedSequence,
          reason: `event ${expectedSequence} is missing — the sequence jumps to ${event.sequence}`,
          headHash: null,
          statement: PROVENANCE_STATEMENT,
        }
      }
      if (event.previousHash !== previousHash) {
        return {
          intact: false,
          events: events.length,
          brokenAt: event.sequence,
          reason: `event ${event.sequence} does not link to the event before it`,
          headHash: null,
          statement: PROVENANCE_STATEMENT,
        }
      }
      if (hashEvent(event) !== event.hash) {
        return {
          intact: false,
          events: events.length,
          brokenAt: event.sequence,
          reason: `event ${event.sequence} has been altered since it was recorded`,
          headHash: null,
          statement: PROVENANCE_STATEMENT,
        }
      }
      previousHash = event.hash
    }

    return { intact: true, events: events.length, brokenAt: null, reason: null, headHash: previousHash, statement: PROVENANCE_STATEMENT }
  }
}

/**
 * The hash of one event.
 *
 * Taken over a canonical serialization — `hashObject` sorts keys at every depth
 * — because two builds that serialize the same event with different key order
 * would otherwise produce different hashes, and an integrity check that fails
 * for no reason is worse than none.
 *
 * The event's own `hash` and `id` are excluded: one is the output, and the
 * other is a random value that says nothing about what happened.
 */
export function hashEvent(event: Omit<ProvenanceEventRecord, 'hash' | 'id'>): string {
  return hashObject({
    sequence: event.sequence,
    eventType: event.eventType,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    actorUserId: event.actorUserId,
    actorLabel: event.actorLabel,
    payload: event.payload,
    previousHash: event.previousHash,
    recordedAt: event.recordedAt,
  })
}

function mapEvent(row: Row): ProvenanceEventRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    sequence: toNum(row.sequence),
    eventType: toStr(row.event_type) as ProvenanceEventType,
    subjectType: toStr(row.subject_type),
    subjectId: toStr(row.subject_id),
    actorUserId: toStrOrNull(row.actor_user_id),
    actorLabel: toStr(row.actor_label),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    previousHash: toStrOrNull(row.previous_hash),
    hash: toStr(row.hash),
    recordedAt: toStr(row.recorded_at),
  }
}
