import { insertRow, parseJsonColumn, toBool, toNum, toNumOrNull, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { SectionType } from '@masterclip/song-analysis'
import type { SongFeatureVector } from '@masterclip/song-feature-vectors'
import type { SongAnalysisRecord, SongAnalysisStatus, SongSectionFeatureRecord, SongSectionRecord } from './types.js'

/**
 * Analyses, sections and section features.
 *
 * An analysis row is append-only. Re-running analysis creates a new row and
 * leaves the old one intact, so a result produced by an older engine stays
 * readable and comparable rather than being silently replaced by a newer one
 * that measured differently.
 */
export class SongAnalysisRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    songLabProjectId: string
    songVersionId: string
    analysisVersion: string
    engineVersion: string
    sourceChecksum: string
    configuration: Record<string, unknown>
  }): Promise<SongAnalysisRecord> {
    const now = this.clock.isoNow()
    const id = newId('sa', this.clock.now())
    await insertRow(this.db, 'song_analyses', {
      id,
      org_id: input.orgId,
      song_lab_project_id: input.songLabProjectId,
      song_version_id: input.songVersionId,
      analysis_version: input.analysisVersion,
      engine_version: input.engineVersion,
      status: 'queued',
      duration_ms: null,
      bpm: null,
      bpm_confidence: null,
      tempo_stability: null,
      song_key: null,
      key_confidence: null,
      meter: null,
      meter_confidence: null,
      loudness: null,
      dynamic_range: null,
      peak_dbfs: null,
      stereo_width: null,
      first_vocal_ms: null,
      structure_confidence: null,
      feature_vector: JSON.stringify(null),
      energy_curve: JSON.stringify({ values: [], stepSeconds: 0 }),
      vocal_analysis: JSON.stringify({}),
      providers: JSON.stringify({}),
      configuration: JSON.stringify(input.configuration),
      source_checksum: input.sourceChecksum,
      failure_reason: null,
      created_at: now,
      completed_at: null,
    })
    return this.get(input.orgId, id)
  }

  async get(orgId: string, id: string): Promise<SongAnalysisRecord> {
    const row = await this.db.get('SELECT * FROM song_analyses WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('song analysis', id)
    return mapAnalysis(row)
  }

  async getAnyOrg(id: string): Promise<SongAnalysisRecord> {
    const row = await this.db.get('SELECT * FROM song_analyses WHERE id = ?', [id])
    if (!row) throw notFound('song analysis', id)
    return mapAnalysis(row)
  }

  /** The most recent completed analysis for a project's current version. */
  async latestForVersion(orgId: string, versionId: string): Promise<SongAnalysisRecord | null> {
    const row = await this.db.get(
      "SELECT * FROM song_analyses WHERE org_id = ? AND song_version_id = ? AND status = 'complete' ORDER BY created_at DESC LIMIT 1",
      [orgId, versionId],
    )
    return row ? mapAnalysis(row) : null
  }

  async listForProject(orgId: string, projectId: string, limit = 50): Promise<SongAnalysisRecord[]> {
    const rows = await this.db.query(
      `SELECT * FROM song_analyses WHERE org_id = ? AND song_lab_project_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`,
      [orgId, projectId],
    )
    return rows.map(mapAnalysis)
  }

  async setStatus(id: string, status: SongAnalysisStatus, failureReason: string | null = null): Promise<void> {
    await this.db.run('UPDATE song_analyses SET status = ?, failure_reason = ? WHERE id = ?', [status, failureReason, id])
  }

  async complete(
    id: string,
    values: {
      durationMs: number | null
      bpm: number | null
      bpmConfidence: number | null
      tempoStability: number | null
      key: string | null
      keyConfidence: number | null
      meter: number | null
      meterConfidence: number | null
      loudness: number | null
      dynamicRange: number | null
      peakDbfs: number | null
      stereoWidth: number | null
      firstVocalMs: number | null
      structureConfidence: number | null
      featureVector: SongFeatureVector
      energyCurve: { values: number[]; stepSeconds: number }
      vocalAnalysis: Record<string, unknown>
      providers: Record<string, { provider: string; modelVersion: string }>
    },
  ): Promise<void> {
    await this.db.run(
      `UPDATE song_analyses SET
         status = 'complete', duration_ms = ?, bpm = ?, bpm_confidence = ?, tempo_stability = ?, song_key = ?, key_confidence = ?,
         meter = ?, meter_confidence = ?, loudness = ?, dynamic_range = ?, peak_dbfs = ?, stereo_width = ?, first_vocal_ms = ?,
         structure_confidence = ?, feature_vector = ?, energy_curve = ?, vocal_analysis = ?, providers = ?, completed_at = ?
       WHERE id = ?`,
      [
        values.durationMs,
        values.bpm,
        values.bpmConfidence,
        values.tempoStability,
        values.key,
        values.keyConfidence,
        values.meter,
        values.meterConfidence,
        values.loudness,
        values.dynamicRange,
        values.peakDbfs,
        values.stereoWidth,
        values.firstVocalMs,
        values.structureConfidence,
        JSON.stringify(values.featureVector),
        JSON.stringify(values.energyCurve),
        JSON.stringify(values.vocalAnalysis),
        JSON.stringify(values.providers),
        this.clock.isoNow(),
        id,
      ],
    )
  }
}

export class SongSectionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async replaceAll(
    orgId: string,
    analysisId: string,
    sections: Array<{
      sectionType: SectionType
      label: string
      startMs: number
      endMs: number
      confidence: number
      humanConfirmed?: boolean
      isHook?: boolean
      isTitlePhrase?: boolean
      orderIndex: number
      features?: Omit<SongSectionFeatureRecord, 'id' | 'orgId' | 'songSectionId'>
    }>,
  ): Promise<SongSectionRecord[]> {
    const existing = await this.db.query('SELECT id FROM song_sections WHERE song_analysis_id = ? AND org_id = ?', [analysisId, orgId])
    for (const row of existing) {
      await this.db.run('DELETE FROM song_section_features WHERE song_section_id = ?', [toStr(row.id)])
    }
    await this.db.run('DELETE FROM song_sections WHERE song_analysis_id = ? AND org_id = ?', [analysisId, orgId])

    const now = this.clock.isoNow()
    const created: SongSectionRecord[] = []
    for (const section of sections) {
      const id = newId('ssec', this.clock.now())
      await insertRow(this.db, 'song_sections', {
        id,
        org_id: orgId,
        song_analysis_id: analysisId,
        section_type: section.sectionType,
        label: section.label,
        start_ms: Math.round(section.startMs),
        end_ms: Math.round(section.endMs),
        confidence: section.confidence,
        human_confirmed: section.humanConfirmed ? 1 : 0,
        is_hook: section.isHook ? 1 : 0,
        is_title_phrase: section.isTitlePhrase ? 1 : 0,
        order_index: section.orderIndex,
        created_at: now,
        updated_at: now,
      })
      if (section.features) {
        await insertRow(this.db, 'song_section_features', {
          id: newId('ssf', this.clock.now()),
          org_id: orgId,
          song_section_id: id,
          energy: section.features.energy,
          vocal_occupancy: section.features.vocalOccupancy,
          syllable_density: section.features.syllableDensity,
          arrangement_density: section.features.arrangementDensity,
          spectral_density: section.features.spectralDensity,
          transient_density: section.features.transientDensity,
          low_frequency_density: section.features.lowFrequencyDensity,
          stereo_width: section.features.stereoWidth,
          rhythmic_density: section.features.rhythmicDensity,
          similarity_vector: JSON.stringify(section.features.similarityVector),
          register_median: section.features.register.median,
          register_low: section.features.register.low,
          register_high: section.features.register.high,
          register_confidence: section.features.register.confidence,
          melodic_contour: JSON.stringify(section.features.melodicContour),
          created_at: now,
        })
      }
      created.push({
        id,
        orgId,
        songAnalysisId: analysisId,
        sectionType: section.sectionType,
        label: section.label,
        startMs: Math.round(section.startMs),
        endMs: Math.round(section.endMs),
        confidence: section.confidence,
        humanConfirmed: Boolean(section.humanConfirmed),
        isHook: Boolean(section.isHook),
        isTitlePhrase: Boolean(section.isTitlePhrase),
        orderIndex: section.orderIndex,
        createdAt: now,
        updatedAt: now,
      })
    }
    return created
  }

  async list(orgId: string, analysisId: string): Promise<SongSectionRecord[]> {
    const rows = await this.db.query('SELECT * FROM song_sections WHERE org_id = ? AND song_analysis_id = ? ORDER BY order_index ASC', [
      orgId,
      analysisId,
    ])
    return rows.map(mapSection)
  }

  async features(orgId: string, analysisId: string): Promise<Map<string, SongSectionFeatureRecord>> {
    const rows = await this.db.query(
      `SELECT f.* FROM song_section_features f
       JOIN song_sections s ON s.id = f.song_section_id
       WHERE f.org_id = ? AND s.song_analysis_id = ?`,
      [orgId, analysisId],
    )
    const map = new Map<string, SongSectionFeatureRecord>()
    for (const row of rows) {
      const record = mapSectionFeature(row)
      map.set(record.songSectionId, record)
    }
    return map
  }

  /**
   * Applies a user's structure correction. Anything the user touches is stamped
   * human_confirmed, which is what reanalysis reads to know it must not
   * overwrite this boundary.
   */
  async applyCorrections(
    orgId: string,
    analysisId: string,
    corrections: Array<{
      id?: string
      sectionType?: SectionType
      label?: string
      startMs?: number
      endMs?: number
      isHook?: boolean
      isTitlePhrase?: boolean
      deleted?: boolean
    }>,
  ): Promise<SongSectionRecord[]> {
    const now = this.clock.isoNow()
    for (const correction of corrections) {
      if (!correction.id) continue
      const row = await this.db.get('SELECT * FROM song_sections WHERE id = ? AND org_id = ? AND song_analysis_id = ?', [
        correction.id,
        orgId,
        analysisId,
      ])
      if (!row) throw notFound('song section', correction.id)
      if (correction.deleted) {
        await this.db.run('DELETE FROM song_section_features WHERE song_section_id = ?', [correction.id])
        await this.db.run('DELETE FROM song_sections WHERE id = ? AND org_id = ?', [correction.id, orgId])
        continue
      }
      const current = mapSection(row)
      await this.db.run(
        `UPDATE song_sections SET section_type = ?, label = ?, start_ms = ?, end_ms = ?, is_hook = ?, is_title_phrase = ?,
           human_confirmed = 1, confidence = 1, updated_at = ? WHERE id = ? AND org_id = ?`,
        [
          correction.sectionType ?? current.sectionType,
          correction.label ?? current.label,
          Math.round(correction.startMs ?? current.startMs),
          Math.round(correction.endMs ?? current.endMs),
          (correction.isHook ?? current.isHook) ? 1 : 0,
          (correction.isTitlePhrase ?? current.isTitlePhrase) ? 1 : 0,
          now,
          correction.id,
          orgId,
        ],
      )
    }
    await this.reindex(orgId, analysisId)
    return this.list(orgId, analysisId)
  }

  async addSection(
    orgId: string,
    analysisId: string,
    section: { sectionType: SectionType; label: string; startMs: number; endMs: number },
  ): Promise<SongSectionRecord[]> {
    const now = this.clock.isoNow()
    await insertRow(this.db, 'song_sections', {
      id: newId('ssec', this.clock.now()),
      org_id: orgId,
      song_analysis_id: analysisId,
      section_type: section.sectionType,
      label: section.label,
      start_ms: Math.round(section.startMs),
      end_ms: Math.round(section.endMs),
      confidence: 1,
      human_confirmed: 1,
      is_hook: 0,
      is_title_phrase: 0,
      order_index: 0,
      created_at: now,
      updated_at: now,
    })
    await this.reindex(orgId, analysisId)
    return this.list(orgId, analysisId)
  }

  /** Renumbers order_index by start time after any structural edit. */
  private async reindex(orgId: string, analysisId: string): Promise<void> {
    const rows = await this.db.query('SELECT id FROM song_sections WHERE org_id = ? AND song_analysis_id = ? ORDER BY start_ms ASC', [
      orgId,
      analysisId,
    ])
    for (const [index, row] of rows.entries()) {
      await this.db.run('UPDATE song_sections SET order_index = ? WHERE id = ?', [index, toStr(row.id)])
    }
  }

  /** Sections a user has confirmed, carried forward across reanalysis. */
  async confirmedSections(orgId: string, analysisId: string): Promise<SongSectionRecord[]> {
    const rows = await this.db.query(
      'SELECT * FROM song_sections WHERE org_id = ? AND song_analysis_id = ? AND human_confirmed = 1 ORDER BY start_ms ASC',
      [orgId, analysisId],
    )
    return rows.map(mapSection)
  }
}

export function mapAnalysis(row: Row): SongAnalysisRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songLabProjectId: toStr(row.song_lab_project_id),
    songVersionId: toStr(row.song_version_id),
    analysisVersion: toStr(row.analysis_version),
    engineVersion: toStr(row.engine_version),
    status: toStr(row.status) as SongAnalysisStatus,
    durationMs: toNumOrNull(row.duration_ms),
    bpm: toNumOrNull(row.bpm),
    bpmConfidence: toNumOrNull(row.bpm_confidence),
    tempoStability: toNumOrNull(row.tempo_stability),
    key: toStrOrNull(row.song_key),
    keyConfidence: toNumOrNull(row.key_confidence),
    meter: toNumOrNull(row.meter),
    meterConfidence: toNumOrNull(row.meter_confidence),
    loudness: toNumOrNull(row.loudness),
    dynamicRange: toNumOrNull(row.dynamic_range),
    peakDbfs: toNumOrNull(row.peak_dbfs),
    stereoWidth: toNumOrNull(row.stereo_width),
    firstVocalMs: toNumOrNull(row.first_vocal_ms),
    structureConfidence: toNumOrNull(row.structure_confidence),
    featureVector: parseJsonColumn<SongFeatureVector | null>(row.feature_vector, null),
    energyCurve: parseJsonColumn<{ values: number[]; stepSeconds: number }>(row.energy_curve, { values: [], stepSeconds: 0 }),
    vocalAnalysis: parseJsonColumn<Record<string, unknown>>(row.vocal_analysis, {}),
    providers: parseJsonColumn<Record<string, { provider: string; modelVersion: string }>>(row.providers, {}),
    configuration: parseJsonColumn<Record<string, unknown>>(row.configuration, {}),
    sourceChecksum: toStr(row.source_checksum),
    failureReason: toStrOrNull(row.failure_reason),
    createdAt: toStr(row.created_at),
    completedAt: toStrOrNull(row.completed_at),
  }
}

export function mapSection(row: Row): SongSectionRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songAnalysisId: toStr(row.song_analysis_id),
    sectionType: toStr(row.section_type) as SectionType,
    label: toStr(row.label),
    startMs: toNum(row.start_ms),
    endMs: toNum(row.end_ms),
    confidence: toNum(row.confidence),
    humanConfirmed: toBool(row.human_confirmed),
    isHook: toBool(row.is_hook),
    isTitlePhrase: toBool(row.is_title_phrase),
    orderIndex: toNum(row.order_index),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

export function mapSectionFeature(row: Row): SongSectionFeatureRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    songSectionId: toStr(row.song_section_id),
    energy: toNum(row.energy),
    vocalOccupancy: toNumOrNull(row.vocal_occupancy),
    syllableDensity: toNumOrNull(row.syllable_density),
    arrangementDensity: toNum(row.arrangement_density),
    spectralDensity: toNum(row.spectral_density),
    transientDensity: toNum(row.transient_density),
    lowFrequencyDensity: toNum(row.low_frequency_density),
    stereoWidth: toNumOrNull(row.stereo_width),
    rhythmicDensity: toNum(row.rhythmic_density),
    similarityVector: parseJsonColumn<number[]>(row.similarity_vector, []),
    // Rows written before migration 0006 have no register columns at all. They
    // read as unmeasured rather than as zero, which is what they are.
    register: {
      median: toNumOrNull(row.register_median),
      low: toNumOrNull(row.register_low),
      high: toNumOrNull(row.register_high),
      confidence: toNumOrNull(row.register_confidence) ?? 0,
    },
    melodicContour: parseJsonColumn<number[]>(row.melodic_contour, []),
  }
}
