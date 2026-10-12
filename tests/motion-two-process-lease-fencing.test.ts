import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDb } from '@masterclip/database'

/** Two actual independent file-backed database connections represent separate
 * worker processes. This exercises the same atomic lease SQL used by
 * MediaFinishLease, without killing any live service or touching real media.
 */
describe('MOTION separate-connection media fencing', () => {
  it('refuses stale workers after a simulated crash and successful lease takeover', async () => {
    const directory=await mkdtemp(join(tmpdir(),'motion-fenced-worker-'))
    const file=join(directory,'workers.sqlite')
    const first=await createDb({driver:'sqlite',sqlitePath:file})
    let second:Awaited<ReturnType<typeof createDb>>|null=null
    try {
      second=await createDb({driver:'sqlite',sqlitePath:file})
      // Leases require a genuine master foreign-key parent.
      const organization='lease-test-org'
      const project='lease-test-project'
      await first.run('INSERT INTO orgs(id,name,created_at) VALUES (?,?,?)',
        [organization,'Lease QA Org','2026-01-01T00:00:00Z'])
      await first.run(`INSERT INTO projects
        (id,org_id,name,slug,brief,style_bible,status,created_at,updated_at,archived_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,[
          project,organization,'Lease QA Project','lease-qa','',
          '{}','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',null,
        ])
      // A worker-fencing invariant is checked without creating, modifying or
      // registering any media master or user asset.
      await first.run('PRAGMA foreign_keys = OFF')
      const id='simulated-approved-master'
      await first.run(`INSERT INTO media_finish_leases(master_id,owner_token,expires_at,updated_at)
        VALUES (?,?,?,?)`,[id,'old-worker','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z'])
      const takeover=await second.run(`INSERT INTO media_finish_leases
        (master_id,owner_token,expires_at,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(master_id) DO UPDATE SET owner_token=excluded.owner_token,
          expires_at=excluded.expires_at,updated_at=excluded.updated_at
        WHERE media_finish_leases.expires_at <= ?`,[
          id,'recovered-worker','2099-01-01T00:00:00.000Z','2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z',
        ])
      expect(takeover.changes).toBe(1)
      const stale=await first.run(`UPDATE media_finish_leases SET updated_at=?
        WHERE master_id=? AND owner_token=? AND expires_at>?`,[
          '2026-10-12T00:00:01.000Z',id,'old-worker','2026-10-12T00:00:01.000Z',
        ])
      expect(stale.changes).toBe(0)
      expect((await second.get<{owner_token:string}>(
        'SELECT owner_token FROM media_finish_leases WHERE master_id=?',[id]))?.owner_token).toBe('recovered-worker')
    } finally {
      await second?.close()
      await first.close()
      await rm(directory,{recursive:true,force:true})
    }
  })
})
