import { type Db, insertRow, parseJsonColumn, toBool, toStr, toStrOrNull } from '@masterclip/database'
import { AppError, newId, notFound, systemClock, type Clock } from '@masterclip/shared'

// ===========================================================================
// Global Release Pack (dubbing projects)
// ===========================================================================

export const DUBBING_STATUSES = [
  'draft',
  'transcribing',
  'transcript_review',
  'translating',
  'dubbing',
  'quality_review',
  'changes_requested',
  'approved',
  'exported',
  'failed',
] as const

export type DubbingStatus = (typeof DUBBING_STATUSES)[number]

export const VOICE_STRATEGIES = [
  'preserve_source_speaker',
  'approved_narrator',
  'voice_vault_profile',
  'human_recorded',
  'subtitles_only',
] as const

export interface DubbingTarget {
  language: string
  providerJobId: string | null
  status: 'pending' | 'dubbing' | 'ready' | 'failed'
  assetId: string | null
  subtitleAssetId: string | null
  error?: string
}

export interface DubbingProjectRecord {
  id: string
  orgId: string
  name: string
  sourceAssetId: string
  sourceLanguage: string
  targets: DubbingTarget[]
  status: DubbingStatus
  voiceStrategy: (typeof VOICE_STRATEGIES)[number]
  transcriptId: string | null
  rightsConfirmationId: string
  humanReviewRequired: boolean
  reviewNote: string
  approvedBy: string | null
  approvedAt: string | null
  exportedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export class DubbingRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: Omit<DubbingProjectRecord, 'id' | 'createdAt' | 'updatedAt' | 'approvedBy' | 'approvedAt' | 'exportedAt' | 'transcriptId' | 'status'>): Promise<DubbingProjectRecord> {
    const now = this.clock.isoNow()
    const record: DubbingProjectRecord = {
      ...input,
      id: newId('dub', this.clock.now()),
      status: 'draft',
      transcriptId: null,
      approvedBy: null,
      approvedAt: null,
      exportedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'dubbing_projects', {
      id: record.id,
      org_id: record.orgId,
      name: record.name,
      source_asset_id: record.sourceAssetId,
      source_language: record.sourceLanguage,
      targets: JSON.stringify(record.targets),
      status: record.status,
      voice_strategy: record.voiceStrategy,
      transcript_id: null,
      rights_confirmation_id: record.rightsConfirmationId,
      human_review_required: record.humanReviewRequired ? 1 : 0,
      review_note: record.reviewNote,
      approved_by: null,
      approved_at: null,
      exported_at: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<DubbingProjectRecord> {
    const row = await this.db.get('SELECT * FROM dubbing_projects WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('dubbing project', id)
    return mapDubbing(row)
  }

  async getAnyOrg(id: string): Promise<DubbingProjectRecord> {
    const row = await this.db.get('SELECT * FROM dubbing_projects WHERE id = ?', [id])
    if (!row) throw notFound('dubbing project', id)
    return mapDubbing(row)
  }

  async list(orgId: string, limit = 100): Promise<DubbingProjectRecord[]> {
    const rows = await this.db.query(`SELECT * FROM dubbing_projects WHERE org_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`, [
      orgId,
    ])
    return rows.map(mapDubbing)
  }

  async setStatus(id: string, status: DubbingStatus): Promise<void> {
    await this.db.run('UPDATE dubbing_projects SET status = ?, updated_at = ? WHERE id = ?', [status, this.clock.isoNow(), id])
  }

  async attachTranscript(id: string, transcriptId: string): Promise<void> {
    await this.db.run('UPDATE dubbing_projects SET transcript_id = ?, updated_at = ? WHERE id = ?', [transcriptId, this.clock.isoNow(), id])
  }

  async updateTargets(id: string, targets: DubbingTarget[]): Promise<void> {
    await this.db.run('UPDATE dubbing_projects SET targets = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(targets),
      this.clock.isoNow(),
      id,
    ])
  }

  async approve(orgId: string, id: string, approvedBy: string): Promise<void> {
    const project = await this.get(orgId, id)
    if (project.status !== 'quality_review') {
      throw new AppError({
        kind: 'conflict',
        code: 'dubbing.not_in_review',
        message: `project is ${project.status}; only quality_review projects can be approved`,
      })
    }
    await this.db.run(`UPDATE dubbing_projects SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [
      approvedBy,
      this.clock.isoNow(),
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async markExported(orgId: string, id: string): Promise<void> {
    await this.db.run(`UPDATE dubbing_projects SET status = 'exported', exported_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [
      this.clock.isoNow(),
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }
}

// ===========================================================================
// Campaign Audio Toolkit
// ===========================================================================

export const CAMPAIGN_TEMPLATES = [
  'release_announcement',
  'out_now',
  'tour_announcement',
  'fan_drop',
  'merch_launch',
  'behind_the_music',
  'countdown',
  'documentary_intro',
  'press_kit_narration',
  'brand_partnership_voiceover',
] as const

export interface CampaignProjectRecord {
  id: string
  orgId: string
  name: string
  templateType: string
  sourceAssetIds: string[]
  voiceProfileId: string | null
  status: 'active' | 'archived'
  usageContext: string
  rightsBasis: string
  rightsConfirmationId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export class CampaignRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: Omit<CampaignProjectRecord, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<CampaignProjectRecord> {
    const now = this.clock.isoNow()
    const record: CampaignProjectRecord = { ...input, id: newId('camp', this.clock.now()), status: 'active', createdAt: now, updatedAt: now }
    await insertRow(this.db, 'campaign_audio_projects', {
      id: record.id,
      org_id: record.orgId,
      name: record.name,
      template_type: record.templateType,
      source_asset_ids: JSON.stringify(record.sourceAssetIds),
      voice_profile_id: record.voiceProfileId,
      status: record.status,
      usage_context: record.usageContext,
      rights_basis: record.rightsBasis,
      rights_confirmation_id: record.rightsConfirmationId,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<CampaignProjectRecord> {
    const row = await this.db.get('SELECT * FROM campaign_audio_projects WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('campaign audio project', id)
    return mapCampaign(row)
  }

  async list(orgId: string, limit = 100): Promise<CampaignProjectRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM campaign_audio_projects WHERE org_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId],
    )
    return rows.map(mapCampaign)
  }
}

// ===========================================================================
// Remix Lab
// ===========================================================================

export const REMIX_LANES = [
  'stems',
  'alternate_sections',
  'social_versions',
  'dj_edit_brief',
  'producer_handoff',
  'inpainting',
  'instrumental_concept',
] as const

export interface RemixProjectRecord {
  id: string
  orgId: string
  name: string
  sourceAudioAssetId: string
  rightsConfirmationId: string
  noImitationConfirmationId: string
  remixLane: string
  targetUse: string
  status: 'active' | 'provider_rights_review' | 'archived'
  providerSongId: string | null
  providerScreening: 'not_submitted' | 'accepted' | 'rights_review_required' | 'failed'
  compositionPlan: unknown
  humanReviewRequired: boolean
  finalApprovalStatus: 'none' | 'producer_approved' | 'release_ready'
  approvedBy: string | null
  approvedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface RemixVersionRecord {
  id: string
  remixProjectId: string
  parentVersionId: string | null
  versionType: string
  prompt: string
  model: string
  seed: string | null
  outputAssetId: string | null
  generationMetadata: Record<string, unknown>
  reviewStatus: 'draft' | 'producer_reviewed' | 'rejected'
  reviewedBy: string | null
  createdBy: string
  createdAt: string
}

export class RemixRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: Omit<RemixProjectRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'providerSongId' | 'providerScreening' | 'compositionPlan' | 'finalApprovalStatus' | 'approvedBy' | 'approvedAt'>): Promise<RemixProjectRecord> {
    const now = this.clock.isoNow()
    const record: RemixProjectRecord = {
      ...input,
      id: newId('rmx', this.clock.now()),
      status: 'active',
      providerSongId: null,
      providerScreening: 'not_submitted',
      compositionPlan: null,
      finalApprovalStatus: 'none',
      approvedBy: null,
      approvedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'remix_projects', {
      id: record.id,
      org_id: record.orgId,
      name: record.name,
      source_audio_asset_id: record.sourceAudioAssetId,
      rights_confirmation_id: record.rightsConfirmationId,
      no_imitation_confirmation_id: record.noImitationConfirmationId,
      remix_lane: record.remixLane,
      target_use: record.targetUse,
      status: record.status,
      provider_song_id: null,
      provider_screening: record.providerScreening,
      composition_plan: null,
      human_review_required: record.humanReviewRequired ? 1 : 0,
      final_approval_status: record.finalApprovalStatus,
      approved_by: null,
      approved_at: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<RemixProjectRecord> {
    const row = await this.db.get('SELECT * FROM remix_projects WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('remix project', id)
    return mapRemix(row)
  }

  async getAnyOrg(id: string): Promise<RemixProjectRecord> {
    const row = await this.db.get('SELECT * FROM remix_projects WHERE id = ?', [id])
    if (!row) throw notFound('remix project', id)
    return mapRemix(row)
  }

  async list(orgId: string, limit = 100): Promise<RemixProjectRecord[]> {
    const rows = await this.db.query(`SELECT * FROM remix_projects WHERE org_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`, [
      orgId,
    ])
    return rows.map(mapRemix)
  }

  async setProviderScreening(id: string, screening: RemixProjectRecord['providerScreening'], providerSongId: string | null): Promise<void> {
    await this.db.run(
      `UPDATE remix_projects SET provider_screening = ?, provider_song_id = ?, status = ?, updated_at = ? WHERE id = ?`,
      [screening, providerSongId, screening === 'rights_review_required' ? 'provider_rights_review' : 'active', this.clock.isoNow(), id],
    )
  }

  async setCompositionPlan(id: string, plan: unknown): Promise<void> {
    await this.db.run('UPDATE remix_projects SET composition_plan = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(plan),
      this.clock.isoNow(),
      id,
    ])
  }

  /**
   * The human release gate. Producer approval and release-ready are distinct,
   * ordered steps; nothing skips to release_ready.
   */
  async setApproval(orgId: string, id: string, status: 'producer_approved' | 'release_ready', approvedBy: string): Promise<void> {
    const project = await this.get(orgId, id)
    if (status === 'release_ready' && project.finalApprovalStatus !== 'producer_approved') {
      throw new AppError({
        kind: 'conflict',
        code: 'remix.needs_producer_review',
        message: 'a version must be producer-approved before it can be marked release ready',
      })
    }
    await this.db.run(`UPDATE remix_projects SET final_approval_status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [
      status,
      approvedBy,
      this.clock.isoNow(),
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async addVersion(orgId: string, input: Omit<RemixVersionRecord, 'id' | 'createdAt' | 'reviewStatus' | 'reviewedBy'>): Promise<RemixVersionRecord> {
    const record: RemixVersionRecord = {
      ...input,
      id: newId('rver', this.clock.now()),
      reviewStatus: 'draft',
      reviewedBy: null,
      createdAt: this.clock.isoNow(),
    }
    await insertRow(this.db, 'remix_versions', {
      id: record.id,
      org_id: orgId,
      remix_project_id: record.remixProjectId,
      parent_version_id: record.parentVersionId,
      version_type: record.versionType,
      prompt: record.prompt,
      model: record.model,
      seed: record.seed,
      output_asset_id: record.outputAssetId,
      generation_metadata: JSON.stringify(record.generationMetadata),
      review_status: record.reviewStatus,
      reviewed_by: null,
      created_by: record.createdBy,
      created_at: record.createdAt,
    })
    return record
  }

  async versions(orgId: string, remixProjectId: string): Promise<RemixVersionRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM remix_versions WHERE remix_project_id = ? AND org_id = ? ORDER BY created_at',
      [remixProjectId, orgId],
    )
    return rows.map(mapVersion)
  }

  async reviewVersion(orgId: string, remixProjectId: string, versionId: string, status: 'producer_reviewed' | 'rejected', reviewedBy: string): Promise<void> {
    const result = await this.db.run(
      `UPDATE remix_versions SET review_status = ?, reviewed_by = ? WHERE id = ? AND remix_project_id = ? AND org_id = ?`,
      [status, reviewedBy, versionId, remixProjectId, orgId],
    )
    if (result.changes === 0) throw notFound('remix version', versionId)
  }
}

function mapDubbing(row: Record<string, unknown>): DubbingProjectRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    name: toStr(row.name),
    sourceAssetId: toStr(row.source_asset_id),
    sourceLanguage: toStr(row.source_language),
    targets: parseJsonColumn(row.targets, []),
    status: toStr(row.status) as DubbingStatus,
    voiceStrategy: toStr(row.voice_strategy) as DubbingProjectRecord['voiceStrategy'],
    transcriptId: toStrOrNull(row.transcript_id),
    rightsConfirmationId: toStr(row.rights_confirmation_id),
    humanReviewRequired: toBool(row.human_review_required),
    reviewNote: toStr(row.review_note),
    approvedBy: toStrOrNull(row.approved_by),
    approvedAt: toStrOrNull(row.approved_at),
    exportedAt: toStrOrNull(row.exported_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapCampaign(row: Record<string, unknown>): CampaignProjectRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    name: toStr(row.name),
    templateType: toStr(row.template_type),
    sourceAssetIds: parseJsonColumn(row.source_asset_ids, []),
    voiceProfileId: toStrOrNull(row.voice_profile_id),
    status: toStr(row.status) as CampaignProjectRecord['status'],
    usageContext: toStr(row.usage_context),
    rightsBasis: toStr(row.rights_basis),
    rightsConfirmationId: toStrOrNull(row.rights_confirmation_id),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapRemix(row: Record<string, unknown>): RemixProjectRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    name: toStr(row.name),
    sourceAudioAssetId: toStr(row.source_audio_asset_id),
    rightsConfirmationId: toStr(row.rights_confirmation_id),
    noImitationConfirmationId: toStr(row.no_imitation_confirmation_id),
    remixLane: toStr(row.remix_lane),
    targetUse: toStr(row.target_use),
    status: toStr(row.status) as RemixProjectRecord['status'],
    providerSongId: toStrOrNull(row.provider_song_id),
    providerScreening: toStr(row.provider_screening) as RemixProjectRecord['providerScreening'],
    compositionPlan: parseJsonColumn(row.composition_plan, null),
    humanReviewRequired: toBool(row.human_review_required),
    finalApprovalStatus: toStr(row.final_approval_status) as RemixProjectRecord['finalApprovalStatus'],
    approvedBy: toStrOrNull(row.approved_by),
    approvedAt: toStrOrNull(row.approved_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapVersion(row: Record<string, unknown>): RemixVersionRecord {
  return {
    id: toStr(row.id),
    remixProjectId: toStr(row.remix_project_id),
    parentVersionId: toStrOrNull(row.parent_version_id),
    versionType: toStr(row.version_type),
    prompt: toStr(row.prompt),
    model: toStr(row.model),
    seed: toStrOrNull(row.seed),
    outputAssetId: toStrOrNull(row.output_asset_id),
    generationMetadata: parseJsonColumn(row.generation_metadata, {}),
    reviewStatus: toStr(row.review_status) as RemixVersionRecord['reviewStatus'],
    reviewedBy: toStrOrNull(row.reviewed_by),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}
