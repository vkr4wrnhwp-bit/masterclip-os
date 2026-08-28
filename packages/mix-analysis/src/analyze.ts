import { analyzeFrames, decodeToPcm, DecodeUnavailableError, isWav, resample, toMono, type PcmAudio } from '@masterclip/song-analysis'
import { CURVE_STEP_MS, DEFAULT_MIX_ANALYZERS, MIX_ANALYZER_SET_VERSION, MIX_ANALYSIS_PROVIDER } from './analyzers.js'
import { computeSpectrogram } from './spectrum.js'
import { isMixMetricKey, type MixAnalysisContext, type MixAnalyzer, type MixCurve, type MixMetric } from './types.js'

/**
 * Running the analyzer set.
 *
 * The audio is decoded once, the spectrogram is built once, and every analyzer
 * reads the same context. An analyzer that throws does not take the analysis
 * down with it: its metrics come back as unmeasured with the failure in the
 * note. One bad analyzer costing an engineer their whole report would be a
 * worse outcome than a report with one gap in it.
 */

/** What the caller supplies. Deliberately not an asset record — this package knows nothing about storage. */
export interface MixAnalysisRequest {
  bytes: Uint8Array
  mimeType: string
  /** An isolated vocal, when the caller has one. Raises the vocal metrics' basis. */
  vocalStemBytes?: Uint8Array | null
  vocalStemMimeType?: string | null
  /** Cap on analysed length, so one long upload cannot occupy a worker forever. */
  maxSeconds?: number
  analyzers?: MixAnalyzer[]
}

export interface MixAnalysisOutput {
  metrics: MixMetric[]
  curves: MixCurve[]
  durationMs: number
  sampleRate: number
  channels: number
  bitDepth: number | null
  analyzerSetVersion: string
  provider: string
  /** Analyzers that failed, so the report can say what is missing and why. */
  failures: Array<{ analyzer: string; reason: string }>
}

/** Thrown when the file cannot be read at all. Distinct from an analyzer failing. */
export class MixAnalysisUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'MixAnalysisUnavailableError'
  }
}

export async function analyzeMix(request: MixAnalysisRequest): Promise<MixAnalysisOutput> {
  const audio = await decodeForMix(request.bytes, request.mimeType, request.maxSeconds)
  const analyzers = request.analyzers ?? DEFAULT_MIX_ANALYZERS

  const mono = toMono(audio)
  const spectrogram = computeSpectrogram(audio)

  // Song Lab's frame descriptors are reused for silence and fade detection
  // rather than reimplemented; they run at their own fixed rate, which is
  // correct for the questions they answer.
  const songLabMono = audio.sampleRate === 22050 ? mono : resample(mono, audio.sampleRate, 22050)
  const frames = analyzeFrames(songLabMono, audio)

  let vocalStem: Float32Array | null = null
  if (request.vocalStemBytes && request.vocalStemBytes.length > 0) {
    try {
      const stem = await decodeForMix(request.vocalStemBytes, request.vocalStemMimeType ?? 'audio/wav', request.maxSeconds)
      vocalStem = toMono(stem)
    } catch {
      // A stem that will not decode is not a reason to refuse the mix report.
      // The vocal analyzer falls back to the full-mix proxy and says so.
      vocalStem = null
    }
  }

  const context: MixAnalysisContext = {
    audio,
    mono,
    spectrogram,
    frames,
    sourceSampleRate: audio.sampleRate,
    channelCount: audio.channels.length,
    bitDepth: bitDepthOf(request.bytes),
    isolatedVocal: vocalStem,
  }

  const metrics: MixMetric[] = []
  const curves: MixCurve[] = []
  const failures: Array<{ analyzer: string; reason: string }> = []

  for (const analyzer of analyzers) {
    try {
      const result = analyzer.run(context)
      for (const emitted of result.metrics) {
        if (!isMixMetricKey(emitted.key)) {
          failures.push({ analyzer: analyzer.id, reason: `emitted the undeclared metric "${emitted.key}"` })
          continue
        }
        metrics.push(emitted)
      }
      for (const curve of result.curves ?? []) curves.push(curve)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failures.push({ analyzer: analyzer.id, reason })
      // The keys this analyzer owns still appear, as unmeasured, so a caller
      // reading the report by key finds an honest gap rather than nothing.
      for (const key of analyzer.metricKeys) {
        metrics.push({
          key,
          value: null,
          unit: 'index',
          confidence: 0,
          analysisMethod: analyzer.id,
          provider: MIX_ANALYSIS_PROVIDER,
          note: `The ${analyzer.id} analyzer failed on this file: ${reason}`,
        })
      }
    }
  }

  return {
    metrics,
    curves,
    durationMs: audio.durationMs,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    bitDepth: context.bitDepth,
    analyzerSetVersion: MIX_ANALYZER_SET_VERSION,
    provider: MIX_ANALYSIS_PROVIDER,
    failures,
  }
}

/**
 * Decodes at the source rate.
 *
 * `decodeToPcm` defaults to Song Lab's 22.05 kHz analysis rate, which would put
 * every sibilance and air measurement above Nyquist. Mix work needs the real
 * rate, capped at 48 kHz — above that the extra bandwidth costs analysis time
 * and answers no question this module asks.
 */
async function decodeForMix(bytes: Uint8Array, mimeType: string, maxSeconds?: number): Promise<PcmAudio> {
  try {
    if (isWav(bytes)) {
      const audio = await decodeToPcm(bytes, mimeType)
      return maxSeconds ? truncate(audio, maxSeconds) : audio
    }
    return await decodeToPcm(bytes, mimeType, { sampleRate: 48000, ...(maxSeconds ? { maxSeconds } : {}) })
  } catch (err) {
    if (err instanceof DecodeUnavailableError) throw new MixAnalysisUnavailableError(err.reason)
    throw new MixAnalysisUnavailableError(err instanceof Error ? err.message : String(err))
  }
}

function truncate(audio: PcmAudio, maxSeconds: number): PcmAudio {
  const limit = Math.floor(maxSeconds * audio.sampleRate)
  if (audio.frameCount <= limit) return audio
  return {
    channels: audio.channels.map((channel) => channel.subarray(0, limit)),
    sampleRate: audio.sampleRate,
    frameCount: limit,
    durationMs: Math.round((limit / audio.sampleRate) * 1000),
  }
}

/**
 * Bit depth as declared by the WAV header.
 *
 * Only WAV is asked, and only the header is read: a transcode through ffmpeg
 * tells us the depth of the *intermediate*, not of the file the artist uploaded,
 * and reporting that as the source's depth would be a lie in a delivery check.
 */
export function bitDepthOf(bytes: Uint8Array): number | null {
  if (!isWav(bytes) || bytes.length < 40) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ' && offset + 24 <= bytes.length) return view.getUint16(offset + 22, true)
    offset += 8 + size + (size % 2)
  }
  return null
}

/** Convenience: pull one metric out of a report by key. */
export function findMetric(metrics: MixMetric[], key: string): MixMetric | undefined {
  return metrics.find((entry) => entry.key === key)
}

/** The measured value, or null when the metric is absent or unmeasured. */
export function metricValue(metrics: MixMetric[], key: string): number | null {
  return findMetric(metrics, key)?.value ?? null
}

export function findCurve(curves: MixCurve[], key: string): MixCurve | undefined {
  return curves.find((curve) => curve.key === key)
}

export { CURVE_STEP_MS }
