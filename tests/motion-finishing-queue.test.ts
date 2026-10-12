import { describe, expect, it } from 'vitest'
import { createTestDb } from '@masterclip/database'
import { DurableQueue, JOB_TYPES, QUEUES } from '@masterclip/queue'

describe('MOTION durable finishing queue', () => {
  it('persists one finishing job across duplicate requests', async () => {
    const db = await createTestDb()
    try {
      const q = new DurableQueue(db)
      const input = { masterId: 'master-fixture', actor: 'director-fixture', orgId: 'org-fixture' }
      const opts = {
        queue: QUEUES.media, type: JOB_TYPES.finishSongMoment, payload: input,
        dedupeKey: 'motion:song:master-fixture', maxAttempts: 2,
      }
      const first = await q.enqueue(opts)
      const again = await q.enqueue(opts)
      expect(first.deduped).toBe(false)
      expect(again).toMatchObject({ id: first.id, deduped: true })
      const retrieved = await q.get(first.id)
      expect(retrieved?.status).toBe('pending')
      expect(retrieved?.payload).toEqual(input)
      expect(retrieved?.queueName).toBe(QUEUES.media)
      const claimed = await q.claim(QUEUES.media, 1)
      expect(claimed).toHaveLength(1)
      expect(claimed[0]?.id).toBe(first.id)
      await q.complete(first.id)
      expect((await q.get(first.id))?.status).toBe('completed')
    } finally { await db.close() }
  })
})
