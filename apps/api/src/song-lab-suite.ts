import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { verifyHandoff, type HandoffIdentity } from '@masterclip/auth'
import { insertRow, toStr } from '@masterclip/database'
import { LIVE_LAB_CAPABILITIES } from '@masterclip/performance-project'
import { PARTNER_SONG_LAB_CAPABILITIES } from '@masterclip/song-lab-domain'
import { PARTNER_STUDIO_CAPABILITIES } from '@masterclip/studio-domain'
import { AppError, sha256Hex } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'
import { SESSION_COOKIE } from './server.js'
import { issueCsrfCookie, clearCsrfCookie } from './security/csrf.js'

export const SONG_LAB_SUITE_ID = 'song_lab_suite'
export const SONG_LAB_WIRE_KEY = 'song-lab'
const STATE_COOKIE = 'song_lab_signin_state'
const SESSION_SECONDS = 15 * 60
const denied = (message: string) => new AppError({ kind: 'forbidden', code: 'song_lab_suite.access', message })

/** The signed parent account chooses tenancy; no client-supplied org or email lookup does. */
export function songLabMembership(who: HandoffIdentity): { tenant: string; role: 'owner' | 'member'; access: 'read' | 'edit' } {
  const seat = who.seat
  const plan = seat ? seat.artist_plan : who.plan
  if (!['pro', 'label'].includes(plan)) throw denied('Song Lab opens with Pro or Label. Upgrade at Street Banker.')
  if (seat && seat.rooms !== 'all' && !seat.rooms.includes('studio')) throw denied('This team seat needs the Studio room.')
  return { tenant: seat?.artist_uid ?? who.uid, role: seat ? 'member' : 'owner', access: seat?.access ?? 'edit' }
}

function cookieOptions(runtime: Runtime) {
  return { httpOnly: true, secure: runtime.config.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' }
}

export async function registerSongLabSuite(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const config = runtime.config
  const home = new URL(config.STREET_BANKER_URL).origin
  app.get('/api/song-lab-suite', async (_req, reply) => {
    void reply.header('cache-control', 'no-store')
    return {
      enabled: config.SONG_LAB_SUITE_ENABLED,
      linkedRecordsEnabled: config.SONG_LAB_SUITE_ENABLED && config.SONG_LAB_SUITE_LINKED_RECORDS_ENABLED,
      signIn: '/login',
      streetBankerUrl: home,
      suiteId: SONG_LAB_SUITE_ID,
    }
  })
  if (!config.SONG_LAB_SUITE_ENABLED) return

  const refusal = (reply: FastifyReply, status: number, locked = false) => reply.code(status).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html').send(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Song Lab access</title><body style="background:#000000;color:#FFFFFF;font:16px Arial,sans-serif;margin:0;padding:24px"><main style="max-width:640px;margin:10vh auto;padding:24px;background:#111111;border:1px solid #3A3A3A;border-radius:10px"><strong style="color:#E8B950">[ SL ]</strong><h1>Street Banker Song Lab</h1><p>${locked ? 'Song Lab requires Pro or Label and permission to use the Studio room.' : 'Open Song Lab from Street Banker to get a fresh sign-in link.'}</p><a style="display:inline-flex;align-items:center;min-height:48px;padding:0 24px;background:#E8B950;color:#000000;border-radius:10px" href="${home}${locked ? '/pricing' : '/suites/go/song-lab'}">${locked ? 'Upgrade at Street Banker' : 'Sign in at Street Banker'}</a></main></body></html>`,
  )
  app.get('/login', async (_request, reply) => {
    if (!config.SONG_LAB_SUITE_SUITE_SSO_ENABLED || !config.SUITE_SSO_SECRET_SONG_LAB) return refusal(reply, 503)
    const state = randomBytes(32).toString('base64url')
    void reply.setCookie(STATE_COOKIE, state, { ...cookieOptions(runtime), sameSite: 'none', maxAge: 300 })
    return reply.header('cache-control', 'no-store').redirect(`${home}/suites/go/song-lab?state=${state}`)
  })
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 32768 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))))
  })
  const receive = async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    if (!config.SONG_LAB_SUITE_SUITE_SSO_ENABLED || !config.SUITE_SSO_SECRET_SONG_LAB) return refusal(reply, 503)
    const token = (request.body as { token?: string } | undefined)?.token
    let who: HandoffIdentity
    try {
      who = verifyHandoff(token, config.SUITE_SSO_SECRET_SONG_LAB, [SONG_LAB_WIRE_KEY], Math.floor(runtime.clock.now() / 1000))
      const state = request.cookies[STATE_COOKIE]
      if (!state || !who.state || sha256Hex(state) !== sha256Hex(who.state)) return refusal(reply, 401)
    } catch { return refusal(reply, 401) }
    let membership: ReturnType<typeof songLabMembership>
    try { membership = songLabMembership(who) } catch { return refusal(reply, 403, true) }
    const tokenValue = randomBytes(32).toString('base64url')
    const orgId = `org_sl_${sha256Hex(membership.tenant).slice(0, 32)}`
    const userId = `usr_sl_${sha256Hex(`${membership.tenant}:${who.uid}`).slice(0, 32)}`
    const expiresAt = new Date(runtime.clock.now() + SESSION_SECONDS * 1000).toISOString()
    try {
      await runtime.db.transaction(async tx => {
        // A unique database key consumes the nonce atomically, including across processes/restarts.
        const used = await tx.run('INSERT INTO song_lab_suite_nonces (nonce_hash, used_at) VALUES (?, ?) ON CONFLICT (nonce_hash) DO NOTHING', [sha256Hex(who.nonce), runtime.clock.isoNow()])
        if (!used.changes) throw new Error('replayed handoff')
        await tx.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING', [orgId, 'Song Lab workspace', runtime.clock.isoNow()])
        await tx.run(`INSERT INTO users (id, org_id, email, display_name, password_hash, org_role, disabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, org_role = excluded.org_role`,
          [userId, orgId, `${userId}@song-lab.invalid`, who.name, 'sso-only', membership.role, runtime.clock.isoNow()])
        await insertRow(tx, 'song_lab_suite_sessions', { token_hash: sha256Hex(tokenValue), user_id: userId, org_id: orgId, tenant_uid: membership.tenant, email: who.email, display_name: who.name, access_mode: membership.access, expires_at: expiresAt })
      })
    } catch { return refusal(reply, 401) }
    // Ordinary capabilities only. Internal A&R and proprietary cohorts still require explicit grants.
    await runtime.entitlements.grantAll(orgId, [...PARTNER_SONG_LAB_CAPABILITIES, ...PARTNER_STUDIO_CAPABILITIES, ...LIVE_LAB_CAPABILITIES])
    void reply.clearCookie(STATE_COOKIE, { path: '/' })
    void reply.setCookie(SESSION_COOKIE, tokenValue, { ...cookieOptions(runtime), maxAge: SESSION_SECONDS })
    issueCsrfCookie(runtime, reply, tokenValue)
    return reply.code(303).redirect('/#/song-lab')
  }
  app.post('/auth/street-banker', receive)
  app.get('/auth/street-banker', async (_req, reply) => reply.redirect('/login'))

  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (!path.startsWith('/api/') || ['/api/health', '/api/song-lab-suite'].includes(path)) return
    if (path === '/api/auth/login' || path === '/api/auth/signup') return refusal(reply, 401)
    if (path === '/api/auth/logout') {
      await runtime.db.run('DELETE FROM song_lab_suite_sessions WHERE token_hash = ?', [sha256Hex(request.cookies[SESSION_COOKIE] ?? '')])
      void reply.clearCookie(SESSION_COOKIE, { path: '/' }); clearCsrfCookie(reply)
      return reply.send({ ok: true })
    }
    const row = await runtime.db.get('SELECT s.*, u.disabled, u.org_role FROM song_lab_suite_sessions s JOIN users u ON u.id = s.user_id WHERE token_hash = ?', [sha256Hex(request.cookies[SESSION_COOKIE] ?? '')])
    if (!row || row.disabled || Date.parse(toStr(row.expires_at)) <= runtime.clock.now()) throw new AppError({ kind: 'unauthorized', code: 'song_lab_suite.signin', message: 'Sign in through Street Banker.' })
    if (row.access_mode === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) throw denied('This team seat is read-only.')
    request.auth = { userId: toStr(row.user_id), orgId: toStr(row.org_id), email: toStr(row.email), displayName: toStr(row.display_name), orgRole: toStr(row.org_role), ...(row.org_role === 'member' ? { suiteSeatAccess: toStr(row.access_mode) as 'read' | 'edit' } : {}) }
  })
}
