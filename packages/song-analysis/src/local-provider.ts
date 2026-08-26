import { measured, unknown, type Measured } from '@masterclip/song-feature-vectors'
import { mean, normalize } from './dsp.js'
import { analyzeFrames, energyCurve, type AnalysisFrames } from './frames.js'
import { decodeToPcm } from './decode.js'
import { resample, toMono, type PcmAudio } from './pcm.js'
import { analyzeLoudness, analyzeSilence, analyzeStereoWidth } from './loudness.js'
import { estimateKey, harmonicChangeRate } from './key.js'
import { estimateMeter, estimateTempo } from './tempo.js'
import { detectVocalActivity, registerProfileFromCurve, vocalPhraseMetrics, voicedRegisterCurve } from './vocal.js'
import type {
  AudioSource,
  MusicFeatureProvider,
  MusicFeatureResult,
  VocalAnalysisOptions,
  VocalAnalysisProvider,
  VocalAnalysisResult,
} from './types.js'

/**
 * The in-process DSP provider.
 *
 * This is the default because it needs no credentials, no network and no
 * per-song cost, and because its methods are inspectable: every figure it
 * produces names the algorithm that produced it. A commercial MIR vendor can be
 * registered alongside it later without any caller changing.
 */

export const LOCAL_ANALYSIS_PROVIDER = 'local-dsp'
export const LOCAL_ANALYSIS_VERSION = '1.0.0'

const SOURCE = { provider: LOCAL_ANALYSIS_PROVIDER, modelVersion: LOCAL_ANALYSIS_VERSION }

export interface PreparedAudio {
  audio: PcmAudio
  mono: Float32Array
  frames: AnalysisFrames
  durationMs: number
}

/** Decodes, downmixes, resamples and frames a source once. */
export async function prepareAudio(source: AudioSource, maxSeconds = 900): Promise<PreparedAudio> {
  const bytes = await source.read()
  const audio = await decodeToPcm(bytes, source.asset.mimeType, { maxSeconds })
  const monoAtSourceRate = toMono(audio)
  const frames = analyzeFrames(resample(monoAtSourceRate, audio.sampleRate, 22050), audio)
  return { audio, mono: monoAtSourceRate, frames, durationMs: audio.durationMs }
}

export class LocalMusicFeatureProvider implements MusicFeatureProvider {
  readonly providerId = LOCAL_ANALYSIS_PROVIDER
  readonly modelVersion = LOCAL_ANALYSIS_VERSION

  isConfigured(): boolean {
    return true
  }

  async analyzeMusicFeatures(source: AudioSource): Promise<MusicFeatureResult> {
    const prepared = await prepareAudio(source)
    return musicFeaturesFrom(prepared)
  }
}

export function musicFeaturesFrom(prepared: PreparedAudio): MusicFeatureResult {
  const { audio, mono, frames } = prepared
  const tempo = estimateTempo(frames)
  const meter = estimateMeter(tempo.beats, frames.flux, frames.frameSeconds)
  const key = estimateKey(frames)
  const loudness = analyzeLoudness(mono, audio.sampleRate)
  const silence = analyzeSilence(frames)
  const width = analyzeStereoWidth(frames, audio)
  const harmonic = harmonicChangeRate(frames)
  const curve = energyCurve(frames)

  // Density descriptors are means of already-normalized per-frame values, so
  // they stay comparable between songs of different lengths and levels.
  const spectralDensity = frames.count > 0 ? mean(normalize(frames.flatness)) : 0
  const transientDensity = frames.count > 0 ? mean(normalize(frames.flux)) : 0
  const lowDensity = frames.count > 0 ? mean(frames.lowBand) : 0

  return {
    durationMs: audio.durationMs,
    bpm:
      tempo.bpm === null
        ? unknown<number>('onset_autocorrelation', SOURCE, 'no stable pulse was detected in this recording')
        : measured(tempo.bpm, tempo.confidence, tempo.method, SOURCE),
    tempoStability:
      tempo.stability === null
        ? unknown<number>('quarter_segment_tempo_agreement', SOURCE, 'the recording is too short to compare tempo across sections')
        : measured(tempo.stability, Math.min(tempo.confidence, 0.8), 'quarter_segment_tempo_agreement', SOURCE),
    meter:
      meter.beatsPerBar === null
        ? unknown<number>(meter.method, SOURCE, 'no time signature stood out clearly enough to report')
        : measured(meter.beatsPerBar, meter.confidence, meter.method, SOURCE),
    key:
      key.key === null
        ? unknown<string>(key.method, SOURCE, 'no tonal centre correlated strongly enough to name')
        : measured(
            key.key,
            key.confidence,
            key.method,
            SOURCE,
            key.alternative ? `next closest: ${key.alternative}` : undefined,
          ),
    loudness: measured(loudness.loudnessLufs, loudness.loudnessConfidence, loudness.method, SOURCE, 'approximate programme loudness, not a BS.1770 measurement'),
    dynamicRange: measured(loudness.dynamicRangeDb, loudness.loudnessConfidence, 'block_loudness_percentile_range', SOURCE),
    peakDbfs: Number.isFinite(loudness.peakDbfs)
      ? measured(loudness.peakDbfs, 0.95, 'sample_peak', SOURCE)
      : unknown<number>('sample_peak', SOURCE, 'the file contains only digital silence'),
    stereoWidth:
      width.width === null
        ? unknown<number>('side_mid_energy_ratio', SOURCE, 'the source is mono, so it has no stereo field to measure')
        : measured(width.width, width.confidence, 'side_mid_energy_ratio', SOURCE),
    spectralDensity: measured(round(spectralDensity), 0.6, 'mean_normalized_spectral_flatness', SOURCE),
    transientDensity: measured(round(transientDensity), 0.6, 'mean_normalized_spectral_flux', SOURCE),
    lowFrequencyDensity: measured(round(lowDensity), 0.6, 'sub_200hz_energy_share', SOURCE),
    energyCurve: curve.map(round),
    energyCurveStepSeconds: frames.frameSeconds,
    beats: tempo.beats.map((value) => Math.round(value * 1000) / 1000),
    leadInSeconds: silence.leadInSeconds,
    tailSeconds: silence.tailSeconds,
    fadeInSeconds: silence.fadeInSeconds,
    fadeOutSeconds: silence.fadeOutSeconds,
    harmonicChangeRate:
      harmonic.changesPerMinute === null
        ? unknown<number>('chroma_change_rate', SOURCE, 'the recording is too short to estimate harmonic movement')
        : measured(harmonic.changesPerMinute, harmonic.confidence, 'chroma_change_rate', SOURCE),
    provider: LOCAL_ANALYSIS_PROVIDER,
    modelVersion: LOCAL_ANALYSIS_VERSION,
  }
}

export class LocalVocalAnalysisProvider implements VocalAnalysisProvider {
  readonly providerId = LOCAL_ANALYSIS_PROVIDER
  readonly modelVersion = LOCAL_ANALYSIS_VERSION

  isConfigured(): boolean {
    return true
  }

  /**
   * Measures the isolated vocal when one is supplied, and the mix otherwise.
   *
   * A stem that cannot be decoded falls back to the mix rather than failing the
   * run — but it falls back honestly, returning a `full_mix` basis and the
   * proxy's lower confidence. The one thing this must never do is report
   * isolated-stem confidence over numbers taken from the mix.
   */
  async analyzeVocals(source: AudioSource, opts: VocalAnalysisOptions = {}): Promise<VocalAnalysisResult> {
    if (opts.isolatedVocal) {
      try {
        const stem = await prepareAudio(opts.isolatedVocal)
        return vocalAnalysisFrom(stem, { isolatedVocal: true })
      } catch {
        // Deliberately swallowed: the mix is still analysable, and the result
        // says which one it measured.
      }
    }
    const prepared = await prepareAudio(source)
    return vocalAnalysisFrom(prepared)
  }
}

export function vocalAnalysisFrom(prepared: PreparedAudio, opts: { isolatedVocal?: boolean } = {}): VocalAnalysisResult {
  const { frames, durationMs } = prepared
  const activity = detectVocalActivity(frames, opts)
  const durationSeconds = durationMs / 1000
  const phrase = vocalPhraseMetrics(activity, durationSeconds, frames)
  const curve = voicedRegisterCurve(activity, frames)
  const register = registerProfileFromCurve(curve, 0, curve.length, {
    isolatedVocal: opts.isolatedVocal,
    detectionConfidence: activity.confidence,
  })
  const confidence = activity.confidence

  const maybe = (value: number | null, method: string, note: string): Measured<number> =>
    value === null ? unknown<number>(method, SOURCE, note) : measured(value, confidence, method, SOURCE)

  return {
    basis: opts.isolatedVocal ? 'isolated_stem' : 'full_mix',
    occupancy: measured(round(activity.occupancy), confidence, activity.method, SOURCE, opts.isolatedVocal ? undefined : 'estimated from the full mix, not an isolated vocal'),
    firstVocalSeconds: maybe(activity.firstVocalSeconds, activity.method, 'no sustained vocal activity was detected'),
    averagePhraseSeconds: maybe(phrase.averagePhraseSeconds, 'vocal_phrase_segmentation', 'no vocal phrases were detected'),
    longestPhraseSeconds: maybe(phrase.longestPhraseSeconds, 'vocal_phrase_segmentation', 'no vocal phrases were detected'),
    restRatio: maybe(phrase.restRatio, 'vocal_phrase_segmentation', 'no vocal phrases were detected'),
    heldNoteSeconds: maybe(phrase.heldNoteSeconds, 'steady_centroid_run', 'no sustained held note was detected'),
    register: { median: register.medianRegister, low: register.lowRegister, high: register.highRegister, confidence: register.confidence },
    phrases: activity.phrases.map(([from, to]) => [Math.round(from * 1000), Math.round(to * 1000)] as [number, number]),
    activity: activity.likelihood,
    activityStepSeconds: frames.frameSeconds,
    registerCurve: curve,
    registerCurveStepSeconds: frames.frameSeconds,
    provider: LOCAL_ANALYSIS_PROVIDER,
    modelVersion: LOCAL_ANALYSIS_VERSION,
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
