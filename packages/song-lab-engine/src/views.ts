import { confidenceLabel, formatClock, metricDefinition, type Measured } from '@masterclip/song-feature-vectors'
import {
  analyzeBuilds,
  registerBands,
  registerMetrics,
  repeatedSectionContrasts,
  sectionContrasts,
  structuralMetrics,
  type BuildAnalysis,
  type RegisterMetrics,
  type SectionContrast,
  type SectionRegisterBand,
  type StructuralMetrics,
} from '@masterclip/song-structure'
import type { SongAnalysisRecord, SongSectionRecord } from '@masterclip/song-lab-domain'
import { toDetected, toSectionFeatures } from './analysis.js'
import type { Actor, SongLabDeps } from './deps.js'

/**
 * View assembly: Overview, Structure, Hook, Energy, Arrangement, Producer.
 *
 * Artist View and Producer View read the same measurements — the difference is
 * how much is shown, not what was computed. Producer View additionally exposes
 * the confidence and method behind every figure, which is the honest way to
 * present a number an experienced engineer will immediately want to check.
 */

export interface EnergyPoint {
  label: string
  sectionType: string
  startMs: number
  endMs: number
  /** 0–100 for display. Normalized within this song, not across songs. */
  energy: number
  vocalOccupancy: number | null
  arrangementDensity: number
}

export interface HookProfileRow {
  metric: string
  finding: string
  /** The neutral chip: `Later Than Cohort`, `Similar To Cohort`, … */
  classification: string
  confidence: number
  confidenceLabel: string
}

export interface HookProfile {
  rows: HookProfileRow[]
  firstHookSeconds: number | null
  titleRepetition: number | null
  hookRepetition: number | null
  /** Fixed at three, but returns fewer rather than padding with filler. */
  experiments: Array<{ title: string; description: string; experimentSupported: boolean; recommendationId: string | null }>
}

export interface ProducerFeatureRow {
  key: string
  label: string
  value: number | string | null
  display: string
  confidence: number
  confidenceLabel: string
  method: string
  provider: string
  modelVersion: string
  note: string | null
}

export class SongLabViewService {
  constructor(private readonly deps: SongLabDeps) {}

  /** The energy curve, per section, for the Energy tab. */
  async energy(actor: Actor, analysisId: string): Promise<{ sections: EnergyPoint[]; curve: number[]; stepSeconds: number }> {
    const analysis = await this.deps.repos.analyses.get(actor.orgId, analysisId)
    const sections = await this.deps.repos.sections.list(actor.orgId, analysisId)
    const featureMap = await this.deps.repos.sections.features(actor.orgId, analysisId)

    const energies = sections.map((section) => featureMap.get(section.id)?.energy ?? 0)
    const min = Math.min(...energies, 0)
    const max = Math.max(...energies, 1)
    const scale = (value: number) => (max - min < 1e-6 ? 50 : Math.round(((value - min) / (max - min)) * 100))

    return {
      sections: sections.map((section) => {
        const features = featureMap.get(section.id)
        return {
          label: section.label,
          sectionType: section.sectionType,
          startMs: section.startMs,
          endMs: section.endMs,
          energy: scale(features?.energy ?? 0),
          vocalOccupancy: features?.vocalOccupancy === null || features?.vocalOccupancy === undefined ? null : Math.round(features.vocalOccupancy * 100),
          arrangementDensity: Math.round((features?.arrangementDensity ?? 0) * 100),
        }
      }),
      curve: analysis.energyCurve.values,
      stepSeconds: analysis.energyCurve.stepSeconds,
    }
  }

  /** Consecutive and repeated-section contrast, for the Arrangement tab. */
  async arrangement(
    actor: Actor,
    analysisId: string,
  ): Promise<{
    consecutive: SectionContrast[]
    repeats: SectionContrast[]
    builds: BuildAnalysis[]
    register: RegisterMetrics
    registerBands: SectionRegisterBand[]
  }> {
    const sections = await this.deps.repos.sections.list(actor.orgId, analysisId)
    const featureMap = await this.deps.repos.sections.features(actor.orgId, analysisId)
    const detected = sections.map(toDetected)
    const features = sections.map((section) => toSectionFeatures(featureMap.get(section.id)))

    const consecutive = sectionContrasts(detected, features)
    return {
      consecutive,
      repeats: repeatedSectionContrasts(detected, features),
      register: registerMetrics(detected, features),
      registerBands: registerBands(detected, features),
      builds: analyzeBuilds({
        sections: detected,
        features,
        contrasts: consecutive,
        // Stem-based experiments are offered only where stems exist; without
        // them Build Intelligence gives the idea, not a render button.
        hasStems: false,
      }),
    }
  }

  /** Structural metrics recomputed from whatever the structure currently is. */
  async structure(actor: Actor, analysisId: string): Promise<{ sections: SongSectionRecord[]; metrics: StructuralMetrics }> {
    const analysis = await this.deps.repos.analyses.get(actor.orgId, analysisId)
    const sections = await this.deps.repos.sections.list(actor.orgId, analysisId)
    const featureMap = await this.deps.repos.sections.features(actor.orgId, analysisId)
    return {
      sections,
      metrics: structuralMetrics({
        sections: sections.map(toDetected),
        features: sections.map((section) => toSectionFeatures(featureMap.get(section.id))),
        durationMs: analysis.durationMs ?? 0,
        firstVocalSeconds: analysis.firstVocalMs === null ? null : analysis.firstVocalMs / 1000,
      }),
    }
  }

  /**
   * Hook Architecture.
   *
   * Deliberately a profile, not a score. A single "hit score" would compress
   * seven independent measurements into one number nobody could argue with,
   * which is the opposite of what this product is for.
   */
  async hookProfile(actor: Actor, projectId: string): Promise<HookProfile> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    const rows: HookProfileRow[] = []
    if (!project.currentVersionId) return { rows, firstHookSeconds: null, titleRepetition: null, hookRepetition: null, experiments: [] }

    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, project.currentVersionId)
    if (!analysis?.featureVector) return { rows, firstHookSeconds: null, titleRepetition: null, hookRepetition: null, experiments: [] }

    const benchmarkResults = project.selectedBenchmarkCohortId
      ? await this.deps.repos.benchmarkResults.list(actor.orgId, analysis.id, project.selectedBenchmarkCohortId)
      : []
    const byMetric = new Map(benchmarkResults.map((result) => [result.metricKey, result]))

    const dimensions: Array<{ key: string; label: string }> = [
      { key: 'first_hook_seconds', label: 'First hook' },
      { key: 'title_repetition', label: 'Title repetition' },
      { key: 'hook_repetition', label: 'Chorus repetition' },
      { key: 'chorus_share', label: 'Chorus share of runtime' },
      { key: 'chorus_similarity', label: 'Chorus-to-chorus similarity' },
      { key: 'chorus_register_lift', label: 'Melodic contrast' },
      { key: 'rhythmic_contrast', label: 'Rhythmic contrast' },
      { key: 'vocal_density_contrast', label: 'Vocal-density contrast' },
      { key: 'final_chorus_contrast', label: 'Final-chorus evolution' },
    ]

    const cohortSelected = Boolean(project.selectedBenchmarkCohortId)
    for (const dimension of dimensions) {
      const measurement = analysis.featureVector.metrics[dimension.key]
      const benchmark = byMetric.get(dimension.key)
      const value = measurement?.value ?? null
      const unmeasured = value === null
      rows.push({
        metric: dimension.label,
        finding: unmeasured ? 'Not enough information' : formatValue(dimension.key, value),
        // Three different absences, and conflating them misleads. The song was
        // never measured; a cohort was never chosen; or a cohort was chosen and
        // holds no distribution for this metric — which is the honest state for
        // anything the benchmark provider does not carry, and reads as a broken
        // picker if it is reported as "no cohort selected".
        classification:
          benchmark?.classificationLabel ??
          (unmeasured ? 'Not Enough Information' : cohortSelected ? 'No Cohort Data' : 'No cohort selected'),
        confidence: measurement?.confidence ?? 0,
        confidenceLabel: confidenceLabel(measurement),
      })
    }

    const observations = await this.deps.repos.observations.listForProject(actor.orgId, projectId)
    const experiments = observations
      .filter(
        (observation) =>
          observation.category === 'hook' ||
          observation.category === 'timing' ||
          observation.category === 'lyric' ||
          observation.category === 'melodic',
      )
      .flatMap((observation) =>
        (observation.recommendations ?? []).map((recommendation) => ({
          title: recommendation.title,
          description: recommendation.description,
          experimentSupported: recommendation.experimentSupported,
          recommendationId: recommendation.id,
        })),
      )
      .slice(0, 3)

    return {
      rows,
      firstHookSeconds: analysis.featureVector.metrics.first_hook_seconds?.value ?? null,
      titleRepetition: analysis.featureVector.metrics.title_repetition?.value ?? null,
      hookRepetition: analysis.featureVector.metrics.hook_repetition?.value ?? null,
      experiments,
    }
  }

  /**
   * Producer View.
   *
   * Every raw feature with its confidence, method, provider and model version.
   * Nothing is hidden and nothing is rounded into looking more certain than it
   * is; a feature that could not be determined appears with its reason.
   */
  async producerView(actor: Actor, analysisId: string): Promise<{
    features: ProducerFeatureRow[]
    sections: SongSectionRecord[]
    contrasts: SectionContrast[]
    builds: BuildAnalysis[]
    registerBands: SectionRegisterBand[]
    providers: Record<string, { provider: string; modelVersion: string }>
    engineVersion: string
    sourceChecksum: string
  }> {
    const analysis = await this.deps.repos.analyses.get(actor.orgId, analysisId)
    const arrangement = await this.arrangement(actor, analysisId)
    const sections = await this.deps.repos.sections.list(actor.orgId, analysisId)

    const features: ProducerFeatureRow[] = []
    for (const [key, measurement] of Object.entries(analysis.featureVector?.metrics ?? {})) {
      features.push(toProducerRow(key, measurement))
    }
    // Key is a string measurement and lives outside the numeric vector.
    if (analysis.key) {
      features.push({
        key: 'key',
        label: 'Key',
        value: analysis.key,
        display: analysis.key,
        confidence: analysis.keyConfidence ?? 0,
        confidenceLabel: confidenceLabel({ value: analysis.key, confidence: analysis.keyConfidence ?? 0 } as Measured<string>),
        method: 'krumhansl_schmuckler',
        provider: analysis.providers.features?.provider ?? 'unknown',
        modelVersion: analysis.providers.features?.modelVersion ?? 'unknown',
        note: null,
      })
    }
    features.sort((a, b) => a.label.localeCompare(b.label))

    return {
      features,
      sections,
      contrasts: arrangement.consecutive,
      builds: arrangement.builds,
      registerBands: arrangement.registerBands,
      providers: analysis.providers,
      engineVersion: analysis.engineVersion,
      sourceChecksum: analysis.sourceChecksum,
    }
  }

  /** The structure timeline, rendered the way the product shows it. */
  timeline(sections: SongSectionRecord[]): Array<{ time: string; label: string; confirmed: boolean }> {
    return sections.map((section) => ({
      time: formatClock(section.startMs / 1000),
      label: section.label.toUpperCase(),
      confirmed: section.humanConfirmed,
    }))
  }
}

function toProducerRow(key: string, measurement: Measured<number>): ProducerFeatureRow {
  const definition = metricDefinition(key)
  const display =
    measurement.value === null
      ? 'not enough information'
      : definition
        ? formatValue(key, measurement.value)
        : String(Math.round(measurement.value * 1000) / 1000)
  return {
    key,
    label: definition?.label ?? key,
    value: measurement.value,
    display,
    confidence: measurement.confidence,
    confidenceLabel: confidenceLabel(measurement),
    method: measurement.analysisMethod,
    provider: measurement.provider,
    modelVersion: measurement.modelVersion,
    note: measurement.note ?? null,
  }
}

function formatValue(key: string, value: number): string {
  const unit = metricDefinition(key)?.unit
  if (unit === 'seconds') return formatClock(value)
  if (unit === 'bpm') return `${Math.round(value)} BPM`
  if (unit === 'percent') return `${Math.round(value)}%`
  if (unit === 'lufs') return `${value.toFixed(1)} LUFS`
  if (unit === 'db') return `${value.toFixed(1)} dB`
  return String(Math.round(value * 1000) / 1000)
}
