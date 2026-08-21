import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type Db } from '@masterclip/database'
import { AppError, fixedClock } from '@masterclip/shared'
import { DurableQueue, QueueWorker } from '../src/index.js'

let db: Db
beforeEach(async () => {
  db = await createTestDb()
})

function makeQueue(clock = fixedClock(1_700_000_000_000)) {
  return { queue: new DurableQueue(db, { clock, leaseSeconds: 60, random: () => 0.5 }), clock }
}

describe('durable queue', () => {
  it('claims a job exactly once', async () => {
    const { queue } = makeQueue()
    await queue.enqueue({ type: 'render.submit', payload: { jobId: 'j1' } })

    const first = await queue.claim('default', 5)
    const second = await queue.claim('default', 5)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    expect(first[0]?.attempts).toBe(1)
  })

  it('deduplicates on the dedupe key, so a double-click is not a second paid render', async () => {
    const { queue } = makeQueue()
    const a = await queue.enqueue({ type: 'render.submit', payload: { jobId: 'j1' }, dedupeKey: 'submit:j1' })
    const b = await queue.enqueue({ type: 'render.submit', payload: { jobId: 'j1' }, dedupeKey: 'submit:j1' })
    expect(b.deduped).toBe(true)
    expect(b.id).toBe(a.id)
    expect(await queue.list()).toHaveLength(1)
  })

  it('honours priority then run_at ordering', async () => {
    const { queue } = makeQueue()
    await queue.enqueue({ type: 'low', payload: {}, priority: 0 })
    await queue.enqueue({ type: 'high', payload: {}, priority: 10 })
    const claimed = await queue.claim('default', 1)
    expect(claimed[0]?.type).toBe('high')
  })

  it('does not claim a job scheduled for the future', async () => {
    const { queue, clock } = makeQueue()
    await queue.enqueue({ type: 'later', payload: {}, delayMs: 60_000 })
    expect(await queue.claim('default', 5)).toHaveLength(0)
    clock.advance(61_000)
    expect(await queue.claim('default', 5)).toHaveLength(1)
  })

  it('retries transient failures with backoff and dead-letters the rest', async () => {
    const { queue, clock } = makeQueue()
    const { id } = await queue.enqueue({ type: 'render.poll', payload: {}, maxAttempts: 3 })

    await queue.claim('default', 1)
    const first = await queue.fail(id, new AppError({ kind: 'provider_rate_limited', message: 'slow down' }))
    expect(first.retried).toBe(true)
    expect(first.delayMs).toBeGreaterThan(0)

    clock.advance(first.delayMs + 1)
    await queue.claim('default', 1)
    const second = await queue.fail(id, new AppError({ kind: 'provider_unavailable', message: 'down' }))
    expect(second.retried).toBe(true)

    clock.advance(second.delayMs + 1)
    await queue.claim('default', 1)
    const third = await queue.fail(id, new AppError({ kind: 'provider_unavailable', message: 'down' }))
    expect(third.dead).toBe(true)

    const stats = await queue.stats()
    expect(stats.dead).toBe(1)
    expect(stats.dead_letter).toBe(1)
  })

  it('never retries a non-transient failure', async () => {
    const { queue } = makeQueue()
    const { id } = await queue.enqueue({ type: 'x', payload: {}, maxAttempts: 5 })
    await queue.claim('default', 1)
    const result = await queue.fail(id, new AppError({ kind: 'validation', message: 'bad request' }))
    expect(result.retried).toBe(false)
    expect(result.dead).toBe(true)
  })

  it('returns a stalled job to the pool when its lease expires', async () => {
    const { queue, clock } = makeQueue()
    await queue.enqueue({ type: 'x', payload: {} })
    const claimed = await queue.claim('default', 1)
    expect(claimed).toHaveLength(1)

    // Worker dies mid-flight; nothing releases the lease.
    expect(await queue.claim('default', 1)).toHaveLength(0)
    clock.advance(61_000)
    expect(await queue.recoverStalled()).toBe(1)
    expect(await queue.claim('default', 1)).toHaveLength(1)
  })

  it('extends a lease for a long provider poll', async () => {
    const { queue, clock } = makeQueue()
    const { id } = await queue.enqueue({ type: 'x', payload: {} })
    await queue.claim('default', 1)
    clock.advance(50_000)
    await queue.extendLease(id, 120)
    clock.advance(61_000)
    expect(await queue.recoverStalled()).toBe(0)
  })

  it('defers without counting a failure', async () => {
    const { queue, clock } = makeQueue()
    const { id } = await queue.enqueue({ type: 'x', payload: {} })
    await queue.claim('default', 1)
    await queue.reschedule(id, 5_000)
    const job = await queue.get(id)
    expect(job?.status).toBe('pending')
    expect(job?.attempts).toBe(0)
    clock.advance(5_001)
    expect(await queue.claim('default', 1)).toHaveLength(1)
  })

  it('replays a dead-lettered job', async () => {
    const { queue } = makeQueue()
    const { id } = await queue.enqueue({ type: 'render.submit', payload: { jobId: 'j9' }, maxAttempts: 1 })
    await queue.claim('default', 1)
    await queue.fail(id, new AppError({ kind: 'validation', message: 'bad' }))
    const dead = await db.get<{ id: string }>('SELECT id FROM queue_dead LIMIT 1')
    const replayed = await queue.replayDead(String(dead?.id))
    const job = await queue.get(replayed)
    expect(job?.type).toBe('render.submit')
    expect(job?.payload).toEqual({ jobId: 'j9' })
  })
})

describe('queue worker', () => {
  it('runs handlers and completes jobs', async () => {
    const { queue } = makeQueue()
    const worker = new QueueWorker(queue, { concurrency: 1 })
    const seen: string[] = []
    worker.register<{ id: string }>('task', async (payload) => {
      seen.push(payload.id)
    })
    await queue.enqueue({ type: 'task', payload: { id: 'a' } })
    await queue.enqueue({ type: 'task', payload: { id: 'b' } })

    expect(await worker.runOnce()).toBe(2)
    expect(seen.sort()).toEqual(['a', 'b'])
    expect((await queue.stats()).completed).toBe(2)
  })

  it('dead-letters a job with no registered handler instead of looping forever', async () => {
    const { queue } = makeQueue()
    const worker = new QueueWorker(queue, { concurrency: 1 })
    await queue.enqueue({ type: 'unknown.type', payload: {} })
    await worker.runOnce()
    expect((await queue.stats()).dead).toBe(1)
  })

  it('reschedules a deferred job rather than completing it', async () => {
    const { queue, clock } = makeQueue()
    const worker = new QueueWorker(queue, { concurrency: 1, clock })
    let runs = 0
    worker.register('poll', async (_payload, ctx) => {
      runs++
      if (runs < 2) ctx.defer(1_000)
    })
    await queue.enqueue({ type: 'poll', payload: {} })

    await worker.runOnce(1)
    expect(runs).toBe(1)
    expect((await queue.stats()).pending).toBe(1)

    clock.advance(1_001)
    await worker.runOnce(1)
    expect(runs).toBe(2)
    expect((await queue.stats()).completed).toBe(1)
  })
})
