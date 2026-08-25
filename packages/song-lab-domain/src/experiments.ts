import { insertRow, parseJsonColumn, toBool, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { forbidden, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { ExperimentEdit, ExperimentType } from '@masterclip/audio-experiments'
import type { SongExperimentRecord, SongExperimentStatus } from './types.js'

/**
 * Experiments.
 *
 * The stored artefact is the edit decision list, not audio. A preview asset id
 * may be attached, may expire, and may be re-rendered — none of which touches
 * the source. There is deliberately no method on this repository that writes to
 * a source asset.
 */
export class SongExperimentRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    songLabProjectId: string
    sourceVersionId: string
    recommendationId?: string | null
    name: string
    experimentType: ExperimentType
    intent: string
    editDecisionList: ExperimentEdit[]
    bpmOverride: number | null
    predictedDurationMs: number | null
    createdBy: string
  }): Promise<SongExperimentRecord> {
    const now = this.clock.isoNow()
    const id = newId('sexp', this.clock.now())
    await insertRow(this.db, 'song_experiments', {
      id,
      org_id: input.orgId,
      song_lab_project_id: input.songLabProjectId,
      source_version_id: input.sourceVersionId,
      recommendation_id: input.recommendationId ?? null,
      name: input.name,
      experiment_type: input.experimentType,
      intent: input.intent,
      edit_decision_list: JSON.stringify(input.editDecisionList),
      bpm_override: input.bpmOverride,
      status: 'draft',
      preview_asset_id: null,
      predicted_duration_ms: input.predictedDurationMs,
      rendered_duration_ms: null,
      renderer: null,
      renderer_version: null,
      placeholder_preview: 0,
      accepted_version_id: null,
      failure_reason: null,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    })
    return this.get(input.orgId, id)
  }

  async get(orgId: string, id: string): Promise<SongExperimentRecord> {
    const row = await this.db.get('SELECT * FROM song_experiments WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('song experiment', id)
    return mapExperiment(row)
  }

  /** For jobs holding only an id. The expected org is proved, never assumed. */
  async getForJob(id: string, expectedOrgId: string): Promise<SongExperimentRecord> {
    const row = await this.db.get('SELECT * FROM song_experiments WHERE id = ?', [id])
    if (!row) throw notFound('song experiment', id)
    const experiment = mapExperiment(row)
    if (experiment.orgId !== expectedOrgId) throw forbidden('song experiment belongs to another organization')
    return experiment
  }

  async list(orgId: string, projectId: string): Promise<SongExperimentRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_experiments WHERE org_id = ? AND song_lab_project_id = ? ORDER BY created_at DESC',
      [orgId, projectId],
    )
    return rows.map(mapExperiment)
  }

  async countForProject(orgId: string, projectId: string): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM song_experiments WHERE org_id = ? AND song_lab_project_id = ?', [
      orgId,
      projectId,
    ])
    return toNum(row?.total)
  }

  async setStatus(orgId: string, id: string, status: SongExperimentStatus, failureReason: string | null = null): Promise<void> {
    await this.db.run('UPDATE song_experiments SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      status,
      failureReason,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async attachPreview(
    orgId: string,
    id: string,
    preview: { assetId: string; durationMs: number; renderer: string; rendererVersion: string; placeholder: boolean },
  ): Promise<void> {
    await this.db.run(
      `UPDATE song_experiments SET status = 'ready', preview_asset_id = ?, rendered_duration_ms = ?, renderer = ?,
         renderer_version = ?, placeholder_preview = ?, failure_reason = NULL, updated_at = ? WHERE id = ? AND org_id = ?`,
      [preview.assetId, preview.durationMs, preview.renderer, preview.rendererVersion, preview.placeholder ? 1 : 0, this.clock.isoNow(), id, orgId],
    )
  }

  async markAccepted(orgId: string, id: string, versionId: string): Promise<void> {
    await this.db.run("UPDATE song_experiments SET status = 'accepted', accepted_version_id = ?, updated_at = ? WHERE id = ? AND org_id = ?", [
      versionId,
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  /**
   * Rejecting an experiment changes only the experiment. The source version,
   * its asset and its analysis are untouched — which is the behaviour the
   * "rejecting leaves the source alone" test pins down.
   */
  async markRejected(orgId: string, id: string): Promise<void> {
    await this.db.run("UPDATE song_experiments SET status = 'rejected', updated_at = ? WHERE id = ? AND org_id = ?", [
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }
}

export function mapExperiment(row: Row): SongExperimentRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    sourceVersionId: toStr(row.source_version_id),
    recommendationId: toStrOrNull(row.recommendation_id),
    name: toStr(row.name),
    experimentType: toStr(row.experiment_type) as ExperimentType,
    intent: toStr(row.intent),
    editDecisionList: parseJsonColumn<ExperimentEdit[]>(row.edit_decision_list, []),
    bpmOverride: toNumOrNull(row.bpm_override),
    status: toStr(row.status) as SongExperimentStatus,
    previewAssetId: toStrOrNull(row.preview_asset_id),
    predictedDurationMs: toNumOrNull(row.predicted_duration_ms),
    renderedDurationMs: toNumOrNull(row.rendered_duration_ms),
    renderer: toStrOrNull(row.renderer),
    rendererVersion: toStrOrNull(row.renderer_version),
    placeholderPreview: toBool(row.placeholder_preview),
    acceptedVersionId: toStrOrNull(row.accepted_version_id),
    failureReason: toStrOrNull(row.failure_reason),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}
