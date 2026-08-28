import { analyzeLoudness, analyzeSilence, dbfs, rms } from '@masterclip/song-analysis'
import {
  BALANCE_BANDS,
  MIX_BANDS,
  metric,
  unmeasured,
  type MixAnalysisContext,
  type MixAnalyzer,
  type MixAnalyzerResult,
  type MixBandKey,
  type MixCurve,
  type MixSpectrogram,
} from './types.js'
import { activeFrames, mean, meanBandShare, median, percentile, smoothSeries, standardDeviation, toDb } from './spectrum.js'

/**
 * The shipped analyzers.
 *
 * Each one is small, independent, and free to decline: an analyzer that cannot
 * measure something on this material emits a `null` metric with a note saying
 * why. Nothing here returns a plausible-looking number in place of an answer,
 * because a mix engineer acting on a fabricated figure is worse off than one
 * told the file could not be measured.
 *
 * Every metric that rests on inference rather than measurement says so in its
 * note. The vocal metrics are the clearest case: with no isolated stem they are
 * a spectral *proxy* for where the voice probably is, and they carry that word
 * everywhere they appear.
 */

export const MIX_ANALYSIS_PROVIDER = 'street-banker-mix-dsp'
export const MIX_ANALYZER_SET_VERSION = '1.0.0'

/** Frames quieter than this are treated as silence for averaging purposes. */
const ACTIVE_FLOOR_RMS = 0.001

/** Curves are stored at a fixed step so a long record does not produce a huge row. */
export const CURVE_STEP_MS = 500

// ---------------------------------------------------------------------------
// level
// ---------------------------------------------------------------------------

export const levelAnalyzer: MixAnalyzer = {
  id: 'level',
  version: '1.0.0',
  metricKeys: ['peak_dbfs', 'true_peak_dbtp', 'headroom_db', 'crest_factor_db'],
  run(context): MixAnalyzerResult {
    const channels = context.audio.channels
    let peak = 0
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i++) {
        const value = Math.abs(channel[i])
        if (value > peak) peak = value
      }
    }
    const peakDb = dbfs(peak)
    const truePeak = estimateTruePeak(channels)
    const truePeakDb = dbfs(truePeak)
    const overallRms = rms(context.mono, 0, context.mono.length)

    return {
      metrics: [
        metric('peak_dbfs', peakDb, {
          confidence: 1,
          method: 'sample_maximum',
          provider: MIX_ANALYSIS_PROVIDER,
          note: 'Exact: the largest sample in the file.',
        }),
        metric('true_peak_dbtp', truePeakDb, {
          confidence: 0.7,
          method: 'oversample_4x_catmull_rom',
          provider: MIX_ANALYSIS_PROVIDER,
          note: 'Estimated by 4× interpolation. A certified true-peak meter may read slightly higher.',
        }),
        metric('headroom_db', -truePeakDb, {
          confidence: 0.7,
          method: 'derived_from_true_peak',
          provider: MIX_ANALYSIS_PROVIDER,
          note: 'Distance from the estimated true peak to full scale.',
        }),
        overallRms > 0
          ? metric('crest_factor_db', peakDb - dbfs(overallRms), {
              confidence: 0.9,
              method: 'peak_minus_rms',
              provider: MIX_ANALYSIS_PROVIDER,
              note: '',
            })
          : unmeasured('crest_factor_db', {
              method: 'peak_minus_rms',
              provider: MIX_ANALYSIS_PROVIDER,
              note: 'The file carries no signal to measure.',
            }),
      ],
    }
  },
}

/**
 * Inter-sample peak estimate.
 *
 * Catmull-Rom through each sample quadruple, evaluated at three intermediate
 * points. It catches the overshoot that a sample-peak reading misses on a
 * limited master, which is the number that decides whether a lossy encode
 * distorts. It is an estimate and is reported as one: a proper implementation
 * band-limits with a polyphase filter, and can read a few tenths higher.
 */
function estimateTruePeak(channels: Float32Array[]): number {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const p0 = channel[i - 1] ?? channel[i]
      const p1 = channel[i]
      const p2 = channel[i + 1] ?? channel[i]
      const p3 = channel[i + 2] ?? p2
      if (Math.abs(p1) > peak) peak = Math.abs(p1)
      for (const t of [0.25, 0.5, 0.75]) {
        const t2 = t * t
        const t3 = t2 * t
        const value =
          0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
        const magnitude = Math.abs(value)
        if (magnitude > peak) peak = magnitude
      }
    }
  }
  return peak
}

// ---------------------------------------------------------------------------
// loudness and dynamics
// ---------------------------------------------------------------------------

export const loudnessAnalyzer: MixAnalyzer = {
  id: 'loudness',
  version: '1.0.0',
  metricKeys: ['integrated_lufs', 'short_term_max_lufs', 'loudness_range_lu', 'dynamic_range_db'],
  run(context): MixAnalyzerResult {
    const loudness = analyzeLoudness(context.mono, context.sourceSampleRate)
    const shortTerm = shortTermLoudness(context.mono, context.sourceSampleRate, 3)
    const gated = loudness.blockLoudness.filter((value) => value > -70)

    const metrics = [
      metric('integrated_lufs', loudness.loudnessLufs, {
        confidence: Math.min(0.7, loudness.loudnessConfidence + 0.2),
        method: loudness.method,
        provider: MIX_ANALYSIS_PROVIDER,
        note: 'Gated block loudness without K-weighting — read it as ±1 LU against a certified meter.',
      }),
      shortTerm.length > 0
        ? metric('short_term_max_lufs', Math.max(...shortTerm), {
            confidence: 0.6,
            method: 'short_term_3s_rms',
            provider: MIX_ANALYSIS_PROVIDER,
            note: '',
          })
        : unmeasured('short_term_max_lufs', {
            method: 'short_term_3s_rms',
            provider: MIX_ANALYSIS_PROVIDER,
            note: 'The file is shorter than one short-term window.',
          }),
      gated.length >= 20
        ? metric('loudness_range_lu', percentile(gated, 95) - percentile(gated, 10), {
            confidence: 0.6,
            method: 'gated_block_percentile_spread',
            provider: MIX_ANALYSIS_PROVIDER,
            note: '',
          })
        : unmeasured('loudness_range_lu', {
            method: 'gated_block_percentile_spread',
            provider: MIX_ANALYSIS_PROVIDER,
            note: 'Too few gated blocks to describe a range — the material is too short or too quiet.',
          }),
      metric('dynamic_range_db', loudness.dynamicRangeDb, {
        confidence: 0.65,
        method: loudness.method,
        provider: MIX_ANALYSIS_PROVIDER,
        note: '',
      }),
    ]

    const curves: MixCurve[] = [
      {
        key: 'short_term_loudness',
        stepMs: 1000,
        points: shortTerm.map((value) => (value <= -70 ? null : Math.round(value * 10) / 10)),
      },
    ]

    return { metrics, curves }
  },
}

/** Overlapping RMS windows, one per second, expressed on the same scale as the integrated figure. */
function shortTermLoudness(mono: Float32Array, sampleRate: number, windowSeconds: number): number[] {
  const window = Math.floor(windowSeconds * sampleRate)
  const hop = Math.floor(sampleRate)
  if (window <= 0 || mono.length < window) return []
  const values: number[] = []
  for (let offset = 0; offset + window <= mono.length; offset += hop) {
    const amplitude = rms(mono, offset, offset + window)
    values.push(-0.691 + 10 * Math.log10(amplitude * amplitude + 1e-12))
  }
  return values
}

export const dynamicsAnalyzer: MixAnalyzer = {
  id: 'dynamics',
  version: '1.0.0',
  metricKeys: ['transient_retention'],
  run(context): MixAnalyzerResult {
    // Local crest — peak over RMS inside a 400 ms block — is what survives or
    // does not survive a limiter. Averaging it across the record says how much
    // attack is left, without needing to know what the instruments are.
    const block = Math.floor(0.4 * context.sourceSampleRate)
    if (block <= 0 || context.mono.length < block * 2) {
      return {
        metrics: [
          unmeasured('transient_retention', {
            method: 'block_crest_mean',
            provider: MIX_ANALYSIS_PROVIDER,
            note: 'The file is too short to measure transient behaviour.',
          }),
        ],
      }
    }

    const crests: number[] = []
    for (let offset = 0; offset + block <= context.mono.length; offset += block) {
      let peak = 0
      for (let i = offset; i < offset + block; i++) {
        const value = Math.abs(context.mono[i])
        if (value > peak) peak = value
      }
      const level = rms(context.mono, offset, offset + block)
      if (level < ACTIVE_FLOOR_RMS) continue
      crests.push(dbfs(peak) - dbfs(level))
    }
    if (crests.length === 0) {
      return {
        metrics: [
          unmeasured('transient_retention', {
            method: 'block_crest_mean',
            provider: MIX_ANALYSIS_PROVIDER,
            note: 'No block in this file carried enough signal to measure.',
          }),
        ],
      }
    }

    // 6 dB of local crest is heavily limited; 20 dB is untouched programme.
    // The mapping is a convention this module owns, printed with the number.
    const average = mean(crests)
    const retention = Math.max(0, Math.min(1, (average - 6) / 14))
    return {
      metrics: [
        metric('transient_retention', retention, {
          confidence: 0.6,
          method: 'block_crest_mean_mapped_6_to_20db',
          provider: MIX_ANALYSIS_PROVIDER,
          note: `Mean local crest ${average.toFixed(1)} dB, mapped so 6 dB reads as 0 and 20 dB as 1.`,
        }),
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// spectral balance
// ---------------------------------------------------------------------------

export const spectralBalanceAnalyzer: MixAnalyzer = {
  id: 'spectral_balance',
  version: '1.0.0',
  metricKeys: [
    'sub_energy_pct',
    'low_energy_pct',
    'low_mid_energy_pct',
    'mid_energy_pct',
    'high_mid_energy_pct',
    'high_energy_pct',
    'spectral_centroid_hz',
    'spectral_tilt_db_per_oct',
  ],
  run(context): MixAnalyzerResult {
    const { spectrogram } = context
    const active = activeFrames(spectrogram, ACTIVE_FLOOR_RMS)
    if (active.length === 0) {
      return { metrics: this.metricKeys.map((key) => unmeasured(key, { method: 'band_share', provider: MIX_ANALYSIS_PROVIDER, note: 'The file carries no measurable programme.' })) }
    }

    const keyFor: Record<string, MixBandKey> = {
      sub_energy_pct: 'sub',
      low_energy_pct: 'low',
      low_mid_energy_pct: 'lowMid',
      mid_energy_pct: 'mid',
      high_mid_energy_pct: 'highMid',
      high_energy_pct: 'high',
    }

    const metrics = Object.entries(keyFor).map(([metricKey, band]) => {
      const share = meanBandShare(spectrogram, band, ACTIVE_FLOOR_RMS)
      // A band that reaches above the file's Nyquist cannot be measured. A
      // 32 kHz-sampled file genuinely has nothing above 16 kHz to report, and
      // saying "0 %" would read as a mix problem rather than a file fact.
      const bandTop = MIX_BANDS[band][1]
      if (bandTop > spectrogram.measurableCeilingHz && MIX_BANDS[band][0] >= spectrogram.measurableCeilingHz) {
        return unmeasured(metricKey, {
          method: 'band_share',
          provider: MIX_ANALYSIS_PROVIDER,
          note: `This file's sample rate puts the whole ${band} band above what can be measured (${Math.round(spectrogram.measurableCeilingHz)} Hz).`,
        })
      }
      return share === null
        ? unmeasured(metricKey, { method: 'band_share', provider: MIX_ANALYSIS_PROVIDER, note: 'No frame carried enough energy to measure this band.' })
        : metric(metricKey, share * 100, {
            confidence: 0.8,
            method: 'mean_band_power_share',
            provider: MIX_ANALYSIS_PROVIDER,
            note: bandTop > spectrogram.measurableCeilingHz ? `Truncated at ${Math.round(spectrogram.measurableCeilingHz)} Hz by this file's sample rate.` : '',
          })
    })

    const centroids = active.map((frame) => spectrogram.centroidHz[frame]).filter((value) => value > 0)
    metrics.push(
      centroids.length > 0
        ? metric('spectral_centroid_hz', median(centroids), {
            confidence: 0.8,
            method: 'median_frame_centroid',
            provider: MIX_ANALYSIS_PROVIDER,
            note: '',
          })
        : unmeasured('spectral_centroid_hz', { method: 'median_frame_centroid', provider: MIX_ANALYSIS_PROVIDER, note: 'No frame carried measurable energy.' }),
    )

    metrics.push(spectralTilt(spectrogram, active))

    const curves: MixCurve[] = BALANCE_BANDS.map((band) => ({
      key: `band_${band}`,
      stepMs: CURVE_STEP_MS,
      points: resampleShares(spectrogram, band),
    }))

    return { metrics, curves }
  },
}

/**
 * Slope of the average spectrum in dB per octave.
 *
 * A least-squares line through the six band levels against log2 of each band's
 * geometric centre. Most commercial records land between −3 and −6 dB/oct; the
 * number is descriptive, and this module never says a tilt is wrong.
 */
function spectralTilt(spectrogram: MixSpectrogram, active: number[]) {
  const points: Array<[number, number]> = []
  for (const band of BALANCE_BANDS) {
    const [low, high] = MIX_BANDS[band]
    if (low >= spectrogram.measurableCeilingHz) continue
    let sum = 0
    for (const frame of active) sum += spectrogram.bands[band][frame]
    const level = toDb(sum / active.length)
    // The geometric centre needs a non-zero lower edge: the sub band reaches
    // down to 0 Hz so the balance bands tile the spectrum, and sqrt(0 × 60) is
    // 0, whose log2 is −Infinity — which would poison the whole regression and
    // report the tilt as unmeasurable on every file. 20 Hz is the audible
    // floor and is the right lower edge for a *centre frequency* regardless of
    // where the band's bins start.
    const lowEdge = Math.max(20, low)
    const centre = Math.sqrt(lowEdge * Math.max(lowEdge, Math.min(high, spectrogram.measurableCeilingHz)))
    if (!Number.isFinite(centre) || centre <= 0) continue
    points.push([Math.log2(centre), level])
  }
  if (points.length < 3) {
    return unmeasured('spectral_tilt_db_per_oct', {
      method: 'least_squares_band_levels',
      provider: MIX_ANALYSIS_PROVIDER,
      note: 'Too few measurable bands in this file to fit a slope.',
    })
  }
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const xMean = mean(xs)
  const yMean = mean(ys)
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < points.length; i++) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean)
    denominator += (xs[i] - xMean) ** 2
  }
  if (denominator === 0) {
    return unmeasured('spectral_tilt_db_per_oct', { method: 'least_squares_band_levels', provider: MIX_ANALYSIS_PROVIDER, note: 'Band centres collapsed; no slope to fit.' })
  }
  return metric('spectral_tilt_db_per_oct', numerator / denominator, {
    confidence: 0.6,
    method: 'least_squares_band_levels',
    provider: MIX_ANALYSIS_PROVIDER,
    note: 'Descriptive only: a darker or brighter tilt is a choice, not a fault.',
  })
}

// ---------------------------------------------------------------------------
// stereo
// ---------------------------------------------------------------------------

export const stereoAnalyzer: MixAnalyzer = {
  id: 'stereo',
  version: '1.0.0',
  metricKeys: ['stereo_width', 'phase_correlation', 'stereo_imbalance_db', 'mono_fold_loss_db'],
  run(context): MixAnalyzerResult {
    const channels = context.audio.channels
    if (channels.length < 2) {
      const note = 'This file is mono, so it has no stereo field to measure.'
      return {
        metrics: this.metricKeys.map((key) => unmeasured(key, { method: 'mid_side', provider: MIX_ANALYSIS_PROVIDER, note })),
      }
    }

    const left = channels[0]
    const right = channels[1]
    const length = Math.min(left.length, right.length)
    const blockSize = Math.floor(0.25 * context.sourceSampleRate)

    let midEnergy = 0
    let sideEnergy = 0
    let leftEnergy = 0
    let rightEnergy = 0
    const correlations: Array<number | null> = []

    for (let offset = 0; offset < length; offset += blockSize) {
      const end = Math.min(length, offset + blockSize)
      let blockLeft = 0
      let blockRight = 0
      let cross = 0
      for (let i = offset; i < end; i++) {
        const l = left[i]
        const r = right[i]
        blockLeft += l * l
        blockRight += r * r
        cross += l * r
        const mid = (l + r) / 2
        const side = (l - r) / 2
        midEnergy += mid * mid
        sideEnergy += side * side
      }
      leftEnergy += blockLeft
      rightEnergy += blockRight
      const denominator = Math.sqrt(blockLeft * blockRight)
      // A silent or near-silent block has no correlation to report. Emitting a
      // spurious +1 there would flatten the curve and hide the real moments.
      correlations.push(denominator > 1e-9 && end - offset > blockSize / 2 ? Math.max(-1, Math.min(1, cross / denominator)) : null)
    }

    const measured = correlations.filter((value): value is number => value !== null)
    const width = midEnergy > 0 ? Math.sqrt(sideEnergy / midEnergy) : 0

    // A "stereo" file whose channels are identical is a mono file in a stereo
    // container. That is a fact about the file, not a width of zero.
    const dualMono = sideEnergy / (midEnergy + 1e-12) < 1e-8

    const monoRms = Math.sqrt(midEnergy / Math.max(1, length))
    const referenceRms = Math.sqrt((leftEnergy + rightEnergy) / 2 / Math.max(1, length))

    return {
      metrics: [
        dualMono
          ? unmeasured('stereo_width', {
              method: 'side_over_mid',
              provider: MIX_ANALYSIS_PROVIDER,
              note: 'Both channels are identical — this is a mono recording in a stereo container.',
            })
          : metric('stereo_width', width, { confidence: 0.75, method: 'side_over_mid', provider: MIX_ANALYSIS_PROVIDER, note: '' }),
        measured.length > 0
          ? metric('phase_correlation', mean(measured), {
              confidence: 0.8,
              method: 'block_normalized_cross_correlation',
              provider: MIX_ANALYSIS_PROVIDER,
              note: 'Mean over 250 ms blocks. Sustained negative values are what fold down badly to mono.',
            })
          : unmeasured('phase_correlation', { method: 'block_normalized_cross_correlation', provider: MIX_ANALYSIS_PROVIDER, note: 'No block carried signal in both channels.' }),
        leftEnergy > 0 && rightEnergy > 0
          ? metric('stereo_imbalance_db', 10 * Math.log10(leftEnergy / rightEnergy), {
              confidence: 0.9,
              method: 'channel_energy_ratio',
              provider: MIX_ANALYSIS_PROVIDER,
              note: 'Positive means the left channel carries more energy.',
            })
          : unmeasured('stereo_imbalance_db', { method: 'channel_energy_ratio', provider: MIX_ANALYSIS_PROVIDER, note: 'One channel carries no signal.' }),
        referenceRms > 0
          ? metric('mono_fold_loss_db', 20 * Math.log10((monoRms + 1e-12) / referenceRms), {
              confidence: 0.75,
              method: 'mono_sum_vs_channel_mean',
              provider: MIX_ANALYSIS_PROVIDER,
              note: 'Negative means level is lost when the mix is summed to mono.',
            })
          : unmeasured('mono_fold_loss_db', { method: 'mono_sum_vs_channel_mean', provider: MIX_ANALYSIS_PROVIDER, note: 'The file carries no signal to sum.' }),
      ],
      curves: [
        {
          key: 'phase_correlation',
          stepMs: 250,
          points: correlations.map((value) => (value === null ? null : Math.round(value * 1000) / 1000)),
        },
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// defects
// ---------------------------------------------------------------------------

export const defectAnalyzer: MixAnalyzer = {
  id: 'defects',
  version: '1.0.0',
  metricKeys: ['clipped_sample_pct', 'clipping_runs', 'dc_offset', 'lead_in_seconds', 'tail_seconds', 'internal_silence_count'],
  run(context): MixAnalyzerResult {
    // Full scale for float material is not exactly 1.0 after decoding, so the
    // threshold sits a hair below it. Three consecutive pinned samples is the
    // conventional definition of a clipping run — two can happen naturally.
    const CLIP_THRESHOLD = 0.9995
    const RUN_LENGTH = 3

    let clipped = 0
    let runs = 0
    let total = 0
    let dcSum = 0

    // Clipping is also emitted as a curve, because "0.02 % of samples clip" is
    // not actionable and "it clips at 2:14" is.
    const samplesPerBucket = Math.max(1, Math.round((CURVE_STEP_MS / 1000) * context.sourceSampleRate))
    const bucketCount = Math.max(1, Math.ceil(context.audio.frameCount / samplesPerBucket))
    const clipBuckets = new Array<number>(bucketCount).fill(0)

    for (const channel of context.audio.channels) {
      let run = 0
      for (let i = 0; i < channel.length; i++) {
        const value = channel[i]
        dcSum += value
        total++
        if (Math.abs(value) >= CLIP_THRESHOLD) {
          clipped++
          run++
          if (run === RUN_LENGTH) {
            runs++
            clipBuckets[Math.min(bucketCount - 1, Math.floor(i / samplesPerBucket))]++
          }
        } else {
          run = 0
        }
      }
    }

    const silence = analyzeSilence(context.frames)

    return {
      metrics: [
        metric('clipped_sample_pct', total > 0 ? (clipped / total) * 100 : 0, {
          confidence: 1,
          method: 'sample_threshold_0dbfs',
          provider: MIX_ANALYSIS_PROVIDER,
          note: '',
        }),
        metric('clipping_runs', runs, {
          confidence: 1,
          method: 'consecutive_pinned_samples',
          provider: MIX_ANALYSIS_PROVIDER,
          note: 'Runs of three or more consecutive samples at full scale.',
        }),
        metric('dc_offset', total > 0 ? dcSum / total : 0, {
          confidence: 1,
          method: 'mean_sample_value',
          provider: MIX_ANALYSIS_PROVIDER,
          note: '',
        }),
        metric('lead_in_seconds', silence.leadInSeconds, { confidence: 0.9, method: 'frame_energy_threshold', provider: MIX_ANALYSIS_PROVIDER, note: '' }),
        metric('tail_seconds', silence.tailSeconds, { confidence: 0.9, method: 'frame_energy_threshold', provider: MIX_ANALYSIS_PROVIDER, note: '' }),
        metric('internal_silence_count', silence.gaps.length, {
          confidence: 0.8,
          method: 'frame_energy_threshold',
          provider: MIX_ANALYSIS_PROVIDER,
          note: 'Gaps longer than 250 ms inside the programme. A deliberate stop counts as one.',
        }),
      ],
      curves: [{ key: 'clipping_runs', stepMs: CURVE_STEP_MS, points: clipBuckets }],
    }
  },
}

// ---------------------------------------------------------------------------
// low end
// ---------------------------------------------------------------------------

export const lowEndAnalyzer: MixAnalyzer = {
  id: 'low_end',
  version: '1.0.0',
  metricKeys: ['low_end_centroid_hz', 'kick_bass_masking_index'],
  run(context): MixAnalyzerResult {
    const { spectrogram } = context
    const active = activeFrames(spectrogram, ACTIVE_FLOOR_RMS)
    if (active.length < 4) {
      const note = 'Not enough programme material to describe the low end.'
      return { metrics: this.metricKeys.map((key) => unmeasured(key, { method: 'band_power', provider: MIX_ANALYSIS_PROVIDER, note })) }
    }

    // Energy-weighted centre of the bottom two bands. Where the weight sits —
    // 45 Hz versus 90 Hz — is what decides whether a record survives a phone.
    const subPower = active.reduce((sum, frame) => sum + spectrogram.bands.sub[frame], 0)
    const lowPower = active.reduce((sum, frame) => sum + spectrogram.bands.low[frame], 0)
    const totalLow = subPower + lowPower
    const centroid = totalLow > 0 ? (subPower * 40 + lowPower * 130) / totalLow : null

    const kick = smoothSeries(active.map((frame) => toDb(spectrogram.bands.kick[frame])), 1)
    const bass = smoothSeries(active.map((frame) => toDb(spectrogram.bands.bassBody[frame])), 1)
    const overlap = pearson(kick, bass)

    return {
      metrics: [
        centroid === null
          ? unmeasured('low_end_centroid_hz', { method: 'band_power_weighted_centre', provider: MIX_ANALYSIS_PROVIDER, note: 'This record carries no measurable low end.' })
          : metric('low_end_centroid_hz', centroid, {
              confidence: 0.55,
              method: 'band_power_weighted_centre',
              provider: MIX_ANALYSIS_PROVIDER,
              note: 'A two-band approximation, not a spectral peak finder.',
            }),
        overlap === null
          ? unmeasured('kick_bass_masking_index', {
              method: 'band_envelope_correlation',
              provider: MIX_ANALYSIS_PROVIDER,
              note: 'One of the two low bands is silent, so there is nothing to overlap.',
            })
          : metric('kick_bass_masking_index', Math.max(0, overlap), {
              confidence: 0.5,
              method: 'band_envelope_correlation',
              provider: MIX_ANALYSIS_PROVIDER,
              note: 'How often 40–100 Hz and 80–250 Hz peak together. High overlap is common and only sometimes a problem.',
            }),
      ],
      curves: [
        { key: 'band_kick', stepMs: CURVE_STEP_MS, points: resampleDb(spectrogram, 'kick') },
        { key: 'band_bass', stepMs: CURVE_STEP_MS, points: resampleDb(spectrogram, 'bassBody') },
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// midrange
// ---------------------------------------------------------------------------

export const midrangeAnalyzer: MixAnalyzer = {
  id: 'midrange',
  version: '1.0.0',
  metricKeys: ['midrange_congestion_index'],
  run(context): MixAnalyzerResult {
    const { spectrogram } = context
    const active = activeFrames(spectrogram, ACTIVE_FLOOR_RMS)
    if (active.length < 8) {
      return {
        metrics: [unmeasured('midrange_congestion_index', { method: 'band_share_steadiness', provider: MIX_ANALYSIS_PROVIDER, note: 'Not enough programme material to measure.' })],
      }
    }

    // Congestion is two things at once: a large share of the energy sitting in
    // 200 Hz–2 kHz, *and* that share barely moving. A busy but dynamic midrange
    // is an arrangement; a static one is a wall. Multiplying the two is what
    // stops a dense-but-moving mix from being flagged.
    const shares = active.map((frame) => {
      const total = spectrogram.total[frame]
      if (total <= 0) return 0
      return (spectrogram.bands.lowMid[frame] + spectrogram.bands.mid[frame]) / total
    })
    const averageShare = mean(shares)
    const movement = standardDeviation(shares)
    const steadiness = Math.max(0, 1 - movement / 0.12)
    const congestion = Math.max(0, Math.min(1, ((averageShare - 0.35) / 0.35) * steadiness))

    return {
      metrics: [
        metric('midrange_congestion_index', congestion, {
          confidence: 0.5,
          method: 'band_share_times_steadiness',
          provider: MIX_ANALYSIS_PROVIDER,
          note: `Midrange holds ${(averageShare * 100).toFixed(0)}% of the energy and varies by ${(movement * 100).toFixed(1)} points across the record.`,
        }),
      ],
      curves: [{ key: 'midrange_share', stepMs: CURVE_STEP_MS, points: resampleValues(spectrogram, shares, active) }],
    }
  },
}

// ---------------------------------------------------------------------------
// high frequency
// ---------------------------------------------------------------------------

export const highFrequencyAnalyzer: MixAnalyzer = {
  id: 'high_frequency',
  version: '1.0.0',
  metricKeys: ['harshness_index', 'sibilance_index'],
  run(context): MixAnalyzerResult {
    const { spectrogram } = context
    const active = activeFrames(spectrogram, ACTIVE_FLOOR_RMS)
    if (active.length < 8) {
      const note = 'Not enough programme material to measure the top end.'
      return { metrics: this.metricKeys.map((key) => unmeasured(key, { method: 'band_share', provider: MIX_ANALYSIS_PROVIDER, note })) }
    }

    const harshShares: number[] = []
    const sibilantShares: number[] = []
    for (const frame of active) {
      const total = spectrogram.total[frame]
      if (total <= 0) continue
      harshShares.push(spectrogram.bands.presence[frame] / total)
      sibilantShares.push(spectrogram.bands.sibilance[frame] / total)
    }

    // Harshness is *sustained* presence-band weight: a bright snare is a
    // transient, an abrasive record is a level. The 12 % / 24 % anchors are
    // this module's convention and are printed with the figure.
    const meanHarsh = mean(harshShares)
    const harshness = Math.max(0, Math.min(1, (meanHarsh - 0.12) / 0.12))

    // Sibilance is the opposite shape: brief excursions well above the record's
    // own baseline. Measuring it against the record's median rather than a
    // fixed threshold is what keeps a naturally bright mix from scoring high.
    const baseline = median(sibilantShares)
    const bursts = sibilantShares.filter((share) => share > baseline * 2.2 && share > 0.03).length
    const sibilance = sibilantShares.length > 0 ? Math.min(1, bursts / (sibilantShares.length * 0.08)) : 0

    const ceilingNote =
      spectrogram.measurableCeilingHz < 11000
        ? ` This file's sample rate limits measurement to ${Math.round(spectrogram.measurableCeilingHz)} Hz, so the figure is partial.`
        : ''

    return {
      metrics: [
        metric('harshness_index', harshness, {
          confidence: 0.5,
          method: 'presence_band_share_mapped_12_to_24pct',
          provider: MIX_ANALYSIS_PROVIDER,
          note: `2–5 kHz holds ${(meanHarsh * 100).toFixed(1)}% of the energy on average.${ceilingNote}`,
        }),
        metric('sibilance_index', sibilance, {
          confidence: 0.45,
          method: 'sibilant_burst_rate_vs_own_median',
          provider: MIX_ANALYSIS_PROVIDER,
          note: `${bursts} short 5–10 kHz excursions above this record's own baseline. An indicator of where to listen, not a verdict.${ceilingNote}`,
        }),
      ],
      curves: [
        { key: 'presence_share', stepMs: CURVE_STEP_MS, points: resampleValues(spectrogram, harshShares, active) },
        { key: 'sibilance_share', stepMs: CURVE_STEP_MS, points: resampleValues(spectrogram, sibilantShares, active) },
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// vocal
// ---------------------------------------------------------------------------

export const vocalAnalyzer: MixAnalyzer = {
  id: 'vocal',
  version: '1.0.0',
  metricKeys: ['vocal_presence_index', 'vocal_level_stability', 'vocal_masking_index'],
  run(context): MixAnalyzerResult {
    const { spectrogram } = context
    const active = activeFrames(spectrogram, ACTIVE_FLOOR_RMS)
    // The basis is stated in every note this analyzer emits. Without a stem
    // these are inferences about where a voice probably is; a dense guitar
    // record reads as vocal and the analyzer cannot tell. That limitation is
    // reported rather than hidden behind a confident number.
    const basis = context.isolatedVocal ? 'isolated stem' : 'full-mix spectral proxy'
    const confidenceCeiling = context.isolatedVocal ? 0.75 : 0.45

    if (active.length < 8) {
      const note = `Not enough programme material to estimate vocal behaviour (${basis}).`
      return { metrics: this.metricKeys.map((key) => unmeasured(key, { method: 'vocal_band_proxy', provider: MIX_ANALYSIS_PROVIDER, note })) }
    }

    const vocalLevels: number[] = []
    const accompaniment: number[] = []
    for (const frame of active) {
      const total = spectrogram.total[frame]
      if (total <= 0) continue
      vocalLevels.push(spectrogram.bands.vocalBand[frame] / total)
      accompaniment.push((spectrogram.bands.low[frame] + spectrogram.bands.lowMid[frame] + spectrogram.bands.highMid[frame]) / total)
    }

    const meanVocal = mean(vocalLevels)
    const threshold = Math.max(0.18, median(vocalLevels) * 0.9)
    const presentFrames = vocalLevels.filter((value) => value >= threshold).length
    const presence = vocalLevels.length > 0 ? presentFrames / vocalLevels.length : 0

    const stability = vocalLevels.length > 1 ? Math.max(0, 1 - standardDeviation(vocalLevels) / Math.max(1e-6, meanVocal)) : 0

    // Masking here is the accompaniment sharing the vocal's own band at the
    // same moment. It is a co-occurrence measure, not a psychoacoustic model,
    // and the note says so.
    const masking = pearson(vocalLevels, accompaniment)

    return {
      metrics: [
        metric('vocal_presence_index', presence, {
          confidence: confidenceCeiling,
          method: 'vocal_band_share_threshold',
          provider: MIX_ANALYSIS_PROVIDER,
          note: `Measured from the ${basis}. An instrumental or a dense guitar record can read as vocal.`,
        }),
        metric('vocal_level_stability', stability, {
          confidence: confidenceCeiling,
          method: 'inverse_coefficient_of_variation',
          provider: MIX_ANALYSIS_PROVIDER,
          note: `Measured from the ${basis}. A deliberate dynamic vocal performance also reads as unstable.`,
        }),
        masking === null
          ? unmeasured('vocal_masking_index', { method: 'band_cooccurrence', provider: MIX_ANALYSIS_PROVIDER, note: `No usable signal in the vocal band (${basis}).` })
          : metric('vocal_masking_index', Math.max(0, masking), {
              confidence: confidenceCeiling * 0.8,
              method: 'band_cooccurrence',
              provider: MIX_ANALYSIS_PROVIDER,
              note: `Co-occurrence of accompaniment energy with the vocal band (${basis}). Not a psychoacoustic masking model.`,
            }),
      ],
      curves: [{ key: 'vocal_band_share', stepMs: CURVE_STEP_MS, points: resampleValues(spectrogram, vocalLevels, active) }],
    }
  },
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/**
 * The default analyzer set.
 *
 * Order is presentation only — analyzers do not read each other's output, which
 * is what makes appending one safe.
 */
export const DEFAULT_MIX_ANALYZERS: MixAnalyzer[] = [
  levelAnalyzer,
  loudnessAnalyzer,
  dynamicsAnalyzer,
  spectralBalanceAnalyzer,
  stereoAnalyzer,
  defectAnalyzer,
  lowEndAnalyzer,
  midrangeAnalyzer,
  highFrequencyAnalyzer,
  vocalAnalyzer,
]

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Pearson correlation. Null when either series is constant — undefined, not zero. */
export function pearson(a: number[], b: number[]): number | null {
  const length = Math.min(a.length, b.length)
  if (length < 4) return null
  const aMean = mean(a.slice(0, length))
  const bMean = mean(b.slice(0, length))
  let numerator = 0
  let aVariance = 0
  let bVariance = 0
  for (let i = 0; i < length; i++) {
    const da = a[i] - aMean
    const db = b[i] - bMean
    numerator += da * db
    aVariance += da * da
    bVariance += db * db
  }
  if (aVariance <= 1e-12 || bVariance <= 1e-12) return null
  return numerator / Math.sqrt(aVariance * bVariance)
}

/** Averages a per-frame series into fixed-width buckets so a curve row stays small. */
function bucket(values: Array<number | null>, frameSeconds: number, stepMs: number): Array<number | null> {
  const perBucket = Math.max(1, Math.round(stepMs / 1000 / frameSeconds))
  const out: Array<number | null> = []
  for (let start = 0; start < values.length; start += perBucket) {
    let sum = 0
    let counted = 0
    for (let i = start; i < Math.min(values.length, start + perBucket); i++) {
      const value = values[i]
      if (value === null || !Number.isFinite(value)) continue
      sum += value
      counted++
    }
    out.push(counted === 0 ? null : Math.round((sum / counted) * 1000) / 1000)
  }
  return out
}

function resampleShares(spectrogram: MixSpectrogram, band: MixBandKey): Array<number | null> {
  const values: Array<number | null> = []
  for (let frame = 0; frame < spectrogram.count; frame++) {
    const total = spectrogram.total[frame]
    values.push(total > 0 && spectrogram.rms[frame] >= ACTIVE_FLOOR_RMS ? spectrogram.bands[band][frame] / total : null)
  }
  return bucket(values, spectrogram.frameSeconds, CURVE_STEP_MS)
}

function resampleDb(spectrogram: MixSpectrogram, band: MixBandKey): Array<number | null> {
  const values: Array<number | null> = []
  for (let frame = 0; frame < spectrogram.count; frame++) {
    values.push(spectrogram.rms[frame] >= ACTIVE_FLOOR_RMS ? toDb(spectrogram.bands[band][frame]) : null)
  }
  return bucket(values, spectrogram.frameSeconds, CURVE_STEP_MS)
}

/**
 * Projects a series that was computed over *active* frames back onto the full
 * timeline, so a curve's index still means a real moment in the record.
 */
function resampleValues(spectrogram: MixSpectrogram, values: number[], active: number[]): Array<number | null> {
  const full = new Array<number | null>(spectrogram.count).fill(null)
  for (let i = 0; i < Math.min(values.length, active.length); i++) full[active[i]] = values[i]
  return bucket(full, spectrogram.frameSeconds, CURVE_STEP_MS)
}

export { bucket as bucketSeries }
