import { AppError, newId, sha256Hex, type Logger } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import {
  DEFAULT_ROLE_PERMISSIONS,
  STUDIO_RIGHTS_STATEMENT,
  type StudioProjectRecord,
  type StudioStage,
  type StudioVersionRecord,
  type StudioVersionType,
} from '@masterclip/studio-domain'
import { actorLabel, STUDIO_ANALYSIS_VERSION, type Actor, type StudioDeps } from './deps.js'
import { LOCAL_ADAPTER, LOCAL_PROVIDER } from './processing.js'

/**
 * Project lifecycle: create, attach audio, version, advance the stage.
 *
 * Rights confirmation is not a checkbox in the UI — it is a `consent_records`
 * row written before a single byte is stored, and every project carries the id
 * of that record, so the basis on which a master was processed is answerable
 * years later.
 *
 * The rule that shapes the rest of this file: **a new version never replaces an
 * old one**. `attachVersion` always creates, never updates; the project's
 * `currentVersionId` moves, and everything that came before stays playable.
 */
export class StudioProjectService {
  constructor(private readonly deps: StudioDeps) {}

  private get logger(): Logger {
    return this.deps.logger.child({ component: 'studio' })
  }

  async create(input: {
    actor: Actor
    title: string
    artistName: string
    artistId?: string | null
    genre: string
    notes?: string
    releaseDate?: string | null
    songLabProjectId?: string | null
    rightsConfirmed: boolean
    demo?: boolean
  }): Promise<StudioProjectRecord> {
    this.assertRights(input.rightsConfirmed)
    const consent = await this.recordRightsConfirmation(input.actor, input.title)

    const project = await this.deps.repos.projects.create({
      orgId: input.actor.orgId,
      artistName: input.artistName,
      artistId: input.artistId ?? null,
      title: input.title,
      genre: input.genre,
      rightsConfirmationId: consent.id,
      songLabProjectId: input.songLabProjectId ?? null,
      releaseDate: input.releaseDate ?? null,
      notes: input.notes ?? '',
      demo: input.demo ?? false,
      createdBy: input.actor.userId,
    })

    // The creator is a collaborator on their own project, with the artist's
    // permissions. Without this, the person who made the project would fail the
    // collaborator gate on their own record.
    await this.deps.repos.collaborators.invite({
      orgId: input.actor.orgId,
      studioProjectId: project.id,
      email: input.actor.email ?? `${input.actor.userId}@local`,
      displayName: actorLabel(input.actor),
      collaboratorRole: 'artist',
      permissions: [...DEFAULT_ROLE_PERMISSIONS.artist, 'admin'],
      userId: input.actor.userId,
      invitedBy: input.actor.userId,
    })

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: project.id,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'project.created',
      subjectType: 'project',
      subjectId: project.id,
      detail: `${project.artistName} — ${project.title}`,
    })
    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'studio.project.created',
      targetType: 'studio_project',
      targetId: project.id,
      data: { title: project.title, rightsConfirmationId: consent.id },
    })
    return project
  }

  /**
   * Stores an upload as a new version.
   *
   * The bytes go through the Audio Intelligence asset service, which sniffs the
   * real type, enforces the size cap, applies the org's retention policy and
   * writes under the tenant's storage prefix. Studio does not re-implement any
   * of that.
   */
  async attachUpload(input: {
    actor: Actor
    projectId: string
    bytes: Uint8Array
    filename: string
    versionType: StudioVersionType
    label?: string
    notes?: string
    rightsConfirmed: boolean
    /**
     * Skips queueing analysis. Used only by the demo seed, which writes its own
     * curated analysis — without this the worker would later analyse the
     * synthesized demo audio and silently replace the documented figures.
     */
    skipAnalysis?: boolean
  }): Promise<{ project: StudioProjectRecord; version: StudioVersionRecord; analysisId: string | null }> {
    this.assertRights(input.rightsConfirmed)
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)

    const asset = await this.deps.platform.audioAssets.storeUpload({
      actor: input.actor,
      bytes: input.bytes,
      filename: input.filename,
      area: 'studio',
      projectType: 'song_lab',
      projectId: project.id,
      assetType: 'studio_version_source',
      retentionKind: 'source',
      rightsStatus: 'authorized_upload',
      consentRecordId: project.rightsConfirmationId,
    })

    return this.attachVersion({
      actor: input.actor,
      projectId: project.id,
      assetId: asset.id,
      assetChecksum: asset.checksum,
      versionType: input.versionType,
      sourceKind: 'upload',
      ...(input.label ? { label: input.label } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.skipAnalysis !== undefined ? { skipAnalysis: input.skipAnalysis } : {}),
    })
  }

  /**
   * Imports audio the organization already holds — a Song Lab source, a Remix
   * Lab render, an earlier release.
   *
   * The asset is referenced, not copied: one master, many projects. The org
   * check is explicit because an asset id arriving from a request body is user
   * input.
   */
  async importAsset(input: {
    actor: Actor
    projectId: string
    assetId: string
    versionType: StudioVersionType
    label?: string
  }): Promise<{ project: StudioProjectRecord; version: StudioVersionRecord; analysisId: string | null }> {
    const asset = await this.deps.platform.audioAssetRepo.get(input.actor.orgId, input.assetId)
    if (asset.orgId !== input.actor.orgId) {
      throw new AppError({ kind: 'forbidden', code: 'studio.cross_tenant_asset', message: 'that audio belongs to another organization' })
    }
    return this.attachVersion({
      actor: input.actor,
      projectId: input.projectId,
      assetId: asset.id,
      assetChecksum: asset.checksum,
      versionType: input.versionType,
      sourceKind: 'import',
      ...(input.label ? { label: input.label } : {}),
      notes: `Imported from an existing ${asset.projectType} asset.`,
    })
  }

  /**
   * Creates a version and points the project at it.
   *
   * The single write path for every kind of version — upload, import, master
   * render, album render — so the guarantees hold uniformly: the previous
   * version is never touched, the activity log always gets an entry, and
   * analysis is always queued the same way.
   */
  async attachVersion(input: {
    actor: Actor
    projectId: string
    assetId: string
    assetChecksum: string
    versionType: StudioVersionType
    sourceKind: 'upload' | 'import' | 'master_render' | 'rack_render' | 'album_render' | 'external'
    label?: string
    notes?: string
    parentVersionId?: string | null
    masterRenditionId?: string | null
    /** Leaves `currentVersionId` alone — a derived version does not take over the session. */
    keepCurrent?: boolean
    skipAnalysis?: boolean
  }): Promise<{ project: StudioProjectRecord; version: StudioVersionRecord; analysisId: string | null }> {
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)

    const version = await this.deps.repos.versions.create({
      orgId: input.actor.orgId,
      studioProjectId: project.id,
      parentVersionId: input.parentVersionId ?? project.currentVersionId,
      versionType: input.versionType,
      ...(input.label ? { label: input.label } : {}),
      assetId: input.assetId,
      assetChecksum: input.assetChecksum,
      sourceKind: input.sourceKind,
      masterRenditionId: input.masterRenditionId ?? null,
      notes: input.notes ?? '',
      createdBy: input.actor.userId,
    })

    if (!input.keepCurrent) await this.deps.repos.projects.setCurrentVersion(input.actor.orgId, project.id, version.id)

    // Uploading a mix means the record is in the mix stage; uploading a master
    // means it has reached mastering. The stage follows the work rather than
    // needing to be set by hand, and never moves backwards.
    const impliedStage = stageForVersionType(input.versionType)
    if (impliedStage && stageRank(impliedStage) > stageRank(project.stage)) {
      await this.deps.repos.projects.setStage(input.actor.orgId, project.id, impliedStage)
    }

    const analysisId = input.skipAnalysis ? null : await this.queueAnalysis(input.actor, project.id, version.id, input.assetId, input.assetChecksum)

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: project.id,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'version.added',
      subjectType: 'version',
      subjectId: version.id,
      detail: `${version.label} (${input.sourceKind})`,
    })
    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'studio.version.added',
      targetType: 'studio_project',
      targetId: project.id,
      data: { versionId: version.id, assetId: input.assetId, checksum: input.assetChecksum, versionType: input.versionType },
    })

    return { project: await this.deps.repos.projects.get(input.actor.orgId, project.id), version, analysisId }
  }

  /**
   * Queues a mix analysis for a version.
   *
   * Never overwrites a previous one: re-analysing produces a new row, so an old
   * result stays readable next to the new one and the two can be compared.
   */
  async queueAnalysis(actor: Actor, projectId: string, versionId: string, assetId: string, checksum: string): Promise<string> {
    const analysis = await this.deps.repos.analyses.create({
      orgId: actor.orgId,
      studioProjectId: projectId,
      studioVersionId: versionId,
      sourceAssetId: assetId,
      sourceChecksum: checksum,
      inputKind: 'stereo_mix',
      analyzerSetVersion: STUDIO_ANALYSIS_VERSION,
      createdBy: actor.userId,
    })

    // The ledger entry is written before the message is queued. Queuing first
    // would leave a window in which a worker could pick the message up and find
    // no job to settle.
    const job = await this.deps.repos.processing.claim({
      orgId: actor.orgId,
      studioProjectId: projectId,
      studioVersionId: versionId,
      jobType: 'mix_analysis',
      subjectType: 'mix_analysis',
      subjectId: analysis.id,
      provider: LOCAL_PROVIDER,
      adapter: LOCAL_ADAPTER,
      // Keyed on the analysis row, which is what the job settles. A re-analysis
      // is a new row and deserves its own ledger entry — the checksum is
      // deliberately not in the key, because "measure these bytes again" is a
      // request a user can legitimately make and the ledger should show both.
      idempotencyKey: `mix_analysis:${analysis.id}`,
      request: { analyzer_set: STUDIO_ANALYSIS_VERSION, input_kind: 'stereo_mix', source_checksum: checksum },
      createdBy: actor.userId,
    })

    await this.deps.queue.enqueue({
      queue: QUEUES.studio,
      type: JOB_TYPES.studioAnalyzeMix,
      payload: { analysisId: analysis.id, orgId: actor.orgId, userId: actor.userId, jobId: job.id },
      // Two analyses of the same bytes for the same version would produce the
      // same answer at twice the cost.
      dedupeKey: `studio.analyze:${analysis.id}`,
    })
    this.logger.info('studio.analysis_queued', { analysis_id: analysis.id, job_id: job.id, project_id: projectId, version_id: versionId })
    return analysis.id
  }

  async reanalyze(actor: Actor, projectId: string, versionId?: string): Promise<string> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    const targetId = versionId ?? project.currentVersionId
    if (!targetId) {
      throw new AppError({ kind: 'validation', code: 'studio.no_audio', message: 'this project has no audio to analyse' })
    }
    const version = await this.deps.repos.versions.get(actor.orgId, targetId)
    if (!version.assetId || !version.assetChecksum) {
      throw new AppError({ kind: 'validation', code: 'studio.no_audio', message: 'this version has no audio to analyse' })
    }
    return this.queueAnalysis(actor, projectId, version.id, version.assetId, version.assetChecksum)
  }

  /** Makes an existing version the one the session opens on. */
  async setCurrentVersion(actor: Actor, projectId: string, versionId: string): Promise<StudioProjectRecord> {
    const version = await this.deps.repos.versions.get(actor.orgId, versionId)
    if (version.studioProjectId !== projectId) {
      throw new AppError({ kind: 'validation', code: 'studio.version_mismatch', message: 'that version belongs to a different project' })
    }
    await this.deps.repos.projects.setCurrentVersion(actor.orgId, projectId, versionId)
    return this.deps.repos.projects.get(actor.orgId, projectId)
  }

  async setStage(actor: Actor, projectId: string, stage: StudioStage): Promise<StudioProjectRecord> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    await this.deps.repos.projects.setStage(actor.orgId, projectId, stage)
    await this.deps.repos.activity.record({
      orgId: actor.orgId,
      studioProjectId: projectId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      action: 'stage.changed',
      subjectType: 'project',
      subjectId: projectId,
      detail: `${project.stage} → ${stage}`,
    })
    return this.deps.repos.projects.get(actor.orgId, projectId)
  }

  private assertRights(confirmed: boolean): void {
    if (confirmed) return
    throw new AppError({
      kind: 'validation',
      code: 'studio.rights_not_confirmed',
      message: STUDIO_RIGHTS_STATEMENT,
      details: { statement: STUDIO_RIGHTS_STATEMENT },
    })
  }

  /** Writes the consent row that every later processing step points back to. */
  private async recordRightsConfirmation(actor: Actor, title: string): Promise<{ id: string }> {
    return this.deps.platform.consents.record({
      orgId: actor.orgId,
      subjectType: 'studio_project',
      subjectId: newId('stp', this.deps.clock.now()),
      consentType: 'rights_confirmation',
      policyVersion: 'studio-1.0',
      disclosureText: STUDIO_RIGHTS_STATEMENT,
      accepted: true,
      acceptedBy: actor.userId,
      evidence: {
        title,
        acceptedAt: this.deps.clock.isoNow(),
        // The exact bytes of the statement the user agreed to, hashed, so a
        // later change to the wording cannot be mistaken for what they saw.
        statementHash: sha256Hex(Buffer.from(STUDIO_RIGHTS_STATEMENT)),
      },
    })
  }
}

const STAGE_ORDER: StudioStage[] = ['create', 'analyze', 'mix', 'master', 'approve', 'package', 'release', 'market', 'monetize', 'track']

export function stageRank(stage: StudioStage): number {
  const index = STAGE_ORDER.indexOf(stage)
  return index < 0 ? 0 : index
}

/**
 * The stage a version type implies.
 *
 * Returns null for the types that say nothing about where the record is: an
 * instrumental or an acapella can be cut at any point, and inferring a stage
 * from one would move the project for no reason.
 */
export function stageForVersionType(versionType: StudioVersionType): StudioStage | null {
  switch (versionType) {
    case 'demo':
    case 'rough':
      return 'analyze'
    case 'mix':
      return 'mix'
    case 'approved_mix':
      return 'master'
    case 'master':
      return 'master'
    case 'final_master':
      return 'approve'
    default:
      return null
  }
}
