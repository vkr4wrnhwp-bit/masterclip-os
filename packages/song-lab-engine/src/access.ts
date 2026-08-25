import { AppError, forbidden, type AppConfig } from '@masterclip/shared'
import { toStr, type Db } from '@masterclip/database'
import type { EntitlementService } from '@masterclip/domain'
import { SONG_LAB_CAPABILITIES, type SongLabCapability, type SongLabLimit } from '@masterclip/song-lab-domain'
import type { Actor } from './deps.js'

/**
 * The Song Lab access gate.
 *
 * Evaluated server-side on every route and every job, in a fixed order:
 * global flag → module entitlement → capability entitlement → role → limit.
 * The first layer to refuse names itself, so an operator debugging a denial
 * learns which control fired rather than getting a flat 403.
 */

/** Which global kill switch each capability sits behind. */
const CAPABILITY_FLAGS: Partial<Record<SongLabCapability, Array<keyof AppConfig>>> = {
  'song_lab.benchmark': ['SONG_LAB_BENCHMARKS_ENABLED'],
  'song_lab.custom_cohorts': ['SONG_LAB_BENCHMARKS_ENABLED'],
  'song_lab.signal_benchmarks': ['SONG_LAB_BENCHMARKS_ENABLED'],
  'song_lab.experiments': ['SONG_LAB_EXPERIMENTS_ENABLED'],
  'song_lab.lyrics': ['SONG_LAB_LYRICS_ENABLED'],
  'song_lab.chant': ['SONG_LAB_LYRICS_ENABLED'],
  'song_lab.ar_view': ['SONG_LAB_AR_VIEW_ENABLED'],
}

const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }

export interface SongLabGateCheck {
  name: 'global_flag' | 'module_entitlement' | 'capability_entitlement' | 'user_permission' | 'usage_limit'
  pass: boolean
  message: string
}

export interface SongLabGateDecision {
  allowed: boolean
  failed?: SongLabGateCheck
  checks: SongLabGateCheck[]
}

export interface AuthorizeOptions {
  capability: SongLabCapability
  actor: Actor
  minimumRole?: 'member' | 'admin' | 'owner'
  /** Checked against the matching `song_lab.max_*` limit when supplied. */
  usage?: { limit: SongLabLimit; current: number; what: string }
}

export class SongLabAccessControl {
  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly entitlements: EntitlementService,
  ) {}

  /** The oldest org on the deployment — the flagship, by construction. */
  async flagshipOrgId(): Promise<string | null> {
    const row = await this.db.get('SELECT id FROM orgs ORDER BY created_at ASC, id ASC LIMIT 1')
    return row ? toStr(row.id) : null
  }

  async isFlagship(orgId: string): Promise<boolean> {
    return orgId === (await this.flagshipOrgId())
  }

  async decide(opts: AuthorizeOptions): Promise<SongLabGateDecision> {
    const checks: SongLabGateCheck[] = []

    const required: Array<keyof AppConfig> = ['SONG_LAB_ENABLED', ...(CAPABILITY_FLAGS[opts.capability] ?? [])]
    const offFlag = required.find((flag) => !this.config[flag])
    checks.push({
      name: 'global_flag',
      pass: !offFlag,
      message: offFlag ? `${String(offFlag)} is disabled on this deployment` : 'ok',
    })

    // Module access is a separate grant from the individual capability, so an
    // organization can hold Song Lab without holding, say, the A&R view.
    const hasModule = await this.entitlements.has(opts.actor.orgId, 'song_lab.access')
    checks.push({
      name: 'module_entitlement',
      pass: hasModule,
      message: hasModule ? 'ok' : 'this organization is not entitled to Song Lab',
    })

    const hasCapability =
      opts.capability === 'song_lab.access' ? hasModule : await this.entitlements.has(opts.actor.orgId, opts.capability)
    checks.push({
      name: 'capability_entitlement',
      pass: hasCapability,
      message: hasCapability ? 'ok' : `this organization's plan does not include ${opts.capability}`,
    })

    const roleOk = (ROLE_RANK[opts.actor.orgRole] ?? 0) >= ROLE_RANK[opts.minimumRole ?? 'member']!
    checks.push({
      name: 'user_permission',
      pass: roleOk,
      message: roleOk ? 'ok' : `this action requires ${opts.minimumRole ?? 'member'} access`,
    })

    let limitOk = true
    let limitMessage = 'ok'
    if (opts.usage) {
      const max = await this.entitlements.limit(opts.actor.orgId, opts.usage.limit)
      if (max !== null && opts.usage.current >= max) {
        limitOk = false
        limitMessage = `${opts.usage.what} limit reached (${max})`
      }
    }
    checks.push({ name: 'usage_limit', pass: limitOk, message: limitMessage })

    const failed = checks.find((check) => !check.pass)
    return { allowed: !failed, ...(failed ? { failed } : {}), checks }
  }

  async authorize(opts: AuthorizeOptions): Promise<void> {
    const decision = await this.decide(opts)
    if (decision.allowed) return
    const failed = decision.failed
    throw new AppError({
      kind: failed?.name === 'usage_limit' ? 'forbidden' : 'forbidden',
      code: `song_lab.gate.${failed?.name ?? 'denied'}`,
      message: failed?.message ?? 'Song Lab is unavailable',
    })
  }

  /**
   * Whether this organization may read proprietary Street Banker cohorts.
   * The flagship always may; a partner needs an explicit grant.
   */
  async entitledToProprietaryCohorts(orgId: string): Promise<boolean> {
    if (await this.isFlagship(orgId)) return true
    return this.entitlements.has(orgId, 'song_lab.signal_benchmarks')
  }

  /** Capabilities this organization actually holds, for the nav and the UI. */
  async capabilitiesFor(orgId: string): Promise<SongLabCapability[]> {
    const held: SongLabCapability[] = []
    for (const capability of SONG_LAB_CAPABILITIES) {
      if (await this.entitlements.has(orgId, capability)) held.push(capability)
    }
    return held
  }

  /** Internal A&R is never implicit: it is checked on its own, every time. */
  async requireArView(actor: Actor): Promise<void> {
    if (!this.config.SONG_LAB_AR_VIEW_ENABLED) {
      throw forbidden('the internal A&R view is disabled on this deployment')
    }
    await this.authorize({ capability: 'song_lab.ar_view', actor, minimumRole: 'member' })
  }
}
