import { type Db, insertRow, toBool, toNumOrNull, toStr, upsertRow } from '@masterclip/database'
import { AppError, newId, systemClock, type Clock } from '@masterclip/shared'

/**
 * Organization feature entitlements — the Partner OS seam.
 *
 * Flagship organizations get every capability; partner / white-label editions
 * get a configured subset plus numeric limits. The service is generic (any
 * string capability), so future modules reuse it; Live Lab's capability
 * constants live in @masterclip/performance-project.
 *
 * Enforcement is server-side: routes call require() before doing anything.
 * Hiding a nav item is a courtesy, not a control.
 */
export class EntitlementService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async grant(orgId: string, capability: string, enabled = true): Promise<void> {
    const now = this.clock.isoNow()
    await upsertRow(
      this.db,
      'org_entitlements',
      {
        id: newId('ent', this.clock.now()),
        org_id: orgId,
        capability,
        enabled: enabled ? 1 : 0,
        limit_value: null,
        created_at: now,
        updated_at: now,
      },
      ['org_id', 'capability'],
      ['enabled', 'updated_at'],
    )
  }

  async grantAll(orgId: string, capabilities: readonly string[]): Promise<void> {
    for (const capability of capabilities) await this.grant(orgId, capability)
  }

  async revoke(orgId: string, capability: string): Promise<void> {
    await this.db.run('UPDATE org_entitlements SET enabled = 0, updated_at = ? WHERE org_id = ? AND capability = ?', [
      this.clock.isoNow(),
      orgId,
      capability,
    ])
  }

  /** Sets a numeric usage limit. `null` clears it (unlimited). */
  async setLimit(orgId: string, limitKey: string, value: number | null): Promise<void> {
    const now = this.clock.isoNow()
    const existing = await this.db.get('SELECT id FROM org_entitlements WHERE org_id = ? AND capability = ?', [orgId, limitKey])
    if (existing) {
      await this.db.run('UPDATE org_entitlements SET limit_value = ?, updated_at = ? WHERE org_id = ? AND capability = ?', [
        value,
        now,
        orgId,
        limitKey,
      ])
      return
    }
    await insertRow(this.db, 'org_entitlements', {
      id: newId('ent', this.clock.now()),
      org_id: orgId,
      capability: limitKey,
      enabled: 1,
      limit_value: value,
      created_at: now,
      updated_at: now,
    })
  }

  async has(orgId: string, capability: string): Promise<boolean> {
    const row = await this.db.get('SELECT enabled FROM org_entitlements WHERE org_id = ? AND capability = ?', [orgId, capability])
    return row !== undefined && row !== null && toBool(row.enabled)
  }

  async require(orgId: string, capability: string): Promise<void> {
    if (!(await this.has(orgId, capability))) {
      throw new AppError({
        kind: 'forbidden',
        code: 'entitlement.missing',
        message: `this organization is not entitled to ${capability}`,
        details: { capability },
      })
    }
  }

  /** The configured limit, or null when unlimited/unset. */
  async limit(orgId: string, limitKey: string): Promise<number | null> {
    const row = await this.db.get('SELECT limit_value FROM org_entitlements WHERE org_id = ? AND capability = ?', [orgId, limitKey])
    if (!row) return null
    return toNumOrNull(row.limit_value)
  }

  /** Throws when `current` already meets or exceeds the configured limit. */
  async requireWithinLimit(orgId: string, limitKey: string, current: number, what: string): Promise<void> {
    const max = await this.limit(orgId, limitKey)
    if (max !== null && current >= max) {
      throw new AppError({
        kind: 'forbidden',
        code: 'entitlement.limit',
        message: `${what} limit reached (${max})`,
        details: { limitKey, limit: max, current },
      })
    }
  }

  async listForOrg(orgId: string): Promise<{ capabilities: string[]; limits: Record<string, number | null> }> {
    const rows = await this.db.query('SELECT capability, enabled, limit_value FROM org_entitlements WHERE org_id = ?', [orgId])
    const capabilities: string[] = []
    const limits: Record<string, number | null> = {}
    for (const row of rows) {
      const capability = toStr(row.capability)
      const limitValue = toNumOrNull(row.limit_value)
      if (limitValue !== null || capability.includes('.max_')) limits[capability] = limitValue
      else if (toBool(row.enabled)) capabilities.push(capability)
    }
    return { capabilities, limits }
  }
}
