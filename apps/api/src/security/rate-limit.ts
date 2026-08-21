import type { FastifyInstance, FastifyRequest } from 'fastify'
import { RateLimiter, rateLimited, type RateLimitPolicy } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'

/**
 * Request classes, ordered by how expensive it is to be wrong about them.
 *
 * The budgets are per client address per process, and are set so that no
 * plausible human or UI ever reaches them — they exist to bound automated
 * abuse, not to meter normal use. Anything tightened to the point where the
 * review grid trips it would just get disabled by whoever runs this.
 */
export const POLICIES = {
  /** Password endpoints. The only place an attacker gets unlimited guesses. */
  auth: { limit: 10, windowMs: 15 * 60_000 },
  /**
   * Per (account, address): stops one host grinding away at one mailbox.
   *
   * Keyed on the address as well as the email on purpose. An email-only budget
   * is an account-lockout weapon — anyone who knows your address spends your
   * five guesses and you are the one who gets the 429, holding it open forever
   * for five requests every fifteen minutes.
   */
  authAccount: { limit: 5, windowMs: 15 * 60_000 },
  /**
   * The distributed backstop `authAccount` used to be, deliberately wide.
   *
   * It still ends a botnet spreading guesses for one mailbox across a thousand
   * addresses, but it is far enough above any single attacker's reach — each
   * address is separately capped at 10 by `auth` — that it cannot be used to
   * deny one user their own login.
   */
  authAccountGlobal: { limit: 50, windowMs: 15 * 60_000 },
  /** Uploads: half-gigabyte bodies, so cheap to request and expensive to serve. */
  upload: { limit: 60, windowMs: 60 * 60_000 },
  /** Anything that can put a paid generation on the wire. */
  render: { limit: 120, windowMs: 60 * 60_000 },
  /**
   * Pricing previews, which spend nothing.
   *
   * Kept out of the `render` budget deliberately. Sharing one meant a producer
   * tuning model selection in the cost lab — exactly the iteration this system
   * is built to encourage — spent the allowance the actual submission needed,
   * and the refusal then landed on the submit rather than the preview: the
   * worst possible ordering.
   */
  preview: { limit: 600, windowMs: 60 * 60_000 },
  /** Every other state change. */
  mutation: { limit: 240, windowMs: 5 * 60_000 },
  /** Reads, including the poll loop the queue view runs. */
  read: { limit: 1_200, windowMs: 5 * 60_000 },
  /** Provider callbacks — generous, but a spoofed flood still cannot pin the box. */
  webhook: { limit: 1_200, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitPolicy>

export type PolicyName = keyof typeof POLICIES

/** Costs nothing to serve and nothing to the caller — priced, not submitted. */
const PREVIEW_PATHS = [/^\/api\/shots\/[^/]+\/matrix$/, /^\/api\/shots\/validate$/, /^\/api\/cost-lab\/strategy$/]
const RENDER_PATHS = [
  /^\/api\/shots\/[^/]+\/render$/,
  /^\/api\/masters\/[^/]+\/(finish|package)$/,
  // A retry and a dead-letter replay each submit a *new* billable generation,
  // so they belong in the same budget as the original submission.
  /^\/api\/jobs\/[^/]+\/retry$/,
  /^\/api\/queue\/dead\/[^/]+\/replay$/,
]
const UPLOAD_PATHS = [/^\/api\/projects\/[^/]+\/assets$/]

/**
 * The path the router will actually match on.
 *
 * `request.url` is the raw request target, but find-my-way matches against a
 * percent-decoded path — so `POST /api/shots/x/%72ender` reaches the render
 * handler while a naive classifier sees `%72ender`, matches no render pattern,
 * and bills the request to the far cheaper `mutation` budget. Decoding here
 * closes that gap.
 *
 * `decodeURI`, not `decodeURIComponent`: the latter also turns `%2F` into `/`,
 * which would split a single path parameter into two segments and reintroduce
 * exactly the misclassification this is meant to prevent.
 */
export function routedPath(url: string): string {
  const raw = url.split('?')[0] ?? url
  try {
    return decodeURI(raw)
  } catch {
    // A malformed escape never matches a real route; leave it as-is so it lands
    // in a bucket rather than throwing out of the hook.
    return raw
  }
}

/** Which budget a request draws from. Exported so the tests can assert the map. */
export function classify(method: string, path: string): PolicyName | null {
  if (!path.startsWith('/api/')) return null // static assets and the SPA shell
  if (path.startsWith('/api/webhooks/')) return 'webhook'
  if (path === '/api/auth/login' || path === '/api/auth/signup') return 'auth'
  if (method === 'GET' || method === 'HEAD') return 'read'
  if (UPLOAD_PATHS.some((re) => re.test(path))) return 'upload'
  if (PREVIEW_PATHS.some((re) => re.test(path))) return 'preview'
  if (RENDER_PATHS.some((re) => re.test(path))) return 'render'
  return 'mutation'
}

/**
 * The address a budget is charged to.
 *
 * `request.ip` is only as trustworthy as `TRUST_PROXY`: with it off Fastify
 * reports the socket peer, which a client cannot forge. With it on we are
 * explicitly relying on a proxy to overwrite `X-Forwarded-For`, and that is the
 * operator's declaration, not a guess this code makes.
 */
function clientKey(request: FastifyRequest): string {
  return request.ip || 'unknown'
}

function scaled(policy: RateLimitPolicy, scale: number): RateLimitPolicy {
  if (scale === 1) return policy
  return { ...policy, limit: Math.max(1, Math.round(policy.limit * scale)) }
}

export interface RateLimitHandle {
  limiter: RateLimiter
  /**
   * Charges a named budget outside the request hook — used for the per-account
   * login limiter, which can only run once the email is known.
   */
  consume(name: PolicyName, key: string): void
  /** Hands a budget back, e.g. once a login turns out to have been legitimate. */
  refund(name: PolicyName, key: string): void
}

/**
 * Installs the global limiter.
 *
 * Runs in `onRequest`, before body parsing, so a refused caller never gets to
 * hand us a 32 MB payload to parse.
 */
export function registerRateLimit(app: FastifyInstance, runtime: Runtime): RateLimitHandle {
  const limiter = new RateLimiter({ clock: runtime.clock })
  const configured = runtime.config.RATE_LIMIT_SCALE
  // Someone setting the scale to 0 means "get out of my way", not "one request
  // per window". Clamping it to a tiny multiplier instead made the app look
  // completely broken — first page load fine, second one 429 — with nothing in
  // the logs connecting the symptom to the setting.
  const disabledByScale = !Number.isFinite(configured) || configured <= 0
  const scale = disabledByScale ? 1 : configured
  const enabled = runtime.config.RATE_LIMIT_ENABLED && !disabledByScale

  if (!enabled) {
    runtime.logger.warn('api.rate_limit_disabled', {
      reason: disabledByScale ? 'RATE_LIMIT_SCALE is zero or invalid' : 'RATE_LIMIT_ENABLED is false',
    })
  } else if (scale !== 1) {
    runtime.logger.info('api.rate_limit_scaled', { scale })
  }

  const consume = (name: PolicyName, key: string): void => {
    if (!enabled) return
    const decision = limiter.check(`${name}:${key}`, scaled(POLICIES[name], scale))
    if (decision.allowed) return
    runtime.logger.warn('api.rate_limited', {
      policy: name,
      clientKey: key,
      limit: decision.limit,
      retryAfterSeconds: decision.retryAfterSeconds,
    })
    throw rateLimited(`too many requests — retry in ${decision.retryAfterSeconds}s`, decision.retryAfterSeconds, {
      policy: name,
      limit: decision.limit,
    })
  }

  const refund = (name: PolicyName, key: string): void => {
    if (!enabled) return
    limiter.reset(`${name}:${key}`)
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!enabled) return
    const path = routedPath(request.url)
    const name = classify(request.method, path)
    if (!name) return

    const policy = scaled(POLICIES[name], scale)
    const key = clientKey(request)
    const decision = limiter.check(`${name}:${key}`, policy)
    void reply.header('x-ratelimit-limit', String(decision.limit))
    void reply.header('x-ratelimit-remaining', String(decision.remaining))
    if (decision.allowed) return

    // The client key is the whole question when someone reports "I can't log
    // in": one scripted address being refused and an entire office NAT being
    // refused look identical without it.
    runtime.logger.warn('api.rate_limited', {
      policy: name,
      method: request.method,
      path,
      clientKey: key,
      limit: decision.limit,
      retryAfterSeconds: decision.retryAfterSeconds,
      trackedKeys: limiter.size,
    })
    throw rateLimited(`too many requests — retry in ${decision.retryAfterSeconds}s`, decision.retryAfterSeconds, {
      policy: name,
      limit: decision.limit,
    })
  })

  return { limiter, consume, refund }
}
