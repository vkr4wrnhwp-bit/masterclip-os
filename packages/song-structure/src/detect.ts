import {
  cosineSimilarity,
  emptyRegister,
  energyCurve,
  mean,
  melodicContour,
  normalize,
  registerProfile,
  smooth,
  standardDeviation,
  type AnalysisFrames,
  type DetectedSection,
  type SectionFeatures,
  type SectionType,
  type StructureAnalysisResult,
  type VocalActivity,
} from '@masterclip/song-analysis'

/**
 * Structure detection.
 *
 * Two stages, in the order a listener would do it:
 *
 *   1. *Where* do things change — a self-similarity matrix over per-frame
 *      timbre/energy descriptors, then a checkerboard novelty curve whose peaks
 *      are candidate boundaries.
 *   2. *What* is each part — segments are clustered by similarity, and the
 *      clusters are assigned musical roles from position, energy, repetition
 *      and vocal presence.
 *
 * Stage 2 is inference about convention, not measurement, and the confidence it
 * reports says so. Users are expected to correct it: a corrected boundary is
 * authoritative for the project from that moment on.
 */

export const STRUCTURE_ENGINE_VERSION = '1.0.0'

/** Frames are pooled to ~0.75 s before the similarity matrix — cheaper, and a
 *  section boundary is never meaningfully finer than that anyway. */
const POOL_SECONDS = 0.75
const MIN_SECTION_SECONDS = 6
const KERNEL_SECONDS = 8

export interface DetectOptions {
  /** Vocal activity, when available: instrumental sections are otherwise easy to mislabel. */
  vocal?: VocalActivity | null
  /** Beat times, used to snap boundaries to the nearest beat. */
  beats?: number[]
  providerId?: string
  modelVersion?: string
}

interface PooledFrames {
  stepSeconds: number
  count: number
  /** Analysis frames per pool, so a pool range maps back to a frame range. */
  perPool: number
  /** Per-pool descriptor used for similarity: chroma + bands + energy. */
  descriptors: number[][]
  energy: number[]
  lowBand: number[]
  midBand: number[]
  highBand: number[]
  flatness: number[]
  flux: number[]
  stereoWidth: number[]
  vocal: number[]
}

export function detectStructure(frames: AnalysisFrames, opts: DetectOptions = {}): StructureAnalysisResult {
  const providerId = opts.providerId ?? 'local-dsp'
  const modelVersion = opts.modelVersion ?? STRUCTURE_ENGINE_VERSION
  const durationSeconds = frames.count * frames.frameSeconds

  if (frames.count < 16 || durationSeconds < MIN_SECTION_SECONDS * 2) {
    // Too short to have a structure worth asserting. One honest section beats a
    // fabricated verse/chorus arrangement.
    const single: DetectedSection = {
      sectionType: 'custom',
      label: 'Full recording',
      startMs: 0,
      endMs: Math.round(durationSeconds * 1000),
      confidence: 0,
      orderIndex: 0,
    }
    return {
      sections: [single],
      features: [emptyFeatures()],
      confidence: 0,
      provider: providerId,
      modelVersion,
      method: 'too_short_for_segmentation',
    }
  }

  const pooled = poolFrames(frames, opts.vocal ?? null)
  const novelty = noveltyCurve(pooled)
  const boundaries = pickBoundaries(novelty, pooled, durationSeconds, opts.beats ?? [])
  const segments = segmentsFrom(boundaries, pooled, durationSeconds)
  const clusters = clusterSegments(segments, pooled)
  const labelled = assignRoles(segments, clusters, pooled, durationSeconds)

  const features = segments.map((segment) => featuresFor(segment, pooled, frames, opts.vocal ?? null))
  const confidence = segmentationConfidence(novelty, segments.length, durationSeconds)

  return {
    sections: labelled,
    features,
    confidence,
    provider: providerId,
    modelVersion,
    method: 'self_similarity_novelty_clustering',
  }
}

// --------------------------------------------------------------- pooling ----

function poolFrames(frames: AnalysisFrames, vocal: VocalActivity | null): PooledFrames {
  const perPool = Math.max(1, Math.round(POOL_SECONDS / frames.frameSeconds))
  const count = Math.max(1, Math.floor(frames.count / perPool))
  const energyPerFrame = energyCurve(frames)

  const pooled: PooledFrames = {
    stepSeconds: perPool * frames.frameSeconds,
    count,
    perPool,
    descriptors: [],
    energy: [],
    lowBand: [],
    midBand: [],
    highBand: [],
    flatness: [],
    flux: [],
    stereoWidth: [],
    vocal: [],
  }

  for (let pool = 0; pool < count; pool++) {
    const from = pool * perPool
    const to = Math.min(frames.count, from + perPool)
    const chroma = new Array<number>(12).fill(0)
    for (let i = from; i < to; i++) {
      for (let bin = 0; bin < 12; bin++) chroma[bin] = chroma[bin]! + (frames.chroma[i]?.[bin] ?? 0)
    }
    const span = Math.max(1, to - from)
    for (let bin = 0; bin < 12; bin++) chroma[bin] = chroma[bin]! / span

    const slice = (values: number[]) => mean(values.slice(from, to))
    const energy = mean(energyPerFrame.slice(from, to))
    const low = slice(frames.lowBand)
    const mid = slice(frames.midBand)
    const high = slice(frames.highBand)
    const flatness = slice(frames.flatness)
    const flux = slice(frames.flux)
    const width = frames.stereoWidth.length > 0 ? slice(frames.stereoWidth) : 0
    const vocalShare = vocal ? mean(vocal.active.slice(from, to).map((value) => (value ? 1 : 0))) : 0

    pooled.energy.push(energy)
    pooled.lowBand.push(low)
    pooled.midBand.push(mid)
    pooled.highBand.push(high)
    pooled.flatness.push(flatness)
    pooled.flux.push(flux)
    pooled.stereoWidth.push(width)
    pooled.vocal.push(vocalShare)
    // Timbre first, then level: two choruses at different masters' levels should
    // still read as the same section.
    pooled.descriptors.push([...chroma, low, mid, high, flatness, energy, vocalShare])
  }

  return pooled
}

// -------------------------------------------------------------- novelty -----

/**
 * Foote's checkerboard novelty: correlate a kernel along the diagonal of the
 * self-similarity matrix. High where the past stops resembling the future —
 * i.e. at a section change.
 */
function noveltyCurve(pooled: PooledFrames): number[] {
  const kernel = Math.max(2, Math.round(KERNEL_SECONDS / pooled.stepSeconds / 2))
  const novelty = new Array<number>(pooled.count).fill(0)
  for (let i = kernel; i < pooled.count - kernel; i++) {
    let before = 0
    let after = 0
    let across = 0
    let pairs = 0
    for (let a = 1; a <= kernel; a++) {
      for (let b = 1; b <= kernel; b++) {
        before += cosineSimilarity(pooled.descriptors[i - a]!, pooled.descriptors[i - b]!)
        after += cosineSimilarity(pooled.descriptors[i + a - 1]!, pooled.descriptors[i + b - 1]!)
        across += cosineSimilarity(pooled.descriptors[i - a]!, pooled.descriptors[i + b - 1]!)
        pairs++
      }
    }
    novelty[i] = pairs > 0 ? (before + after - 2 * across) / (2 * pairs) : 0
  }
  return smooth(novelty, 1)
}

function pickBoundaries(novelty: number[], pooled: PooledFrames, durationSeconds: number, beats: number[]): number[] {
  const minPools = Math.max(2, Math.round(MIN_SECTION_SECONDS / pooled.stepSeconds))
  const threshold = mean(novelty) + standardDeviation(novelty) * 0.6

  const peaks: Array<{ index: number; value: number }> = []
  for (let i = 1; i < novelty.length - 1; i++) {
    if (novelty[i]! > threshold && novelty[i]! >= novelty[i - 1]! && novelty[i]! >= novelty[i + 1]!) {
      peaks.push({ index: i, value: novelty[i]! })
    }
  }
  peaks.sort((a, b) => b.value - a.value)

  // Greedy, strongest-first, enforcing a musical minimum section length.
  const chosen: number[] = []
  for (const peak of peaks) {
    if (chosen.every((index) => Math.abs(index - peak.index) >= minPools)) chosen.push(peak.index)
    // A pop song has on the order of ten sections; more than this is noise.
    if (chosen.length >= 14) break
  }
  chosen.sort((a, b) => a - b)

  const seconds = chosen.map((index) => index * pooled.stepSeconds)
  return snapToBeats(seconds, beats, durationSeconds)
}

/** Nudges each boundary to the nearest beat within a quarter-second. */
function snapToBeats(boundaries: number[], beats: number[], durationSeconds: number): number[] {
  if (beats.length === 0) return boundaries
  return boundaries.map((time) => {
    let closest = time
    let best = Infinity
    for (const beat of beats) {
      const distance = Math.abs(beat - time)
      if (distance < best) {
        best = distance
        closest = beat
      }
    }
    return best <= 0.25 && closest > 0 && closest < durationSeconds ? closest : time
  })
}

interface Segment {
  fromPool: number
  toPool: number
  startSeconds: number
  endSeconds: number
}

function segmentsFrom(boundaries: number[], pooled: PooledFrames, durationSeconds: number): Segment[] {
  const edges = [0, ...boundaries, durationSeconds]
  const segments: Segment[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const startSeconds = edges[i]!
    const endSeconds = edges[i + 1]!
    if (endSeconds - startSeconds < 1) continue
    segments.push({
      fromPool: Math.floor(startSeconds / pooled.stepSeconds),
      toPool: Math.min(pooled.count, Math.ceil(endSeconds / pooled.stepSeconds)),
      startSeconds,
      endSeconds,
    })
  }
  return segments
}

// ------------------------------------------------------------ clustering ----

/** Agglomerates segments whose mean descriptors are close. Same cluster = same
 *  part of the song recurring. */
function clusterSegments(segments: Segment[], pooled: PooledFrames): number[] {
  const centroids = segments.map((segment) => segmentCentroid(segment, pooled))
  const assignment = segments.map((_, index) => index)
  const SIMILARITY = 0.92

  for (let i = 0; i < segments.length; i++) {
    for (let j = 0; j < i; j++) {
      if (assignment[j] !== j) continue
      if (cosineSimilarity(centroids[i]!, centroids[j]!) >= SIMILARITY) {
        assignment[i] = j
        break
      }
    }
  }
  // Renumber to dense cluster ids so callers can index by them.
  const dense = new Map<number, number>()
  return assignment.map((value) => {
    if (!dense.has(value)) dense.set(value, dense.size)
    return dense.get(value)!
  })
}

function segmentCentroid(segment: Segment, pooled: PooledFrames): number[] {
  const width = pooled.descriptors[0]?.length ?? 0
  const centroid = new Array<number>(width).fill(0)
  let counted = 0
  for (let i = segment.fromPool; i < segment.toPool; i++) {
    const descriptor = pooled.descriptors[i]
    if (!descriptor) continue
    for (let d = 0; d < width; d++) centroid[d] = centroid[d]! + descriptor[d]!
    counted++
  }
  if (counted > 0) for (let d = 0; d < width; d++) centroid[d] = centroid[d]! / counted
  return centroid
}

// ----------------------------------------------------------------- roles ----

/**
 * Assigns musical roles.
 *
 * These are conventions, not laws — a record can put its highest-energy
 * recurring section first and call it something else. The rules below encode
 * the *common* shape (an opening that recurs least, a recurring high-energy
 * cluster as chorus, a lower-energy vocal cluster as verse, a late unique
 * section as bridge) and every section carries a confidence the user can
 * overrule.
 */
function assignRoles(segments: Segment[], clusters: number[], pooled: PooledFrames, durationSeconds: number): DetectedSection[] {
  const energies = segments.map((segment) => mean(pooled.energy.slice(segment.fromPool, segment.toPool)))
  const vocals = segments.map((segment) => mean(pooled.vocal.slice(segment.fromPool, segment.toPool)))
  const normalizedEnergy = normalize(energies)

  const clusterCount = new Map<number, number>()
  for (const cluster of clusters) clusterCount.set(cluster, (clusterCount.get(cluster) ?? 0) + 1)

  // The recurring cluster with the highest mean energy is the chorus candidate.
  let chorusCluster: number | null = null
  let chorusEnergy = -Infinity
  for (const [cluster, count] of clusterCount) {
    if (count < 2) continue
    const indices = clusters.flatMap((value, index) => (value === cluster ? [index] : []))
    const energy = mean(indices.map((index) => normalizedEnergy[index]!))
    if (energy > chorusEnergy) {
      chorusEnergy = energy
      chorusCluster = cluster
    }
  }

  // The verse is the recurring cluster with real vocal presence and the lowest
  // energy that is not the chorus.
  let verseCluster: number | null = null
  let verseEnergy = Infinity
  for (const [cluster, count] of clusterCount) {
    if (cluster === chorusCluster || count < 2) continue
    const indices = clusters.flatMap((value, index) => (value === cluster ? [index] : []))
    const energy = mean(indices.map((index) => normalizedEnergy[index]!))
    const vocal = mean(indices.map((index) => vocals[index]!))
    if (energy < verseEnergy && vocal >= 0.2) {
      verseEnergy = energy
      verseCluster = cluster
    }
  }

  const types: SectionType[] = segments.map((segment, index) => {
    const isFirst = index === 0
    const isLast = index === segments.length - 1
    const cluster = clusters[index]!
    const energy = normalizedEnergy[index]!
    const vocal = vocals[index]!
    const positionRatio = segment.startSeconds / Math.max(1, durationSeconds)

    if (isFirst && (vocal < 0.25 || energy < 0.45)) return 'intro'
    if (isLast && (energy < 0.5 || vocal < 0.3)) return 'outro'
    if (chorusCluster !== null && cluster === chorusCluster) return 'chorus'
    if (verseCluster !== null && cluster === verseCluster) return 'verse'
    // A short, rising, single-occurrence segment immediately before a chorus is
    // the classic pre-chorus shape.
    const nextIsChorus = chorusCluster !== null && clusters[index + 1] === chorusCluster
    if (nextIsChorus && segment.endSeconds - segment.startSeconds <= 20 && (clusterCount.get(cluster) ?? 0) <= 2) return 'pre_chorus'
    if ((clusterCount.get(cluster) ?? 0) === 1 && positionRatio > 0.5 && positionRatio < 0.85) {
      return vocal >= 0.3 ? 'bridge' : 'instrumental'
    }
    if (vocal < 0.15) return 'instrumental'
    return 'verse'
  })

  // The last chorus is the final chorus — the section every "does it evolve?"
  // question in this product is about.
  const lastChorus = types.lastIndexOf('chorus')
  if (lastChorus >= 0 && types.filter((type) => type === 'chorus').length > 1) types[lastChorus] = 'final_chorus'

  const counters = new Map<SectionType, number>()
  return segments.map((segment, index) => {
    const sectionType = types[index]!
    const occurrence = (counters.get(sectionType) ?? 0) + 1
    counters.set(sectionType, occurrence)
    const repeats = types.filter((type) => type === sectionType).length
    return {
      sectionType,
      label: labelFor(sectionType, occurrence, repeats),
      startMs: Math.round(segment.startSeconds * 1000),
      endMs: Math.round(segment.endSeconds * 1000),
      // Cluster support is the evidence: a role assigned to a section that
      // recurs is better founded than one assigned to a singleton.
      confidence: roleConfidence(sectionType, clusterCount.get(clusters[index]!) ?? 1),
      orderIndex: index,
    }
  })
}

function labelFor(sectionType: SectionType, occurrence: number, total: number): string {
  const base: Record<SectionType, string> = {
    intro: 'Intro',
    verse: 'Verse',
    pre_chorus: 'Pre-Chorus',
    chorus: 'Chorus',
    post_chorus: 'Post-Chorus',
    hook: 'Hook',
    bridge: 'Bridge',
    break: 'Break',
    drop: 'Drop',
    instrumental: 'Instrumental',
    solo: 'Solo',
    breakdown: 'Breakdown',
    final_chorus: 'Final Chorus',
    outro: 'Outro',
    custom: 'Section',
  }
  return total > 1 ? `${base[sectionType]} ${occurrence}` : base[sectionType]
}

function roleConfidence(sectionType: SectionType, clusterSize: number): number {
  const support = Math.min(1, clusterSize / 3)
  switch (sectionType) {
    case 'chorus':
    case 'final_chorus':
    case 'verse':
      return Math.round((0.4 + support * 0.4) * 100) / 100
    case 'intro':
    case 'outro':
      return 0.6
    case 'pre_chorus':
    case 'bridge':
      // Inferred from position alone; deliberately modest.
      return 0.35
    default:
      return 0.3
  }
}

/**
 * How much to trust the segmentation as a whole: how sharply the novelty peaks
 * stand out, tempered by whether the section count is musically plausible.
 */
function segmentationConfidence(novelty: number[], sectionCount: number, durationSeconds: number): number {
  const spread = standardDeviation(novelty)
  const peakiness = Math.min(1, spread * 8)
  const perMinute = sectionCount / Math.max(1, durationSeconds / 60)
  const plausible = perMinute >= 1 && perMinute <= 6 ? 1 : 0.5
  return Math.round(Math.max(0, Math.min(0.85, peakiness * plausible)) * 100) / 100
}

// -------------------------------------------------------------- features ----

function featuresFor(segment: Segment, pooled: PooledFrames, frames: AnalysisFrames, activity: VocalActivity | null): SectionFeatures {
  const slice = (values: number[]) => values.slice(segment.fromPool, segment.toPool)
  const energy = mean(slice(pooled.energy))
  const low = mean(slice(pooled.lowBand))
  const mid = mean(slice(pooled.midBand))
  const high = mean(slice(pooled.highBand))
  const flatness = mean(slice(pooled.flatness))
  const flux = mean(slice(pooled.flux))
  const vocal = mean(slice(pooled.vocal))
  const width = pooled.stereoWidth.some((value) => value > 0) ? mean(slice(pooled.stereoWidth)) : null

  // Register and contour are measured on the raw frames rather than the pooled
  // ones: a pool is three quarters of a second, which is long enough to average
  // two sung notes into one that was never sung.
  const fromFrame = segment.fromPool * pooled.perPool
  const toFrame = Math.min(frames.count, segment.toPool * pooled.perPool)
  const register = activity ? registerProfile(activity, frames, fromFrame, toFrame) : null

  return {
    energy: round(energy),
    vocalOccupancy: round(vocal),
    // "How much is happening at once": spectral spread plus transient activity
    // plus low-end weight. A proxy for instrument count that does not require
    // source separation, and named as a proxy wherever it is shown.
    arrangementDensity: round(flatness * 0.4 + Math.min(1, flux * 4) * 0.35 + low * 0.25),
    spectralDensity: round(flatness),
    transientDensity: round(Math.min(1, flux * 4)),
    lowFrequencyDensity: round(low),
    stereoWidth: width === null ? null : round(width),
    rhythmicDensity: round(Math.min(1, flux * 5)),
    similarityVector: [energy, low, mid, high, flatness, vocal, width ?? 0].map(round),
    register: register
      ? { median: register.medianRegister, low: register.lowRegister, high: register.highRegister, confidence: register.confidence }
      : emptyRegister(),
    melodicContour: activity ? melodicContour(activity, frames, fromFrame, toFrame) : [],
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
    register: emptyRegister(),
    melodicContour: [],
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
