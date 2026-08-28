import { insertRow, toNum, toNumOrNull, toStr, toStrOrNull, upsertRow, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import type { CreativeMemoryRecord, SonicDnaAttribute, SonicDnaRecord } from './types.js'

/**
 * Artist Sonic DNA and Creative Memory.
 *
 * Both tables answer the same question — "what does this artist consistently
 * choose?" — at different resolutions, and both are subject to the same rule:
 * nothing becomes active because the machine noticed it. A derived entry lands
 * as `proposed` / `candidate` and needs either a strong, repeated pattern or a
 * person to promote it.
 *
 * Everything stored here is *derived*: a preference for less stereo widening,
 * a habit of choosing more dynamic masters. No reference audio is retained to
 * support an entry — the evidence is a list of the artist's own approvals.
 */
export class SonicDnaRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async upsert(input: {
    orgId: string
    artistKey: string
    attribute: SonicDnaAttribute
    value?: number | null
    valueText?: string | null
    confidence: number
    sampleSize: number
    derivedFrom: string[]
    source: 'derived' | 'stated'
    status?: 'proposed' | 'active' | 'dismissed'
  }): Promise<SonicDnaRecord> {
    const existing = await this.find(input.orgId, input.artistKey, input.attribute)
    const now = this.clock.isoNow()

    // A preference the artist typed is never downgraded by an inference. If a
    // stated entry exists, a derived observation updates its evidence and
    // leaves the value alone.
    if (existing?.source === 'stated' && input.source === 'derived') {
      await this.db.run('UPDATE studio_sonic_dna SET sample_size = ?, derived_from = ?, updated_at = ? WHERE id = ?', [
        input.sampleSize,
        toJson(input.derivedFrom),
        now,
        existing.id,
      ])
      return this.get(input.orgId, existing.id)
    }

    const record: SonicDnaRecord = {
      id: existing?.id ?? newId('stdna', this.clock.now()),
      orgId: input.orgId,
      artistKey: input.artistKey,
      attribute: input.attribute,
      value: input.value ?? null,
      valueText: input.valueText ?? null,
      confidence: input.confidence,
      sampleSize: input.sampleSize,
      derivedFrom: input.derivedFrom,
      source: input.source,
      // A stated preference is active immediately — the artist said it. A
      // derived one starts proposed and is promoted deliberately.
      status: input.status ?? (input.source === 'stated' ? 'active' : (existing?.status ?? 'proposed')),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await upsertRow(
      this.db,
      'studio_sonic_dna',
      {
        id: record.id,
        org_id: record.orgId,
        artist_key: record.artistKey,
        attribute: record.attribute,
        value: record.value,
        value_text: record.valueText,
        confidence: record.confidence,
        sample_size: record.sampleSize,
        derived_from: toJson(record.derivedFrom),
        source: record.source,
        status: record.status,
        created_at: record.createdAt,
        updated_at: now,
      },
      ['org_id', 'artist_key', 'attribute'],
      ['value', 'value_text', 'confidence', 'sample_size', 'derived_from', 'source', 'status', 'updated_at'],
    )
    return record
  }

  async find(orgId: string, artistKey: string, attribute: SonicDnaAttribute): Promise<SonicDnaRecord | null> {
    const row = await this.db.get('SELECT * FROM studio_sonic_dna WHERE org_id = ? AND artist_key = ? AND attribute = ?', [orgId, artistKey, attribute])
    return row ? mapDna(row) : null
  }

  async get(orgId: string, id: string): Promise<SonicDnaRecord> {
    const row = await this.db.get('SELECT * FROM studio_sonic_dna WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('sonic dna entry', id)
    return mapDna(row)
  }

  async list(orgId: string, artistKey: string): Promise<SonicDnaRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_sonic_dna WHERE org_id = ? AND artist_key = ? ORDER BY attribute ASC', [orgId, artistKey])
    return rows.map(mapDna)
  }

  /** Only the entries that should influence anything: active, and not dismissed. */
  async active(orgId: string, artistKey: string): Promise<SonicDnaRecord[]> {
    const rows = await this.db.query("SELECT * FROM studio_sonic_dna WHERE org_id = ? AND artist_key = ? AND status = 'active' ORDER BY attribute ASC", [
      orgId,
      artistKey,
    ])
    return rows.map(mapDna)
  }

  async setStatus(orgId: string, id: string, status: 'proposed' | 'active' | 'dismissed'): Promise<SonicDnaRecord> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_sonic_dna SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?', [status, this.clock.isoNow(), id, orgId])
    return this.get(orgId, id)
  }

  /**
   * Erases everything derived for an artist.
   *
   * The product promises a user can view *and reset* their Sonic DNA, so this
   * is a real delete rather than a status flag: a reset that leaves the rows in
   * place is not a reset.
   */
  async reset(orgId: string, artistKey: string): Promise<number> {
    const result = await this.db.run('DELETE FROM studio_sonic_dna WHERE org_id = ? AND artist_key = ?', [orgId, artistKey])
    return result.changes
  }
}

export class CreativeMemoryRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Records one observation of a pattern.
   *
   * Counts move; status does not. A pattern becomes a *candidate* worth showing
   * once it has been seen enough times, and only a person promotes it. That is
   * the difference between memory the user controls and a system that quietly
   * learns from every click.
   */
  async observe(input: {
    orgId: string
    scope: 'project' | 'artist'
    scopeId: string
    patternKey: string
    statement: string
    supporting: boolean
    evidence: string
  }): Promise<CreativeMemoryRecord> {
    const existing = await this.find(input.orgId, input.scope, input.scopeId, input.patternKey)
    const now = this.clock.isoNow()

    if (existing) {
      const observations = existing.observations + 1
      const supporting = existing.supporting + (input.supporting ? 1 : 0)
      const evidence = [...existing.evidence, input.evidence].slice(-20)
      await this.db.run('UPDATE studio_creative_memory SET observations = ?, supporting = ?, confidence = ?, evidence = ?, updated_at = ? WHERE id = ?', [
        observations,
        supporting,
        confidenceFrom(observations, supporting),
        toJson(evidence),
        now,
        existing.id,
      ])
      return this.get(input.orgId, existing.id)
    }

    const record: CreativeMemoryRecord = {
      id: newId('stmem', this.clock.now()),
      orgId: input.orgId,
      scope: input.scope,
      scopeId: input.scopeId,
      patternKey: input.patternKey,
      statement: input.statement,
      observations: 1,
      supporting: input.supporting ? 1 : 0,
      confidence: confidenceFrom(1, input.supporting ? 1 : 0),
      status: 'candidate',
      editedStatement: null,
      evidence: [input.evidence],
      promotedBy: null,
      promotedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_creative_memory', {
      id: record.id,
      org_id: record.orgId,
      scope: record.scope,
      scope_id: record.scopeId,
      pattern_key: record.patternKey,
      statement: record.statement,
      observations: record.observations,
      supporting: record.supporting,
      confidence: record.confidence,
      status: record.status,
      edited_statement: null,
      evidence: toJson(record.evidence),
      promoted_by: null,
      promoted_at: null,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async find(orgId: string, scope: 'project' | 'artist', scopeId: string, patternKey: string): Promise<CreativeMemoryRecord | null> {
    const row = await this.db.get('SELECT * FROM studio_creative_memory WHERE org_id = ? AND scope = ? AND scope_id = ? AND pattern_key = ?', [
      orgId,
      scope,
      scopeId,
      patternKey,
    ])
    return row ? mapMemory(row) : null
  }

  async get(orgId: string, id: string): Promise<CreativeMemoryRecord> {
    const row = await this.db.get('SELECT * FROM studio_creative_memory WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('creative memory entry', id)
    return mapMemory(row)
  }

  async list(orgId: string, scope: 'project' | 'artist', scopeId: string): Promise<CreativeMemoryRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_creative_memory WHERE org_id = ? AND scope = ? AND scope_id = ? ORDER BY confidence DESC, updated_at DESC', [
      orgId,
      scope,
      scopeId,
    ])
    return rows.map(mapMemory)
  }

  async promote(orgId: string, id: string, actorUserId: string, editedStatement?: string | null): Promise<CreativeMemoryRecord> {
    await this.get(orgId, id)
    const now = this.clock.isoNow()
    await this.db.run("UPDATE studio_creative_memory SET status = 'promoted', promoted_by = ?, promoted_at = ?, edited_statement = ?, updated_at = ? WHERE id = ? AND org_id = ?", [
      actorUserId,
      now,
      editedStatement ?? null,
      now,
      id,
      orgId,
    ])
    return this.get(orgId, id)
  }

  async dismiss(orgId: string, id: string): Promise<CreativeMemoryRecord> {
    await this.get(orgId, id)
    await this.db.run("UPDATE studio_creative_memory SET status = 'dismissed', updated_at = ? WHERE id = ? AND org_id = ?", [this.clock.isoNow(), id, orgId])
    return this.get(orgId, id)
  }

  async reset(orgId: string, scope: 'project' | 'artist', scopeId: string): Promise<number> {
    const result = await this.db.run('DELETE FROM studio_creative_memory WHERE org_id = ? AND scope = ? AND scope_id = ?', [orgId, scope, scopeId])
    return result.changes
  }
}

/**
 * Confidence in a pattern.
 *
 * Agreement rate discounted by how little has been seen: three-for-three is
 * suggestive, not established, and the discount keeps a brand-new pattern from
 * arriving at 100%.
 */
export function confidenceFrom(observations: number, supporting: number): number {
  if (observations <= 0) return 0
  const rate = supporting / observations
  const evidenceWeight = Math.min(1, observations / 5)
  return Math.round(rate * evidenceWeight * 100) / 100
}

/** How many consistent observations before a pattern is worth showing at all. */
export const CREATIVE_MEMORY_MIN_OBSERVATIONS = 3

export function isWorthShowing(record: CreativeMemoryRecord): boolean {
  if (record.status === 'promoted') return true
  if (record.status === 'dismissed') return false
  return record.observations >= CREATIVE_MEMORY_MIN_OBSERVATIONS && record.confidence >= 0.6
}

function mapDna(row: Row): SonicDnaRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    artistKey: toStr(row.artist_key),
    attribute: toStr(row.attribute) as SonicDnaAttribute,
    value: toNumOrNull(row.value),
    valueText: toStrOrNull(row.value_text),
    confidence: toNum(row.confidence),
    sampleSize: toNum(row.sample_size),
    derivedFrom: parseJson<string[]>(row.derived_from, []),
    source: toStr(row.source) === 'stated' ? 'stated' : 'derived',
    status: toStr(row.status) as SonicDnaRecord['status'],
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapMemory(row: Row): CreativeMemoryRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    scope: toStr(row.scope) === 'artist' ? 'artist' : 'project',
    scopeId: toStr(row.scope_id),
    patternKey: toStr(row.pattern_key),
    statement: toStr(row.statement),
    observations: toNum(row.observations),
    supporting: toNum(row.supporting),
    confidence: toNum(row.confidence),
    status: toStr(row.status) as CreativeMemoryRecord['status'],
    editedStatement: toStrOrNull(row.edited_statement),
    evidence: parseJson<string[]>(row.evidence, []),
    promotedBy: toStrOrNull(row.promoted_by),
    promotedAt: toStrOrNull(row.promoted_at),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
