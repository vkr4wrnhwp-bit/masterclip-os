import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, migrationStatus, runMigrations, type Db } from '@masterclip/database'
import { DurableQueue, JOB_TYPES, QUEUES } from '@masterclip/queue'

let db: Db | null = null
afterEach(async () => { if (db) await db.close(); db = null })

describe('MOTION release migration and worker recovery', () => {
  it('includes fenced media leases in a clean schema and is idempotent', async () => {
    db = await createTestDb()
    const status = await migrationStatus(db)
    expect(status.find(row => row.id === '0004_media_finish_leases')).toMatchObject({ applied: true })
    const table = await db.query<{name: string}>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_finish_leases'")
    expect(table).toHaveLength(1)
    const second = await runMigrations(db)
    expect(second.applied).toEqual([])
    expect(second.skipped).toContain('0004_media_finish_leases')
  })

  it('recovers expired job leases without creating a second persistent job', async () => {
    db = await createTestDb()
    const queue = new DurableQueue(db, { workerId: 'worker-one', leaseSeconds: 1 })
    const first = await queue.enqueue({
      queue: QUEUES.media,
      type: JOB_TYPES.finishSongMoment,
      payload: { masterId: 'fixture-master', actor: 'director', orgId: 'fixture-org' },
      dedupeKey: 'release-test:fixture-master',
    })
    const claimed = await queue.claim(QUEUES.media, 1)
    expect(claimed[0]?.id).toBe(first.id)
    await db.run('UPDATE queue_jobs SET lease_until = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', first.id])
    expect(await queue.recoverStalled()).toBe(1)
    const secondWorker = new DurableQueue(db, { workerId: 'worker-two' })
    const recovered = await secondWorker.claim(QUEUES.media, 1)
    expect(recovered[0]?.id).toBe(first.id)
    expect(recovered[0]?.attempts).toBe(2)
    expect((await secondWorker.enqueue({
      queue: QUEUES.media,
      type: JOB_TYPES.finishSongMoment,
      payload: { masterId: 'fixture-master', actor: 'director', orgId: 'fixture-org' },
      dedupeKey: 'release-test:fixture-master',
    })).deduped).toBe(true)
    await secondWorker.complete(first.id)
    expect((await queue.get(first.id))?.status).toBe('completed')
  })
})
