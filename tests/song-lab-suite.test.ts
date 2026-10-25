import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { verifyHandoff } from '@masterclip/auth'
import { buildServer } from '../apps/api/src/server.js'
import type { FastifyInstance } from 'fastify'

const SECRET = 'fixture-song-lab-only-signing-key'
function mint(payload: Record<string, unknown>, age = 0, secret = SECRET) {
  const body = Buffer.from(JSON.stringify({ v: 1, uid: 'artist-1', email: 'artist@example.com', name: 'Artist', plan: 'pro', suite: 'song-lab', nonce: randomBytes(12).toString('hex'), ...payload })).toString('base64url')
  const now = Math.floor(Date.now() / 1000) - age
  const hex = now.toString(16).padStart(8, '0')
  const signed = `${body}.${Buffer.from(hex, 'hex').toString('base64url')}`
  const key = createHash('sha1').update(`street-banker-suite-sso-v1signer${secret}`).digest()
  return `${signed}.${createHmac('sha1', key).update(signed).digest('base64url')}`
}
let db: Db, runtime: Runtime, app: FastifyInstance, root: string
async function boot(enabled = true, sso = true, live = false) {
  db = await createTestDb(); root = await mkdtemp(join(tmpdir(), 'songlab-suite-'))
  const config = loadConfig({ NODE_ENV: 'test', SONG_LAB_SUITE_ENABLED: enabled ? '1' : '0', SONG_LAB_SUITE_SUITE_SSO_ENABLED: sso ? '1' : '0', STAGE_LIVE_LAB_ENABLED: live ? '1' : '0', SUITE_SSO_SECRET_SONG_LAB: SECRET, SESSION_SECRET: 'fixture-session', ASSET_SIGNING_SECRET: 'fixture-storage', RATE_LIMIT_ENABLED: '0' }, true)
  runtime = await createRuntime({ config, db, logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root, signingSecret: 'fixture-storage' }) })
  app = await buildServer({ runtime }); await app.ready()
}
async function arrival(payload: Record<string, unknown> = {}, age = 0, secret = SECRET, entry: 'song' | 'live' = 'song') {
  const start = await app.inject({ url: entry === 'live' ? '/login?entry=live' : '/login' })
  const state = new URL(start.headers.location!).searchParams.get('state')!
  const cookie = start.cookies.find(c => c.name === 'song_lab_signin_state')!
  const token = mint({ state, ...payload }, age, secret)
  const result = await app.inject({ method: 'POST', url: '/auth/street-banker', headers: { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }, payload: new URLSearchParams({ token }).toString() })
  return { result, token, state, cookie: `${cookie.name}=${cookie.value}`, session: result.cookies.find(c => c.name === 'masterclip_session')?.value }
}
afterEach(async () => { await app?.close(); await runtime?.close(); if(root) await rm(root, { recursive: true, force: true }) })

describe('Song Lab suite server boundary', () => {
  beforeEach(() => boot())
  it('keeps Job 45 version comparison unavailable by default', async () => {
    const config = await app.inject({ url: '/api/song-lab-suite' })
    expect(config.statusCode).toBe(200)
    expect(config.json().versionCompareEnabled).toBe(false)
    const { session } = await arrival({ plan: 'pro' })
    const headers = { cookie: `masterclip_session=${session}` }
    const pair = await app.inject({ url: '/api/song-journey/links/unknown/version-pair?left=v1&right=v2', headers })
    const loudness = await app.inject({ url: '/api/song-journey/links/unknown/version-pair-loudness?left=v1&right=v2', headers })
    expect(pair.statusCode).toBe(404)
    expect(loudness.statusCode).toBe(404)
    const approval = await app.inject({ url: '/api/song-journey/links/unknown/final-approval', headers })
    expect(approval.statusCode).toBe(404)
  })
  it('only accepts a real parent identity; Pro and Label can use existing libraries', async () => {
    for (const plan of ['pro', 'label']) {
      const { result, session } = await arrival({ plan })
      expect(result.statusCode).toBe(303)
      const songs = await app.inject({ url: '/api/song-lab/projects', headers: { cookie: `masterclip_session=${session}` } })
      expect(songs.statusCode).toBe(200)
      expect((await app.inject({ url: '/api/studio/projects', headers: { cookie: `masterclip_session=${session}` } })).statusCode).toBe(200)
    }
  })
  it('opens the existing Live Lab from a Stage seat with only Stage scoped routes', async () => {
    await app.close(); await runtime.close(); if (root) await rm(root, { recursive: true, force: true })
    await boot(true, true, true)
    const seat = { seat_id: 'stage-seat', artist_uid: 'stage-owner', artist_plan: 'pro', rooms: ['stage'], access: 'edit' }
    const { result, session } = await arrival({ uid: 'stage-performer', plan: 'fan', seat }, 0, SECRET, 'live')
    expect(result.statusCode).toBe(303)
    expect(result.headers.location).toBe('/#/live-lab')
    const cookie = { cookie: `masterclip_session=${session}` }
    expect((await app.inject({ url: '/api/live-lab/projects', headers: cookie })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/projects', headers: cookie })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/live-lab/projects/live-1/import-release', headers: cookie, payload: { sourceProjectId: 'release-1' } })).statusCode).toBe(403)
    expect((await app.inject({ url: '/api/studio/projects', headers: cookie })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: '/api/projects', headers: cookie, payload: { name: 'Cross-room write' } })).statusCode).toBe(403)
    const access = (await app.inject({ url: '/api/song-lab-suite', headers: cookie })).json()
    expect(access.entryMode).toBe('live'); expect(access.sourceLibraryEnabled).toBe(false)
    const releaseSeat = { ...seat, seat_id: 'stage-and-release-seat', rooms: ['stage', 'releases'] }
    const withReleases = await arrival({ uid: 'stage-performer-with-releases', plan: 'fan', seat: releaseSeat }, 0, SECRET, 'live')
    expect(withReleases.result.statusCode).toBe(303)
    const releaseCookie = { cookie: `masterclip_session=${withReleases.session}` }
    expect((await app.inject({ url: '/api/projects', headers: releaseCookie })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/song-lab-suite', headers: releaseCookie })).json().sourceLibraryEnabled).toBe(true)
  })
  it('keeps Live set opt-in and refuses seats without Stage', async () => {
    expect((await app.inject({ url: '/login?entry=live' })).statusCode).toBe(404)
    await app.close(); await runtime.close(); if (root) await rm(root, { recursive: true, force: true })
    await boot(true, true, true)
    const studioSeat = { seat_id: 'studio-seat', artist_uid: 'studio-owner', artist_plan: 'pro', rooms: ['studio'], access: 'edit' }
    expect((await arrival({ uid: 'studio-performer', seat: studioSeat }, 0, SECRET, 'live')).result.statusCode).toBe(403)
  })
  it.each(['artist', 'fan', '', 'unknown'])('locks %s on the server with an upgrade door', async plan => {
    const { result, session } = await arrival({ plan })
    expect(result.statusCode).toBe(403); expect(result.body).toContain('Upgrade at Street Banker'); expect(session).toBeUndefined()
  })
  it('refuses forged, expired, future and wrong-suite tokens', async () => {
    expect((await arrival({}, 0, 'other-suite-fixture-key')).result.statusCode).toBe(401)
    expect((await arrival({}, 121)).result.statusCode).toBe(401)
    expect((await arrival({}, -31)).result.statusCode).toBe(401)
    expect((await arrival({ suite: 'motion' })).result.statusCode).toBe(401)
    expect((await arrival({ uid: '' })).result.statusCode).toBe(401)
  })
  it('consumes a nonce once even after a server restart', async () => {
    const first = await arrival()
    expect(first.result.statusCode).toBe(303)
    await app.close(); app = await buildServer({ runtime }); await app.ready()
    const replay = await app.inject({ method: 'POST', url: '/auth/street-banker', headers: { cookie: first.cookie }, payload: { token: first.token } })
    expect(replay.statusCode).toBe(401)
  })
  it('binds sign-in to the requesting browser', async () => {
    const result = await app.inject({ method: 'POST', url: '/auth/street-banker', payload: { token: mint({ state: 'another-browser' }) } })
    expect(result.statusCode).toBe(401)
  })
  it('team access follows owner plan and Studio room; read seats cannot write', async () => {
    const seat = { seat_id: 'seat-1', artist_uid: 'owner-1', artist_plan: 'pro', rooms: ['studio'], access: 'read' }
    const accepted = await arrival({ uid: 'seat-user', plan: 'fan', seat })
    expect(accepted.result.statusCode).toBe(303)
    const write = await app.inject({ method: 'POST', url: '/api/song-lab/projects', headers: { authorization: 'Bearer ignored', cookie: `masterclip_session=${accepted.session}` }, payload: {} })
    expect(write.statusCode).toBe(403)
    expect((await arrival({ seat: { ...seat, artist_plan: 'artist' } })).result.statusCode).toBe(403)
    expect((await arrival({ seat: { ...seat, rooms: ['stage'] } })).result.statusCode).toBe(403)
  })
  it('isolates tenants even if two signed identities share an email', async () => {
    const first = await arrival({ uid: 'artist-a' }); const second = await arrival({ uid: 'artist-b' })
    const me = async (session: string | undefined) => (await app.inject({ url: '/api/auth/me', headers: { cookie: `masterclip_session=${session}` } })).json().user
    const a = await me(first.session), b = await me(second.session)
    expect(a.orgId).not.toBe(b.orgId)
    const project = await runtime.songLab.projects.create({ actor: { orgId: a.orgId, userId: a.userId, orgRole: 'owner', email: a.email }, title: 'Private', artistName: 'Private', genre: 'pop', rightsConfirmed: true })
    const foreign = await app.inject({ url: `/api/song-lab/projects/${project.id}`, headers: { cookie: `masterclip_session=${second.session}` } })
    expect([403, 404]).toContain(foreign.statusCode)
    const tampered = await arrival({ uid: 'artist-a', seat: { seat_id: 'seat-1', artist_uid: '', artist_plan: 'pro', rooms: 'all', access: 'edit' } })
    expect(tampered.result.statusCode).toBe(401)
  })
  it('a Studio-room seat can read its owner’s project without gaining another tenant', async () => {
    const owner = await arrival({ uid: 'owner-seat-test' })
    const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: `masterclip_session=${owner.session}` } })).json().user
    const project = await runtime.studio.projects.create({ actor: { orgId: me.orgId, userId: me.userId, orgRole: 'owner', email: me.email }, title: 'Seat project', artistName: 'Artist', genre: 'pop', rightsConfirmed: true })
    const seat = await arrival({ uid: 'reader-seat-test', plan: 'fan', seat: { seat_id: 'reader-1', artist_uid: 'owner-seat-test', artist_plan: 'pro', rooms: ['studio'], access: 'read' } })
    const response = await app.inject({ url: `/api/studio/projects/${project.id}`, headers: { cookie: `masterclip_session=${seat.session}` } })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Seat project')
    expect((await app.inject({ url: '/api/live-lab/projects', headers: { cookie: `masterclip_session=${owner.session}` } })).statusCode).toBe(200)
  })
  it('rejects password login and old local/bearer sessions', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@y.com', password: 'fake' } })).statusCode).toBe(401)
    expect((await app.inject({ url: '/api/song-lab/projects', headers: { authorization: 'Bearer fake' } })).statusCode).toBe(401)
  })
  it('keeps A&R and proprietary cohorts behind explicit grants', async () => {
    const { session } = await arrival()
    const caps = await app.inject({ url: '/api/song-lab/capabilities', headers: { cookie: `masterclip_session=${session}` } })
    expect(caps.body).not.toContain('song_lab.ar_view'); expect(caps.body).not.toContain('song_lab.signal_benchmarks')
  })
  it('expires suite sessions and refuses mutations without the session CSRF token', async () => {
    const { session } = await arrival()
    const mutation = await app.inject({ method: 'POST', url: '/api/song-lab/projects', headers: { cookie: `masterclip_session=${session}` }, payload: {} })
    expect(mutation.statusCode).toBe(403)
    expect(mutation.body).toContain('csrf.rejected')
    await db.run("UPDATE song_lab_suite_sessions SET expires_at = ?", ['2000-01-01T00:00:00.000Z'])
    expect((await app.inject({ url: '/api/song-lab/projects', headers: { cookie: `masterclip_session=${session}` } })).statusCode).toBe(401)
  })
  it('understands a Python itsdangerous compressed handoff', () => {
    // Captured from Python itsdangerous 2.2; compressed payload, fixed timestamp.
    const token = ".eJyrVipTsjLUUSrNTFGyUiqoLMnIz9MtLU4tUtJRSs1NzMyBizqkViTmFuSk6iXn5wIl8xJzU4FyPvl56Qp-QLbCKGswsIAxU5CTmAeKtaJ8IKe4NLMEFE_FQBW6OYlJoJjLz0tORUR2WmZFSWlRqlItABGrrTA.atr4xQ.HrZh0XOhiR8IOKDRD_q618dBxzg"
    expect(verifyHandoff(token, SECRET, ['song-lab'], 1792735429).uid).toBe('python-user')
  })
})
it('flag off leaves legacy auth and preview APIs unchanged', async () => {
  await boot(false)
  expect((await app.inject({ url: '/api/song-lab-suite' })).json().enabled).toBe(false)
  expect((await app.inject({ url: '/login' })).statusCode).toBe(404)
  expect((await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'legacy@example.com', password: 'legacy-long-fixture', displayName: 'Legacy', orgName: 'Legacy' } })).statusCode).toBe(200)
})
it('SSO defaults off and fails closed when the suite shell is enabled', async () => {
  await boot(true, false)
  expect((await app.inject({ url: '/login' })).statusCode).toBe(503)
  expect((await app.inject({ url: '/api/song-lab/projects' })).statusCode).toBe(401)
})
