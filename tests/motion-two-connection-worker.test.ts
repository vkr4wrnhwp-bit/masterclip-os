import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDb } from '@masterclip/database'
import { DurableQueue, JOB_TYPES, QUEUES } from '@masterclip/queue'

describe('MOTION two-connection queue recovery', () => {
  it('claims one job across two distinct SQLite database connections and recovers a stalled lease', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motion-shared-worker-test-'))
    const path = join(dir, 'shared.db')
    const db1 = await createDb({ driver: 'sqlite', sqlitePath: path })
    let db2: Awaited<ReturnType<typeof createDb>> | null = null
    try {
      db2 = await createDb({ driver: 'sqlite', sqlitePath: path })
      const worker1 = new DurableQueue(db1, { workerId: 'worker-A', leaseSeconds: 1 })
      const worker2 = new DurableQueue(db2, { workerId: 'worker-B', leaseSeconds: 1 })
      const queued = await worker1.enqueue({
        queue: QUEUES.media, type: JOB_TYPES.finishSongMoment,
        payload: { masterId: 'shared-master', actor: 'director', orgId: 'organization' },
        dedupeKey: 'two-connections:shared-master',
      })
      const first = await worker1.claim(QUEUES.media, 1)
      expect(first.map(job => job.id)).toEqual([queued.id])
      expect(await worker2.claim(QUEUES.media, 1)).toHaveLength(0)
      const existing = await worker2.enqueue({
        queue: QUEUES.media, type: JOB_TYPES.finishSongMoment,
        payload: { masterId: 'shared-master', actor: 'director', orgId: 'organization' },
        dedupeKey: 'two-connections:shared-master',
      })
      expect(existing).toMatchObject({ id: queued.id, deduped: true })

      // Simulate process death without sleeping; only the queue lease expires.
      await db1.run('UPDATE queue_jobs SET lease_until = ? WHERE id = ?', [
        '2000-01-01T00:00:00.000Z', queued.id,
      ])
      expect(await worker2.recoverStalled()).toBe(1)
      const reclaimed = await worker2.claim(QUEUES.media, 1)
      expect(reclaimed.map(job => job.id)).toEqual([queued.id])
      expect(reclaimed[0]?.attempts).toBe(2)
      await worker2.complete(queued.id)
      expect((await worker1.get(queued.id))?.status).toBe('completed')
    } finally {
      await db2?.close()
      await db1.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
