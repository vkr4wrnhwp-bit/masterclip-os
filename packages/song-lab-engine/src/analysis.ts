import { AppError } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import {
  DecodeUnavailableError,
  HOOK_SECTION_TYPES,
  type AudioSource,
  type DetectedSection,
  type MusicFeatureResult,
  type SectionFeatures,
  type StructureAnalysisResult,
  type VocalAnalysisResult,
} from '@masterclip/song-analysis'
import {
  chorusEnergyLift,
  dynamicContrast,
  repeatedSectionContrasts,
  sectionContrasts,
  structuralMetrics,
  type StructuralMetrics,
} from '@masterclip/song-structure'
import {
  FEATURE_VECTOR_VERSION,
  measured,
  unknown,
  type Measured,
  type SongFeatureVector,
} from '@masterclip/song-feature-vectors'
import type { SongAnalysisRecord, SongSectionRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'

/**
 * The analysis pipeline.
 *
 * Runs the stages in dependency order and assembles one feature vector from
 * them. Two properties are load-bearing:
 *
 *   - Every metric in the vector carries its own provider, method and
 *     confidence. A stage that fails contributes explicit unknowns rather than
 *     failing the whole run, so a mono file still gets a structure analysis and
 *     a track with no detectable pulse still gets an energy curve.
 *   - Human-confirmed sections from a previous run are carried forward. A user
 *     who fixed a boundary does not have to fix it again after reanalysis.
 */

export const SONG_LAB_ANALYSIS_STAGES = {
  engineVersion: '1.0.0',
  stages: ['audio.analyze', 'structure.detect', 'vocal.analyze', 'features.build'] as const,
}

export interface AnalysisOutcome {
  analysis: SongAnalysisRecord
  sections: SongSectionRecord[]
  metrics: StructuralMetrics
}

export class SongAnalysisService {
  constructor(private readonly deps: SongLabDeps) {}

  /**
   * Runs a queued analysis to completion.
   *
   * Called by the worker with only an analysis id. The org is read from the
   * row and then proved against the job's claimed org by the caller.
   */
  async run(analysisId: string, expectedOrgId: string): Promise<AnalysisOutcome> {
    const analysis = await this.deps.repos.analyses.getAnyOrg(analysisId)
    if (analysis.orgId !== expectedOrgId) {
      throw new AppError({ kind: 'forbidden', code: 'song_lab.cross_tenant_job', message: 'analysis belongs to another organization' })
    }
    if (analysis.status === 'complete') return this.load(analysis)

    await this.deps.repos.analyses.setStatus(analysis.id, 'running')
    try {
      const outcome = await this.execute(analysis)
      await this.deps.repos.projects.setStatus(analysis.orgId, analysis.songLabProjectId, 'analyzed')
      return outcome
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.deps.repos.analyses.setStatus(analysis.id, 'failed', message)
      await this.deps.repos.projects.setStatus(analysis.orgId, analysis.songLabProjectId, 'failed')
      this.deps.logger.error('song_lab.analysis_failed', { analysis_id: analysis.id, err: message })
      throw err
    }
  }

  private async execute(analysis: SongAnalysisRecord): Promise<AnalysisOutcome> {
    const version = await this.deps.repos.versions.get(analysis.orgId, analysis.songVersionId)
    if (!version.sourceAssetId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'this version has no audio to analyse' })
    }
    const asset = await this.deps.platform.audioAssetRepo.get(analysis.orgId, version.sourceAssetId)

    const source: AudioSource = {
      asset: {
        id: asset.id,
        orgId: asset.orgId,
        storageKey: asset.storageKey,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
        checksum: asset.checksum,
        fileSize: asset.fileSize,
        durationMs: asset.durationMs,
      },
      read: async () => this.deps.storage.getBuffer(asset.storageKey),
    }

    const features = await this.runFeatures(source)
    const structure = await this.runStructure(source)
    const vocals = await this.runVocals(source)

    // Two things outrank a fresh detection, in this order.
    //
    // 1. Sections carried across an accepted edit. The edit list knows exactly
    //    where every section moved, so "Chorus 1" stays "Chorus 1" at its new
    //    time rather than being re-detected as something else — which is what
    //    makes a version comparison read as "first chorus 0:56 → 0:42" instead
    //    of comparing two different sections.
    // 2. Boundaries a person fixed, which survive any reanalysis, including
    //    one by a better detector.
    const carried = readCarriedSections(analysis.configuration)
    const previous = analysis.songVersionId
      ? await this.deps.repos.analyses.latestForVersion(analysis.orgId, analysis.songVersionId)
      : null
    const confirmed = previous ? await this.deps.repos.sections.confirmedSections(analysis.orgId, previous.id) : []

    const authoritative: CarriedSection[] = carried.length > 0 ? carried : confirmed.map(toCarried)
    const sections = authoritative.length > 0 ? this.mergeAuthoritative(structure, authoritative) : structure

    const stored = await this.deps.repos.sections.replaceAll(
      analysis.orgId,
      analysis.id,
      sections.sections.map((section, index) => ({
        sectionType: section.sectionType,
        label: section.label,
        startMs: section.startMs,
        endMs: section.endMs,
        confidence: section.confidence,
        // A carried section is the artist's structure moved by their own edit,
        // not a machine guess — it is confirmed in the same sense a manual
        // correction is.
        humanConfirmed: authoritative.some((entry) => entry.startMs === section.startMs && entry.label === section.label),
        isHook: HOOK_SECTION_TYPES.includes(section.sectionType),
        isTitlePhrase: false,
        orderIndex: index,
        features: toFeatureRecord(sections.features[index]),
      })),
    )

    const metrics = structuralMetrics({
      sections: sections.sections,
      features: sections.features,
      durationMs: features.durationMs,
      firstVocalSeconds: vocals.firstVocalSeconds.value,
      vocalOccupancy: vocals.occupancy.value === null ? null : vocals.occupancy.value * 100,
    })

    const vector = buildFeatureVector({
      features,
      vocals,
      structure: sections,
      metrics,
      sourceChecksum: asset.checksum,
      analyzedAt: this.deps.clock.isoNow(),
      configuration: analysis.configuration,
    })

    await this.deps.repos.analyses.complete(analysis.id, {
      durationMs: features.durationMs,
      bpm: features.bpm.value,
      bpmConfidence: features.bpm.confidence,
      tempoStability: features.tempoStability.value,
      key: features.key.value,
      keyConfidence: features.key.confidence,
      meter: features.meter.value,
      meterConfidence: features.meter.confidence,
      loudness: features.loudness.value,
      dynamicRange: features.dynamicRange.value,
      peakDbfs: features.peakDbfs.value,
      stereoWidth: features.stereoWidth.value,
      firstVocalMs: vocals.firstVocalSeconds.value === null ? null : Math.round(vocals.firstVocalSeconds.value * 1000),
      structureConfidence: sections.confidence,
      featureVector: vector,
      energyCurve: { values: features.energyCurve, stepSeconds: features.energyCurveStepSeconds },
      vocalAnalysis: {
        occupancy: vocals.occupancy,
        phrases: vocals.phrases,
        activity: vocals.activity,
        activityStepSeconds: vocals.activityStepSeconds,
        register: vocals.register,
        averagePhraseSeconds: vocals.averagePhraseSeconds,
        longestPhraseSeconds: vocals.longestPhraseSeconds,
        restRatio: vocals.restRatio,
        heldNoteSeconds: vocals.heldNoteSeconds,
      },
      providers: {
        features: { provider: features.provider, modelVersion: features.modelVersion },
        structure: { provider: sections.provider, modelVersion: sections.modelVersion },
        vocals: { provider: vocals.provider, modelVersion: vocals.modelVersion },
      },
    })

    // Benchmarking follows analysis automatically when the project already has
    // a cohort selected; otherwise it waits for the user to choose one.
    const project = await this.deps.repos.projects.get(analysis.orgId, analysis.songLabProjectId)
    if (project.selectedBenchmarkCohortId) {
      await this.deps.queue.enqueue({
        queue: QUEUES.songLab,
        type: JOB_TYPES.songLabCompareBenchmark,
        payload: { analysisId: analysis.id, orgId: analysis.orgId, cohortId: project.selectedBenchmarkCohortId },
        dedupeKey: `song_lab.benchmark:${analysis.id}:${project.selectedBenchmarkCohortId}`,
      })
    }

    return { analysis: await this.deps.repos.analyses.get(analysis.orgId, analysis.id), sections: stored, metrics }
  }

  /**
   * Feature extraction, with a documented fallback.
   *
   * If the audio cannot be decoded on this deployment — no ffmpeg for a
   * compressed upload — the deterministic provider takes over so the artist
   * still reaches a working product, and the substitution is recorded in the
   * provider provenance rather than hidden.
   */
  private async runFeatures(source: AudioSource): Promise<MusicFeatureResult> {
    try {
      return await this.deps.providers.features.analyzeMusicFeatures(source)
    } catch (err) {
      if (err instanceof DecodeUnavailableError) {
        this.deps.logger.warn('song_lab.decode_unavailable', { asset_id: source.asset.id, reason: err.reason })
        const { MockMusicFeatureProvider } = await import('@masterclip/song-analysis')
        return new MockMusicFeatureProvider().analyzeMusicFeatures(source)
      }
      throw err
    }
  }

  private async runStructure(source: AudioSource): Promise<StructureAnalysisResult> {
    try {
      return await this.deps.providers.structure.analyzeStructure(source)
    } catch (err) {
      if (err instanceof DecodeUnavailableError) {
        const { MockStructureProvider } = await import('@masterclip/song-structure')
        return new MockStructureProvider().analyzeStructure(source)
      }
      throw err
    }
  }

  private async runVocals(source: AudioSource): Promise<VocalAnalysisResult> {
    try {
      return await this.deps.providers.vocals.analyzeVocals(source)
    } catch (err) {
      if (err instanceof DecodeUnavailableError) {
        const { MockVocalAnalysisProvider } = await import('@masterclip/song-analysis')
        return new MockVocalAnalysisProvider().analyzeVocals(source)
      }
      throw err
    }
  }

  /**
   * Overlays authoritative sections onto a fresh detection.
   *
   * Authoritative boundaries win outright; detected sections that overlap one
   * are dropped, and detected sections in the gaps are kept. That way a user
   * who corrected two boundaries still benefits from a better detector
   * everywhere else.
   */
  private mergeAuthoritative(detected: StructureAnalysisResult, confirmed: CarriedSection[]): StructureAnalysisResult {
    const kept: Array<{ section: DetectedSection; features: SectionFeatures | undefined }> = []

    for (const [index, section] of detected.sections.entries()) {
      const overlaps = confirmed.some((entry) => section.startMs < entry.endMs && section.endMs > entry.startMs)
      if (!overlaps) kept.push({ section, features: detected.features[index] })
    }
    for (const entry of confirmed) {
      // A confirmed section inherits the nearest detected section's measured
      // features: the boundaries are the user's, the measurements are ours.
      const nearest = detected.sections.reduce<{ index: number; distance: number }>(
        (best, candidate, index) => {
          const distance = Math.abs(candidate.startMs - entry.startMs)
          return distance < best.distance ? { index, distance } : best
        },
        { index: 0, distance: Infinity },
      )
      kept.push({
        section: {
          sectionType: entry.sectionType,
          label: entry.label,
          startMs: entry.startMs,
          endMs: entry.endMs,
          confidence: 1,
          orderIndex: 0,
        },
        features: detected.features[nearest.index],
      })
    }

    kept.sort((a, b) => a.section.startMs - b.section.startMs)
    return {
      ...detected,
      sections: kept.map((entry, index) => ({ ...entry.section, orderIndex: index })),
      features: kept.map((entry) => entry.features ?? emptyFeatures()),
      method: `${detected.method}+authoritative_sections`,
    }
  }

  private async load(analysis: SongAnalysisRecord): Promise<AnalysisOutcome> {
    const sections = await this.deps.repos.sections.list(analysis.orgId, analysis.id)
    const featureMap = await this.deps.repos.sections.features(analysis.orgId, analysis.id)
    const metrics = structuralMetrics({
      sections: sections.map(toDetected),
      features: sections.map((section) => toSectionFeatures(featureMap.get(section.id))),
      durationMs: analysis.durationMs ?? 0,
      firstVocalSeconds: analysis.firstVocalMs === null ? null : analysis.firstVocalMs / 1000,
    })
    return { analysis, sections, metrics }
  }

  /** Recomputes metrics after a structure correction, without re-reading audio. */
  async recomputeAfterCorrection(actor: Actor, analysisId: string): Promise<AnalysisOutcome> {
    const analysis = await this.deps.repos.analyses.get(actor.orgId, analysisId)
    const sections = await this.deps.repos.sections.list(actor.orgId, analysisId)
    const featureMap = await this.deps.repos.sections.features(actor.orgId, analysisId)
    const detected = sections.map(toDetected)
    const features = sections.map((section) => toSectionFeatures(featureMap.get(section.id)))

    const metrics = structuralMetrics({
      sections: detected,
      features,
      durationMs: analysis.durationMs ?? 0,
      firstVocalSeconds: analysis.firstVocalMs === null ? null : analysis.firstVocalMs / 1000,
      vocalOccupancy: readMeasured(analysis.vocalAnalysis.occupancy),
    })

    // The vector is rebuilt from the corrected structure, so every benchmark
    // and observation downstream reflects what the user said the song is.
    const existing = analysis.featureVector
    if (existing) {
      const rebuilt = applyStructuralMetrics(existing, metrics, detected, features)
      await this.deps.db.run('UPDATE song_analyses SET feature_vector = ?, structure_confidence = ? WHERE id = ? AND org_id = ?', [
        JSON.stringify(rebuilt),
        1,
        analysisId,
        actor.orgId,
      ])
    }

    return { analysis: await this.deps.repos.analyses.get(actor.orgId, analysisId), sections, metrics }
  }
}

// --------------------------------------------------------------- helpers ----

/** A section whose identity and position are known, not detected. */
export interface CarriedSection {
  sectionType: DetectedSection['sectionType']
  label: string
  startMs: number
  endMs: number
}

function toCarried(section: SongSectionRecord): CarriedSection {
  return { sectionType: section.sectionType, label: section.label, startMs: section.startMs, endMs: section.endMs }
}

/** Sections stashed on an analysis's configuration when an edit was accepted. */
function readCarriedSections(configuration: Record<string, unknown>): CarriedSection[] {
  const raw = configuration.carriedSections
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is CarriedSection =>
      Boolean(entry) &&
      typeof (entry as CarriedSection).label === 'string' &&
      Number.isFinite((entry as CarriedSection).startMs) &&
      Number.isFinite((entry as CarriedSection).endMs),
  )
}

export function toDetected(section: SongSectionRecord): DetectedSection {
  return {
    sectionType: section.sectionType,
    label: section.label,
    startMs: section.startMs,
    endMs: section.endMs,
    confidence: section.confidence,
    orderIndex: section.orderIndex,
  }
}

export function toSectionFeatures(record: { energy: number; vocalOccupancy: number | null; arrangementDensity: number; spectralDensity: number; transientDensity: number; lowFrequencyDensity: number; stereoWidth: number | null; rhythmicDensity: number; similarityVector: number[] } | undefined): SectionFeatures {
  if (!record) return emptyFeatures()
  return {
    energy: record.energy,
    vocalOccupancy: record.vocalOccupancy,
    arrangementDensity: record.arrangementDensity,
    spectralDensity: record.spectralDensity,
    transientDensity: record.transientDensity,
    lowFrequencyDensity: record.lowFrequencyDensity,
    stereoWidth: record.stereoWidth,
    rhythmicDensity: record.rhythmicDensity,
    similarityVector: record.similarityVector,
  }
}

function emptyFeatures(): SectionFeatures {
  return {
    energy: 0,
    vocalOccupancy: null,
    arrangementDensity: 0,
    spectralDensity: 0,
    transientDensity: 0,
    lowFrequencyDensity: 0,
    stereoWidth: null,
    rhythmicDensity: 0,
    similarityVector: [],
  }
}

function toFeatureRecord(features: SectionFeatures | undefined) {
  const value = features ?? emptyFeatures()
  return {
    energy: value.energy,
    vocalOccupancy: value.vocalOccupancy,
    syllableDensity: null,
    arrangementDensity: value.arrangementDensity,
    spectralDensity: value.spectralDensity,
    transientDensity: value.transientDensity,
    lowFrequencyDensity: value.lowFrequencyDensity,
    stereoWidth: value.stereoWidth,
    rhythmicDensity: value.rhythmicDensity,
    similarityVector: value.similarityVector,
  }
}

function readMeasured(value: unknown): number | null {
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value: unknown }).value
    return typeof inner === 'number' ? inner * 100 : null
  }
  return null
}

/**
 * Assembles the feature vector.
 *
 * Structural metrics are *derived* rather than measured, so they inherit the
 * structure detector's confidence — a percentile computed against a guessed
 * chorus boundary should not present itself as firm.
 */
export function buildFeatureVector(input: {
  features: MusicFeatureResult
  vocals: VocalAnalysisResult
  structure: StructureAnalysisResult
  metrics: StructuralMetrics
  sourceChecksum: string
  analyzedAt: string
  configuration: Record<string, unknown>
}): SongFeatureVector {
  const { features, vocals, structure, metrics } = input
  const structureSource = { provider: structure.provider, modelVersion: structure.modelVersion }
  const structureConfidence = structure.confidence

  const vector: SongFeatureVector = {
    provenance: {
      engineVersion: SONG_LAB_ANALYSIS_STAGES.engineVersion,
      featureVectorVersion: FEATURE_VECTOR_VERSION,
      providers: {
        features: { provider: features.provider, modelVersion: features.modelVersion },
        structure: structureSource,
        vocals: { provider: vocals.provider, modelVersion: vocals.modelVersion },
      },
      sourceChecksum: input.sourceChecksum,
      analyzedAt: input.analyzedAt,
      configuration: input.configuration,
    },
    metrics: {},
  }

  const set = (key: string, entry: Measured<number>) => {
    vector.metrics[key] = entry
  }
  const structural = (key: string, value: number | null, method: string, note: string) => {
    set(key, value === null ? unknown<number>(method, structureSource, note) : measured(value, structureConfidence, method, structureSource))
  }

  set('duration_seconds', measured(features.durationMs / 1000, 1, 'container_duration', { provider: features.provider, modelVersion: features.modelVersion }))
  set('bpm', features.bpm)
  set('tempo_stability', features.tempoStability)
  set('loudness_lufs', features.loudness)
  set('dynamic_range_db', features.dynamicRange)
  set('stereo_width', features.stereoWidth)
  set('spectral_density', features.spectralDensity)
  set('transient_density', features.transientDensity)
  set('low_frequency_density', features.lowFrequencyDensity)

  set('vocal_occupancy', scale(vocals.occupancy, 100))
  set('average_phrase_seconds', vocals.averagePhraseSeconds)
  set('longest_phrase_seconds', vocals.longestPhraseSeconds)
  set('rest_ratio', scale(vocals.restRatio, 100))
  set(
    'first_vocal_seconds',
    vocals.firstVocalSeconds,
  )

  structural('intro_seconds', metrics.introSeconds, 'section_boundaries', 'no intro section was identified')
  structural('first_hook_seconds', metrics.firstHookSeconds, 'section_boundaries', 'no hook section was identified')
  structural('first_chorus_seconds', metrics.firstChorusSeconds, 'section_boundaries', 'no chorus section was identified')
  structural('first_verse_seconds', metrics.firstVerseSeconds, 'section_boundaries', 'no verse section was identified')
  structural('second_verse_seconds', metrics.secondVerseSeconds, 'section_boundaries', 'this song has fewer than two verses')
  structural('chorus_seconds', metrics.chorusSeconds, 'section_boundaries', 'no chorus section was identified')
  structural('bridge_position_ratio', metrics.bridgePositionRatio, 'section_boundaries', 'no bridge section was identified')
  structural('outro_seconds', metrics.outroSeconds, 'section_boundaries', 'no closing section was identified')
  structural('runtime_before_first_repeat', metrics.runtimeBeforeFirstRepeat, 'section_order', 'no section type recurs in this song')
  structural('runtime_after_final_hook', metrics.runtimeAfterFinalHook, 'section_boundaries', 'no hook section was identified')

  set('section_count', measured(metrics.sectionCount, structureConfidence, 'section_boundaries', structureSource))
  set('unique_section_count', measured(metrics.uniqueSectionCount, structureConfidence, 'section_boundaries', structureSource))
  set('chorus_count', measured(metrics.chorusCount, structureConfidence, 'section_boundaries', structureSource))
  set('verse_count', measured(metrics.verseCount, structureConfidence, 'section_boundaries', structureSource))
  set('average_section_seconds', measured(metrics.averageSectionSeconds, structureConfidence, 'section_boundaries', structureSource))
  set('section_length_variance', measured(metrics.sectionLengthVariance, structureConfidence, 'section_boundaries', structureSource))
  set('repetition_frequency', measured(metrics.repetitionFrequency, structureConfidence, 'section_order', structureSource))
  set('structural_symmetry', measured(metrics.structuralSymmetry, structureConfidence, 'section_length_mirror', structureSource))
  set('chorus_share', measured(metrics.chorusShare, structureConfidence, 'section_boundaries', structureSource))
  set('hook_repetition', measured(metrics.hookRepetition, structureConfidence, 'section_boundaries', structureSource))

  applyEnergyMetrics(vector, structure, structureSource, structureConfidence)
  return vector
}

function applyEnergyMetrics(
  vector: SongFeatureVector,
  structure: StructureAnalysisResult,
  source: { provider: string; modelVersion: string },
  confidence: number,
): void {
  const features = structure.features
  if (features.length === 0) return

  const energies = features.map((entry) => entry.energy)
  const peakIndex = energies.indexOf(Math.max(...energies))
  const total = structure.sections[structure.sections.length - 1]?.endMs ?? 0
  const peakStart = structure.sections[peakIndex]?.startMs ?? 0

  vector.metrics.peak_energy_position =
    total > 0
      ? measured(Math.round((peakStart / total) * 1000) / 1000, confidence, 'section_energy_peak', source)
      : unknown<number>('section_energy_peak', source, 'the recording has no measurable duration')
  vector.metrics.energy_range = measured(
    Math.round((Math.max(...energies) - Math.min(...energies)) * 1000) / 1000,
    confidence,
    'section_energy_range',
    source,
  )
  vector.metrics.dynamic_contrast = measured(dynamicContrast(features), confidence, 'mean_section_energy_delta', source)
  vector.metrics.arrangement_density = measured(
    Math.round((features.reduce((sum, entry) => sum + entry.arrangementDensity, 0) / features.length) * 1000) / 1000,
    confidence,
    'mean_section_arrangement_density',
    source,
  )

  const lift = chorusEnergyLift(structure.sections, features)
  vector.metrics.chorus_energy_lift =
    lift === null
      ? unknown<number>('verse_chorus_energy_delta', source, 'this song has no identified verse/chorus pair to compare')
      : measured(lift, confidence, 'verse_chorus_energy_delta', source)

  // Chorus-to-chorus similarity: measured directly from the audio's own
  // features, so it stands on firmer ground than the cohort-relative metrics.
  const repeats = repeatedSectionContrasts(structure.sections, features).filter(
    (entry) => entry.fromLabel.toLowerCase().includes('chorus') && entry.toLabel.toLowerCase().includes('chorus'),
  )
  if (repeats.length > 0) {
    const mean = repeats.reduce((sum, entry) => sum + entry.similarity, 0) / repeats.length
    vector.metrics.chorus_similarity = measured(Math.round(mean * 100), Math.max(confidence, 0.6), 'section_similarity_cosine', source)
    const last = repeats[repeats.length - 1]!
    vector.metrics.final_chorus_contrast = measured(
      Math.round((1 - last.similarity) * 1000) / 1000,
      Math.max(confidence, 0.6),
      'final_vs_previous_chorus_similarity',
      source,
    )
  }

  const consecutive = sectionContrasts(structure.sections, features)
  if (consecutive.length > 0) {
    const vocalDeltas = consecutive.map((entry) => entry.vocalDelta).filter((value): value is number => value !== null)
    if (vocalDeltas.length > 0) {
      vector.metrics.vocal_density_contrast = measured(
        Math.round((vocalDeltas.reduce((sum, value) => sum + Math.abs(value), 0) / vocalDeltas.length) * 1000) / 1000,
        confidence,
        'mean_section_vocal_delta',
        source,
      )
    }
  }

  const verseOccupancy = sectionOccupancy(structure, features, ['verse'])
  const chorusOccupancy = sectionOccupancy(structure, features, ['chorus', 'final_chorus'])
  if (verseOccupancy !== null) {
    vector.metrics.verse_vocal_occupancy = measured(Math.round(verseOccupancy * 100), confidence, 'section_vocal_occupancy', source)
  }
  if (chorusOccupancy !== null) {
    vector.metrics.chorus_vocal_occupancy = measured(Math.round(chorusOccupancy * 100), confidence, 'section_vocal_occupancy', source)
  }
}

function sectionOccupancy(structure: StructureAnalysisResult, features: SectionFeatures[], types: string[]): number | null {
  const values: number[] = []
  for (const section of structure.sections) {
    if (!types.includes(section.sectionType)) continue
    const occupancy = features[section.orderIndex]?.vocalOccupancy
    if (occupancy !== null && occupancy !== undefined) values.push(occupancy)
  }
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function scale(entry: Measured<number>, factor: number): Measured<number> {
  if (entry.value === null) return entry
  return { ...entry, value: Math.round(entry.value * factor * 100) / 100 }
}

/** Rewrites the structural half of a vector after a manual correction. */
export function applyStructuralMetrics(
  vector: SongFeatureVector,
  metrics: StructuralMetrics,
  sections: DetectedSection[],
  features: SectionFeatures[],
): SongFeatureVector {
  const source = vector.provenance.providers.structure ?? { provider: 'human', modelVersion: 'manual' }
  const rebuilt: SongFeatureVector = { ...vector, metrics: { ...vector.metrics } }
  const humanSource = { provider: 'human-confirmed', modelVersion: source.modelVersion }

  const structural = (key: string, value: number | null, method: string, note: string) => {
    rebuilt.metrics[key] = value === null ? unknown<number>(method, humanSource, note) : measured(value, 1, method, humanSource)
  }

  structural('intro_seconds', metrics.introSeconds, 'confirmed_section_boundaries', 'no intro section is marked')
  structural('first_hook_seconds', metrics.firstHookSeconds, 'confirmed_section_boundaries', 'no hook section is marked')
  structural('first_chorus_seconds', metrics.firstChorusSeconds, 'confirmed_section_boundaries', 'no chorus section is marked')
  structural('first_verse_seconds', metrics.firstVerseSeconds, 'confirmed_section_boundaries', 'no verse section is marked')
  structural('second_verse_seconds', metrics.secondVerseSeconds, 'confirmed_section_boundaries', 'this song has fewer than two verses')
  structural('chorus_seconds', metrics.chorusSeconds, 'confirmed_section_boundaries', 'no chorus section is marked')
  structural('bridge_position_ratio', metrics.bridgePositionRatio, 'confirmed_section_boundaries', 'no bridge section is marked')
  structural('outro_seconds', metrics.outroSeconds, 'confirmed_section_boundaries', 'no closing section is marked')
  structural('runtime_before_first_repeat', metrics.runtimeBeforeFirstRepeat, 'confirmed_section_order', 'no section type recurs')
  structural('runtime_after_final_hook', metrics.runtimeAfterFinalHook, 'confirmed_section_boundaries', 'no hook section is marked')

  rebuilt.metrics.section_count = measured(metrics.sectionCount, 1, 'confirmed_section_boundaries', humanSource)
  rebuilt.metrics.unique_section_count = measured(metrics.uniqueSectionCount, 1, 'confirmed_section_boundaries', humanSource)
  rebuilt.metrics.chorus_count = measured(metrics.chorusCount, 1, 'confirmed_section_boundaries', humanSource)
  rebuilt.metrics.verse_count = measured(metrics.verseCount, 1, 'confirmed_section_boundaries', humanSource)
  rebuilt.metrics.average_section_seconds = measured(metrics.averageSectionSeconds, 1, 'confirmed_section_boundaries', humanSource)
  rebuilt.metrics.section_length_variance = measured(metrics.sectionLengthVariance, 1, 'confirmed_section_boundaries', humanSource)
  rebuilt.metrics.repetition_frequency = measured(metrics.repetitionFrequency, 1, 'confirmed_section_order', humanSource)
  rebuilt.metrics.structural_symmetry = measured(metrics.structuralSymmetry, 1, 'confirmed_section_length_mirror', humanSource)
  rebuilt.metrics.chorus_share = measured(metrics.chorusShare, 1, 'confirmed_section_boundaries', humanSource)
  rebuilt.metrics.hook_repetition = measured(metrics.hookRepetition, 1, 'confirmed_section_boundaries', humanSource)

  applyEnergyMetrics(
    rebuilt,
    { sections, features, confidence: 1, provider: humanSource.provider, modelVersion: humanSource.modelVersion, method: 'human_confirmed' },
    humanSource,
    1,
  )
  return rebuilt
}
