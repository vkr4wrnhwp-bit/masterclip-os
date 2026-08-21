import { type Db, insertRow, parseJsonColumn, toNum, toStr, toStrOrNull } from '@masterclip/database'
import {
  AppError,
  backoffDelayMs,
  isTransient,
  newId,
  systemClock,
  type Clock,
  type Logger,
  silentLogger,
} from '@masterclip/shared'

export type QueueStatus = 'pending' | 'active' | 'completed' | 'failed' | 'dead' | 'cancelled'

export interface QueueJob<P = unknown> {
  id: string
  queueName: string
  type: string
  payload: P
  status: QueueStatus
  priority: number
  attempts: number
  maxAttempts: number
  runAt: string
  leaseUntil: string | null
  lockedBy: string | null
  dedupeKey: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface EnqueueOptions<P = unknown> {
  type: string
  payload: P
  queue?: string
  /** Higher runs first. */
  priority?: number
  delayMs?: number
  runAt?: string
  maxAttempts?: number
  /**
   * Uniqueness key. A second enqueue with the same key is a no-op, which is how
   * a duplicated webhook or a double-clicked button stops becoming a second
   * paid render.
   */
  dedupeKey?: string
}

export interface QueueOptions {
  clock?: Clock
  logger?: Logger
  workerId?: string
  leaseSeconds?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  random?: () => number
}

const DEFAULT_QUEUE = 'default'

/**
 * Database-backed durable queue.
 *
 * Chosen over Redis+BullMQ because the state that must not be lost — what was
 * submitted, what it cost, what is still owed — already lives in this database,
 * and a queue in the same transaction as the ledger write cannot disagree with
 * it. Jobs survive browser closure, API restarts, and worker crashes because
 * nothing about a job lives in a process: claiming is a leased row update, and
 * an expired lease returns the job to the pool.
 */
export class DurableQueue {
  private readonly clock: Clock
  private readonly logger: Logger
  private readonly workerId: string
  private readonly leaseSeconds: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly random: () => number

  constructor(
    private readonly db: Db,
    opts: QueueOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock
    this.logger = opts.logger ?? silentLogger
    this.workerId = opts.workerId ?? `worker-${process.pid}-${newId('run').slice(-6)}`
    this.leaseSeconds = opts.leaseSeconds ?? 120
    this.backoffBaseMs = opts.backoffBaseMs ?? 2_000
    this.backoffMaxMs = opts.backoffMaxMs ?? 5 * 60_000
    this.random = opts.random ?? Math.random
  }

  get id(): string {
    return this.workerId
  }

  async enqueue<P>(opts: EnqueueOptions<P>): Promise<{ id: string; deduped: boolean }> {
    const now = this.clock.now()
    const runAt = opts.runAt ?? new Date(now + (opts.delayMs ?? 0)).toISOString()
    const iso = new Date(now).toISOString()

    if (opts.dedupeKey) {
      const existing = await this.db.get<{ id: string }>('SELECT id FROM queue_jobs WHERE dedupe_key = ?', [
        opts.dedupeKey,
      ])
      if (existing) return { id: existing.id, deduped: true }
    }

    const id = newId('qmsg', now)
    try {
      await insertRow(this.db, 'queue_jobs', {
        id,
        queue_name: opts.queue ?? DEFAULT_QUEUE,
        job_type: opts.type,
        payload: JSON.stringify(opts.payload ?? null),
        status: 'pending',
        priority: opts.priority ?? 0,
        run_at: runAt,
        attempts: 0,
        max_attempts: opts.maxAttempts ?? 5,
        lease_until: null,
        locked_by: null,
        dedupe_key: opts.dedupeKey ?? null,
        last_error: null,
        created_at: iso,
        updated_at: iso,
        completed_at: null,
      })
    } catch (err) {
      // Lost a race on the unique dedupe index — the other writer's row wins.
      if (opts.dedupeKey) {
        const existing = await this.db.get<{ id: string }>('SELECT id FROM queue_jobs WHERE dedupe_key = ?', [
          opts.dedupeKey,
        ])
        if (existing) return { id: existing.id, deduped: true }
      }
      throw err
    }
    return { id, deduped: false }
  }

  /**
   * Atomically leases up to `limit` runnable jobs. PostgreSQL uses
   * `FOR UPDATE SKIP LOCKED`; SQLite relies on its single-writer transaction,
   * which gives the same guarantee for the same reason.
   */
  async claim(queueName = DEFAULT_QUEUE, limit = 1): Promise<QueueJob[]> {
    const now = this.clock.now()
    const nowIso = new Date(now).toISOString()
    const leaseUntil = new Date(now + this.leaseSeconds * 1000).toISOString()

    return this.db.transaction(async (tx) => {
      const selectSql =
        `SELECT id FROM queue_jobs
         WHERE queue_name = ? AND status = 'pending' AND run_at <= ?
         ORDER BY priority DESC, run_at ASC
         LIMIT ${Math.max(1, Math.floor(limit))}` + (tx.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '')

      const candidates = await tx.query<{ id: string }>(selectSql, [queueName, nowIso])
      const claimed: QueueJob[] = []
      for (const { id } of candidates) {
        const result = await tx.run(
          `UPDATE queue_jobs
             SET status = 'active', attempts = attempts + 1, lease_until = ?, locked_by = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
          [leaseUntil, this.workerId, nowIso, id],
        )
        if (result.changes === 0) continue
        const row = await tx.get('SELECT * FROM queue_jobs WHERE id = ?', [id])
        if (row) claimed.push(mapJob(row))
      }
      return claimed
    })
  }

  async complete(id: string): Promise<void> {
    const iso = this.clock.isoNow()
    await this.db.run(
      `UPDATE queue_jobs SET status = 'completed', completed_at = ?, updated_at = ?, lease_until = NULL, locked_by = NULL
       WHERE id = ?`,
      [iso, iso, id],
    )
  }

  /**
   * Records a failure and decides between retry and dead-letter.
   *
   * `forceRetry` exists for the case the retry classifier calls non-transient
   * but a human explicitly re-queued; `neverRetry` for errors whose retry would
   * spend money again without authorization.
   */
  async fail(
    id: string,
    error: unknown,
    opts: { forceRetry?: boolean; neverRetry?: boolean } = {},
  ): Promise<{ retried: boolean; delayMs: number; dead: boolean }> {
    const job = await this.get(id)
    if (!job) throw new AppError({ kind: 'not_found', message: `queue job ${id} not found` })

    const message = error instanceof Error ? error.message : String(error)
    const detail = error instanceof AppError ? JSON.stringify(error.toJSON()) : message
    const iso = this.clock.isoNow()

    const canRetry =
      !opts.neverRetry && (opts.forceRetry || isTransient(error)) && job.attempts < job.maxAttempts

    if (canRetry) {
      const hinted = error instanceof AppError ? error.retryAfterSeconds : undefined
      const delayMs =
        typeof hinted === 'number' && hinted > 0
          ? Math.round(hinted * 1000)
          : backoffDelayMs(job.attempts, { baseMs: this.backoffBaseMs, maxMs: this.backoffMaxMs }, this.random)
      await this.db.run(
        `UPDATE queue_jobs
           SET status = 'pending', run_at = ?, last_error = ?, updated_at = ?, lease_until = NULL, locked_by = NULL
         WHERE id = ?`,
        [new Date(this.clock.now() + delayMs).toISOString(), detail, iso, id],
      )
      this.logger.warn('queue.retry', { job_id: id, type: job.type, attempt: job.attempts, delay_ms: delayMs })
      return { retried: true, delayMs, dead: false }
    }

    await this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE queue_jobs SET status = 'dead', last_error = ?, updated_at = ?, lease_until = NULL, locked_by = NULL
         WHERE id = ?`,
        [detail, iso, id],
      )
      await insertRow(tx, 'queue_dead', {
        id: newId('qmsg'),
        original_id: job.id,
        queue_name: job.queueName,
        job_type: job.type,
        payload: JSON.stringify(job.payload ?? null),
        attempts: job.attempts,
        last_error: detail,
        failed_at: iso,
        replayed_at: null,
      })
    })
    this.logger.error('queue.dead_letter', { job_id: id, type: job.type, attempts: job.attempts, err: message })
    return { retried: false, delayMs: 0, dead: true }
  }

  /** Keeps a long-running job's lease alive (provider polling can outlive it). */
  async extendLease(id: string, seconds = this.leaseSeconds): Promise<void> {
    await this.db.run(`UPDATE queue_jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'active'`, [
      new Date(this.clock.now() + seconds * 1000).toISOString(),
      this.clock.isoNow(),
      id,
    ])
  }

  /** Re-queues a job for a later re-check without counting a failure. */
  async reschedule(id: string, delayMs: number): Promise<void> {
    const iso = this.clock.isoNow()
    await this.db.run(
      `UPDATE queue_jobs
         SET status = 'pending', run_at = ?, updated_at = ?, lease_until = NULL, locked_by = NULL,
             attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END
       WHERE id = ?`,
      [new Date(this.clock.now() + delayMs).toISOString(), iso, id],
    )
  }

  /**
   * Returns jobs whose lease expired (worker died mid-flight) to the pending
   * pool. Without this a crashed worker silently strands work forever.
   */
  async recoverStalled(): Promise<number> {
    const iso = this.clock.isoNow()
    const result = await this.db.run(
      `UPDATE queue_jobs
         SET status = 'pending', lease_until = NULL, locked_by = NULL, updated_at = ?
       WHERE status = 'active' AND lease_until IS NOT NULL AND lease_until < ?`,
      [iso, iso],
    )
    if (result.changes > 0) this.logger.warn('queue.recovered_stalled', { count: result.changes })
    return result.changes
  }

  async cancel(id: string): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE queue_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending','active')`,
      [this.clock.isoNow(), id],
    )
    return result.changes > 0
  }

  async get(id: string): Promise<QueueJob | undefined> {
    const row = await this.db.get('SELECT * FROM queue_jobs WHERE id = ?', [id])
    return row ? mapJob(row) : undefined
  }

  async replayDead(deadId: string): Promise<string> {
    const row = await this.db.get('SELECT * FROM queue_dead WHERE id = ?', [deadId])
    if (!row) throw new AppError({ kind: 'not_found', message: `dead job ${deadId} not found` })
    const iso = this.clock.isoNow()
    const { id } = await this.enqueue({
      type: toStr(row.job_type),
      payload: parseJsonColumn(row.payload, null),
      queue: toStr(row.queue_name),
    })
    await this.db.run('UPDATE queue_dead SET replayed_at = ? WHERE id = ?', [iso, deadId])
    return id
  }

  async stats(queueName?: string): Promise<Record<QueueStatus | 'dead_letter', number>> {
    const where = queueName ? 'WHERE queue_name = ?' : ''
    const params = queueName ? [queueName] : []
    const rows = await this.db.query<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM queue_jobs ${where} GROUP BY status`,
      params,
    )
    const out: Record<string, number> = {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      cancelled: 0,
      dead_letter: 0,
    }
    for (const r of rows) out[toStr(r.status)] = toNum(r.n)
    const dead = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM queue_dead WHERE replayed_at IS NULL${queueName ? ' AND queue_name = ?' : ''}`,
      params,
    )
    out.dead_letter = toNum(dead?.n)
    return out as Record<QueueStatus | 'dead_letter', number>
  }

  async list(queueName?: string, statuses?: QueueStatus[], limit = 100): Promise<QueueJob[]> {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (queueName) {
      clauses.push('queue_name = ?')
      params.push(queueName)
    }
    if (statuses && statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await this.db.query(
      `SELECT * FROM queue_jobs ${where} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
      params,
    )
    return rows.map(mapJob)
  }
}

function mapJob(row: Record<string, unknown>): QueueJob {
  return {
    id: toStr(row.id),
    queueName: toStr(row.queue_name),
    type: toStr(row.job_type),
    payload: parseJsonColumn(row.payload, null),
    status: toStr(row.status) as QueueStatus,
    priority: toNum(row.priority),
    attempts: toNum(row.attempts),
    maxAttempts: toNum(row.max_attempts),
    runAt: toStr(row.run_at),
    leaseUntil: toStrOrNull(row.lease_until),
    lockedBy: toStrOrNull(row.locked_by),
    dedupeKey: toStrOrNull(row.dedupe_key),
    lastError: toStrOrNull(row.last_error),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
