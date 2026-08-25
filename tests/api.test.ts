import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'

/**
  * HTTP-level tests against the real Fastify instance.
 *
 * These drive the real Fastify instance through `inject`, so the hooks, the
 * error handler and the cookie plumbing are all the shipping ones. The point is
 * not that a limiter and a CSRF check exist — it is that a request which should
 * be refused actually is.
 */
let runtime: Runtime
let db: Db
let app: FastifyInstance
let storageRoot: string

const EMAIL = 'director@example.com'
const PASSWORD = 'a-sufficiently-long-password'

async function boot(overrides: Record<string, string> = {}): Promise<void> {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'masterclip-api-test-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'api-test-secret',
      SESSION_SECRET: 'api-test-session-secret',
      ...overrides,
    },
    true,
  )
  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'api-test-secret' }),
  })
  app = await buildServer({ runtime, logger: silentLogger })
  await app.ready()
}

/**
 * Creates the owner without going through HTTP, so a test about login budgets
 * is not also spending one on the signup that set the account up.
 */
async function createUser(): Promise<void> {
  const org = await runtime.projects.createOrg('Test Org')
  await runtime.auth.createUser({ orgId: org.id, email: EMAIL, password: PASSWORD, displayName: 'Director', orgRole: 'owner' })
}

/** Signs up the bootstrap owner and returns the cookies the browser would hold. */
async function signup(): Promise<{ session: string; csrf: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: EMAIL, password: PASSWORD, displayName: 'Director', orgName: 'Test Org' },
  })
  expect(response.statusCode).toBe(200)
  const session = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? ''
  const csrf = response.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? ''
  expect(session).not.toBe('')
  expect(csrf).not.toBe('')
  return { session, csrf }
}

beforeEach(async () => {
  await boot()
})

afterEach(async () => {
  await app?.close()
  await rm(storageRoot, { recursive: true, force: true })
})

describe('CSRF', () => {
  it('issues a readable token cookie alongside the http-only session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: EMAIL, password: PASSWORD, displayName: 'Director', orgName: 'Test Org' },
    })
    const session = response.cookies.find((c) => c.name === SESSION_COOKIE)
    const csrf = response.cookies.find((c) => c.name === CSRF_COOKIE)
    // The session must stay unreadable to script; the CSRF token must not,
    // because the SPA has to echo it back in a header.
    expect(session?.httpOnly).toBe(true)
    expect(csrf?.httpOnly).toBeFalsy()
  })

  it('refuses a cookie-authenticated mutation with no token', async () => {
    const { session } = await signup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { [SESSION_COOKIE]: session },
      payload: { name: 'Forged Project' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('csrf.rejected')
  })

  it('accepts the same mutation once the token accompanies it', async () => {
    const { session, csrf } = await signup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { name: 'Legitimate Project' },
    })
    expect(response.statusCode).toBe(200)
  })

  it('refuses a token minted for a different session', async () => {
    const { session } = await signup()
    // What an attacker who can write cookies but not read them would try: pick
    // their own value for both halves of the double-submit pair.
    const forged = 'attacker-nonce.attacker-signature'
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: forged },
      headers: { [CSRF_HEADER]: forged },
      payload: { name: 'Forged Project' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('csrf.rejected')
  })

  it('refuses a cross-site request even when it carries a valid token', async () => {
    const { session, csrf } = await signup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf, 'sec-fetch-site': 'cross-site' },
      payload: { name: 'Forged Project' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('refuses a request whose Origin is not this host', async () => {
    const { session, csrf } = await signup()
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf, origin: 'https://evil.example.com' },
      payload: { name: 'Forged Project' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('leaves reads alone', async () => {
    const { session } = await signup()
    const response = await app.inject({ method: 'GET', url: '/api/projects', cookies: { [SESSION_COOKIE]: session } })
    expect(response.statusCode).toBe(200)
  })

  it('does not stand in front of login itself', async () => {
    await signup()
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD } })
    expect(response.statusCode).toBe(200)
  })

  it('exempts provider webhooks, which carry no cookie and their own HMAC', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/webhooks/mock', payload: { anything: true } })
    // Whatever the webhook route decides, it must not be a CSRF refusal.
    expect(response.json()?.error?.code).not.toBe('csrf.rejected')
  })

  it('re-arms a session that predates CSRF enforcement when the SPA boots', async () => {
    const { session } = await signup()
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: session } })
    expect(me.statusCode).toBe(200)
    const reissued = me.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? ''
    expect(reissued).not.toBe('')

    const mutation = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: reissued },
      headers: { [CSRF_HEADER]: reissued },
      payload: { name: 'Recovered Project' },
    })
    expect(mutation.statusCode).toBe(200)
  })
})

describe('rate limiting', () => {
  it('refuses login attempts once the per-address budget is gone', async () => {
    await signup()
    const attempt = () => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: 'wrong-password' } })

    let sawRateLimit = false
    for (let i = 0; i < 15; i++) {
      const response = await attempt()
      if (response.statusCode === 429) {
        sawRateLimit = true
        expect(response.headers['retry-after']).toBeDefined()
        expect(response.json().error.kind).toBe('rate_limited')
        break
      }
      // Until the budget runs out these are ordinary credential failures.
      expect(response.statusCode).toBe(401)
    }
    expect(sawRateLimit).toBe(true)
  })

  it('reports remaining budget on every API response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(Number(response.headers['x-ratelimit-remaining'])).toBeGreaterThan(0)
  })

  it('leaves the SPA shell and static assets unmetered', async () => {
    // A page reload pulling a dozen assets must not spend the API budget.
    const before = Number((await app.inject({ method: 'GET', url: '/api/health' })).headers['x-ratelimit-remaining'])
    for (let i = 0; i < 20; i++) await app.inject({ method: 'GET', url: '/some/spa/route' })
    const after = Number((await app.inject({ method: 'GET', url: '/api/health' })).headers['x-ratelimit-remaining'])
    expect(before - after).toBe(1)
  })

  it('can be switched off for load testing', async () => {
    await app.close()
    await boot({ RATE_LIMIT_ENABLED: 'false' })
    await signup()
    for (let i = 0; i < 30; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: 'wrong-password' } })
      expect(response.statusCode).toBe(401)
    }
  })
})

/**
 * Every case below is a defect an adversarial review found in the first cut of
 * this hardening work. They are here so the fixes cannot quietly regress.
 */
describe('regressions found by attacking this code', () => {
  it('cannot be demoted to a cheaper budget by percent-encoding the path', async () => {
    // find-my-way routes on the decoded path, so `%72ender` reaches the render
    // handler. A classifier reading the raw URL saw no match and billed the
    // request to `mutation`, which is twice the budget over a shorter window.
    const { classify, routedPath } = await import('../apps/api/src/security/rate-limit.js')
    expect(classify('POST', routedPath('/api/shots/shot_1/%72ender'))).toBe('render')
    expect(classify('POST', routedPath('/api/projects/p1/%61ssets'))).toBe('upload')
    expect(classify('POST', routedPath('/api/shots/shot_1/render?seed=3'))).toBe('render')
  })

  it('bills a retry to the render budget, because a retry is a new paid generation', async () => {
    const { classify } = await import('../apps/api/src/security/rate-limit.js')
    expect(classify('POST', '/api/jobs/job_1/retry')).toBe('render')
    expect(classify('POST', '/api/queue/dead/dead_1/replay')).toBe('render')
  })

  it('keeps free pricing previews out of the paid render budget', async () => {
    const { classify } = await import('../apps/api/src/security/rate-limit.js')
    // Sharing one budget meant a producer iterating in the cost lab spent the
    // allowance the actual submission needed, so the refusal landed on the
    // submit rather than the preview.
    expect(classify('POST', '/api/shots/shot_1/matrix')).toBe('preview')
    expect(classify('POST', '/api/shots/validate')).toBe('preview')
    expect(classify('POST', '/api/cost-lab/strategy')).toBe('preview')
    expect(classify('POST', '/api/shots/shot_1/render')).toBe('render')
  })

  it('lets a producer price far more matrices than they could submit', async () => {
    const { POLICIES } = await import('../apps/api/src/security/rate-limit.js')
    expect(POLICIES.preview.limit).toBeGreaterThan(POLICIES.render.limit)
  })

  it('lets a user log in with a stale session cookie instead of locking them out', async () => {
    await signup()
    // A session row that no longer exists — an expired session, a reset
    // database, a token from a previous deployment. The CSRF gate keys on the
    // cookie being *present*, so this used to 403 every attempt to log in,
    // sign up or log out, with no way out but clearing cookies by hand.
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      cookies: { [SESSION_COOKIE]: 'stale-token-from-a-previous-deployment' },
      payload: { email: EMAIL, password: PASSWORD },
    })
    expect(response.statusCode).toBe(200)
  })

  it('lets a user log out with a stale session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: 'stale-token' },
    })
    expect(response.statusCode).toBe(200)
  })

  it('does not let a stranger elsewhere lock a known account out of its own login', async () => {
    // TRUST_PROXY on so the two parties are genuinely different addresses;
    // with it off they would share one, and an attacker who is already inside
    // your network being able to spend your budget is the accepted case.
    await app.close()
    await boot({ TRUST_PROXY: 'true' })
    await createUser()

    for (let i = 0; i < 8; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.9' },
        payload: { email: EMAIL, password: 'guess' },
      })
    }
    // The real owner, from their own address with the right password, gets in.
    const victim = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '198.51.100.4' },
      payload: { email: EMAIL, password: PASSWORD },
    })
    expect(victim.statusCode).toBe(200)
  })

  it('refunds the account budget once the password is proven', async () => {
    await createUser()
    const attempt = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password } })

    // Three typos, then success. Without the refund the account budget (5) is
    // left with one token, and the next run of typos locks the user out.
    for (let i = 0; i < 3; i++) expect((await attempt('typo')).statusCode).toBe(401)
    expect((await attempt(PASSWORD)).statusCode).toBe(200)
    for (let i = 0; i < 3; i++) expect((await attempt('typo')).statusCode).toBe(401)
    expect((await attempt(PASSWORD)).statusCode).toBe(200)
  })

  it('demands a callback token instead of letting the caller opt out of one', async () => {
    await app.close()
    await boot({ WEBHOOK_SECRET: 'webhook-test-secret' })
    // Omitting `job` used to skip verification entirely, leaving an anonymous
    // write path into webhook_events with an attacker-chosen dedupe key.
    const noJob = await app.inject({ method: 'POST', url: '/api/webhooks/mock', payload: { request_id: 'attacker-0', status: 'OK' } })
    expect(noJob.statusCode).toBe(403)
    expect(noJob.json().error.code).toBe('webhook.missing_job')

    const badToken = await app.inject({
      method: 'POST',
      url: '/api/webhooks/mock?job=job_1&token=deadbeef',
      payload: { request_id: 'attacker-1', status: 'OK' },
    })
    expect(badToken.statusCode).toBe(403)

    const rows = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM webhook_events')
    expect(Number(rows?.n ?? 0)).toBe(0)
  })

  it('answers a malformed body with 400 and readable field errors, not a 500 dump', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'x' } })
    expect(response.statusCode).toBe(400)
    const error = response.json().error
    expect(error.kind).toBe('validation')
    expect(error.code).toBe('schema.invalid')
    // The raw ZodError dump used to be copied verbatim into `message`.
    expect(error.message).not.toContain('"code"')
    expect(Array.isArray(error.details.issues)).toBe(true)
    expect(error.details.issues[0]).toHaveProperty('field')
  })

  it('refuses a multi-file upload rather than silently keeping one', async () => {
    const { session, csrf } = await signup()
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { name: 'Upload Project' },
    })
    const projectId = project.json().project.id as string

    const boundary = '----masterclipTestBoundary'
    const part = (name: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.png"\r\nContent-Type: image/png\r\n\r\n\x89PNG\r\n\x1a\n\r\n`
    const body = `${part('a')}${part('b')}--${boundary}--\r\n`

    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assets`,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('assets.too_many_files')
  })
})

describe('proxy trust', () => {
  it('ignores a forged X-Forwarded-For by default', async () => {
    // With TRUST_PROXY off, rotating this header must not buy a fresh budget —
    // otherwise every IP-keyed limit above is decorative.
    await signup()
    let refusals = 0
    for (let i = 0; i < 15; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
        payload: { email: EMAIL, password: 'wrong-password' },
      })
      if (response.statusCode === 429) refusals++
    }
    expect(refusals).toBeGreaterThan(0)
  })
})

describe('asset links are stable enough to cache', () => {
  it('hands out the identical URL for the same asset across reloads', async () => {
    const { session, csrf } = await signup()
    const cookies = { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }
    const headers = { [CSRF_HEADER]: csrf }

    const project = await app.inject({ method: 'POST', url: '/api/projects', cookies, headers, payload: { name: 'Cache Project' } })
    const projectId = project.json().project.id as string

    const boundary = '----masterclipCacheBoundary'
    // Built as a Buffer: a PNG signature carried in a JS string is re-encoded
    // as UTF-8 on the way out, and 0x89 becomes two bytes that sniff as nothing.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).fill(0)])
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ref.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const upload = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/assets`,
      cookies,
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expect(upload.statusCode).toBe(200)

    const list = () => app.inject({ method: 'GET', url: `/api/projects/${projectId}/assets`, cookies })
    const first = (await list()).json().assets[0].url as string
    const second = (await list()).json().assets[0].url as string

    // The review grid reloads after every decision. A URL that differs each
    // time makes the browser re-download every clip in the grid, however good
    // the cache-control header on the asset route is.
    expect(second).toBe(first)
  })
})

describe('sandbox mode does not authorize real providers', () => {
  it('refuses a billable provider while MASTERCLIP_MODE=sandbox', async () => {
    /**
     * `isSandboxProvider` used to return true for every provider whenever the
     * deployment posture was sandbox, which marked real fal/Google/Runway
     * requests `sandbox: true`. The cost controller reads that flag to decide
     * what to enforce, so those requests skipped the global live-spend cap, the
     * human-approval gate and the attempt caps — and their ledger rows were
     * written sandbox=1, so they never counted toward any later cap either. The
     * default posture, the one documented as costing nothing, was the one that
     * spent without limit.
     */
    const { CostController } = await import('@masterclip/cost-engine')
    const { sampleRequest, quoteFromProvider } = await import('@masterclip/provider-core')
    const { usdToMicros } = await import('@masterclip/shared')

    const controller = new CostController(db, runtime.config, runtime.clock)
    const org = await runtime.projects.createOrg('Sandbox Org')
    const project = await runtime.projects.create({ orgId: org.id, name: 'Sandbox P', createdBy: 'test' })
    await controller.budgetStore.ensureDefaults('project', project.id)
    await controller.budgetStore.ensureDefaults('org', org.id)

    // What a real provider's request looks like now: not sandbox, because the
    // provider bills regardless of how this deployment is configured.
    const request = sampleRequest({ providerId: 'fal', durationSeconds: 8, maxCostMicros: usdToMicros(5), sandbox: false })
    const quote = quoteFromProvider({ providerId: 'fal', request, micros: usdToMicros(0.8), nowMs: runtime.clock.now(), raw: {} })

    const result = await controller.authorize({
      orgId: org.id, projectId: project.id, shotId: 'shot_x', request, quote, tier: 'standard', humanApproved: true,
    })
    expect(result.allowed).toBe(false)
    expect(result.denials.map((d) => d.code)).toContain('mode.sandbox_required')
  })
})

describe('money-path regressions', () => {
  /** Project + shot + job, built through the real repositories. */
  async function seedJob(name: string, opts: { sandbox: boolean; estimatedMicros: number }) {
    const { emptyShot } = await import('@masterclip/shot-schema')
    const org = await runtime.projects.createOrg(`${name} Org`)
    const project = await runtime.projects.create({ orgId: org.id, name: `${name} P`, createdBy: 'test' })
    const { shot, version } = await runtime.projects.createShot({
      projectId: project.id,
      spec: emptyShot({ generation_mode: 'text_to_video', action: 'a woman turns', duration_seconds: 4 }),
      createdBy: 'test',
    })
    const { job } = await runtime.renders.createJob({
      projectId: project.id, shotId: shot.id, shotVersionId: version.id,
      providerId: 'mock', modelId: 'mock-draft', routingProfile: 'STANDARD',
      compiledPrompt: 'p', request: { n: name }, estimatedMicros: opts.estimatedMicros,
      sandbox: opts.sandbox, createdBy: 'test',
    })
    return { project, shot, job }
  }

  it('refuses to retry a job that is still running at the provider', async () => {
    // Retrying an in-flight job submits a second paid generation alongside the
    // first, and orphans the original so nothing ever records what it cost.
    const { session, csrf } = await signup()
    const cookies = { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }
    const headers = { [CSRF_HEADER]: csrf }
    // The job has to live in a project this user can act on, or the
    // authorization check answers first and the status guard is never reached.
    const created = await app.inject({ method: 'POST', url: '/api/projects', cookies, headers, payload: { name: 'Retry P' } })
    const projectId = created.json().project.id as string
    const { emptyShot } = await import('@masterclip/shot-schema')
    const { shot, version } = await runtime.projects.createShot({
      projectId,
      spec: emptyShot({ generation_mode: 'text_to_video', action: 'a woman turns', duration_seconds: 4 }),
      createdBy: 'test',
    })
    const { job } = await runtime.renders.createJob({
      projectId, shotId: shot.id, shotVersionId: version.id,
      providerId: 'mock', modelId: 'mock-draft', routingProfile: 'STANDARD',
      compiledPrompt: 'p', request: { n: 'retry' }, estimatedMicros: 100_000,
      sandbox: true, createdBy: 'test',
    })
    await runtime.renders.updateJob(job.id, { status: 'processing', externalJobId: 'ext-1' })

    const response = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, cookies, headers })
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('job.still_running')
  })

  it('writes one charge per generation even if two pollers settle it', async () => {
    // A provider webhook enqueues a poll under its own dedupe key while the
    // timer poll is still scheduled, so both can observe the same terminal
    // state. One generation must not become two charges.
    const { chargeJobOnce } = await import('@masterclip/runtime')
    const { job } = await seedJob('Charge', { sandbox: false, estimatedMicros: 250_000 })

    expect(await chargeJobOnce(runtime, job, 250_000, 4, 'first settle')).toBe(250_000)
    expect(await chargeJobOnce(runtime, job, 250_000, 4, 'racing settle')).toBeNull()

    const rows = await runtime.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cost_ledger WHERE job_id = ? AND entry_type = 'charge'", [job.id],
    )
    expect(Number(rows?.n ?? 0)).toBe(1)
  })
})

describe('build identity on /api/health', () => {
  it('reports the commit a deployment is running', async () => {
    // Confirming a deploy previously meant inferring the version from which
    // routes happened to 404. The health payload now answers it directly.
    await app.close()
    await boot({ GIT_COMMIT: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' })
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()
    expect(body.commit).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')
    expect(body.commitShort).toBe('a1b2c3d')
  })

  it('inherits the host’s variable when no explicit commit is set', async () => {
    await app.close()
    await boot({ RENDER_GIT_COMMIT: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', RENDER_GIT_BRANCH: 'main' })
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()
    expect(body.commit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    expect(body.branch).toBe('main')
  })

  it('an explicit commit overrides the host’s', async () => {
    await app.close()
    await boot({ GIT_COMMIT: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', RENDER_GIT_COMMIT: 'bbbbbbbb' })
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().commit).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
  })

  it('reports an honest blank rather than inventing a version', async () => {
    // A deployment whose host provides nothing must not claim a commit.
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json()
    expect(body.commit).toBe('')
    expect(body.commitShort).toBe('')
    expect(body.ok).toBe(true)
  })
})
