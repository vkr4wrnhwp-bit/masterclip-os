import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { AppError, formatUsd, maskSecret } from '@masterclip/shared'
import { toNum, toStr } from '@masterclip/database'
import { verifyCallbackToken } from '@masterclip/provider-core'
import { ROUTING_PROFILES } from '@masterclip/model-router'
import type { Runtime } from '@masterclip/runtime'
import { SESSION_COOKIE, requireAuth, requireProject } from '../server.js'
import { clearCsrfCookie, issueCsrfCookie } from '../security/csrf.js'
import type { RateLimitHandle } from '../security/rate-limit.js'

const LoginBody = z.object({ email: z.string().min(3), password: z.string().min(1) })
const SignupBody = z.object({
  email: z.string().min(3),
  password: z.string().min(10),
  displayName: z.string().min(1),
  orgName: z.string().min(1),
})

/** Auth, providers, cost reporting, and provider webhooks. */
export async function registerOpsRoutes(app: FastifyInstance, runtime: Runtime, rateLimit: RateLimitHandle): Promise<void> {
  // ---------------------------------------------------------------- auth ----
  app.post('/api/auth/signup', async (request, reply) => {
    const body = SignupBody.parse(request.body)
    // The first account bootstraps the organization; after that, invitations
    // are issued by an owner (see docs/security-model.md).
    const existing = await runtime.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')
    if (toNum(existing?.n, 0) > 0) {
      throw new AppError({ kind: 'forbidden', code: 'auth.signup_closed', message: 'an organization already exists — ask an owner for an invite' })
    }
    const org = await runtime.projects.createOrg(body.orgName)
    const user = await runtime.auth.createUser({
      orgId: org.id,
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      orgRole: 'owner',
    })
    const session = await runtime.auth.login(body.email, body.password)
    void reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'lax', path: '/', secure: runtime.config.NODE_ENV === 'production' })
    issueCsrfCookie(runtime, reply, session.token)
    return { user, org }
  })

  app.post('/api/auth/login', async (request, reply) => {
    const body = LoginBody.parse(request.body)
    // Checked before the password so a refused caller never reaches the KDF.
    // Two budgets: a tight one per (account, address) that only an attacker
    // sharing the victim's address can exhaust, and a deliberately wide
    // account-wide backstop that ends a distributed guessing campaign without
    // handing anyone an account-lockout button.
    const account = body.email.trim().toLowerCase()
    const accountFromHere = `${account}|${request.ip}`
    rateLimit.consume('authAccount', accountFromHere)
    rateLimit.consume('authAccountGlobal', account)
    const session = await runtime.auth.login(body.email, body.password)
    // Proving the password refunds the guesses: a legitimate user who mistyped
    // four times must not be left one attempt from lockout.
    rateLimit.refund('authAccount', accountFromHere)
    rateLimit.refund('authAccountGlobal', account)
    void reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'lax', path: '/', secure: runtime.config.NODE_ENV === 'production' })
    issueCsrfCookie(runtime, reply, session.token)
    return { user: session.user, expiresAt: session.expiresAt }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) await runtime.auth.logout(token)
    void reply.clearCookie(SESSION_COOKIE, { path: '/' })
    clearCsrfCookie(reply)
    return { ok: true }
  })

  app.get('/api/auth/me', async (request, reply) => {
    const user = await requireAuth(runtime, request)
    // The SPA calls this on boot, which is what re-arms a session that predates
    // CSRF enforcement — otherwise a logged-in user's first mutation after a
    // deploy would be refused with no way to recover but logging out.
    const token = request.cookies[SESSION_COOKIE]
    if (token) issueCsrfCookie(runtime, reply, token)
    return { user }
  })

  // ----------------------------------------------------------- providers ----
  app.get('/api/providers', async (request) => {
    await requireAuth(runtime, request)
    const health = await runtime.db.query('SELECT * FROM provider_health')
    const healthByProvider = new Map(health.map((row) => [toStr(row.provider_id), row]))

    return {
      // MASTERCLIP_MODE is the safety posture, surfaced everywhere it matters.
      mode: runtime.config.MASTERCLIP_MODE,
      liveSpendCapUsd: runtime.config.LIVE_SPEND_CAP_USD,
      liveSpentUsd: formatUsd(await runtime.ledger.totalLiveSpend(), 4),
      providers: runtime.registry.list().map((provider) => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        configured: provider.isConfigured(),
        keyFingerprint: maskSecret(credentialFor(runtime, provider.providerId)),
        health: healthByProvider.get(provider.providerId) ?? null,
      })),
    }
  })

  app.get('/api/providers/health', async (request) => {
    await requireAuth(runtime, request)
    return { health: await runtime.registry.health() }
  })

  app.get('/api/models', async (request) => {
    await requireAuth(runtime, request)
    const refresh = (request.query as { refresh?: string }).refresh === '1'
    const models = await runtime.registry.models({ refresh })
    return {
      models: models.map((model) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        displayName: model.displayName,
        family: model.family,
        tier: model.capabilities.tier,
        modes: model.capabilities.modes,
        resolutions: model.capabilities.resolutions,
        aspectRatios: model.capabilities.aspectRatios,
        durations: model.capabilities.duration,
        nativeAudio: model.capabilities.nativeAudio,
        firstFrame: model.capabilities.firstFrame,
        lastFrame: model.capabilities.lastFrame,
        videoReference: model.capabilities.videoReference,
        extension: model.capabilities.extension,
        maxReferenceImages: model.capabilities.maxReferenceImages,
        pricing: model.pricing,
        source: model.source,
        fetchedAt: model.fetchedAt,
      })),
    }
  })

  app.get('/api/routing-profiles', async (request) => {
    await requireAuth(runtime, request)
    return { profiles: Object.values(ROUTING_PROFILES) }
  })

  // ---------------------------------------------------------------- cost ----
  app.get('/api/projects/:projectId/costs', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const [metrics, byProvider, rejections, avoided, project] = await Promise.all([
      runtime.metrics.projectMetrics(projectId),
      runtime.ledger.byProvider(projectId, { includeSandbox: true }),
      runtime.metrics.rejectionBreakdown(projectId),
      runtime.metrics.qcAvoidedSpend(projectId),
      runtime.projects.get(projectId),
    ])
    const daily = await runtime.ledger.byDay(project.orgId, 30, true)
    const budget = await runtime.cost.budgetStore.ensureDefaults('project', projectId)

    return {
      metrics: {
        ...metrics,
        formatted: {
          rawSpend: formatUsd(metrics.rawSpendMicros),
          sandboxSpend: formatUsd(metrics.sandboxSpendMicros),
          costPerApprovedSecond: metrics.costPerApprovedSecond === null ? null : formatUsd(metrics.costPerApprovedSecond),
          costPerApprovedClip: metrics.costPerApprovedClip === null ? null : formatUsd(metrics.costPerApprovedClip),
          costPerSubmittedSecond: metrics.costPerSubmittedSecond === null ? null : formatUsd(metrics.costPerSubmittedSecond),
        },
      },
      byProvider: byProvider.map((row) => ({ ...row, usd: formatUsd(row.micros) })),
      daily: daily.map((row) => ({ ...row, usd: formatUsd(row.micros) })),
      rejections,
      qcAvoided: { ...avoided, usd: formatUsd(avoided.estimatedAvoidedMicros) },
      budget,
      liveCap: { capUsd: runtime.config.LIVE_SPEND_CAP_USD, spent: formatUsd(await runtime.ledger.totalLiveSpend(), 4) },
    }
  })

  app.put('/api/projects/:projectId/budget', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'producer')
    const body = z
      .object({
        dailyCapMicros: z.number().nullable().optional(),
        monthlyCapMicros: z.number().nullable().optional(),
        lifetimeCapMicros: z.number().nullable().optional(),
        perShotCapMicros: z.number().nullable().optional(),
        maxAttempts: z.number().int().nullable().optional(),
        maxPremiumAttempts: z.number().int().nullable().optional(),
        warnThresholdPct: z.number().optional(),
        approvalRequiredAboveMicros: z.number().nullable().optional(),
      })
      .parse(request.body)

    const current = await runtime.cost.budgetStore.ensureDefaults('project', projectId)
    const updated = { ...current, ...body }
    await runtime.cost.budgetStore.set(updated)
    await runtime.audit.record({
      orgId: auth.orgId,
      projectId,
      actor: auth.userId,
      action: 'budget.changed',
      targetType: 'project',
      targetId: projectId,
      data: { before: current, after: updated },
    })
    return { budget: updated }
  })

  app.get('/api/projects/:projectId/model-performance', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    await runtime.metrics.recomputeModelPerformance(projectId)
    return { performance: await runtime.metrics.modelPerformance(projectId) }
  })

  app.get('/api/projects/:projectId/audit', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    return { entries: await runtime.audit.forProject(projectId) }
  })

  // ------------------------------------------------------------ webhooks ----
  /**
   * Provider callbacks.
   *
   * Three defences, because provider webhook security varies from "signed" to
   * "nothing at all": our own HMAC token in the callback URL, per-provider
   * signature verification where the provider offers one, and a dedupe key so a
   * replayed delivery cannot drive a second ingest. Even then the payload is
   * treated as a wake-up — authoritative state comes from re-polling.
   */
  app.post('/api/webhooks/:providerId', async (request: FastifyRequest, reply) => {
    const { providerId } = request.params as { providerId: string }
    const query = request.query as { job?: string; token?: string }

    if (!runtime.registry.has(providerId)) {
      return reply.status(404).send({ error: { kind: 'not_found', message: `unknown provider ${providerId}` } })
    }
    // Fail closed. This used to run only when the caller supplied `job`, which
    // made the check opt-in for the very party it defends against: omitting the
    // parameter skipped verification and left an anonymous, unauthenticated
    // write path into `webhook_events` with an attacker-chosen dedupe key —
    // enough to pre-poison a genuine redelivery into being dropped as a
    // duplicate. Every callback URL we hand out carries both `job` and `token`
    // (see RenderService), so nothing legitimate is lost by demanding them.
    if (!runtime.config.WEBHOOK_SECRET) {
      throw new AppError({ kind: 'forbidden', code: 'webhook.no_secret', message: 'webhook callbacks are not configured on this deployment' })
    }
    if (!query.job) {
      throw new AppError({ kind: 'forbidden', code: 'webhook.missing_job', message: 'missing callback job id' })
    }
    verifyCallbackToken(runtime.config.WEBHOOK_SECRET, providerId, query.job, query.token)

    const provider = runtime.registry.get(providerId)
    if (!provider.normalizeWebhook) {
      return reply.status(202).send({ ok: true, note: 'provider has no webhook mapping; polling remains authoritative' })
    }

    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(key, value)
    }

    const event = await provider.normalizeWebhook(request.body, headers)

    // Idempotent by construction: a duplicate delivery hits the unique index
    // and is acknowledged without re-processing.
    const inserted = await runtime.db
      .run(
        `INSERT INTO webhook_events (id, provider_id, dedupe_key, external_id, status, payload, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (provider_id, dedupe_key) DO NOTHING`,
        [
          `hook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          providerId,
          event.dedupeKey,
          event.externalJobId,
          event.status.state,
          JSON.stringify(request.body).slice(0, 100_000),
          runtime.clock.isoNow(),
        ],
      )
      .catch(() => ({ changes: 0 }))

    if (inserted.changes === 0) return reply.status(200).send({ ok: true, duplicate: true })

    const job = await runtime.renders.findJobByExternalId(providerId, event.externalJobId)
    if (job) {
      await runtime.queue.enqueue({
        queue: 'render',
        type: 'render.poll',
        payload: { jobId: job.id },
        dedupeKey: `poll-hook:${job.id}:${event.status.state}`,
      })
    }
    await runtime.db.run('UPDATE webhook_events SET processed_at = ? WHERE provider_id = ? AND dedupe_key = ?', [
      runtime.clock.isoNow(),
      providerId,
      event.dedupeKey,
    ])
    return reply.status(200).send({ ok: true })
  })
}

function credentialFor(runtime: Runtime, providerId: string): string {
  const map: Record<string, string> = {
    muapi: runtime.config.MUAPI_API_KEY,
    google: runtime.config.GOOGLE_API_KEY,
    fal: runtime.config.FAL_KEY,
    runway: runtime.config.RUNWAY_API_KEY,
    luma: runtime.config.LUMA_API_KEY,
    replicate: runtime.config.REPLICATE_API_TOKEN,
    selfhosted: runtime.config.COMFYUI_API_KEY,
  }
  return map[providerId] ?? ''
}
