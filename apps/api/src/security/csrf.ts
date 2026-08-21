import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError, DEV_SESSION_SECRET } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'
import { SESSION_COOKIE } from '../server.js'
import { routedPath } from './rate-limit.js'

export const CSRF_COOKIE = 'masterclip_csrf'
export const CSRF_HEADER = 'x-csrf-token'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Paths that are never browser-driven and carry their own proof of origin.
 *
 * Provider callbacks arrive server-to-server with no cookie and no `Origin`,
 * so they never reach the token check below in any case — the gate only applies
 * to requests carrying a session cookie. The exemption is explicit so that a
 * provider which does send a cookie-shaped header cannot be refused. Their own
 * authentication is an HMAC token in the callback URL, demanded unconditionally
 * by the route itself, plus a per-provider signature over the raw body.
 */
const EXEMPT_PREFIXES = ['/api/webhooks/']

/**
 * Endpoints that establish or tear down a session.
 *
 * These keep the origin checks but must not require a token, because the gate
 * below keys on the *presence* of a session cookie rather than on it being
 * valid. A stale cookie — an expired session, a server whose sessions table was
 * reset, a token from a previous deployment — would otherwise make login,
 * signup and logout all return 403, and the only way out would be for the user
 * to clear cookies by hand. The endpoints whose job is to repair a broken
 * session cannot be the ones a broken session locks you out of.
 *
 * Nothing is given away: a cross-site login or logout is still refused by the
 * `Sec-Fetch-Site` and `Origin` checks, and none of these three is authorized
 * by the session cookie in the first place.
 */
const SESSION_LIFECYCLE = new Set(['/api/auth/login', '/api/auth/signup', '/api/auth/logout'])

/**
 * Mints a CSRF token bound to the session it belongs to.
 *
 * Plain double-submit — "the cookie and the header must match" — is forgeable
 * by anyone who can write a cookie onto the victim's domain, which includes a
 * compromised sibling subdomain: the attacker sets both halves to a value they
 * chose. Binding the token to the session token with an HMAC removes that:
 * forging a pair that verifies requires the victim's session, which an attacker
 * who can only *set* cookies does not have.
 */
export function mintCsrfToken(secret: string, sessionToken: string): string {
  const nonce = randomBytes(18).toString('base64url')
  return `${nonce}.${sign(secret, sessionToken, nonce)}`
}

function sign(secret: string, sessionToken: string, nonce: string): string {
  return createHmac('sha256', secret).update(`${nonce}.${sessionToken}`).digest('base64url')
}

export function verifyCsrfToken(secret: string, sessionToken: string, token: string | undefined): boolean {
  if (!token) return false
  const [nonce, mac] = token.split('.')
  if (!nonce || !mac) return false
  const expected = Buffer.from(sign(secret, sessionToken, nonce))
  const actual = Buffer.from(mac)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/**
 * Attaches a fresh CSRF cookie to a reply. Readable by JavaScript on purpose —
 * the SPA has to echo it back in a header, and a header is the half of the pair
 * a cross-site attacker cannot set.
 */
export function issueCsrfCookie(runtime: Runtime, reply: FastifyReply, sessionToken: string): string {
  const token = mintCsrfToken(csrfSecret(runtime), sessionToken)
  void reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    secure: runtime.config.NODE_ENV === 'production',
  })
  return token
}

export function clearCsrfCookie(reply: FastifyReply): void {
  void reply.clearCookie(CSRF_COOKIE, { path: '/' })
}

function csrfSecret(runtime: Runtime): string {
  // Same trust root as the session itself: anyone who knows it can already mint
  // sessions, so a separate secret would add key management, not security.
  return runtime.config.SESSION_SECRET || DEV_SESSION_SECRET
}

/**
 * Rejects cross-site state changes.
 *
 * Two independent layers, because each has a gap the other covers:
 *
 * 1. An origin check. `Sec-Fetch-Site` is set by the browser and cannot be
 *    forged by page JavaScript; `Origin` is the fallback for older engines.
 *    This alone stops classic cross-site POSTs.
 * 2. A session-bound double-submit token, which still holds when the request
 *    genuinely is same-site — a subdomain takeover, or anything that can write
 *    a cookie but not read one.
 *
 * Requests authenticated by `Authorization: Bearer` are exempt: they are not
 * cookie-driven, so a browser cannot be tricked into making one on a user's
 * behalf, and the CLI depends on that path.
 */
export function registerCsrf(app: FastifyInstance, runtime: Runtime): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (SAFE_METHODS.has(request.method)) return

    // Decoded the same way the router decodes it, so a percent-encoded path
    // cannot make a protected route look like an exempt one.
    const path = routedPath(request.url)
    if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return

    const sessionToken = request.cookies[SESSION_COOKIE]
    // No session cookie means nothing to ride on. Either the caller is
    // unauthenticated (login, signup) or is using a bearer token.
    if (!sessionToken) return

    const site = request.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      throw csrfFailure(`cross-site ${request.method} refused (sec-fetch-site: ${site})`)
    }

    const origin = request.headers.origin
    if (typeof origin === 'string' && origin !== 'null' && !originMatchesHost(origin, request)) {
      throw csrfFailure(`request origin ${origin} does not match this host`)
    }

    if (SESSION_LIFECYCLE.has(path)) return

    const header = request.headers[CSRF_HEADER]
    const presented = Array.isArray(header) ? header[0] : header
    if (!verifyCsrfToken(csrfSecret(runtime), sessionToken, presented)) {
      throw csrfFailure('missing or invalid CSRF token — reload the page and retry')
    }
  })
}

function originMatchesHost(origin: string, request: FastifyRequest): boolean {
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  const host = request.headers.host
  return typeof host === 'string' && host.length > 0 && originHost === host
}

function csrfFailure(message: string): AppError {
  return new AppError({ kind: 'forbidden', code: 'csrf.rejected', message })
}
