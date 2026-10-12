import { z } from 'zod/v4'

/**
 * Non-destructive music-video edit decision list.
 * Video is previewed from genuinely approved masters. Saving does not render,
 * concatenate, pay providers, publish or modify any media assets.
 */
export const TimelineClip = z.object({
  master_id: z.string().min(1),
  source_start_seconds: z.number().finite().min(0),
  source_end_seconds: z.number().finite().positive(),
})
export type TimelineClip = z.infer<typeof TimelineClip>

export const MotionTimelineInput = z.object({
  name: z.string().trim().min(1).max(120),
  audio_asset_id: z.string().min(1),
  song_start_seconds: z.number().finite().min(0),
  clips: z.array(TimelineClip).min(1).max(16),
})
export type MotionTimelineInput = z.infer<typeof MotionTimelineInput>

/** Validate user-authored edit math independently of the API's asset/rights
 * checks. No invented transitions or video-frame interpolation.
 */
export function timelineDuration(spec: MotionTimelineInput): number {
  let duration = 0
  for (const clip of spec.clips) {
    const span = clip.source_end_seconds - clip.source_start_seconds
    if (!Number.isFinite(span) || span < 0.5 || span > 60) {
      throw new Error('Every clip must have a positive duration from 0.5 to 60 seconds')
    }
    duration += span
  }
  if (duration < 0.5 || duration > 60.001) {
    throw new Error('Timeline length must be between 0.5 and 60 seconds')
  }
  return Number(duration.toFixed(3))
}
