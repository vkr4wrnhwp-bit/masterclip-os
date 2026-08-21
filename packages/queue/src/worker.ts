import { AppError, sleep, silentLogger, systemClock, type Clock, type Logger } from '@masterclip/shared'
import type { DurableQueue, QueueJob } from './queue.js'

export interface HandlerContext {
  job: QueueJob
  logger: Logger
  /** Push the lease out while a long provider poll is in flight. */
  heartbeat(): Promise<void>
  /** Re-run this job later without counting it as a failure. */
  defer(delayMs: number): void
}

export type JobHandler<P = unknown> = (payload: P, ctx: HandlerContext) => Promise<void>

export interface WorkerOptions {
  queueName?: string
  concurrency?: number
  pollIntervalMs?: number
  stalledSweepMs?: number
  logger?: Logger
  clock?: Clock
}

class DeferSignal {
  constructor(readonly delayMs: number) {}
}

/**
 * Pulls leased jobs off the durable queue and runs registered handlers.
 *
 * Deliberately a plain loop: the interesting behaviour (leases, backoff,
 * dead-lettering) lives in the queue where it is transactional and testable,
 * and the worker is just the part that can crash without consequence.
 */
export class QueueWorker {
  private readonly handlers = new Map<string, JobHandler<never>>()
  private readonly logger: Logger
  private readonly clock: Clock
  private readonly queueName: string
  private readonly concurrency: number
  private readonly pollIntervalMs: number
  private readonly stalledSweepMs: number
  private running = false
  private stopping = false
  private inFlight = 0
  private lastSweep = 0
  private loopPromise: Promise<void> | null = null

  constructor(
    private readonly queue: DurableQueue,
    opts: WorkerOptions = {},
  ) {
    this.logger = opts.logger ?? silentLogger
    this.clock = opts.clock ?? systemClock
    this.queueName = opts.queueName ?? 'default'
    this.concurrency = Math.max(1, opts.concurrency ?? 4)
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000
    this.stalledSweepMs = opts.stalledSweepMs ?? 30_000
  }

  register<P>(type: string, handler: JobHandler<P>): this {
    this.handlers.set(type, handler as JobHandler<never>)
    return this
  }

  get registeredTypes(): string[] {
    return [...this.handlers.keys()]
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopping = false
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.loopPromise
    this.running = false
  }

  /** Drains everything currently runnable. Used by tests and by the CLI. */
  async runOnce(max = 50): Promise<number> {
    let processed = 0
    for (let i = 0; i < max; i++) {
      const jobs = await this.queue.claim(this.queueName, 1)
      if (jobs.length === 0) break
      for (const job of jobs) {
        await this.execute(job)
        processed++
      }
    }
    return processed
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (this.clock.now() - this.lastSweep > this.stalledSweepMs) {
          this.lastSweep = this.clock.now()
          await this.queue.recoverStalled()
        }
        const capacity = this.concurrency - this.inFlight
        if (capacity <= 0) {
          await sleep(this.pollIntervalMs)
          continue
        }
        const jobs = await this.queue.claim(this.queueName, capacity)
        if (jobs.length === 0) {
          await sleep(this.pollIntervalMs)
          continue
        }
        for (const job of jobs) {
          this.inFlight++
          void this.execute(job).finally(() => {
            this.inFlight--
          })
        }
      } catch (err) {
        this.logger.error('worker.loop_error', { err })
        await sleep(this.pollIntervalMs)
      }
    }
    // Let in-flight handlers finish before the process exits.
    const deadline = this.clock.now() + 30_000
    while (this.inFlight > 0 && this.clock.now() < deadline) await sleep(50)
  }

  private async execute(job: QueueJob): Promise<void> {
    const handler = this.handlers.get(job.type)
    const logger = this.logger.child({ job_id: job.id, job_type: job.type, attempt: job.attempts })

    if (!handler) {
      await this.queue.fail(
        job.id,
        new AppError({ kind: 'internal', code: 'queue.no_handler', message: `no handler for job type ${job.type}` }),
        { neverRetry: true },
      )
      return
    }

    let deferMs: number | null = null
    const ctx: HandlerContext = {
      job,
      logger,
      heartbeat: () => this.queue.extendLease(job.id),
      defer: (delayMs: number) => {
        deferMs = delayMs
      },
    }

    const startedAt = this.clock.now()
    try {
      await handler(job.payload as never, ctx)
      if (deferMs !== null) {
        await this.queue.reschedule(job.id, deferMs)
        logger.debug('worker.deferred', { delay_ms: deferMs })
      } else {
        await this.queue.complete(job.id)
        logger.debug('worker.completed', { duration_ms: this.clock.now() - startedAt })
      }
    } catch (err) {
      if (err instanceof DeferSignal) {
        await this.queue.reschedule(job.id, err.delayMs)
        return
      }
      logger.error('worker.failed', { err, duration_ms: this.clock.now() - startedAt })
      await this.queue.fail(job.id, err)
    }
  }
}
