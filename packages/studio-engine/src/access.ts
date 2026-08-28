import { AppError, forbidden, type AppConfig } from '@masterclip/shared'
import { toStr, type Db } from '@masterclip/database'
import type { EntitlementService } from '@masterclip/domain'
import {
  STUDIO_CAPABILITIES,
  type CollaboratorPermission,
  type StudioCapability,
  type StudioCollaboratorRepo,
  type StudioLimit,
  type StudioProjectRepo,
} from '@masterclip/studio-domain'
import type { Actor } from './deps.js'

/**
 * The Studio access gate.
 *
 * Evaluated server-side on every route and every job, in a fixed order:
 * global flag → module entitlement → capability entitlement → role → limit.
 * The first layer to refuse names itself, so an operator debugging a denial
 * learns which control fired rather than getting a flat 403.
 *
 * Studio adds a second axis the earlier modules did not need: *collaborator*
 * permission. An organization's entitlement says what the org may do; a
 * collaborator's permission says what this person may do on this project. Both
 * must pass, and they are checked separately because they fail for different
 * reasons and a user needs to be told which.
 */

/** Which global kill switch each capability sits behind. */
const CAPABILITY_FLAGS: Partial<Record<StudioCapability, Array<keyof AppConfig>>> = {
  'studio.mix': ['STUDIO_MIX_ENABLED'],
  'studio.mix_doctor': ['STUDIO_MIX_ENABLED'],
  'studio.references': ['STUDIO_MIX_ENABLED'],
  'studio.ask_the_room': ['STUDIO_ASK_THE_ROOM_ENABLED'],
  'studio.master': ['STUDIO_MASTER_ENABLED'],
  'studio.master_album': ['STUDIO_MASTER_ENABLED'],
  'studio.translation_lab': ['STUDIO_TRANSLATION_LAB_ENABLED'],
  'studio.deliver': ['STUDIO_DELIVER_ENABLED'],
  'studio.sonic_dna': ['STUDIO_SONIC_DNA_ENABLED'],
  'studio.record_passport': ['STUDIO_RECORD_PASSPORT_ENABLED'],
  'studio.identity_vault': ['STUDIO_IDENTITY_VAULT_ENABLED'],
  'studio.ai_licensing': ['STUDIO_AI_LICENSING_ENABLED'],
  'studio.marketplace': ['STUDIO_MARKETPLACE_ENABLED'],
  'studio.opportunities': ['STUDIO_OPPORTUNITY_ENGINE_ENABLED'],
}

const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }

export interface StudioGateCheck {
  name: 'global_flag' | 'module_entitlement' | 'capability_entitlement' | 'user_permission' | 'collaborator_permission' | 'usage_limit'
  pass: boolean
  message: string
}

export interface StudioGateDecision {
  allowed: boolean
  failed?: StudioGateCheck
  checks: StudioGateCheck[]
}

export interface StudioAuthorizeOptions {
  capability: StudioCapability
  actor: Actor
  minimumRole?: 'member' | 'admin' | 'owner'
  /** Checked against the matching `studio.max_*` limit when supplied. */
  usage?: { limit: StudioLimit; current: number; what: string }
  /**
   * When set, the actor must additionally hold this collaborator permission on
   * the project — unless they are an org admin or owner, who administer the
   * project regardless of whether anyone remembered to invite them to it.
   */
  project?: { id: string; permission: CollaboratorPermission }
}

export class StudioAccessControl {
  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly entitlements: EntitlementService,
    private readonly collaborators: StudioCollaboratorRepo,
    private readonly projects: StudioProjectRepo,
  ) {}

  /** The oldest org on the deployment — the flagship, by construction. */
  async flagshipOrgId(): Promise<string | null> {
    const row = await this.db.get('SELECT id FROM orgs ORDER BY created_at ASC, id ASC LIMIT 1')
    return row ? toStr(row.id) : null
  }

  async isFlagship(orgId: string): Promise<boolean> {
    return orgId === (await this.flagshipOrgId())
  }

  async decide(opts: StudioAuthorizeOptions): Promise<StudioGateDecision> {
    const checks: StudioGateCheck[] = []

    const required: Array<keyof AppConfig> = ['STUDIO_ENABLED', ...(CAPABILITY_FLAGS[opts.capability] ?? [])]
    const offFlag = required.find((flag) => !this.config[flag])
    checks.push({ name: 'global_flag', pass: !offFlag, message: offFlag ? `${String(offFlag)} is disabled on this deployment` : 'ok' })

    const hasModule = await this.entitlements.has(opts.actor.orgId, 'studio.access')
    checks.push({ name: 'module_entitlement', pass: hasModule, message: hasModule ? 'ok' : 'this organization is not entitled to Street Banker Studio' })

    const hasCapability = opts.capability === 'studio.access' ? hasModule : await this.entitlements.has(opts.actor.orgId, opts.capability)
    checks.push({
      name: 'capability_entitlement',
      pass: hasCapability,
      message: hasCapability ? 'ok' : `this organization's plan does not include ${opts.capability}`,
    })

    const roleOk = (ROLE_RANK[opts.actor.orgRole] ?? 0) >= ROLE_RANK[opts.minimumRole ?? 'member']
    checks.push({ name: 'user_permission', pass: roleOk, message: roleOk ? 'ok' : `this action requires ${opts.minimumRole ?? 'member'} access` })

    let collaboratorOk = true
    let collaboratorMessage = 'ok'
    if (opts.project) {
      const administers = (ROLE_RANK[opts.actor.orgRole] ?? 0) >= ROLE_RANK.admin
      if (!administers) {
        const held = await this.collaborators.permissionsFor(opts.actor.orgId, opts.project.id, opts.actor.userId, opts.actor.email ?? '')
        // An admin permission subsumes the rest — otherwise the person who set
        // the project up would have to grant themselves each one by hand.
        collaboratorOk = held.includes(opts.project.permission) || held.includes('admin')
        if (!collaboratorOk) {
          collaboratorMessage = held.length === 0
            ? 'you are not a collaborator on this project'
            : `your role on this project does not include ${opts.project.permission}`
        }
      }
    }
    checks.push({ name: 'collaborator_permission', pass: collaboratorOk, message: collaboratorMessage })

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

  async authorize(opts: StudioAuthorizeOptions): Promise<void> {
    const decision = await this.decide(opts)
    if (!decision.allowed) {
      const failed = decision.failed
      throw new AppError({
        kind: 'forbidden',
        code: `studio.gate.${failed?.name ?? 'denied'}`,
        message: failed?.message ?? 'Street Banker Studio is unavailable',
      })
    }

    // The project must exist *in this actor's organization*.
    //
    // Without this, a route that only queries child rows — versions, notes,
    // references, comments — passes the gate and answers with an empty list for
    // another tenant's project id. Nothing leaks, because every one of those
    // queries is org-scoped, but the response distinguishes "not yours" from
    // "does not exist", and a route that fails open on the identity of the
    // thing it is operating on is one refactor away from failing open on the
    // data too. Checking here covers every route at once, rather than relying
    // on each one remembering to load the project first.
    //
    // Deliberately after the capability checks: an organization with no Studio
    // entitlement learns nothing about which project ids exist.
    if (opts.project) await this.projects.get(opts.actor.orgId, opts.project.id)
  }

  /** Capabilities this organization actually holds, for the nav and the UI. */
  async capabilitiesFor(orgId: string): Promise<StudioCapability[]> {
    const held: StudioCapability[] = []
    for (const capability of STUDIO_CAPABILITIES) {
      if (await this.entitlements.has(orgId, capability)) held.push(capability)
    }
    return held
  }

  /**
   * The collaborator permissions this actor effectively holds on a project.
   *
   * Org admins and owners get the full set: they administer the organization's
   * projects whether or not somebody remembered to invite them.
   */
  async projectPermissionsFor(actor: Actor, projectId: string): Promise<CollaboratorPermission[]> {
    if ((ROLE_RANK[actor.orgRole] ?? 0) >= ROLE_RANK.admin) return ['view', 'comment', 'upload', 'approve', 'download', 'admin']
    return this.collaborators.permissionsFor(actor.orgId, projectId, actor.userId, actor.email ?? '')
  }

  /**
   * Approval is checked on its own, every time.
   *
   * It is the one action that changes what a record *is* — an approved master
   * is what goes out — so it never rides along on a broader grant.
   */
  async requireApprovalRight(actor: Actor, projectId: string): Promise<void> {
    if (!this.config.STUDIO_ENABLED) throw forbidden('Street Banker Studio is disabled on this deployment')
    await this.authorize({ capability: 'studio.approve', actor, project: { id: projectId, permission: 'approve' } })
  }
}
