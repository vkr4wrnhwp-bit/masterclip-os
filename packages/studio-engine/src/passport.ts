import { AppError } from '@masterclip/shared'
import type { PassportContributor, RecordPassportDocument, RecordPassportRecord } from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'

/**
 * RECORD PASSPORT.
 *
 * Assembles a machine-readable provenance record from what the platform already
 * knows — versions, approvals, contributions, splits, delivery history — rather
 * than from a form somebody fills in twice. The parts that cannot be derived
 * (sample declarations, AI disclosures, ownership statements) are declared by a
 * person and recorded as declarations, attributed and timestamped.
 *
 * What it deliberately does not do:
 *
 *   - It makes no legal conclusions. A sample with `cleared: null` means nobody
 *     has said, which is different from "not cleared", and the schema keeps the
 *     two apart.
 *   - It is not DDEX or RIN. The document is shaped so an exporter can map into
 *     those standards without this application depending on any one of them, or
 *     on a particular version of one.
 */
export class StudioPassportService {
  constructor(private readonly deps: StudioDeps) {}

  /**
   * Builds (or rebuilds) the draft passport for a project.
   *
   * Idempotent in spirit: calling it again produces a new draft reflecting the
   * project's current state. A finalized passport is never modified — it
   * describes bytes that already shipped.
   */
  async build(input: {
    actor: Actor
    projectId: string
    declarations?: string[]
    samples?: Array<{ description: string; source: string; cleared: boolean | null; licenseReference: string | null }>
    generativeUse?: string[]
    voiceModelUse?: string[]
    externalProfile?: string | null
  }): Promise<RecordPassportRecord> {
    const orgId = input.actor.orgId
    const project = await this.deps.repos.projects.get(orgId, input.projectId)
    const versions = await this.deps.repos.versions.list(orgId, project.id)
    const approvals = await this.deps.repos.approvals.list(orgId, project.id)
    const contributions = await this.deps.repos.contributions.list(orgId, project.id)
    const metadata = await this.deps.repos.releaseMetadata.get(orgId, project.id)
    const deliverables = await this.deps.repos.deliverables.list(orgId, project.id)
    const collaborators = await this.deps.repos.collaborators.list(orgId, project.id, { includeRevoked: true })
    const renditions = await this.deps.repos.renditions.list(orgId, project.id)

    // Contributors come from two sources: the declared creation ledger, which
    // is authoritative about who did what, and the collaborator list, which
    // records who had access. Both are included and distinguished, because
    // "was on the project" and "performed on the record" are different claims.
    const contributors: PassportContributor[] = [
      ...contributions.map((contribution) => ({
        name: contribution.performedBy,
        roles: [contribution.contributionType, ...(contribution.instrument ? [contribution.instrument] : [])],
        userId: contribution.performerUserId,
        human: contribution.human,
        detail: contribution.detail || (contribution.human ? 'declared human contribution' : `AI-assisted: ${contribution.aiTool ?? 'unspecified tool'}`),
      })),
      ...collaborators
        .filter((collaborator) => !contributions.some((contribution) => contribution.performerUserId === collaborator.userId))
        .map((collaborator) => ({
          name: collaborator.displayName,
          roles: [collaborator.collaboratorRole],
          userId: collaborator.userId,
          human: true,
          detail: 'had project access; no creative contribution declared',
        })),
    ]

    // Tools used: derived from what the platform actually did, not from a
    // checkbox. A master rendered here is an AI-assisted-tooling fact whether
    // or not anybody remembers to declare it.
    const toolsUsed = [
      ...renditions
        .filter((rendition) => rendition.status === 'ready' && !rendition.placeholder)
        .map((rendition) => ({
          tool: `Street Banker Master Station (${rendition.renderer ?? 'unknown renderer'})`,
          role: `${rendition.direction} mastering chain`,
          stage: 'master',
        })),
      ...contributions
        .filter((contribution) => !contribution.human && contribution.aiTool)
        .map((contribution) => ({ tool: contribution.aiTool as string, role: contribution.aiRole ?? 'unspecified', stage: contribution.contributionType })),
    ]
    // De-duplicated: three renditions from the same chain is one tool.
    const uniqueTools = [...new Map(toolsUsed.map((tool) => [`${tool.tool}|${tool.role}|${tool.stage}`, tool])).values()]

    const document: RecordPassportDocument = {
      schemaVersion: '1.0.0',
      projectId: project.id,
      recordingId: `${project.id}:recording`,
      title: project.title,
      artist: project.artistName,
      generatedAt: this.deps.clock.isoNow(),
      contributors,
      versions: versions.map((version) => ({
        versionId: version.id,
        label: version.label,
        versionType: version.versionType,
        createdAt: version.createdAt,
        createdBy: version.createdBy,
        checksum: version.assetChecksum,
        sourceKind: version.sourceKind,
        parentVersionId: version.parentVersionId,
      })),
      approvals: approvals
        .filter((approval) => !approval.revokedAt)
        .map((approval) => ({
          approvalType: approval.approvalType,
          versionId: approval.studioVersionId,
          approvedBy: approval.approvedByLabel,
          approvedAt: approval.approvedAt,
          versionChecksum: approval.versionChecksum,
        })),
      ownership: {
        declarations: input.declarations ?? [],
        splits: metadata?.splits ?? [],
      },
      aiDisclosure: {
        toolsUsed: uniqueTools,
        generativeUse: input.generativeUse ?? [],
        voiceModelUse: input.voiceModelUse ?? [],
        // Recorded even when empty, because a passport that omits the field is
        // indistinguishable from one where nobody was asked.
        declaredBy: input.generativeUse || input.voiceModelUse ? actorLabel(input.actor) : null,
        declaredAt: input.generativeUse || input.voiceModelUse ? this.deps.clock.isoNow() : null,
      },
      samples: input.samples ?? [],
      licenses: (await this.deps.repos.aiPermissions.list(orgId, project.id))
        .filter((permission) => permission.granted && !permission.revokedAt)
        .map((permission) => ({
          kind: `ai:${permission.permission}`,
          reference: permission.contractReference ?? permission.id,
          territories: permission.territories,
          termEnd: permission.termEnd,
        })),
      deliveryHistory: deliverables.map((deliverable) => ({
        deliverableId: deliverable.id,
        kind: deliverable.assetKind,
        sentAt: deliverable.sentAt,
        releaseId: deliverable.sentReleaseId,
      })),
    }

    const passport = await this.deps.repos.passports.create({
      orgId,
      studioProjectId: project.id,
      document,
      externalProfile: input.externalProfile ?? null,
      createdBy: input.actor.userId,
    })

    await this.deps.repos.activity.record({
      orgId,
      studioProjectId: project.id,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'passport.built',
      subjectType: 'passport',
      subjectId: passport.id,
      detail: `${contributors.length} contributor(s), ${versions.length} version(s)`,
    })

    return passport
  }

  /**
   * Binds a passport to the exact bytes of a version and closes it.
   *
   * Refuses on a version with no checksum: a provenance record that cannot name
   * the file it describes is a document, not a record.
   */
  async finalize(actor: Actor, passportId: string, versionId: string): Promise<RecordPassportRecord> {
    const passport = await this.deps.repos.passports.get(actor.orgId, passportId)
    const version = await this.deps.repos.versions.get(actor.orgId, versionId)
    if (version.studioProjectId !== passport.studioProjectId) {
      throw new AppError({ kind: 'validation', code: 'studio.version_mismatch', message: 'that version belongs to a different project' })
    }
    if (!version.assetChecksum) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.passport_needs_checksum',
        message: 'this version has no stored checksum, so a passport cannot be bound to it',
      })
    }
    const finalized = await this.deps.repos.passports.finalize(actor.orgId, passportId, version.id, version.assetChecksum)

    await this.deps.repos.activity.record({
      orgId: actor.orgId,
      studioProjectId: passport.studioProjectId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      action: 'passport.finalized',
      subjectType: 'passport',
      subjectId: passportId,
      detail: `bound to ${version.label} (${version.assetChecksum.slice(0, 12)}…)`,
    })
    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'studio.passport.finalized',
      targetType: 'studio_passport',
      targetId: passportId,
      data: { versionId: version.id, checksum: version.assetChecksum, documentHash: finalized.documentHash },
    })

    return finalized
  }

  /**
   * Verifies a passport.
   *
   * Two independent checks: the document still hashes to what was recorded, and
   * — for a finalized passport — the version it names still carries the same
   * audio checksum. Either failing means something changed that should not
   * have, and the result says which.
   */
  async verify(actor: Actor, passportId: string) {
    const passport = await this.deps.repos.passports.get(actor.orgId, passportId)
    const documentCheck = await this.deps.repos.passports.verify(actor.orgId, passportId)

    let assetCheck: { checked: boolean; valid: boolean; detail: string } = {
      checked: false,
      valid: false,
      detail: 'This passport is a draft and is not bound to a specific file yet.',
    }
    if (passport.status === 'finalized' && passport.finalizedVersionId) {
      const version = await this.deps.repos.versions.get(actor.orgId, passport.finalizedVersionId).catch(() => null)
      if (!version) {
        assetCheck = { checked: true, valid: false, detail: 'The version this passport names no longer exists.' }
      } else if (version.assetChecksum !== passport.finalizedAssetChecksum) {
        assetCheck = { checked: true, valid: false, detail: 'The audio this passport was bound to has a different checksum now.' }
      } else {
        assetCheck = { checked: true, valid: true, detail: `Bound audio still matches (${version.assetChecksum?.slice(0, 12)}…).` }
      }
    }

    return { passport, document: documentCheck, asset: assetCheck, valid: documentCheck.valid && (!assetCheck.checked || assetCheck.valid) }
  }
}
