import { AppError, newId, sha256Hex, type Logger } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import type { SongLabProjectRecord, SongVersionRecord } from '@masterclip/song-lab-domain'
import { SONG_LAB_ANALYSIS_STAGES } from './analysis.js'
import { SONG_LAB_RIGHTS_STATEMENT, type Actor, type SongLabDeps } from './deps.js'

/**
 * Project lifecycle: create, attach audio, kick off analysis.
 *
 * Rights confirmation is not a checkbox in the UI — it is a `consent_records`
 * row written before a single byte is stored, and `createWithUpload` refuses to
 * proceed without it. Every project row carries the id of that record, so the
 * basis on which a master was processed is answerable years later.
 */
export class SongLabProjectService {
  constructor(private readonly deps: SongLabDeps) {}

  private get logger(): Logger {
    return this.deps.logger.child({ component: 'song-lab' })
  }

  async create(input: {
    actor: Actor
    title: string
    artistName: string
    artistId?: string | null
    genre: string
    titlePhrase?: string
    notes?: string
    rightsConfirmed: boolean
    demo?: boolean
  }): Promise<SongLabProjectRecord> {
    this.assertRights(input.rightsConfirmed)
    const consent = await this.recordRightsConfirmation(input.actor, input.title)

    const project = await this.deps.repos.projects.create({
      orgId: input.actor.orgId,
      artistId: input.artistId ?? null,
      artistName: input.artistName,
      title: input.title,
      genre: input.genre,
      rightsConfirmationId: consent.id,
      ...(input.titlePhrase !== undefined ? { titlePhrase: input.titlePhrase } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.demo !== undefined ? { demo: input.demo } : {}),
      createdBy: input.actor.userId,
    })

    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'song_lab.project.created',
      targetType: 'song_lab_project',
      targetId: project.id,
      data: { title: project.title, rightsConfirmationId: consent.id },
    })
    return project
  }

  /**
   * Stores an upload and queues analysis.
   *
   * The bytes go through the Audio Intelligence asset service, which sniffs the
   * real type, enforces the size cap, applies the org's retention policy and
   * writes under the tenant's storage prefix. Song Lab does not re-implement
   * any of that.
   */
  async attachUpload(input: {
    actor: Actor
    projectId: string
    bytes: Uint8Array
    filename: string
    rightsConfirmed: boolean
    /**
     * Skips queueing analysis. Used only by the demo seed, which writes its own
     * curated analysis — without this the worker would later analyse the
     * synthesized demo audio and silently replace the documented figures.
     */
    skipAnalysis?: boolean
  }): Promise<{ project: SongLabProjectRecord; version: SongVersionRecord; analysisId: string | null }> {
    this.assertRights(input.rightsConfirmed)
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)

    const asset = await this.deps.platform.audioAssets.storeUpload({
      actor: input.actor,
      bytes: input.bytes,
      filename: input.filename,
      area: 'song-lab',
      projectType: 'song_lab',
      projectId: project.id,
      assetType: 'song_lab_source',
      retentionKind: 'source',
      rightsStatus: 'authorized_upload',
      consentRecordId: project.rightsConfirmationId,
    })

    const version = await this.deps.repos.versions.create({
      orgId: input.actor.orgId,
      songLabProjectId: project.id,
      parentVersionId: null,
      versionType: 'original_upload',
      versionLabel: 'Original Upload',
      sourceAssetId: asset.id,
      notes: 'Uploaded by the artist or an authorized user.',
      createdBy: input.actor.userId,
    })

    await this.deps.repos.projects.setSource(input.actor.orgId, project.id, asset.id, version.id)
    const analysisId = input.skipAnalysis ? null : await this.queueAnalysis(input.actor, project.id, version.id, asset.checksum)

    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'song_lab.audio.attached',
      targetType: 'song_lab_project',
      targetId: project.id,
      data: { assetId: asset.id, versionId: version.id, checksum: asset.checksum },
    })

    return { project: await this.deps.repos.projects.get(input.actor.orgId, project.id), version, analysisId }
  }

  /**
   * Imports audio the organization already holds — a Remix Lab source, an
   * existing Song Lab version, or any audio asset in the same tenant.
   *
   * The asset is referenced, not copied: one master, many projects. The org
   * check is explicit here because an asset id arriving from a request body is
   * user input.
   */
  async importAsset(input: {
    actor: Actor
    projectId: string
    assetId: string
    label?: string
  }): Promise<{ project: SongLabProjectRecord; version: SongVersionRecord; analysisId: string }> {
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)
    const asset = await this.deps.platform.audioAssetRepo.get(input.actor.orgId, input.assetId)
    if (asset.orgId !== input.actor.orgId) {
      throw new AppError({ kind: 'forbidden', code: 'song_lab.cross_tenant_asset', message: 'that audio belongs to another organization' })
    }
    const version = await this.deps.repos.versions.create({
      orgId: input.actor.orgId,
      songLabProjectId: project.id,
      parentVersionId: null,
      versionType: 'original_upload',
      versionLabel: input.label ?? 'Imported Source',
      sourceAssetId: asset.id,
      notes: `Imported from an existing ${asset.projectType} asset.`,
      createdBy: input.actor.userId,
    })
    await this.deps.repos.projects.setSource(input.actor.orgId, project.id, asset.id, version.id)
    const analysisId = await this.queueAnalysis(input.actor, project.id, version.id, asset.checksum)

    await this.deps.audit.record({
      orgId: input.actor.orgId,
      actor: input.actor.userId,
      action: 'song_lab.audio.imported',
      targetType: 'song_lab_project',
      targetId: project.id,
      data: { assetId: asset.id, sourceProjectType: asset.projectType },
    })

    return { project: await this.deps.repos.projects.get(input.actor.orgId, project.id), version, analysisId }
  }

  /**
   * Queues a fresh analysis run.
   *
   * Never overwrites the previous one: REANALYZE WITH CURRENT ENGINE means a
   * new row, so an old result stays readable next to the new one and the two
   * can be compared.
   */
  async queueAnalysis(actor: Actor, projectId: string, versionId: string, checksum: string): Promise<string> {
    const analysis = await this.deps.repos.analyses.create({
      orgId: actor.orgId,
      songLabProjectId: projectId,
      songVersionId: versionId,
      analysisVersion: this.deps.config.SONG_LAB_ANALYSIS_PROVIDER,
      engineVersion: SONG_LAB_ANALYSIS_STAGES.engineVersion,
      sourceChecksum: checksum,
      configuration: {
        provider: this.deps.config.SONG_LAB_ANALYSIS_PROVIDER,
        maxAnalysisSeconds: this.deps.config.SONG_LAB_MAX_ANALYSIS_SECONDS,
        stages: SONG_LAB_ANALYSIS_STAGES.stages,
      },
    })

    await this.deps.repos.projects.setStatus(actor.orgId, projectId, 'analyzing')
    await this.deps.queue.enqueue({
      queue: QUEUES.songLab,
      type: JOB_TYPES.songLabAnalyzeAudio,
      payload: { analysisId: analysis.id, orgId: actor.orgId, userId: actor.userId },
      // Two analyses of the same bytes for the same version would produce the
      // same answer at twice the cost.
      dedupeKey: `song_lab.analyze:${analysis.id}`,
    })
    this.logger.info('song_lab.analysis_queued', { analysis_id: analysis.id, project_id: projectId })
    return analysis.id
  }

  async reanalyze(actor: Actor, projectId: string): Promise<string> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.currentVersionId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'this project has no audio to analyse' })
    }
    const version = await this.deps.repos.versions.get(actor.orgId, project.currentVersionId)
    if (!version.sourceAssetId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'this version has no audio to analyse' })
    }
    const asset = await this.deps.platform.audioAssetRepo.get(actor.orgId, version.sourceAssetId)
    return this.queueAnalysis(actor, projectId, version.id, asset.checksum)
  }

  private assertRights(confirmed: boolean): void {
    if (confirmed) return
    throw new AppError({
      kind: 'validation',
      code: 'song_lab.rights_not_confirmed',
      message: SONG_LAB_RIGHTS_STATEMENT,
      details: { statement: SONG_LAB_RIGHTS_STATEMENT },
    })
  }

  /** Writes the consent row that every later processing step points back to. */
  private async recordRightsConfirmation(actor: Actor, title: string): Promise<{ id: string }> {
    return this.deps.platform.consents.record({
      orgId: actor.orgId,
      subjectType: 'song_lab_project',
      subjectId: newId('slp', this.deps.clock.now()),
      consentType: 'rights_confirmation',
      policyVersion: 'song-lab-1.0',
      disclosureText: SONG_LAB_RIGHTS_STATEMENT,
      accepted: true,
      acceptedBy: actor.userId,
      evidence: {
        title,
        acceptedAt: this.deps.clock.isoNow(),
        // The exact bytes of the statement the user agreed to, hashed, so a
        // later change to the wording cannot be mistaken for what they saw.
        statementHash: sha256Hex(Buffer.from(SONG_LAB_RIGHTS_STATEMENT)),
      },
    })
  }
}
