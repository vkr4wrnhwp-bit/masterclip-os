import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { AppError, microsToUsd, usdToMicros } from '@masterclip/shared'
import { toStr } from '@masterclip/database'
import { AUDIO_CAPABILITIES, AUDIO_PLAN_PRESETS, isAudioCapability } from '@masterclip/audio-core'
import { fetchElevenLabsAccountUsage } from '@masterclip/audio-providers'
import type { Runtime } from '@masterclip/runtime'
import { flagshipOrgId } from '@masterclip/audio-engine'
import { requireFlagshipAdmin } from './helpers.js'

/**
 * Flagship (root) administration: providers, entitlements, budgets, jobs,
 * webhook events. Provider API keys are configured via environment and are
 * never returned by any route here.
 */
export async function registerAudioAdminRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const audio = runtime.audio

  app.get('/api/admin/audio/providers', async (request) => {
    await requireFlagshipAdmin(runtime, request)
    const health = await audio.registry.health()
    const slots = audio.registry.listAll().map(({ slot, provider }) => ({
      slot,
      providerId: provider.providerId,
      configured: provider.isConfigured(),
      zeroRetention: provider.supportsZeroRetention(slot),
    }))
    // Account-level usage as the provider reports it — never invented from a
    // price table, never fatal to the page when the probe fails.
    let accountUsage: unknown = null
    if (audio.elevenLabsClient?.isConfigured()) {
      try {
        accountUsage = await fetchElevenLabsAccountUsage(audio.elevenLabsClient)
      } catch (err) {
        runtime.logger.warn('audio.account_usage_failed', { err })
      }
    }
    return { health, slots, elevenLabsEnabled: runtime.config.ELEVENLABS_ENABLED, accountUsage }
  })

  app.get('/api/admin/audio/orgs', async (request) => {
    await requireFlagshipAdmin(runtime, request)
    const orgs = await runtime.db.query('SELECT id, name, created_at FROM orgs ORDER BY created_at')
    const flagship = await flagshipOrgId(runtime.db)
    const out = []
    for (const org of orgs) {
      const orgId = toStr(org.id)
      const [entitlements, budgets, usage] = await Promise.all([
        audio.repos.policy.listEntitlements(orgId),
        audio.repos.usage.listBudgets(orgId),
        audio.repos.usage.summary(orgId),
      ])
      out.push({
        id: orgId,
        name: toStr(org.name),
        createdAt: toStr(org.created_at),
        // The flagship holds every capability implicitly; the UI must say so
        // rather than showing an empty grant list as "no access".
        isFlagship: orgId === flagship,
        entitlements,
        budgets: budgets.map((budget) => ({
          scope: budget.scope,
          scopeId: budget.scopeId,
          monthlyCapUsd: budget.monthlyCapMicros === null ? null : microsToUsd(budget.monthlyCapMicros),
          perJobCapUsd: budget.perJobCapMicros === null ? null : microsToUsd(budget.perJobCapMicros),
          hardStop: budget.hardStop,
          warnThresholdPct: budget.warnThresholdPct,
        })),
        monthSpendUsd: microsToUsd(usage.monthSpendMicros),
      })
    }
    return { orgs: out, capabilities: AUDIO_CAPABILITIES, presets: Object.keys(AUDIO_PLAN_PRESETS) }
  })

  /**
   * Switches a granted capability on or off without losing the grant — the
   * reversible control, distinct from revoking entitlement entirely.
   */
  app.post('/api/admin/audio/orgs/:orgId/entitlements/toggle', async (request) => {
    await requireFlagshipAdmin(runtime, request)
    const { orgId } = request.params as { orgId: string }
    const body = z.object({ capability: z.string(), enabled: z.boolean() }).parse(request.body)
    if (!isAudioCapability(body.capability)) {
      throw new AppError({ kind: 'validation', code: 'audio.unknown_capability', message: `unknown capability ${body.capability}` })
    }
    await audio.repos.policy.setEntitlementEnabled(orgId, body.capability, body.enabled)
    return { ok: true, entitlements: await audio.repos.policy.listEntitlements(orgId) }
  })

  app.post('/api/admin/audio/orgs/:orgId/entitlements', async (request: FastifyRequest) => {
    const actor = await requireFlagshipAdmin(runtime, request)
    const { orgId } = request.params as { orgId: string }
    const body = z
      .object({
        preset: z.string().optional(),
        grant: z.array(z.string()).optional(),
        revoke: z.array(z.string()).optional(),
      })
      .parse(request.body)
    if (body.preset) {
      const preset = AUDIO_PLAN_PRESETS[body.preset]
      if (!preset) return { ok: false, error: 'unknown preset' }
      await audio.repos.policy.grantEntitlements(orgId, preset, actor.userId)
    }
    for (const capability of body.grant ?? []) {
      if (isAudioCapability(capability)) await audio.repos.policy.grantEntitlements(orgId, [capability], actor.userId)
    }
    for (const capability of body.revoke ?? []) {
      if (isAudioCapability(capability)) await audio.repos.policy.revokeEntitlement(orgId, capability)
    }
    return { ok: true, entitlements: await audio.repos.policy.listEntitlements(orgId) }
  })

  app.post('/api/admin/audio/orgs/:orgId/budgets', async (request) => {
    await requireFlagshipAdmin(runtime, request)
    const { orgId } = request.params as { orgId: string }
    const body = z
      .object({
        scope: z.enum(['org', 'user', 'feature']),
        scopeId: z.string().min(1),
        monthlyCapUsd: z.number().min(0).nullable(),
        perJobCapUsd: z.number().min(0).nullable(),
        hardStop: z.boolean().default(true),
        warnThresholdPct: z.number().min(0.1).max(1).default(0.8),
      })
      .parse(request.body)
    const budget = await audio.repos.usage.setBudget({
      orgId,
      scope: body.scope,
      scopeId: body.scopeId,
      monthlyCapMicros: body.monthlyCapUsd === null ? null : usdToMicros(body.monthlyCapUsd),
      perJobCapMicros: body.perJobCapUsd === null ? null : usdToMicros(body.perJobCapUsd),
      approvalAboveMicros: null,
      warnThresholdPct: body.warnThresholdPct,
      hardStop: body.hardStop,
    })
    return { budget }
  })

  app.get('/api/admin/audio/jobs', async (request) => {
    await requireFlagshipAdmin(runtime, request)
    const rows = await runtime.db.query(`SELECT * FROM audio_jobs ORDER BY created_at DESC LIMIT 200`)
    return { jobs: rows }
  })

  app.post('/api/admin/audio/jobs/:id/cancel', async (request) => {
    const actor = await requireFlagshipAdmin(runtime, request)
    const { id } = request.params as { id: string }
    const row = await runtime.db.get('SELECT org_id FROM audio_jobs WHERE id = ?', [id])
    if (!row) return { ok: false }
    const cancelled = await audio.repos.jobs.cancel(toStr(row.org_id), id)
    if (cancelled) {
      await runtime.audit.record({
        orgId: toStr(row.org_id),
        actor: actor.userId,
        action: 'audio.job_cancelled',
        targetType: 'audio_job',
        targetId: id,
        data: {},
      })
    }
    return { ok: cancelled }
  })

  app.get('/api/admin/audio/webhooks', async (request) => {
    await requireFlagshipAdmin(runtime, request)
    const status = (request.query as { status?: string }).status
    return { events: await audio.repos.webhookEvents.list(status ? { status } : {}, 200) }
  })

  app.get('/api/admin/audio/usage', async (request) => {
    await requireFlagshipAdmin(runtime, request)
    const rows = await runtime.db.query(
      `SELECT org_id, operation, provider, COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN final_cost_micros > 0 THEN final_cost_micros ELSE estimated_cost_micros END), 0) AS micros
         FROM audio_usage_ledger GROUP BY org_id, operation, provider ORDER BY micros DESC LIMIT 200`,
    )
    return { usage: rows }
  })
}
