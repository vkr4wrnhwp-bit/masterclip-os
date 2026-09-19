import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { HandoffRejected, SUITE_SSO_SALT, verifyHandoff, workspaceKey } from '@masterclip/auth'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'

/**
 * Street Banker signs the hand-off in Python (itsdangerous). These two tokens
 * were minted by that library with the throwaway secret below, one small and
 * one long enough to be zlib-compressed, so the Node verifier is proved
 * against the real wire format rather than against itself.
 */
const SECRET = 'fixture-secret-not-a-real-one'
const ISSUED = 1789646498
const PLAIN =
  '.eJwVjDEOwCAMA__iGVViZWqfklKGSJAgCl2q_r3Jdj5bfvEgxYDFFxJWREBpxNUC7eeW1YRQK5YPw15JDPtwfy-eXjSdrOJDlezCmWna8fcDKCYb3Q.aqvWog._K6L-hzcgPxfMEtwUzYk5BLqxgU'
const ZIPPED =
  '.eJyrVipTsjLUUSrNTFGyUio1VNJRSs1NzMwBchIdkvSS84ECeYm5qUC-4yggGgBDrSAnMQ8YagVFoCAsLs0sAYVhbn5JZn4eKEzz85JBAiB2ZmIJMA5qATr0Z8g.aqvWog.R3VDMSCHxSq0AH0FfkUvPUMB9bA'

describe('verifyHandoff', () => {
  it('reads a token minted by Street Banker', () => {
    const who = verifyHandoff(PLAIN, SECRET, ['motion'], ISSUED + 5)
    expect(who).toMatchObject({ email: 'a@b.co', name: 'A', plan: 'pro', suite: 'motion', uid: 'u1' })
    expect(verifyHandoff(ZIPPED, SECRET, ['motion'], ISSUED + 5).name).toHaveLength(300)
  })

  it('refuses the wrong secret, a tampered token, an old token and another suite', () => {
    const reason = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error instanceof HandoffRejected ? error.reason : 'threw something else'
      }
      return 'accepted'
    }
    expect(reason(() => verifyHandoff(PLAIN, 'another-secret', ['motion'], ISSUED))).toBe('bad signature')
    expect(reason(() => verifyHandoff(PLAIN.replace('eJwV', 'eJwW'), SECRET, ['motion'], ISSUED))).toBe('bad signature')
    expect(reason(() => verifyHandoff(PLAIN, SECRET, ['motion'], ISSUED + 121))).toBe('expired')
    expect(reason(() => verifyHandoff(PLAIN, SECRET, ['tour'], ISSUED))).toBe('wrong suite')
    expect(reason(() => verifyHandoff(undefined, SECRET, ['motion'], ISSUED))).toBe('no token')
  })

  it('files a workspace under the Street Banker id, and under the email only without one', () => {
    expect(workspaceKey({ uid: '42', email: 'A@B.co' })).toBe('uid:42')
    expect(workspaceKey({ uid: '', email: 'A@B.co' })).toBe('email:a@b.co')
  })
})

/**
 * Mints a hand-off the way itsdangerous does, stamped now. The verifier is
 * proved against Python-minted tokens above; this only lets the route tests
 * arrive with a token that has not expired.
 */
function mint(claims: { uid: string; email: string; name?: string }): string {
  const b64 = (value: Buffer) => value.toString('base64url')
  const payload = b64(Buffer.from(JSON.stringify({ v: 1, plan: 'label', suite: 'motion', nonce: 'n', ...claims })))
  const stamp: number[] = []
  for (let n = Math.floor(Date.now() / 1000); n > 0; n = Math.floor(n / 256)) stamp.unshift(n % 256)
  const signed = `${payload}.${b64(Buffer.from(stamp))}`
  const key = createHash('sha1').update(`${SUITE_SSO_SALT}signer${SECRET}`).digest()
  return `${signed}.${b64(createHmac('sha1', key).update(signed).digest())}`
}

describe('GET /auth/street-banker', () => {
  let db: Db
  let runtime: Runtime
  let app: FastifyInstance
  let storageRoot: string

  beforeEach(async () => {
    db = await createTestDb()
    storageRoot = await mkdtemp(join(tmpdir(), 'masterclip-sso-test-'))
    const config = loadConfig(
      { NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: storageRoot, ASSET_SIGNING_SECRET: 'sso-test-secret', SESSION_SECRET: 'sso-test-session-secret' },
      true,
    )
    runtime = await createRuntime({ config, db, logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root: storageRoot, signingSecret: 'sso-test-secret' }) })
    app = await buildServer({ runtime, logger: silentLogger })
    await app.ready()
  })

  afterEach(async () => {
    delete process.env.SUITE_SSO_SECRET
    delete process.env.OWNER_EMAILS
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('refuses a bare visit plainly, and says so when the suite is not connected', async () => {
    const bare = await app.inject({ method: 'GET', url: '/auth/street-banker' })
    expect(bare.statusCode).toBe(401)
    expect(bare.body).toContain('needs a link from Street Banker')
    const unconnected = await app.inject({ method: 'GET', url: '/auth/street-banker?token=x' })
    expect(unconnected.statusCode).toBe(503)
  })

  it('refuses a token it cannot verify, with the way back', async () => {
    process.env.SUITE_SSO_SECRET = SECRET
    // The fixture tokens are long expired by wall-clock time, which is the point.
    const response = await app.inject({ method: 'GET', url: `/auth/street-banker?token=${PLAIN}` })
    expect(response.statusCode).toBe(401)
    expect(response.body).toContain('expired')
    expect(response.body).toContain('https://app.streetbankermusic.com/login')
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined()
  })

  it('a vouched email founds the organization once and reuses the account after', async () => {
    const first = await runtime.auth.sessionForVouchedEmail({ email: 'Artist@Example.com', displayName: 'Artist', orgId: (await runtime.projects.createOrg('Street Banker')).id, orgRole: 'owner' })
    expect(first.created).toBe(true)
    expect((await runtime.auth.resolve(first.token)).user.email).toBe('artist@example.com')
    const org = await runtime.db.get<{ id: string }>('SELECT id FROM orgs LIMIT 1')
    const again = await runtime.auth.sessionForVouchedEmail({ email: 'artist@example.com', displayName: 'Artist', orgId: String(org!.id), orgRole: 'member' })
    expect(again.created).toBe(false)
    expect(again.user.id).toBe(first.user.id)
    expect(again.user.orgRole).toBe('owner')
  })

  // ------------------------------------------------ one workspace each ----
  interface Arrival {
    cookies: Record<string, string>
    headers: Record<string, string>
    user: { userId: string; orgId: string; orgRole: string }
  }

  async function arrive(claims: { uid: string; email: string; name?: string }): Promise<Arrival> {
    process.env.SUITE_SSO_SECRET = SECRET
    const response = await app.inject({ method: 'GET', url: `/auth/street-banker?token=${mint(claims)}` })
    expect(response.statusCode).toBe(302)
    const session = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? ''
    const csrf = response.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? ''
    const cookies = { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies })
    return { cookies, headers: { [CSRF_HEADER]: csrf }, user: me.json().user }
  }

  async function listed(who: { cookies: Record<string, string> }): Promise<string[]> {
    const response = await app.inject({ method: 'GET', url: '/api/projects', cookies: who.cookies })
    expect(response.statusCode).toBe(200)
    return (response.json().projects as Array<{ name: string }>).map((p) => p.name)
  }

  async function createProject(who: Arrival, name: string): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/projects', cookies: who.cookies, headers: who.headers, payload: { name } })
    expect(response.statusCode).toBe(200)
    return response.json().project.id as string
  }

  /** What the deployed service has before anyone arrives: the seed's org, owner and project. */
  async function seedHouse(): Promise<{ orgId: string; projectId: string }> {
    const org = await runtime.projects.createOrg('Summit Arts')
    const owner = await runtime.auth.createUser({ orgId: org.id, email: 'seed@label.test', password: 'a-long-seed-password', displayName: 'Seed', orgRole: 'owner' })
    const project = await runtime.projects.create({ orgId: org.id, name: 'Neon Rain', createdBy: owner.id })
    return { orgId: org.id, projectId: project.id }
  }

  it('gives two artists two workspaces, and neither can list or open the other one', async () => {
    const a = await arrive({ uid: '101', email: 'a@artists.test', name: 'A' })
    const b = await arrive({ uid: '102', email: 'b@artists.test', name: 'B' })
    expect(a.user.orgId).not.toBe(b.user.orgId)
    expect(a.user.orgRole).toBe('owner')
    expect(b.user.orgRole).toBe('owner')

    const aSong = await createProject(a, 'A Song')
    const bSong = await createProject(b, 'B Song')
    expect(await listed(a)).toEqual(['A Song'])
    expect(await listed(b)).toEqual(['B Song'])

    for (const [who, other] of [[a, bSong], [b, aSong]] as const) {
      const open = await app.inject({ method: 'GET', url: `/api/projects/${other}`, cookies: who.cookies })
      expect(open.statusCode).toBe(403)
      const costs = await app.inject({ method: 'GET', url: `/api/projects/${other}/costs`, cookies: who.cookies })
      expect(costs.statusCode).toBe(403)
    }
    const own = await app.inject({ method: 'GET', url: `/api/projects/${aSong}`, cookies: a.cookies })
    expect(own.statusCode).toBe(200)
  })

  it('brings the same account back to the same workspace, even under a new email', async () => {
    const first = await arrive({ uid: '201', email: 'c@artists.test', name: 'C' })
    await createProject(first, 'First Single')
    const again = await arrive({ uid: '201', email: 'c@artists.test', name: 'C' })
    expect(again.user.userId).toBe(first.user.userId)
    expect(again.user.orgId).toBe(first.user.orgId)
    expect(await listed(again)).toEqual(['First Single'])

    const renamed = await arrive({ uid: '201', email: 'c.new@artists.test', name: 'C' })
    expect(renamed.user.orgId).toBe(first.user.orgId)
    expect(await listed(renamed)).toEqual(['First Single'])
    const orgs = await runtime.db.query('SELECT id FROM orgs WHERE street_banker_identity IS NOT NULL')
    expect(orgs).toHaveLength(1)
  })

  it('keeps OWNER_EMAILS in the original organization, as owner, with its projects', async () => {
    const house = await seedHouse()
    process.env.OWNER_EMAILS = 'boss@label.test'
    const artist = await arrive({ uid: '301', email: 'd@artists.test', name: 'D' })
    const owner = await arrive({ uid: '1', email: 'Boss@Label.test', name: 'Boss' })

    expect(owner.user.orgId).toBe(house.orgId)
    expect(owner.user.orgRole).toBe('owner')
    expect(await listed(owner)).toEqual(['Neon Rain'])
    expect(artist.user.orgId).not.toBe(house.orgId)
    expect(await listed(artist)).toEqual([])
    const peek = await app.inject({ method: 'GET', url: `/api/projects/${house.projectId}`, cookies: artist.cookies })
    expect(peek.statusCode).toBe(403)
  })

  it('never mistakes the first artist workspace for the original organization', async () => {
    process.env.OWNER_EMAILS = 'boss@label.test'
    const artist = await arrive({ uid: '401', email: 'e@artists.test', name: 'E' })
    const owner = await arrive({ uid: '1', email: 'boss@label.test', name: 'Boss' })
    expect(owner.user.orgId).not.toBe(artist.user.orgId)
    expect(await runtime.auth.houseOrgId()).toBe(owner.user.orgId)
  })

  it('moves an artist who arrived as a shared member into their own workspace, with only what they made', async () => {
    const house = await seedHouse()
    // Before per-account workspaces every arrival joined the seed's org as a
    // member. This is that account, and a project it made through the API.
    const member = await runtime.auth.createUser({ orgId: house.orgId, email: 'f@artists.test', password: 'a-long-member-password', displayName: 'F', orgRole: 'member' })
    const demo = await runtime.projects.create({ orgId: house.orgId, name: 'Old Demo', createdBy: member.id })
    await runtime.audit.record({ orgId: house.orgId, projectId: demo.id, actor: member.id, action: 'project.created', targetType: 'project', targetId: demo.id })

    // A session from before the move no longer lists the house's projects.
    const earlier = { cookies: { [SESSION_COOKIE]: (await runtime.auth.login('f@artists.test', 'a-long-member-password')).token } }
    expect(await listed(earlier)).toEqual([])

    const back = await arrive({ uid: '501', email: 'f@artists.test', name: 'F' })
    expect(back.user.userId).toBe(member.id)
    expect(back.user.orgRole).toBe('owner')
    expect(back.user.orgId).not.toBe(house.orgId)
    expect(await listed(back)).toEqual(['Old Demo'])
    expect(await listed(earlier)).toEqual(['Old Demo'])
    const peek = await app.inject({ method: 'GET', url: `/api/projects/${house.projectId}`, cookies: back.cookies })
    expect(peek.statusCode).toBe(403)

    expect((await runtime.projects.get(house.projectId)).orgId).toBe(house.orgId)
    expect((await runtime.projects.get(demo.id)).orgId).toBe(back.user.orgId)
    const trail = await runtime.db.get<{ data: string }>("SELECT data FROM audit_log WHERE action = 'account.moved_to_own_workspace'")
    expect(JSON.parse(String(trail?.data))).toEqual({ fromOrgId: house.orgId, projectIds: [demo.id] })

    // The next arrival finds the workspace and moves nothing.
    const later = await arrive({ uid: '501', email: 'f@artists.test', name: 'F' })
    expect(later.user.orgId).toBe(back.user.orgId)
    const moves = await runtime.db.query("SELECT id FROM audit_log WHERE action = 'account.moved_to_own_workspace'")
    expect(moves).toHaveLength(1)
  })

  it('brings an owner who first arrived as an artist back to the original organization once named', async () => {
    const house = await seedHouse()
    const early = await arrive({ uid: '1', email: 'boss@label.test', name: 'Boss' })
    expect(early.user.orgId).not.toBe(house.orgId)
    await createProject(early, 'Boss Draft')

    process.env.OWNER_EMAILS = 'boss@label.test'
    const named = await arrive({ uid: '1', email: 'boss@label.test', name: 'Boss' })
    expect(named.user.userId).toBe(early.user.userId)
    expect(named.user.orgId).toBe(house.orgId)
    expect(named.user.orgRole).toBe('owner')
    expect((await listed(named)).sort()).toEqual(['Boss Draft', 'Neon Rain'])
  })

  it('keeps an email-keyed workspace when the same person later arrives with their id', async () => {
    const before = await arrive({ uid: '', email: 'h@artists.test', name: 'H' })
    await createProject(before, 'Untitled')
    const after = await arrive({ uid: '701', email: 'h@artists.test', name: 'H' })
    expect(after.user.orgId).toBe(before.user.orgId)
    expect(await listed(after)).toEqual(['Untitled'])
    const org = await runtime.db.get<{ street_banker_identity: string }>('SELECT street_banker_identity FROM orgs WHERE id = ?', [after.user.orgId])
    expect(org?.street_banker_identity).toBe('uid:701')
  })

  it('does not move the seeded owner who arrives without being in OWNER_EMAILS', async () => {
    const house = await seedHouse()
    const seed = await arrive({ uid: '1', email: 'seed@label.test', name: 'Seed' })
    expect(seed.user.orgId).toBe(house.orgId)
    expect(seed.user.orgRole).toBe('owner')
    expect(await listed(seed)).toEqual(['Neon Rain'])
  })

  it('refuses an email that already belongs to another artist workspace', async () => {
    await arrive({ uid: '601', email: 'g@artists.test', name: 'G' })
    process.env.SUITE_SSO_SECRET = SECRET
    const response = await app.inject({ method: 'GET', url: `/auth/street-banker?token=${mint({ uid: '602', email: 'g@artists.test' })}` })
    expect(response.statusCode).toBe(409)
    expect(response.body).toContain('different Street Banker account')
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined()
  })
})
