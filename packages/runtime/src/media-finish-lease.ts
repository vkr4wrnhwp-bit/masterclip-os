import type { Db } from '@masterclip/database'
import { AppError, newId } from '@masterclip/shared'
import type { Runtime } from './index.js'

const LEASE_MS = 5 * 60_000
const RENEW_MS = 20_000

/**
 * A cross-process per-master lease with a unique fencing token.
 *
 * A queue dedupe key alone is not a lock: a dead-letter retry or expired
 * queue lease can place multiple workers on the same master. The database
 * protects every final asset+deliverable transaction from a stale worker.
 */
export class MediaFinishLease {
  private released = false
  private lost = false

  private constructor(
    private readonly rt: Runtime,
    readonly masterId: string,
    readonly token: string,
  ) {}

  static async acquire(rt: Runtime, masterId: string): Promise<MediaFinishLease> {
    const token = newId('run', rt.clock.now())
    const now = new Date(rt.clock.now()).toISOString()
    const expires = new Date(rt.clock.now() + LEASE_MS).toISOString()
    // This one statement is atomic on both SQLite and PostgreSQL. The
    // conditional conflict update cannot steal an unexpired lease.
    const result = await rt.db.run(
      `INSERT INTO media_finish_leases (master_id, owner_token, expires_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(master_id) DO UPDATE
          SET owner_token = excluded.owner_token,
              expires_at = excluded.expires_at,
              updated_at = excluded.updated_at
       WHERE media_finish_leases.expires_at <= ?`,
      [masterId, token, expires, now, now],
    )
    if (result.changes !== 1) {
      throw new AppError({
        kind: 'conflict',
        code: 'media_finish.busy',
        message: 'another worker is finishing media for this master',
      })
    }
    return new MediaFinishLease(rt, masterId, token)
  }

  async renew(): Promise<void> {
    if (this.released || this.lost) throw this.notOwned()
    const now = new Date(this.rt.clock.now()).toISOString()
    const expires = new Date(this.rt.clock.now() + LEASE_MS).toISOString()
    try {
      const result = await this.rt.db.run(
        `UPDATE media_finish_leases SET expires_at = ?, updated_at = ?
         WHERE master_id = ? AND owner_token = ? AND expires_at > ?`,
        [expires, now, this.masterId, this.token, now],
      )
      if (result.changes !== 1) { this.lost = true; throw this.notOwned() }
    } catch (error) {
      this.lost = true
      throw error
    }
  }

  private notOwned(): AppError {
    return new AppError({
      kind: 'conflict',
      code: 'media_finish.lease_lost',
      message: 'finishing lease was lost; refuse to register a duplicate delivery',
    })
  }

  /**
   * Holds the database row lock *within* the same transaction that inserts
   * the derivative asset, its lineage and its master_deliverables record.
   *
   * A stale worker cannot pass this check once another worker has recovered
   * the expired lease. PostgreSQL SELECT FOR UPDATE serializes recovery;
   * SQLite begins its write transaction with BEGIN IMMEDIATE.
   */
  async commit<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return this.rt.db.transaction(async tx => {
      const sql = `SELECT owner_token, expires_at FROM media_finish_leases
        WHERE master_id = ?` + (tx.dialect === 'postgres' ? ' FOR UPDATE' : '')
      const row = await tx.get<{ owner_token: string; expires_at: string }>(sql, [this.masterId])
      const now = new Date(this.rt.clock.now()).toISOString()
      if (this.released || this.lost || !row || row.owner_token !== this.token || row.expires_at <= now) {
        this.lost = true
        throw this.notOwned()
      }
      return work(tx)
    })
  }

  async release(): Promise<void> {
    this.released = true
    await this.rt.db.run('DELETE FROM media_finish_leases WHERE master_id = ? AND owner_token = ?', [
      this.masterId, this.token,
    ])
  }
}

export async function withMediaFinishLease<T>(
  rt: Runtime,
  masterId: string,
  action: (lease: MediaFinishLease) => Promise<T>,
): Promise<T> {
  const lease = await MediaFinishLease.acquire(rt, masterId)
  let renewalFailed = false
  let renewalInFlight = false
  const timer = setInterval(() => {
    if (renewalInFlight) return
    renewalInFlight = true
    void lease.renew().catch(() => { renewalFailed = true }).finally(() => { renewalInFlight = false })
  }, RENEW_MS)
  timer.unref()
  try {
    const result = await action(lease)
    if (renewalFailed) throw new AppError({
      kind: 'conflict', code: 'media_finish.renewal_failed',
      message: 'finishing lease renewal failed',
    })
    return result
  } finally {
    clearInterval(timer)
    await lease.release()
  }
}
