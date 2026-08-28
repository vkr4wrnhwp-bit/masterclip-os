import { AppError } from '@masterclip/shared'
import {
  type AiPermission,
  type AiPermissionRecord,
  type AiPermissionScope,
  type IdentityControl,
  type IdentitySubject,
  type IdentityVaultRecord,
  type LicenseMatch,
  type LicenseRequestRecord,
} from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'

/**
 * IDENTITY VAULT, rights-safe AI licensing, and the agent-to-agent boundary.
 *
 * The whole surface is default-deny, and the denial is structural rather than
 * a policy that could be forgotten: `AiPermissionRepo.isAllowed` and
 * `IdentityVaultRepo.controlFor` return refusal when no row exists, so an
 * artist who has never opened these screens is protected exactly as if they had
 * set everything to prohibited.
 *
 * The line this service will not cross: nothing here executes a licence. A
 * licensing request is received, rights-checked against stored permissions,
 * priced indicatively, and then stops at `awaiting_human`. Contract and payment
 * infrastructure does not exist yet, and a system that grants rights it cannot
 * paper is a liability rather than a feature.
 */
export class StudioRightsService {
  constructor(private readonly deps: StudioDeps) {}

  // --- identity vault -----------------------------------------------------

  async setIdentity(input: {
    actor: Actor
    artistKey: string
    subject: IdentitySubject
    control: IdentityControl
    approvedModelIds?: string[]
    permittedUses?: string[]
    prohibitedUses?: string[]
    territories?: string[]
    termStart?: string | null
    termEnd?: string | null
    pricing?: string
    consentRecordId?: string | null
  }): Promise<IdentityVaultRecord> {
    // A `permitted` control needs a consent record that actually exists, was
    // accepted, and has not been revoked. Accepting an id without checking it
    // would make the verification flag decorative.
    let verified = false
    if (input.consentRecordId) {
      await this.deps.platform.consents.requireActive(input.actor.orgId, input.consentRecordId)
      verified = true
    }

    return this.deps.repos.identities.set({
      orgId: input.actor.orgId,
      artistKey: input.artistKey,
      subject: input.subject,
      control: input.control,
      ...(input.approvedModelIds ? { approvedModelIds: input.approvedModelIds } : {}),
      ...(input.permittedUses ? { permittedUses: input.permittedUses } : {}),
      ...(input.prohibitedUses ? { prohibitedUses: input.prohibitedUses } : {}),
      ...(input.territories ? { territories: input.territories } : {}),
      termStart: input.termStart ?? null,
      termEnd: input.termEnd ?? null,
      ...(input.pricing !== undefined ? { pricing: input.pricing } : {}),
      consentRecordId: input.consentRecordId ?? null,
      verified,
      actorUserId: input.actor.userId,
    })
  }

  async identityProfile(actor: Actor, artistKey: string) {
    const entries = await this.deps.repos.identities.list(actor.orgId, artistKey)
    const withEvents = []
    for (const entry of entries) {
      withEvents.push({ entry, events: await this.deps.repos.identities.events(actor.orgId, entry.id) })
    }
    // Subjects with no row are listed explicitly as prohibited, so the screen
    // shows the artist's whole position rather than only what they have edited.
    const covered = new Set(entries.map((entry) => entry.subject))
    const implicit = (['voice', 'name', 'image', 'likeness', 'performance_style'] as IdentitySubject[])
      .filter((subject) => !covered.has(subject))
      .map((subject) => ({ subject, control: 'prohibited' as const, reason: 'no entry exists, so this use is not permitted' }))

    return { artistKey, entries: withEvents, implicit }
  }

  /**
   * The gate every voice or likeness feature must call.
   *
   * Returns a decision and a reason. Callers must not interpret an absent entry
   * as permission — and cannot, because this never returns `permitted` for one.
   */
  async checkIdentity(actor: Actor, artistKey: string, subject: IdentitySubject): Promise<{ control: IdentityControl; reason: string }> {
    return this.deps.repos.identities.controlFor(actor.orgId, artistKey, subject)
  }

  async revokeIdentity(actor: Actor, id: string, reason: string): Promise<IdentityVaultRecord> {
    return this.deps.repos.identities.revoke(actor.orgId, id, actor.userId, reason)
  }

  // --- AI permissions -----------------------------------------------------

  async setAiPermission(input: {
    actor: Actor
    projectId: string
    assetScope: AiPermissionScope
    permission: AiPermission
    granted: boolean
    revocable?: boolean
    territories?: string[]
    termEnd?: string | null
    conditions?: string
    contractReference?: string | null
  }): Promise<AiPermissionRecord> {
    await this.deps.repos.projects.get(input.actor.orgId, input.projectId)

    // An irrevocable grant is a contractual commitment, so it must name the
    // contract. Otherwise "irrevocable" is just a checkbox somebody ticked.
    if (input.revocable === false && !input.contractReference) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.irrevocable_needs_contract',
        message: 'an irrevocable permission must reference the contract that makes it irrevocable',
      })
    }

    const record = await this.deps.repos.aiPermissions.set({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      assetScope: input.assetScope,
      permission: input.permission,
      granted: input.granted,
      ...(input.revocable !== undefined ? { revocable: input.revocable } : {}),
      ...(input.territories ? { territories: input.territories } : {}),
      termEnd: input.termEnd ?? null,
      ...(input.conditions !== undefined ? { conditions: input.conditions } : {}),
      contractReference: input.contractReference ?? null,
      actorUserId: input.actor.userId,
    })

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: input.granted ? 'ai_permission.granted' : 'ai_permission.withheld',
      subjectType: 'ai_permission',
      subjectId: record.id,
      detail: `${input.permission} on ${input.assetScope}`,
    })
    return record
  }

  async aiPermissions(actor: Actor, projectId: string) {
    const permissions = await this.deps.repos.aiPermissions.list(actor.orgId, projectId)
    const withEvents = []
    for (const permission of permissions) {
      withEvents.push({ permission, events: await this.deps.repos.aiPermissions.events(actor.orgId, permission.id) })
    }
    return withEvents
  }

  async checkAiPermission(actor: Actor, projectId: string, assetScope: AiPermissionScope, permission: AiPermission) {
    return this.deps.repos.aiPermissions.isAllowed(actor.orgId, projectId, assetScope, permission)
  }

  async revokeAiPermission(actor: Actor, id: string, reason: string): Promise<AiPermissionRecord> {
    return this.deps.repos.aiPermissions.revoke(actor.orgId, id, actor.userId, reason)
  }

  // --- agent-to-agent licensing -------------------------------------------

  /**
   * Receives a licensing request and takes it as far as it can go without a
   * human.
   *
   * The pipeline is REQUEST → RIGHTS CHECK → PRICE → *stop*. Every match names
   * why it matched and whether its rights are clear; `rightsClear: null` means
   * the stored data does not answer the question, which is a different answer
   * from "no" and is presented as such.
   */
  async receiveLicenseRequest(input: {
    actor: Actor
    requester: string
    requesterKind: 'human' | 'agent'
    brief: string
    budgetMicros?: number | null
    durationSeconds?: number | null
    territories?: string[]
    rightsRequested?: string[]
  }): Promise<LicenseRequestRecord> {
    const request = await this.deps.repos.licenseRequests.create({
      orgId: input.actor.orgId,
      requester: input.requester,
      requesterKind: input.requesterKind,
      brief: input.brief,
      budgetMicros: input.budgetMicros ?? null,
      durationSeconds: input.durationSeconds ?? null,
      ...(input.territories ? { territories: input.territories } : {}),
      ...(input.rightsRequested ? { rightsRequested: input.rightsRequested } : {}),
    })

    const matches = await this.matchCatalog(input.actor, request)
    const eligible = matches.filter((match) => match.rightsClear === true)

    return this.deps.repos.licenseRequests.settle(
      input.actor.orgId,
      request.id,
      eligible.length > 0 ? 'awaiting_human' : 'declined',
      matches,
      eligible.length > 0
        ? `${eligible.length} of ${matches.length} candidates have clear rights for the requested use. Street Banker does not execute licences: a person reviews, prices and papers this. Nothing has been granted.`
        : matches.length === 0
          ? 'No catalogue match for this brief.'
          : 'No candidate has the rights permissions this request needs. Nothing has been granted.',
    )
  }

  /**
   * Matches a brief against the catalogue.
   *
   * Deliberately conservative and explainable: it matches on the facts the
   * platform actually holds — genre, stage, duration, measured characteristics
   * — and lists them as the reasons. A relevance model that could not explain
   * itself would be worse than useless in a rights context.
   */
  private async matchCatalog(actor: Actor, request: LicenseRequestRecord): Promise<LicenseMatch[]> {
    const brief = request.brief.toLowerCase()
    const projects = await this.deps.repos.projects.list(actor.orgId, { limit: 200 })
    const matches: LicenseMatch[] = []

    for (const project of projects) {
      const reasons: string[] = []
      if (project.genre && brief.includes(project.genre.toLowerCase())) reasons.push(`genre "${project.genre}" appears in the brief`)
      for (const word of brief.split(/[^a-z0-9]+/).filter((token) => token.length > 3)) {
        if (project.title.toLowerCase().includes(word)) reasons.push(`title contains "${word}"`)
      }

      const versionId = project.approvedMasterVersionId ?? project.currentVersionId
      const version = versionId ? await this.deps.repos.versions.get(actor.orgId, versionId).catch(() => null) : null
      if (request.durationSeconds && version?.durationMs) {
        const seconds = version.durationMs / 1000
        if (Math.abs(seconds - request.durationSeconds) <= request.durationSeconds * 0.35) {
          reasons.push(`runtime ${Math.round(seconds)}s is close to the ${request.durationSeconds}s requested`)
        }
      }
      if (project.approvedMasterVersionId) reasons.push('has an approved master')

      if (reasons.length === 0) continue

      // Rights: does this project carry a permission covering commercial
      // synchronised generation or licensed derivative use? A project with no
      // permissions at all answers "not determined", not "yes".
      const permissions = await this.deps.repos.aiPermissions.list(actor.orgId, project.id)
      const rightsNotes: string[] = []
      let rightsClear: boolean | null = null

      if (permissions.length === 0) {
        rightsNotes.push('No AI or licensing permissions have been recorded for this project, so its rights position is not determined.')
      } else {
        const blanket = permissions.find((permission) => permission.permission === 'no_ai_use' && permission.granted && !permission.revokedAt)
        if (blanket) {
          rightsClear = false
          rightsNotes.push('This project carries an explicit "no AI use" declaration.')
        } else {
          const sync = await this.deps.repos.aiPermissions.isAllowed(actor.orgId, project.id, 'master', 'commercial_sync_generation')
          rightsClear = sync.allowed
          rightsNotes.push(sync.allowed ? 'Commercial sync generation is permitted on the master.' : sync.reason)
        }
      }

      matches.push({
        studioProjectId: project.id,
        title: project.title,
        artistName: project.artistName,
        whyItMatches: reasons,
        rightsClear,
        rightsNotes,
        // No pricing model exists, and inventing one against a real budget
        // would be the most damaging kind of made-up number.
        indicativePriceMicros: null,
        priceBasis: 'No pricing model is configured. A price is set by a person against the brief, the budget and the rights being licensed.',
      })
    }

    return matches.slice(0, 20)
  }

  async licenseRequests(actor: Actor): Promise<LicenseRequestRecord[]> {
    return this.deps.repos.licenseRequests.list(actor.orgId)
  }
}
