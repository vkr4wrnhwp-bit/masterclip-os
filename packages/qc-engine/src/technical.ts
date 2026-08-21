import { stat } from 'node:fs/promises'
import { AppError, sha256File } from '@masterclip/shared'
import { decodeIntegrity, detectBlack, detectFreeze, lumaStats, motionEnergy, probe, type MediaInfo } from '@masterclip/media-tools'
import { frameSize, type CanonicalShot } from '@masterclip/shot-schema'

export interface QcFinding {
  code: string
  message: string
  /** `hard` fails the clip outright; `warning` is context for the human review. */
  severity: 'hard' | 'warning'
  measured?: string
  expected?: string
}

export interface TechnicalQcResult {
  pass: boolean
  hardFailures: QcFinding[]
  warnings: QcFinding[]
  measurements: {
    bytes: number
    sha256: string
    durationSeconds: number
    width: number
    height: number
    fps: number
    codec: string
    container: string
    bitRate: number | null
    hasAudio: boolean
    blackIntervals: number
    blackSeconds: number
    freezeIntervals: number
    freezeSeconds: number
    motionMean: number
    motionMax: number
    lumaMean: number
    lumaStdev: number
    decodeErrors: string[]
  }
}

export interface TechnicalQcOptions {
  /** Tolerance on duration, as a fraction of the requested length. */
  durationTolerance?: number
  /** Bits per second below which the clip is unusable regardless of content. */
  minBitRate?: number
  /** Frame-difference energy below which the clip is treated as static. */
  staticMotionThreshold?: number
  /** sha256 values of other outputs in the same batch, for duplicate detection. */
  siblingHashes?: string[]
  expectAudio?: boolean
}

/**
 * Deterministic technical QC.
 *
 * Everything here is measurement, not judgement: ffprobe, blackdetect,
 * freezedetect, a full decode pass, and arithmetic. No model is consulted,
 * because none is needed to know that a 4-second file was returned for an
 * 8-second request — and paying a vision model to notice that would be
 * exactly the waste this system exists to avoid.
 */
export async function runTechnicalQc(
  filePath: string,
  shot: CanonicalShot,
  opts: TechnicalQcOptions = {},
): Promise<TechnicalQcResult> {
  const hardFailures: QcFinding[] = []
  const warnings: QcFinding[] = []

  const fail = (code: string, message: string, measured?: string, expected?: string) =>
    hardFailures.push({ code, message, severity: 'hard', ...(measured ? { measured } : {}), ...(expected ? { expected } : {}) })
  const warn = (code: string, message: string, measured?: string, expected?: string) =>
    warnings.push({ code, message, severity: 'warning', ...(measured ? { measured } : {}), ...(expected ? { expected } : {}) })

  // --- the file itself ------------------------------------------------------
  let bytes = 0
  try {
    const info = await stat(filePath)
    bytes = info.size
    if (bytes === 0) fail('file.empty', 'output file is zero bytes')
  } catch (err) {
    fail('file.missing', `output file could not be read: ${(err as Error).message}`)
    return emptyResult(hardFailures, warnings)
  }

  const sha256 = await sha256File(filePath)
  if (opts.siblingHashes?.includes(sha256)) {
    fail('output.duplicate', 'byte-identical to another output in this batch — the provider returned the same render twice', sha256.slice(0, 12))
  }

  // --- container and streams ------------------------------------------------
  let info: MediaInfo
  try {
    info = await probe(filePath)
  } catch (err) {
    fail(
      'container.unreadable',
      `file is not a readable video container (${err instanceof AppError ? err.code : 'probe failed'}) — treat as a failed download, not a bad render`,
    )
    return emptyResult(hardFailures, warnings, { bytes, sha256 })
  }

  if (!info.video) {
    fail('stream.no_video', 'file contains no video stream')
    return emptyResult(hardFailures, warnings, { bytes, sha256 })
  }

  const expected = frameSize(shot.target_resolution, shot.aspect_ratio)
  const tolerance = opts.durationTolerance ?? 0.12

  // --- duration -------------------------------------------------------------
  const durationDelta = Math.abs(info.durationSeconds - shot.duration_seconds)
  if (info.durationSeconds <= 0) {
    fail('duration.zero', 'clip has no duration')
  } else if (durationDelta > shot.duration_seconds * tolerance) {
    fail(
      'duration.mismatch',
      `clip is ${info.durationSeconds.toFixed(2)}s but ${shot.duration_seconds}s was requested`,
      `${info.durationSeconds.toFixed(2)}s`,
      `${shot.duration_seconds}s ±${(tolerance * 100).toFixed(0)}%`,
    )
  }

  // --- geometry -------------------------------------------------------------
  if (info.video.width !== expected.width || info.video.height !== expected.height) {
    const aspectDelta = Math.abs(info.video.width / info.video.height - expected.width / expected.height)
    if (aspectDelta > 0.02) {
      fail(
        'resolution.aspect_mismatch',
        `delivered ${info.video.width}x${info.video.height}, which is a different aspect ratio than the requested ${shot.aspect_ratio}`,
        `${info.video.width}x${info.video.height}`,
        `${expected.width}x${expected.height}`,
      )
    } else {
      warn(
        'resolution.size_mismatch',
        `delivered ${info.video.width}x${info.video.height} instead of ${expected.width}x${expected.height} (same aspect ratio)`,
        `${info.video.width}x${info.video.height}`,
        `${expected.width}x${expected.height}`,
      )
    }
  }

  if (info.video.fps > 0 && Math.abs(info.video.fps - shot.fps) > 1.5) {
    warn('fps.mismatch', `delivered ${info.video.fps}fps instead of ${shot.fps}fps`, `${info.video.fps}`, `${shot.fps}`)
  }

  // --- audio ----------------------------------------------------------------
  const expectAudio = opts.expectAudio ?? (shot.audio_mode === 'native_generated' || shot.audio_mode === 'native_dialogue')
  if (expectAudio && !info.audio) fail('audio.missing', 'native audio was requested but the file has no audio stream')
  if (!expectAudio && info.audio) warn('audio.unexpected', 'file contains an audio stream that was not requested')

  // --- bitrate --------------------------------------------------------------
  const minBitRate = opts.minBitRate ?? 120_000
  if (info.bitRate !== null && info.bitRate < minBitRate) {
    fail(
      'bitrate.too_low',
      `overall bitrate is ${Math.round(info.bitRate / 1000)}kbps — the file is too compressed to be usable`,
      `${Math.round(info.bitRate / 1000)}kbps`,
      `≥${Math.round(minBitRate / 1000)}kbps`,
    )
  }

  // --- content --------------------------------------------------------------
  const [black, freeze, motion, luma, integrity] = await Promise.all([
    detectBlack(filePath).catch(() => []),
    detectFreeze(filePath).catch(() => []),
    motionEnergy(filePath).catch(() => ({ meanDifference: 0, maxDifference: 0, samples: 0 })),
    lumaStats(filePath).catch(() => ({ mean: 0, min: 0, max: 0, stdev: 0 })),
    decodeIntegrity(filePath).catch(() => ({ ok: true, errors: [] as string[] })),
  ])

  const blackSeconds = black.reduce((acc, i) => acc + i.durationSeconds, 0)
  const freezeSeconds = freeze.reduce((acc, i) => acc + i.durationSeconds, 0)

  if (blackSeconds > 0 && blackSeconds >= info.durationSeconds * 0.9) {
    fail('content.all_black', 'the entire clip is black')
  } else if (blackSeconds > Math.max(0.25, info.durationSeconds * 0.15)) {
    fail(
      'content.black_frames',
      `${blackSeconds.toFixed(2)}s of black frames`,
      `${blackSeconds.toFixed(2)}s`,
      `<${Math.max(0.25, info.durationSeconds * 0.15).toFixed(2)}s`,
    )
  } else if (blackSeconds > 0) {
    warn('content.black_frames_minor', `${blackSeconds.toFixed(2)}s of black frames near a boundary`)
  }

  if (freezeSeconds >= info.durationSeconds * 0.85) {
    fail('content.frozen', 'the clip is a still image held for the full duration — no motion was generated')
  } else if (freezeSeconds > info.durationSeconds * 0.3) {
    fail('content.long_freeze', `${freezeSeconds.toFixed(2)}s frozen out of ${info.durationSeconds.toFixed(2)}s`)
  } else if (freezeSeconds > 0) {
    warn('content.freeze_minor', `${freezeSeconds.toFixed(2)}s of frozen frames`)
  }

  // Calibrated against real renders: a clip with genuine movement scores
  // several units of mean frame difference, while a static plate with encoder
  // noise sits well under 1.
  const staticThreshold = opts.staticMotionThreshold ?? 1.0
  if (motion.samples > 0 && motion.meanDifference < staticThreshold && freezeSeconds === 0) {
    warn(
      'content.low_motion',
      `frame-to-frame change is very low (${motion.meanDifference}) — the clip may be effectively static`,
      `${motion.meanDifference}`,
      `≥${staticThreshold}`,
    )
  }

  if (!integrity.ok) {
    const message = integrity.errors.slice(0, 3).join(' | ')
    fail('decode.errors', `decoder reported errors: ${message}`)
  }

  return {
    pass: hardFailures.length === 0,
    hardFailures,
    warnings,
    measurements: {
      bytes,
      sha256,
      durationSeconds: Number(info.durationSeconds.toFixed(3)),
      width: info.video.width,
      height: info.video.height,
      fps: info.video.fps,
      codec: info.video.codec,
      container: info.formatName,
      bitRate: info.bitRate,
      hasAudio: Boolean(info.audio),
      blackIntervals: black.length,
      blackSeconds: Number(blackSeconds.toFixed(3)),
      freezeIntervals: freeze.length,
      freezeSeconds: Number(freezeSeconds.toFixed(3)),
      motionMean: motion.meanDifference,
      motionMax: motion.maxDifference,
      lumaMean: luma.mean,
      lumaStdev: luma.stdev,
      decodeErrors: integrity.errors,
    },
  }
}

function emptyResult(
  hardFailures: QcFinding[],
  warnings: QcFinding[],
  partial: Partial<TechnicalQcResult['measurements']> = {},
): TechnicalQcResult {
  return {
    pass: false,
    hardFailures,
    warnings,
    measurements: {
      bytes: 0,
      sha256: '',
      durationSeconds: 0,
      width: 0,
      height: 0,
      fps: 0,
      codec: '',
      container: '',
      bitRate: null,
      hasAudio: false,
      blackIntervals: 0,
      blackSeconds: 0,
      freezeIntervals: 0,
      freezeSeconds: 0,
      motionMean: 0,
      motionMax: 0,
      lumaMean: 0,
      lumaStdev: 0,
      decodeErrors: [],
      ...partial,
    },
  }
}
