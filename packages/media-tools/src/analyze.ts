import { ffmpeg, type RunOptions } from './runner.js'

export interface Interval {
  startSeconds: number
  endSeconds: number
  durationSeconds: number
}

/**
 * Black-frame detection via ffmpeg's `blackdetect`.
 *
 * `d` is the minimum run length that counts; a single black frame at a cut is
 * normal, a black half-second at the head of an 8-second clip means the model
 * gave up. `pic_th` is the fraction of pixels below the threshold.
 */
export async function detectBlack(
  path: string,
  opts: { minDurationSeconds?: number; pixelThreshold?: number } & RunOptions = {},
): Promise<Interval[]> {
  const minDuration = opts.minDurationSeconds ?? 0.15
  const pictureThreshold = opts.pixelThreshold ?? 0.98
  const stderr = await ffmpeg(
    ['-i', path, '-vf', `blackdetect=d=${minDuration}:pic_th=${pictureThreshold}:pix_th=0.10`, '-an', '-f', 'null', '-'],
    { timeoutMs: 5 * 60_000, ...opts },
  )
  return [...stderr.matchAll(/black_start:(?<start>[\d.]+)\s+black_end:(?<end>[\d.]+)\s+black_duration:(?<dur>[\d.]+)/g)].map(
    (match) => ({
      startSeconds: Number(match.groups?.start ?? 0),
      endSeconds: Number(match.groups?.end ?? 0),
      durationSeconds: Number(match.groups?.dur ?? 0),
    }),
  )
}

/**
 * Frozen-frame detection via `freezedetect`. Catches the common failure where a
 * model returns a still image padded out to the requested duration — which
 * passes every container-level check and is worthless.
 */
export async function detectFreeze(
  path: string,
  opts: { minDurationSeconds?: number; noiseDb?: number } & RunOptions = {},
): Promise<Interval[]> {
  const minDuration = opts.minDurationSeconds ?? 0.7
  const noise = opts.noiseDb ?? -60
  const stderr = await ffmpeg(['-i', path, '-vf', `freezedetect=n=${noise}dB:d=${minDuration}`, '-an', '-f', 'null', '-'], {
    timeoutMs: 5 * 60_000,
    ...opts,
  })

  const starts = [...stderr.matchAll(/freeze_start:\s*(?<t>[\d.]+)/g)].map((m) => Number(m.groups?.t ?? 0))
  const ends = [...stderr.matchAll(/freeze_end:\s*(?<t>[\d.]+)/g)].map((m) => Number(m.groups?.t ?? 0))
  const durations = [...stderr.matchAll(/freeze_duration:\s*(?<t>[\d.]+)/g)].map((m) => Number(m.groups?.t ?? 0))

  // A freeze that runs to the end of the file gets a `freeze_start` and no
  // `freeze_end` — which is exactly the worst case (a still image padded to
  // length). Close the open interval at the clip duration rather than scoring
  // it as zero frozen seconds.
  let clipDuration: number | null = null
  if (starts.length > ends.length && durations.length < starts.length) {
    const { probe } = await import('./probe.js')
    clipDuration = await probe(path, opts)
      .then((info) => info.durationSeconds)
      .catch(() => null)
  }

  return starts.map((start, index) => {
    const explicitDuration = durations[index]
    const end = ends[index] ?? (explicitDuration !== undefined ? start + explicitDuration : (clipDuration ?? start))
    return { startSeconds: start, endSeconds: end, durationSeconds: explicitDuration ?? Math.max(0, end - start) }
  })
}

/**
 * Mean absolute frame-to-frame difference over sampled frames.
 *
 * Cheap proxy for "is anything actually moving": near zero means a static
 * plate; a high value with no camera move usually means flicker rather than
 * performance. Reported as a signal, never as a verdict on its own.
 */
export async function motionEnergy(path: string, opts: { sampleFps?: number } & RunOptions = {}): Promise<{
  meanDifference: number
  maxDifference: number
  samples: number
}> {
  const sampleFps = opts.sampleFps ?? 6
  // `tblend=difference` turns each sampled frame into its delta from the
  // previous one; `signalstats` then reports that delta's mean luma. Metadata
  // is printed to the log (stderr) rather than `file=-`, because stdout is
  // reserved for the null muxer.
  const stderr = await ffmpeg(
    ['-i', path, '-vf', `fps=${sampleFps},scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print`, '-an', '-f', 'null', '-'],
    { timeoutMs: 5 * 60_000, ...opts },
  )
  const values = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=(?<v>[\d.]+)/g)].map((m) => Number(m.groups?.v ?? 0))
  if (values.length === 0) return { meanDifference: 0, maxDifference: 0, samples: 0 }
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    meanDifference: Number((sum / values.length).toFixed(4)),
    maxDifference: Number(Math.max(...values).toFixed(4)),
    samples: values.length,
  }
}

/** Per-frame luma statistics, used to spot flat/blown exposure and dead clips. */
export async function lumaStats(path: string, opts: RunOptions = {}): Promise<{ mean: number; min: number; max: number; stdev: number }> {
  const stderr = await ffmpeg(['-i', path, '-vf', 'signalstats,metadata=print', '-an', '-f', 'null', '-'], {
    timeoutMs: 5 * 60_000,
    ...opts,
  })
  const values = [...stderr.matchAll(/lavfi\.signalstats\.YAVG=(?<v>[\d.]+)/g)].map((m) => Number(m.groups?.v ?? 0))
  if (values.length === 0) return { mean: 0, min: 0, max: 0, stdev: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return {
    mean: Number(mean.toFixed(3)),
    min: Number(Math.min(...values).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
    stdev: Number(Math.sqrt(variance).toFixed(3)),
  }
}
