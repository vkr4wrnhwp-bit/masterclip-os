import type { TranscriptSegmentData } from '@masterclip/audio-core'

/** SRT/VTT builders — pure functions over transcript segments. */

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function timestamp(ms: number, separator: ',' | '.'): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`
}

export function buildSrt(segments: TranscriptSegmentData[]): string {
  return segments
    .map((segment, index) => `${index + 1}\n${timestamp(segment.startMs, ',')} --> ${timestamp(segment.endMs, ',')}\n${segment.text}\n`)
    .join('\n')
}

export function buildVtt(segments: TranscriptSegmentData[]): string {
  const cues = segments
    .map((segment) => `${timestamp(segment.startMs, '.')} --> ${timestamp(segment.endMs, '.')}\n${segment.text}\n`)
    .join('\n')
  return `WEBVTT\n\n${cues}`
}
