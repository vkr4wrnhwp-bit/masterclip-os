import {
  MOCK_ANALYSIS_PROVIDER,
  MOCK_ANALYSIS_VERSION,
  LOCAL_ANALYSIS_PROVIDER,
  LOCAL_ANALYSIS_VERSION,
  detectVocalActivity,
  emptyRegister,
  estimateTempo,
  prepareAudio,
  seedFrom,
  type AudioSource,
  type DetectedSection,
  type SectionFeatures,
  type SectionType,
  type SongStructureProvider,
  type StructureAnalysisResult,
} from '@masterclip/song-analysis'
import { detectStructure, STRUCTURE_ENGINE_VERSION } from './detect.js'

/** Structure detection over the in-process DSP pipeline. */
export class LocalStructureProvider implements SongStructureProvider {
  readonly providerId = LOCAL_ANALYSIS_PROVIDER
  readonly modelVersion = `${LOCAL_ANALYSIS_VERSION}+structure-${STRUCTURE_ENGINE_VERSION}`

  isConfigured(): boolean {
    return true
  }

  async analyzeStructure(source: AudioSource): Promise<StructureAnalysisResult> {
    const prepared = await prepareAudio(source)
    const vocal = detectVocalActivity(prepared.frames)
    const tempo = estimateTempo(prepared.frames)
    return detectStructure(prepared.frames, {
      vocal,
      beats: tempo.beats,
      providerId: this.providerId,
      modelVersion: this.modelVersion,
    })
  }
}

/**
 * Deterministic structure.
 *
 * Lays out a conventional arrangement scaled to the runtime, seeded from the
 * checksum. Every section is emitted at confidence 0, which is what the UI
 * reads to say "machine-detected, unverified" — the sections exist so the
 * timeline, experiments and benchmark flow are all reachable, not because
 * anything listened to the record.
 */
export class MockStructureProvider implements SongStructureProvider {
  readonly providerId = MOCK_ANALYSIS_PROVIDER
  readonly modelVersion = MOCK_ANALYSIS_VERSION

  isConfigured(): boolean {
    return true
  }

  async analyzeStructure(source: AudioSource): Promise<StructureAnalysisResult> {
    const random = seedFrom(source.asset.checksum)
    const durationMs = source.asset.durationMs && source.asset.durationMs > 1000 ? source.asset.durationMs : Math.round((150 + random() * 120) * 1000)
    return buildDeterministicStructure(durationMs, random, this.providerId, this.modelVersion)
  }
}

/** Shape shared by the mock provider and the demo seed. */
export function buildDeterministicStructure(
  durationMs: number,
  random: () => number,
  provider: string,
  modelVersion: string,
): StructureAnalysisResult {
  // `register` is the placeholder register band and `contour` its melodic
  // shape. Both carry confidence 0 like everything else this provider emits —
  // they exist so the register panel, the contrast table and the experiments
  // that read them are all reachable on a deployment with no decoder, not
  // because anything listened to the record.
  const plan: Array<{ type: SectionType; weight: number; energy: number; vocal: number; register: number | null; contour: number[] }> = [
    { type: 'intro', weight: 0.07, energy: 0.32, vocal: 0, register: null, contour: [] },
    { type: 'verse', weight: 0.14, energy: 0.51, vocal: 0.82, register: 0.34, contour: [-0.6, -0.2, 0.3, 0.8, 0.4, -0.1, -0.5, -0.9] },
    { type: 'pre_chorus', weight: 0.07, energy: 0.68, vocal: 0.86, register: 0.41, contour: [-0.4, 0.1, 0.5, 0.9, 1, 0.6, 0.2, -0.2] },
    { type: 'chorus', weight: 0.13, energy: 0.83, vocal: 0.88, register: 0.38, contour: [0.9, 0.5, -0.1, -0.6, 0.7, 0.3, -0.3, -0.8] },
    { type: 'verse', weight: 0.13, energy: 0.62, vocal: 0.84, register: 0.35, contour: [-0.55, -0.15, 0.35, 0.75, 0.45, -0.05, -0.45, -0.85] },
    { type: 'pre_chorus', weight: 0.06, energy: 0.71, vocal: 0.85, register: 0.42, contour: [-0.35, 0.15, 0.55, 0.95, 1, 0.55, 0.15, -0.25] },
    { type: 'chorus', weight: 0.13, energy: 0.84, vocal: 0.88, register: 0.39, contour: [0.88, 0.52, -0.08, -0.58, 0.72, 0.32, -0.28, -0.78] },
    { type: 'bridge', weight: 0.1, energy: 0.66, vocal: 0.6, register: 0.52, contour: [0.2, 0.6, 1, 0.7, 0.1, -0.4, -0.8, -1] },
    { type: 'final_chorus', weight: 0.12, energy: 0.89, vocal: 0.9, register: 0.44, contour: [0.95, 0.6, 0, -0.5, 0.8, 0.4, -0.2, -0.7] },
    { type: 'outro', weight: 0.05, energy: 0.35, vocal: 0.1, register: null, contour: [] },
  ]

  const sections: DetectedSection[] = []
  const features: SectionFeatures[] = []
  const counters = new Map<SectionType, number>()
  let cursor = 0

  plan.forEach((entry, index) => {
    const isLast = index === plan.length - 1
    const length = isLast ? durationMs - cursor : Math.round(durationMs * entry.weight)
    const startMs = cursor
    const endMs = Math.min(durationMs, cursor + length)
    cursor = endMs
    const occurrence = (counters.get(entry.type) ?? 0) + 1
    counters.set(entry.type, occurrence)
    const total = plan.filter((candidate) => candidate.type === entry.type).length

    sections.push({
      sectionType: entry.type,
      label: total > 1 ? `${humanLabel(entry.type)} ${occurrence}` : humanLabel(entry.type),
      startMs,
      endMs,
      // Zero, always: nothing here was measured.
      confidence: 0,
      orderIndex: index,
    })
    const jitter = (random() - 0.5) * 0.04
    const energy = clamp(entry.energy + jitter)
    features.push({
      energy,
      vocalOccupancy: clamp(entry.vocal + jitter),
      arrangementDensity: clamp(entry.energy * 0.9 + jitter),
      spectralDensity: clamp(0.4 + entry.energy * 0.3 + jitter),
      transientDensity: clamp(0.35 + entry.energy * 0.4 + jitter),
      lowFrequencyDensity: clamp(0.3 + entry.energy * 0.25 + jitter),
      stereoWidth: clamp(0.18 + entry.energy * 0.2 + jitter),
      rhythmicDensity: clamp(0.35 + entry.energy * 0.4 + jitter),
      similarityVector: [energy, entry.energy * 0.3, entry.energy * 0.4, entry.energy * 0.25, 0.45, entry.vocal, 0.2].map(
        (value) => Math.round(value * 1000) / 1000,
      ),
      register:
        entry.register === null
          ? emptyRegister()
          : { median: clamp(entry.register), low: clamp(entry.register - 0.09), high: clamp(entry.register + 0.11), confidence: 0 },
      melodicContour: entry.contour,
    })
  })

  return { sections, features, confidence: 0, provider, modelVersion, method: 'deterministic_placeholder' }
}

function humanLabel(type: SectionType): string {
  return type
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-')
    .replace('Pre-Chorus', 'Pre-Chorus')
}

function clamp(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000
}
