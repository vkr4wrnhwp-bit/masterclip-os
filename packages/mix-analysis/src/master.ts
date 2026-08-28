import { metricValue } from './analyze.js'
import type { MixMetric } from './types.js'

/**
 * Master directions and the processing plan each one produces.
 *
 * The rules this file exists to enforce:
 *
 *   - **A direction is a set of targets, not a preset named after anybody.**
 *     Nothing here imitates a named engineer, a named studio, or the measured
 *     characteristics of a specific commercial master. The targets are generic
 *     translation goals, and the reasoning for each is written down.
 *   - **The plan is data.** A rendition stores the exact stages it applied, so a
 *     year later anyone can read what was done to the record. A master whose
 *     processing cannot be recovered is a master nobody can reason about.
 *   - **The plan adapts to the mix.** Directions describe intent; the amount of
 *     each move is computed from what the analysis actually found, so
 *     "competitive" on a mix that is already at −9 LUFS does almost nothing.
 */

export const MASTER_DIRECTIONS = ['transparent', 'competitive', 'warm', 'open', 'modern', 'custom'] as const

export type MasterDirection = (typeof MASTER_DIRECTIONS)[number]

export interface MasterDirectionInfo {
  key: MasterDirection
  label: string
  summary: string
  /** What the direction is actually optimising, in the operator's own words. */
  intent: string
  targetLufs: number
  targetTruePeakDbtp: number
  /** How hard the dynamics stage is allowed to work, in dB of gain reduction. */
  maxGainReductionDb: number
  /** Broad tonal moves, in dB. Applied only as far as the mix has room for them. */
  tilt: { lowShelfDb: number; presenceDb: number; airDb: number }
  /** Harmonic drive, 0–1. Zero means the chain adds no colour at all. */
  drive: number
}

export const MASTER_DIRECTION_INFO: MasterDirectionInfo[] = [
  {
    key: 'transparent',
    label: 'Transparent',
    summary: 'Preserve mix character.',
    intent: 'Level and ceiling only. Nothing is shaped, so what you approved in the mix is what gets delivered.',
    targetLufs: -14,
    targetTruePeakDbtp: -1,
    maxGainReductionDb: 1.5,
    tilt: { lowShelfDb: 0, presenceDb: 0, airDb: 0 },
    drive: 0,
  },
  {
    key: 'competitive',
    label: 'Competitive',
    summary: 'Higher perceived level while protecting transients.',
    intent: 'Trades some dynamic range for level, with the limiter kept below the point where attacks start to disappear.',
    targetLufs: -9,
    targetTruePeakDbtp: -1,
    maxGainReductionDb: 5,
    tilt: { lowShelfDb: -0.5, presenceDb: 0.5, airDb: 0.5 },
    drive: 0.15,
  },
  {
    key: 'warm',
    label: 'Warm',
    summary: 'Controlled top end and richer harmonic character.',
    intent: 'Softens the presence region and adds low-order harmonic content, for material that reads as brittle on consumer playback.',
    targetLufs: -12,
    targetTruePeakDbtp: -1,
    maxGainReductionDb: 3,
    tilt: { lowShelfDb: 1, presenceDb: -1.5, airDb: -0.5 },
    drive: 0.3,
  },
  {
    key: 'open',
    label: 'Open',
    summary: 'Greater perceived dimension and transient preservation.',
    intent: 'Keeps the limiter almost out of the way and lifts the extremes slightly, at the cost of competitive level.',
    targetLufs: -15,
    targetTruePeakDbtp: -1,
    maxGainReductionDb: 1,
    tilt: { lowShelfDb: 0.5, presenceDb: 0, airDb: 1 },
    drive: 0,
  },
  {
    key: 'modern',
    label: 'Modern',
    summary: 'Balanced contemporary streaming presentation.',
    intent: 'Sits at the level platform normalisation targets, with a mild contemporary tilt and moderate control.',
    targetLufs: -11,
    targetTruePeakDbtp: -1,
    maxGainReductionDb: 3.5,
    tilt: { lowShelfDb: 0.5, presenceDb: 0.5, airDb: 1 },
    drive: 0.12,
  },
  {
    key: 'custom',
    label: 'Custom',
    summary: 'You choose the priorities.',
    intent: 'Starts from the transparent chain; every target comes from what you set.',
    targetLufs: -12,
    targetTruePeakDbtp: -1,
    maxGainReductionDb: 3,
    tilt: { lowShelfDb: 0, presenceDb: 0, airDb: 0 },
    drive: 0,
  },
]

export function masterDirectionInfo(direction: MasterDirection): MasterDirectionInfo {
  return MASTER_DIRECTION_INFO.find((info) => info.key === direction) ?? MASTER_DIRECTION_INFO[0]
}

/** What a user may override on a custom direction. Every field is optional. */
export interface MasterPriorities {
  targetLufs?: number
  targetTruePeakDbtp?: number
  lowShelfDb?: number
  presenceDb?: number
  airDb?: number
  drive?: number
  maxGainReductionDb?: number
  /** Refuses every tonal and dynamics stage; level and ceiling only. */
  preserveMixCharacter?: boolean
}

export interface MasterStage {
  /** highpass | low_shelf | presence | air | dynamics | drive | gain | limiter */
  stage: string
  /** Human-readable, printed in the UI next to the rendition. */
  description: string
  params: Record<string, number | string>
}

export interface MasterRenderPlan {
  direction: MasterDirection
  targetLufs: number
  targetTruePeakDbtp: number
  stages: MasterStage[]
  /**
   * What the plan expects to change, so a user can see the intent *before*
   * rendering and compare it with what actually happened afterwards.
   */
  expectation: string
  /** Anything the plan deliberately did not do, and why. */
  restraint: string[]
}

/**
 * Builds the processing plan for one direction against one measured mix.
 *
 * Every move is bounded by what the mix already is. Three cases the bounding
 * exists for:
 *
 *   - A mix already at −8 LUFS asked for "competitive" needs no gain, so it
 *     gets none rather than 6 dB of pointless limiting.
 *   - A mix with 22 % of its energy below 200 Hz does not get a low shelf lift
 *     on top, whatever the direction nominally says.
 *   - A mix with no measurable headroom is told so, and the plan says what it
 *     could not do rather than doing it anyway.
 */
export function planMaster(
  direction: MasterDirection,
  metrics: MixMetric[],
  priorities: MasterPriorities = {},
): MasterRenderPlan {
  const info = masterDirectionInfo(direction)
  const preserve = priorities.preserveMixCharacter === true || direction === 'transparent'

  const targetLufs = priorities.targetLufs ?? info.targetLufs
  const targetTruePeak = priorities.targetTruePeakDbtp ?? info.targetTruePeakDbtp

  const currentLufs = metricValue(metrics, 'integrated_lufs')
  const currentTruePeak = metricValue(metrics, 'true_peak_dbtp')
  const dynamicRange = metricValue(metrics, 'dynamic_range_db')
  const lowShare = (metricValue(metrics, 'sub_energy_pct') ?? 0) + (metricValue(metrics, 'low_energy_pct') ?? 0)
  const harshness = metricValue(metrics, 'harshness_index')
  const dcOffset = metricValue(metrics, 'dc_offset')

  const stages: MasterStage[] = []
  const restraint: string[] = []

  // --- corrective -----------------------------------------------------------
  if (dcOffset !== null && Math.abs(dcOffset) > 0.002) {
    stages.push({
      stage: 'highpass',
      description: 'A 20 Hz high-pass, because the mix carries a standing DC offset that would otherwise spend headroom on silence.',
      params: { frequencyHz: 20, order: 2 },
    })
  }

  // --- tonal ----------------------------------------------------------------
  if (preserve) {
    restraint.push('No tonal shaping was applied: this direction preserves the mix exactly as delivered.')
  } else {
    const lowShelf = priorities.lowShelfDb ?? info.tilt.lowShelfDb
    if (lowShelf > 0 && lowShare > 34) {
      restraint.push(`The low shelf was skipped: this mix already carries ${lowShare.toFixed(0)}% of its energy below 200 Hz.`)
    } else if (Math.abs(lowShelf) >= 0.25) {
      stages.push({
        stage: 'low_shelf',
        description: `${lowShelf > 0 ? 'Lifts' : 'Trims'} the weight below 120 Hz by ${Math.abs(lowShelf).toFixed(1)} dB.`,
        params: { frequencyHz: 120, gainDb: lowShelf, q: 0.7 },
      })
    }

    const presence = priorities.presenceDb ?? info.tilt.presenceDb
    if (presence > 0 && harshness !== null && harshness > 0.55) {
      restraint.push(`The presence lift was skipped: this mix already measures ${(harshness * 100).toFixed(0)}% on the upper-mid concentration indicator.`)
    } else if (Math.abs(presence) >= 0.25) {
      stages.push({
        stage: 'presence',
        description: `${presence > 0 ? 'Opens' : 'Softens'} the 3 kHz region by ${Math.abs(presence).toFixed(1)} dB.`,
        params: { frequencyHz: 3000, gainDb: presence, q: 0.9 },
      })
    }

    const air = priorities.airDb ?? info.tilt.airDb
    if (Math.abs(air) >= 0.25) {
      stages.push({
        stage: 'air',
        description: `${air > 0 ? 'Adds' : 'Removes'} ${Math.abs(air).toFixed(1)} dB above 12 kHz.`,
        params: { frequencyHz: 12000, gainDb: air, q: 0.7 },
      })
    }
  }

  // --- dynamics -------------------------------------------------------------
  const maxReduction = priorities.maxGainReductionDb ?? info.maxGainReductionDb
  if (!preserve && maxReduction > 0.5) {
    // A mix that is already tightly controlled gets less compression, not more:
    // stacking a second stage on top of a limited mix is where masters lose
    // their attacks entirely.
    const allowance = dynamicRange === null ? maxReduction * 0.5 : Math.min(maxReduction, Math.max(0, (dynamicRange - 4) / 2))
    if (allowance < 0.5) {
      restraint.push(
        dynamicRange === null
          ? 'Compression was held back: the mix could not be measured well enough to know how much it would tolerate.'
          : `Compression was held back: the mix already measures ${dynamicRange.toFixed(1)} dB of dynamic range.`,
      )
    } else {
      stages.push({
        stage: 'dynamics',
        description: `Gentle bus compression, allowed up to ${allowance.toFixed(1)} dB of gain reduction.`,
        params: { thresholdDb: -18, ratio: 2, attackMs: 30, releaseMs: 200, maxReductionDb: allowance },
      })
    }
  }

  const drive = priorities.drive ?? info.drive
  if (!preserve && drive > 0.02) {
    stages.push({
      stage: 'drive',
      description: `Low-order harmonic saturation at ${(drive * 100).toFixed(0)}% — colour, not distortion.`,
      params: { amount: drive },
    })
  }

  // --- level ----------------------------------------------------------------
  const gainDb = currentLufs === null ? 0 : targetLufs - currentLufs
  if (currentLufs === null) {
    restraint.push('No loudness target was applied: the mix loudness could not be measured, so raising it would be guesswork.')
  } else {
    stages.push({
      stage: 'gain',
      description: `${gainDb >= 0 ? 'Raises' : 'Lowers'} the level by ${Math.abs(gainDb).toFixed(1)} dB to reach ${targetLufs} LUFS.`,
      params: { gainDb, fromLufs: currentLufs, toLufs: targetLufs },
    })
  }

  stages.push({
    stage: 'limiter',
    description: `Holds the ceiling at ${targetTruePeak} dBTP.`,
    params: { ceilingDbtp: targetTruePeak, releaseMs: 50 },
  })

  const expectation =
    currentLufs === null
      ? `This chain applies ${stages.length} stage${stages.length === 1 ? '' : 's'} and holds the ceiling at ${targetTruePeak} dBTP. Loudness could not be measured, so no level target was set.`
      : `Expect roughly ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB of level, landing near ${targetLufs} LUFS with a ${targetTruePeak} dBTP ceiling.` +
        (currentTruePeak !== null && currentTruePeak > -1 ? ' The mix arrives with little headroom, so the limiter will work harder than it otherwise would.' : '')

  return { direction, targetLufs, targetTruePeakDbtp: targetTruePeak, stages, expectation, restraint }
}

// ---------------------------------------------------------------------------
// A/B at matched loudness
// ---------------------------------------------------------------------------

/**
 * The gain to apply to `candidate` so it plays at the same loudness as
 * `reference`.
 *
 * This is not a nicety. A mastering chain that adds 5 dB sounds better to
 * everyone, every time, for reasons that have nothing to do with the
 * mastering — which is exactly how a product talks a user into approving a
 * master they would otherwise reject. Every comparison surface in Studio applies
 * this, and there is no code path that plays an unmatched A/B.
 */
export function loudnessMatchGainDb(referenceLufs: number | null, candidateLufs: number | null): number | null {
  if (referenceLufs === null || candidateLufs === null) return null
  return Math.round((referenceLufs - candidateLufs) * 100) / 100
}

export interface MasterComparisonRow {
  metricKey: string
  label: string
  before: number | null
  after: number | null
  delta: number | null
  unit: string
  /** True when the change is large enough to be worth showing. */
  meaningful: boolean
}

/** How much a metric must move before it is worth putting in front of someone. */
const MEANINGFUL_DELTA: Record<string, number> = {
  integrated_lufs: 0.5,
  true_peak_dbtp: 0.2,
  dynamic_range_db: 0.5,
  loudness_range_lu: 0.5,
  stereo_width: 0.03,
  phase_correlation: 0.05,
  sub_energy_pct: 1,
  low_energy_pct: 1,
  low_mid_energy_pct: 1,
  mid_energy_pct: 1,
  high_mid_energy_pct: 1,
  high_energy_pct: 1,
  spectral_centroid_hz: 150,
  spectral_tilt_db_per_oct: 0.3,
  transient_retention: 0.05,
  harshness_index: 0.05,
}

/**
 * What actually changed between the source and a rendition.
 *
 * Only the metrics with a declared meaningfulness threshold are compared, and
 * each row says whether the movement clears it. A table of twelve numbers that
 * all moved by 0.01 tells a user nothing except that something happened.
 */
export function compareMasterMetrics(before: MixMetric[], after: MixMetric[], labels: Record<string, string>): MasterComparisonRow[] {
  const rows: MasterComparisonRow[] = []
  for (const [key, threshold] of Object.entries(MEANINGFUL_DELTA)) {
    const beforeMetric = before.find((entry) => entry.key === key)
    const afterMetric = after.find((entry) => entry.key === key)
    if (!beforeMetric && !afterMetric) continue
    const beforeValue = beforeMetric?.value ?? null
    const afterValue = afterMetric?.value ?? null
    const delta = beforeValue !== null && afterValue !== null ? Math.round((afterValue - beforeValue) * 1000) / 1000 : null
    rows.push({
      metricKey: key,
      label: labels[key] ?? key,
      before: beforeValue,
      after: afterValue,
      delta,
      unit: afterMetric?.unit ?? beforeMetric?.unit ?? 'index',
      meaningful: delta !== null && Math.abs(delta) >= threshold,
    })
  }
  return rows
}
