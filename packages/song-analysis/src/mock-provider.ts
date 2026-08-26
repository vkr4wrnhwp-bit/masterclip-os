import { measured, unknown } from '@masterclip/song-feature-vectors'
import type { AudioSource, MusicFeatureProvider, MusicFeatureResult, VocalAnalysisProvider, VocalAnalysisResult } from './types.js'

/**
 * The deterministic provider.
 *
 * Seeded from the source checksum, so a given file always yields the same
 * answer and a different file yields a different one. It exists so the whole
 * product flow — analysis, benchmarking, observations, experiments, versions —
 * is exercisable where the DSP path cannot run (no ffmpeg for a compressed
 * upload, a partner deployment with analysis disabled, a fast test).
 *
 * It never claims to have heard anything: every value it emits carries a low
 * ceiling on confidence and a note naming it as synthesized, so nothing
 * downstream can mistake a placeholder for a measurement.
 */

export const MOCK_ANALYSIS_PROVIDER = 'mock-song-analysis'
export const MOCK_ANALYSIS_VERSION = '1.0.0'

const SOURCE = { provider: MOCK_ANALYSIS_PROVIDER, modelVersion: MOCK_ANALYSIS_VERSION }
const SYNTHETIC = 'synthesized by the deterministic analysis provider — not measured from audio'
/** Hard ceiling: a placeholder must never outrank a real measurement. */
const MAX_CONFIDENCE = 0.3

/** Mulberry32 over the first 8 hex characters of the checksum. */
export function seedFrom(checksum: string): () => number {
  let state = parseInt(checksum.slice(0, 8) || '0', 16) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Duration from the asset when known, otherwise a plausible 2:30–4:30. */
function durationFor(source: AudioSource, random: () => number): number {
  if (source.asset.durationMs && source.asset.durationMs > 1000) return source.asset.durationMs
  return Math.round((150 + random() * 120) * 1000)
}

export class MockMusicFeatureProvider implements MusicFeatureProvider {
  readonly providerId = MOCK_ANALYSIS_PROVIDER
  readonly modelVersion = MOCK_ANALYSIS_VERSION

  isConfigured(): boolean {
    return true
  }

  async analyzeMusicFeatures(source: AudioSource): Promise<MusicFeatureResult> {
    const random = seedFrom(source.asset.checksum)
    const durationMs = durationFor(source, random)
    const bpm = Math.round(84 + random() * 40)
    const steps = Math.max(8, Math.round(durationMs / 1000 / 0.5))
    const curve: number[] = []
    for (let i = 0; i < steps; i++) {
      // A shape with a rise into the last third — recognizably song-like
      // without pretending to be this song.
      const position = i / steps
      const arc = 0.45 + 0.25 * Math.sin(position * Math.PI * 2.2) + 0.2 * position
      curve.push(Math.max(0, Math.min(1, arc + (random() - 0.5) * 0.08)))
    }
    const beatSeconds = 60 / bpm
    const beats: number[] = []
    for (let time = 0.2; time < durationMs / 1000; time += beatSeconds) beats.push(Math.round(time * 1000) / 1000)

    return {
      durationMs,
      bpm: measured(bpm, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      tempoStability: measured(0.9, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      meter: measured(4, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      key: measured(['C major', 'A minor', 'G major', 'E minor', 'D major'][Math.floor(random() * 5)]!, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      loudness: measured(-9 - random() * 4, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      dynamicRange: measured(6 + random() * 5, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      peakDbfs: measured(-0.5 - random(), MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      stereoWidth: measured(0.2 + random() * 0.2, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      spectralDensity: measured(0.4 + random() * 0.2, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      transientDensity: measured(0.4 + random() * 0.2, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      lowFrequencyDensity: measured(0.3 + random() * 0.2, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      energyCurve: curve.map((value) => Math.round(value * 1000) / 1000),
      energyCurveStepSeconds: 0.5,
      beats,
      leadInSeconds: 0,
      tailSeconds: 0,
      fadeInSeconds: null,
      fadeOutSeconds: random() > 0.6 ? Math.round(random() * 60) / 10 : null,
      harmonicChangeRate: measured(Math.round(20 + random() * 30), MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      provider: MOCK_ANALYSIS_PROVIDER,
      modelVersion: MOCK_ANALYSIS_VERSION,
    }
  }
}

export class MockVocalAnalysisProvider implements VocalAnalysisProvider {
  readonly providerId = MOCK_ANALYSIS_PROVIDER
  readonly modelVersion = MOCK_ANALYSIS_VERSION

  isConfigured(): boolean {
    return true
  }

  async analyzeVocals(source: AudioSource): Promise<VocalAnalysisResult> {
    const random = seedFrom(source.asset.checksum.slice(8) || source.asset.checksum)
    const durationMs = durationFor(source, random)
    const firstVocal = 8 + random() * 12
    const phrases: Array<[number, number]> = []
    for (let time = firstVocal; time < durationMs / 1000 - 5; time += 2.4 + random() * 1.5) {
      phrases.push([Math.round(time * 1000), Math.round((time + 1.4 + random()) * 1000)])
    }
    const activitySteps = Math.max(8, Math.round(durationMs / 500))
    const activity = Array.from({ length: activitySteps }, (_, i) => (i * 0.5 >= firstVocal && random() > 0.25 ? 0.8 : 0.2))

    return {
      // Synthetic numbers describe no recording at all, so no stem could make
      // them a stem measurement. Always the weaker basis.
      basis: 'full_mix',
      occupancy: measured(0.55 + random() * 0.2, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      firstVocalSeconds: measured(Math.round(firstVocal * 10) / 10, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      averagePhraseSeconds: measured(1.8 + random() * 0.8, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      longestPhraseSeconds: measured(3.5 + random(), MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      restRatio: measured(0.3 + random() * 0.15, MAX_CONFIDENCE, 'deterministic_placeholder', SOURCE, SYNTHETIC),
      // A held-note proxy from synthesized data would be pure invention.
      heldNoteSeconds: unknown<number>('deterministic_placeholder', SOURCE, 'held-note duration cannot be synthesized'),
      register: { median: null, low: null, high: null, confidence: 0 },
      phrases,
      activity,
      activityStepSeconds: 0.5,
      // No register was measured, so there is no curve to hand on. An empty
      // curve is what stops a caller windowing synthetic values per section.
      registerCurve: [],
      registerCurveStepSeconds: 0.5,
      provider: MOCK_ANALYSIS_PROVIDER,
      modelVersion: MOCK_ANALYSIS_VERSION,
    }
  }
}
