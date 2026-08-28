import { metricValue } from './analyze.js'
import type { MixMetric } from './types.js'

/**
 * Translation Lab.
 *
 * The one thing this module must never do is claim to *simulate* a device.
 * Nothing here models a specific speaker's impulse response, cabinet, driver
 * behaviour or DSP, and every result says so. What it does is narrower and
 * defensible: given a playback context described by a bandwidth, a mono/stereo
 * behaviour and a typical listening level, estimate how much of the record's
 * measured energy survives, and what the listener is left with.
 *
 * `modelled: false` on every target is the honest state of this implementation.
 * The field exists because a validated, measured device model is a plausible
 * future, and the UI must be able to tell the two apart the day one arrives —
 * rather than the product quietly upgrading its claims.
 */

export const TRANSLATION_TARGETS = [
  'phone_speaker',
  'laptop',
  'earbuds',
  'car',
  'bluetooth_speaker',
  'studio_monitors',
  'club',
  'large_pa',
  'mono',
  'low_volume',
] as const

export type TranslationTarget = (typeof TRANSLATION_TARGETS)[number]

export interface TranslationTargetInfo {
  key: TranslationTarget
  label: string
  /** Usable band, in Hz. Everything outside it is treated as not reaching the listener. */
  bandwidthHz: [number, number]
  /** Whether the target collapses the stereo image. */
  mono: boolean
  /** Typical listening level, used for the loudness-dependent bands. */
  typicalSpl: 'quiet' | 'moderate' | 'loud'
  /** Playback-side emphasis, in dB, applied per band before estimating. */
  emphasis: { low: number; mid: number; high: number }
  description: string
  /**
   * False for every target today: these are analytical estimates from published
   * bandwidth characteristics, not measured device models.
   */
  modelled: boolean
}

export const TRANSLATION_TARGET_INFO: TranslationTargetInfo[] = [
  {
    key: 'phone_speaker',
    label: 'Phone speaker',
    bandwidthHz: [500, 12000],
    mono: true,
    typicalSpl: 'quiet',
    emphasis: { low: -12, mid: 3, high: 0 },
    description: 'A single small driver with essentially no output below 500 Hz, summed to mono.',
    modelled: false,
  },
  {
    key: 'laptop',
    label: 'Laptop',
    bandwidthHz: [300, 15000],
    mono: false,
    typicalSpl: 'quiet',
    emphasis: { low: -9, mid: 2, high: 1 },
    description: 'Small drivers close together — nominally stereo, effectively near-mono at any distance.',
    modelled: false,
  },
  {
    key: 'earbuds',
    label: 'Consumer earbuds',
    bandwidthHz: [40, 18000],
    mono: false,
    typicalSpl: 'moderate',
    emphasis: { low: 3, mid: 0, high: 3 },
    description: 'Wide bandwidth with a consumer smile curve, heard very close to the ear.',
    modelled: false,
  },
  {
    key: 'car',
    label: 'Car',
    bandwidthHz: [50, 16000],
    mono: false,
    typicalSpl: 'loud',
    emphasis: { low: 4, mid: -2, high: 1 },
    description: 'A small, reflective space with strong low-frequency reinforcement and high background noise.',
    modelled: false,
  },
  {
    key: 'bluetooth_speaker',
    label: 'Bluetooth speaker',
    bandwidthHz: [80, 15000],
    mono: true,
    typicalSpl: 'moderate',
    emphasis: { low: 2, mid: 1, high: -1 },
    description: 'One enclosure, heavily processed, usually summed to mono, often with dynamic bass boost.',
    modelled: false,
  },
  {
    key: 'studio_monitors',
    label: 'Studio monitors',
    bandwidthHz: [40, 20000],
    mono: false,
    typicalSpl: 'moderate',
    emphasis: { low: 0, mid: 0, high: 0 },
    description: 'The reference case — what you already hear.',
    modelled: false,
  },
  {
    key: 'club',
    label: 'Club playback',
    bandwidthHz: [25, 18000],
    mono: true,
    typicalSpl: 'loud',
    emphasis: { low: 8, mid: -1, high: 2 },
    description: 'Substantial sub extension, played loud, with the low end summed to mono by the system.',
    modelled: false,
  },
  {
    key: 'large_pa',
    label: 'Large PA',
    bandwidthHz: [35, 18000],
    mono: false,
    typicalSpl: 'loud',
    emphasis: { low: 5, mid: 1, high: -2 },
    description: 'High level over distance, where air absorption takes the top end and the low end dominates.',
    modelled: false,
  },
  {
    key: 'mono',
    label: 'Mono',
    bandwidthHz: [20, 20000],
    mono: true,
    typicalSpl: 'moderate',
    emphasis: { low: 0, mid: 0, high: 0 },
    description: 'Full bandwidth, both channels summed. Isolates phase behaviour from everything else.',
    modelled: false,
  },
  {
    key: 'low_volume',
    label: 'Low-volume playback',
    bandwidthHz: [20, 20000],
    mono: false,
    typicalSpl: 'quiet',
    emphasis: { low: -6, mid: 0, high: -4 },
    description: 'Full bandwidth at a level where the ear itself is least sensitive at the extremes.',
    modelled: false,
  },
]

export function translationTargetInfo(target: TranslationTarget): TranslationTargetInfo | undefined {
  return TRANSLATION_TARGET_INFO.find((info) => info.key === target)
}

export interface TranslationEstimate {
  target: TranslationTarget
  label: string
  /** 0–100. How much of the record's measured character is expected to survive. */
  survival: number | null
  /** Share of the record's total measured energy inside this target's band. */
  energyInBandPct: number | null
  observations: string[]
  /** Repeated on every estimate, because it is the claim being made. */
  basis: string
  modelled: boolean
  confidence: number
}

const BASIS =
  'An analytical estimate from published bandwidth and playback characteristics — not a measured model of any specific device. Treat it as a prompt to go and listen, not as a substitute for listening.'

/**
 * Estimates how a mix behaves on each playback context.
 *
 * Deliberately built from the band shares and stereo metrics the analyzers
 * already produced rather than from re-filtering the audio: re-filtering would
 * *look* more convincing while resting on exactly the same assumptions about
 * what each device does, and would invite the claim this file exists to avoid.
 */
export function estimateTranslation(metrics: MixMetric[], targets: TranslationTarget[] = [...TRANSLATION_TARGETS]): TranslationEstimate[] {
  const bands = {
    sub: metricValue(metrics, 'sub_energy_pct'),
    low: metricValue(metrics, 'low_energy_pct'),
    lowMid: metricValue(metrics, 'low_mid_energy_pct'),
    mid: metricValue(metrics, 'mid_energy_pct'),
    highMid: metricValue(metrics, 'high_mid_energy_pct'),
    high: metricValue(metrics, 'high_energy_pct'),
  }
  const correlation = metricValue(metrics, 'phase_correlation')
  const monoLoss = metricValue(metrics, 'mono_fold_loss_db')
  const dynamicRange = metricValue(metrics, 'dynamic_range_db')
  const lufs = metricValue(metrics, 'integrated_lufs')
  const harshness = metricValue(metrics, 'harshness_index')

  // Band centres, so a target's bandwidth can be intersected with the measured
  // balance without pretending to more resolution than six bands provide.
  const bandRanges: Array<[keyof typeof bands, number, number]> = [
    ['sub', 20, 60],
    ['low', 60, 200],
    ['lowMid', 200, 600],
    ['mid', 600, 2000],
    ['highMid', 2000, 6000],
    ['high', 6000, 20000],
  ]

  return targets.map((target) => {
    const info = translationTargetInfo(target)
    if (!info) {
      return { target, label: target, survival: null, energyInBandPct: null, observations: [], basis: BASIS, modelled: false, confidence: 0 }
    }

    const measurable = bandRanges.filter(([key]) => bands[key] !== null)
    if (measurable.length < 4) {
      return {
        target,
        label: info.label,
        survival: null,
        energyInBandPct: null,
        observations: ['The spectral balance of this file could not be measured well enough to estimate translation.'],
        basis: BASIS,
        modelled: false,
        confidence: 0,
      }
    }

    // Fraction of each band that falls inside the target's usable range,
    // weighted by how much energy the record puts there.
    let inBand = 0
    let total = 0
    let lost: Array<[string, number]> = []
    for (const [key, low, high] of measurable) {
      const share = bands[key] ?? 0
      total += share
      const overlapLow = Math.max(low, info.bandwidthHz[0])
      const overlapHigh = Math.min(high, info.bandwidthHz[1])
      // Overlap in log-frequency: an octave lost at the bottom matters as much
      // as an octave lost at the top, which linear overlap would not capture.
      const fraction = overlapHigh <= overlapLow ? 0 : Math.log2(overlapHigh / overlapLow) / Math.log2(high / low)
      inBand += share * fraction
      if (fraction < 0.6 && share > 3) lost.push([bandLabel(key), share * (1 - fraction)])
    }
    lost = lost.sort((a, b) => b[1] - a[1]).slice(0, 2)

    const energyInBandPct = total > 0 ? (inBand / total) * 100 : null
    const observations: string[] = []

    for (const [label, amount] of lost) {
      observations.push(`About ${amount.toFixed(0)}% of the record's energy sits in the ${label} region, most of which this playback does not reproduce.`)
    }

    if (info.mono) {
      if (correlation !== null && correlation < 0) {
        observations.push(`This playback sums to mono, and the record's mean channel correlation is ${correlation.toFixed(2)} — some material will partly cancel.`)
      } else if (monoLoss !== null && monoLoss < -1) {
        observations.push(`Summed to mono the record loses about ${Math.abs(monoLoss).toFixed(1)} dB, which this playback will apply.`)
      } else {
        observations.push('This playback sums to mono; the record folds down without measurable loss.')
      }
    }

    if (info.typicalSpl === 'quiet' && dynamicRange !== null && dynamicRange > 12) {
      observations.push(`At the low levels this playback is usually heard at, ${dynamicRange.toFixed(1)} dB of dynamic range means the quiet passages may fall below the room.`)
    }
    if (info.typicalSpl === 'loud' && lufs !== null && lufs > -8) {
      observations.push('Played loud, a record already this dense tends to read as flat rather than powerful.')
    }
    if (info.emphasis.high > 0 && harshness !== null && harshness > 0.5) {
      observations.push(`This playback lifts the top end by roughly ${info.emphasis.high} dB, and the record already measures ${(harshness * 100).toFixed(0)}% on the upper-mid concentration indicator.`)
    }

    if (observations.length === 0) observations.push('Nothing in the measurements suggests this record changes character on this playback.')

    // Survival combines what is in band with the mono and level penalties. It
    // is a rough composite by construction, and its confidence says so.
    let survival = energyInBandPct ?? 0
    if (info.mono && correlation !== null && correlation < 0) survival -= Math.abs(correlation) * 30
    if (info.mono && monoLoss !== null && monoLoss < 0) survival -= Math.min(20, Math.abs(monoLoss) * 6)
    if (info.emphasis.high > 0 && (harshness ?? 0) > 0.5) survival -= 8

    return {
      target,
      label: info.label,
      survival: Math.round(Math.max(0, Math.min(100, survival))),
      energyInBandPct: energyInBandPct === null ? null : Math.round(energyInBandPct * 10) / 10,
      observations,
      basis: BASIS,
      modelled: info.modelled,
      confidence: 0.35,
    }
  })
}

function bandLabel(key: string): string {
  switch (key) {
    case 'sub':
      return 'sub (below 60 Hz)'
    case 'low':
      return 'low (60–200 Hz)'
    case 'lowMid':
      return 'low-mid (200–600 Hz)'
    case 'mid':
      return 'mid (600 Hz–2 kHz)'
    case 'highMid':
      return 'high-mid (2–6 kHz)'
    default:
      return 'high (above 6 kHz)'
  }
}
