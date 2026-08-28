import { insertRow, toBool, toNum, toNumOrNull, toStr, toStrOrNull, upsertRow, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import type {
  MixAnalysisRecord,
  MixAnalysisStatus,
  MixCurveRecord,
  MixInputKind,
  MixIssueRecord,
  MixIssueStatus,
  MixMetricRecord,
  ReferenceRightsBasis,
  StudioReferenceRecord,
} from './types.js'

/** Mix analyses, their metrics and curves, Mix Doctor issues, and reference tracks. */
export class MixAnalysisRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId?: string | null
    studioVersionId?: string | null
    referenceId?: string | null
    sourceAssetId: string
    sourceChecksum: string
    inputKind: MixInputKind
    analyzerSetVersion: string
    createdBy: string
  }): Promise<MixAnalysisRecord> {
    const now = this.clock.isoNow()
    const record: MixAnalysisRecord = {
      id: newId('stma', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId ?? null,
      studioVersionId: input.studioVersionId ?? null,
      referenceId: input.referenceId ?? null,
      sourceAssetId: input.sourceAssetId,
      sourceChecksum: input.sourceChecksum,
      inputKind: input.inputKind,
      status: 'pending',
      analyzerSetVersion: input.analyzerSetVersion,
      durationMs: null,
      sampleRate: null,
      channels: null,
      bitDepth: null,
      failureReason: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_mix_analyses', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      reference_id: record.referenceId,
      source_asset_id: record.sourceAssetId,
      source_checksum: record.sourceChecksum,
      input_kind: record.inputKind,
      status: record.status,
      analyzer_set_version: record.analyzerSetVersion,
      duration_ms: null,
      sample_rate: null,
      channels: null,
      bit_depth: null,
      failure_reason: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<MixAnalysisRecord> {
    const row = await this.db.get('SELECT * FROM studio_mix_analyses WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('mix analysis', id)
    return mapAnalysis(row)
  }

  /** The newest analysis for a version, or null when it has never been analysed. */
  async latestForVersion(orgId: string, versionId: string): Promise<MixAnalysisRecord | null> {
    const row = await this.db.get(
      "SELECT * FROM studio_mix_analyses WHERE org_id = ? AND studio_version_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1",
      [orgId, versionId],
    )
    return row ? mapAnalysis(row) : null
  }

  async latestForReference(orgId: string, referenceId: string): Promise<MixAnalysisRecord | null> {
    const row = await this.db.get("SELECT * FROM studio_mix_analyses WHERE org_id = ? AND reference_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1", [
      orgId,
      referenceId,
    ])
    return row ? mapAnalysis(row) : null
  }

  async listForProject(orgId: string, projectId: string, limit = 50): Promise<MixAnalysisRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM studio_mix_analyses WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId, projectId],
    )
    return rows.map(mapAnalysis)
  }

  async settle(
    orgId: string,
    id: string,
    patch: { status: MixAnalysisStatus; durationMs?: number | null; sampleRate?: number | null; channels?: number | null; bitDepth?: number | null; failureReason?: string | null },
  ): Promise<void> {
    await this.db.run(
      'UPDATE studio_mix_analyses SET status = ?, duration_ms = ?, sample_rate = ?, channels = ?, bit_depth = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND org_id = ?',
      [
        patch.status,
        patch.durationMs ?? null,
        patch.sampleRate ?? null,
        patch.channels ?? null,
        patch.bitDepth ?? null,
        patch.failureReason ?? null,
        this.clock.isoNow(),
        id,
        orgId,
      ],
    )
  }

  async writeMetrics(orgId: string, analysisId: string, metrics: Array<Omit<MixMetricRecord, 'analysisId' | 'orgId'>>): Promise<void> {
    for (const metric of metrics) {
      await upsertRow(
        this.db,
        'studio_mix_metrics',
        {
          analysis_id: analysisId,
          metric_key: metric.metricKey,
          org_id: orgId,
          value: metric.value,
          unit: metric.unit,
          confidence: metric.confidence,
          analysis_method: metric.analysisMethod,
          provider: metric.provider,
          note: metric.note,
        },
        ['analysis_id', 'metric_key'],
        ['value', 'unit', 'confidence', 'analysis_method', 'provider', 'note'],
      )
    }
  }

  async metrics(orgId: string, analysisId: string): Promise<MixMetricRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_mix_metrics WHERE org_id = ? AND analysis_id = ? ORDER BY metric_key ASC', [orgId, analysisId])
    return rows.map((row) => ({
      analysisId: toStr(row.analysis_id),
      metricKey: toStr(row.metric_key),
      orgId: toStr(row.org_id),
      value: toNumOrNull(row.value),
      unit: toStr(row.unit),
      confidence: toNum(row.confidence),
      analysisMethod: toStr(row.analysis_method),
      provider: toStr(row.provider),
      note: toStr(row.note),
    }))
  }

  async writeCurves(orgId: string, analysisId: string, curves: Array<{ curveKey: string; stepMs: number; points: Array<number | null> }>): Promise<void> {
    for (const curve of curves) {
      await upsertRow(
        this.db,
        'studio_mix_curves',
        { analysis_id: analysisId, curve_key: curve.curveKey, org_id: orgId, step_ms: curve.stepMs, points: toJson(curve.points) },
        ['analysis_id', 'curve_key'],
        ['step_ms', 'points'],
      )
    }
  }

  async curves(orgId: string, analysisId: string): Promise<MixCurveRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_mix_curves WHERE org_id = ? AND analysis_id = ?', [orgId, analysisId])
    return rows.map((row) => ({
      analysisId: toStr(row.analysis_id),
      curveKey: toStr(row.curve_key),
      orgId: toStr(row.org_id),
      stepMs: toNum(row.step_ms),
      points: parseJson<Array<number | null>>(row.points, []),
    }))
  }
}

export class MixIssueRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async replaceForAnalysis(
    orgId: string,
    projectId: string,
    analysisId: string,
    issues: Array<Omit<MixIssueRecord, 'id' | 'orgId' | 'studioProjectId' | 'analysisId' | 'status' | 'statusChangedBy' | 'statusChangedAt' | 'noteId' | 'createdAt'>>,
  ): Promise<MixIssueRecord[]> {
    // Findings belong to one analysis run. Re-running the doctor on the same
    // analysis replaces its findings rather than accumulating duplicates; a
    // *new* analysis gets its own rows, so a user can see what a new mix
    // changed.
    await this.db.run('DELETE FROM studio_mix_issues WHERE org_id = ? AND analysis_id = ?', [orgId, analysisId])
    const now = this.clock.isoNow()
    const written: MixIssueRecord[] = []
    for (const issue of issues) {
      const record: MixIssueRecord = {
        ...issue,
        id: newId('stmi', this.clock.now()),
        orgId,
        studioProjectId: projectId,
        analysisId,
        status: 'open',
        statusChangedBy: null,
        statusChangedAt: null,
        noteId: null,
        createdAt: now,
      }
      await insertRow(this.db, 'studio_mix_issues', {
        id: record.id,
        org_id: orgId,
        studio_project_id: projectId,
        analysis_id: analysisId,
        issue_type: record.issueType,
        severity: record.severity,
        confidence: record.confidence,
        start_ms: record.startMs,
        end_ms: record.endMs,
        headline: record.headline,
        detail: record.detail,
        why_it_matters: record.whyItMatters,
        suggested_action: record.suggestedAction,
        evidence: toJson(record.evidence),
        status: record.status,
        status_changed_by: null,
        status_changed_at: null,
        note_id: null,
        created_at: now,
      })
      written.push(record)
    }
    return written
  }

  async list(orgId: string, analysisId: string): Promise<MixIssueRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_mix_issues WHERE org_id = ? AND analysis_id = ? ORDER BY start_ms ASC', [orgId, analysisId])
    return rows.map(mapIssue)
  }

  async get(orgId: string, id: string): Promise<MixIssueRecord> {
    const row = await this.db.get('SELECT * FROM studio_mix_issues WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('mix issue', id)
    return mapIssue(row)
  }

  async setStatus(orgId: string, id: string, status: MixIssueStatus, actorUserId: string, noteId?: string | null): Promise<MixIssueRecord> {
    await this.get(orgId, id)
    await this.db.run('UPDATE studio_mix_issues SET status = ?, status_changed_by = ?, status_changed_at = ?, note_id = COALESCE(?, note_id) WHERE id = ? AND org_id = ?', [
      status,
      actorUserId,
      this.clock.isoNow(),
      noteId ?? null,
      id,
      orgId,
    ])
    return this.get(orgId, id)
  }

  async countOpen(orgId: string, analysisId: string): Promise<number> {
    const row = await this.db.get("SELECT COUNT(*) AS total FROM studio_mix_issues WHERE org_id = ? AND analysis_id = ? AND status = 'open'", [orgId, analysisId])
    return toNum(row?.total)
  }
}

export class StudioReferenceRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    label: string
    artistName: string
    title: string
    assetId?: string | null
    rightsBasis: ReferenceRightsBasis
    rightsConfirmedBy: string
    derivedOnly?: boolean
    createdBy: string
  }): Promise<StudioReferenceRecord> {
    const now = this.clock.isoNow()
    const record: StudioReferenceRecord = {
      id: newId('stref', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      label: input.label,
      artistName: input.artistName,
      title: input.title,
      assetId: input.assetId ?? null,
      rightsBasis: input.rightsBasis,
      rightsConfirmedBy: input.rightsConfirmedBy,
      rightsConfirmedAt: now,
      analysisId: null,
      // Default true: unless the user owns or has licensed the recording,
      // Street Banker keeps the measurements and not the audio.
      derivedOnly: input.derivedOnly ?? input.rightsBasis === 'authorized_private_reference',
      audioDiscardedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
    }
    await insertRow(this.db, 'studio_references', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      label: record.label,
      artist_name: record.artistName,
      title: record.title,
      asset_id: record.assetId,
      rights_basis: record.rightsBasis,
      rights_confirmed_by: record.rightsConfirmedBy,
      rights_confirmed_at: record.rightsConfirmedAt,
      analysis_id: null,
      derived_only: record.derivedOnly ? 1 : 0,
      audio_discarded_at: null,
      created_by: record.createdBy,
      created_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<StudioReferenceRecord> {
    const row = await this.db.get('SELECT * FROM studio_references WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('reference', id)
    return mapReference(row)
  }

  async list(orgId: string, projectId: string): Promise<StudioReferenceRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_references WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at ASC', [orgId, projectId])
    return rows.map(mapReference)
  }

  async countForProject(orgId: string, projectId: string): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS total FROM studio_references WHERE org_id = ? AND studio_project_id = ?', [orgId, projectId])
    return toNum(row?.total)
  }

  async setAnalysis(orgId: string, id: string, analysisId: string): Promise<void> {
    await this.db.run('UPDATE studio_references SET analysis_id = ? WHERE id = ? AND org_id = ?', [analysisId, id, orgId])
  }

  /** Records that the reference audio has been discarded, leaving measurements only. */
  async markAudioDiscarded(orgId: string, id: string): Promise<void> {
    await this.db.run('UPDATE studio_references SET asset_id = NULL, audio_discarded_at = ?, derived_only = 1 WHERE id = ? AND org_id = ?', [
      this.clock.isoNow(),
      id,
      orgId,
    ])
  }

  async delete(orgId: string, id: string): Promise<void> {
    await this.get(orgId, id)
    await this.db.run('DELETE FROM studio_references WHERE id = ? AND org_id = ?', [id, orgId])
  }
}

function mapAnalysis(row: Row): MixAnalysisRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStrOrNull(row.studio_project_id),
    studioVersionId: toStrOrNull(row.studio_version_id),
    referenceId: toStrOrNull(row.reference_id),
    sourceAssetId: toStr(row.source_asset_id),
    sourceChecksum: toStr(row.source_checksum),
    inputKind: toStr(row.input_kind) as MixInputKind,
    status: toStr(row.status) as MixAnalysisStatus,
    analyzerSetVersion: toStr(row.analyzer_set_version),
    durationMs: toNumOrNull(row.duration_ms),
    sampleRate: toNumOrNull(row.sample_rate),
    channels: toNumOrNull(row.channels),
    bitDepth: toNumOrNull(row.bit_depth),
    failureReason: toStrOrNull(row.failure_reason),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapIssue(row: Row): MixIssueRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    analysisId: toStr(row.analysis_id),
    issueType: toStr(row.issue_type),
    severity: toStr(row.severity) as 'low' | 'moderate' | 'high',
    confidence: toNum(row.confidence),
    startMs: toNum(row.start_ms),
    endMs: toNum(row.end_ms),
    headline: toStr(row.headline),
    detail: toStr(row.detail),
    whyItMatters: toStr(row.why_it_matters),
    suggestedAction: toStr(row.suggested_action),
    evidence: parseJson<Record<string, unknown>>(row.evidence, {}),
    status: toStr(row.status) as MixIssueStatus,
    statusChangedBy: toStrOrNull(row.status_changed_by),
    statusChangedAt: toStrOrNull(row.status_changed_at),
    noteId: toStrOrNull(row.note_id),
    createdAt: toStr(row.created_at),
  }
}

function mapReference(row: Row): StudioReferenceRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    label: toStr(row.label),
    artistName: toStr(row.artist_name),
    title: toStr(row.title),
    assetId: toStrOrNull(row.asset_id),
    rightsBasis: toStr(row.rights_basis) as ReferenceRightsBasis,
    rightsConfirmedBy: toStr(row.rights_confirmed_by),
    rightsConfirmedAt: toStr(row.rights_confirmed_at),
    analysisId: toStrOrNull(row.analysis_id),
    derivedOnly: toBool(row.derived_only),
    audioDiscardedAt: toStrOrNull(row.audio_discarded_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}
