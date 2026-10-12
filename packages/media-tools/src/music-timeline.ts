import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AppError } from '@masterclip/shared'
import { ffmpeg } from './runner.js'
import { concat, replaceAudioMoment } from './transform.js'
import { probe } from './probe.js'

export interface VideoCutInput {
  path: string
  source_start_seconds: number
  source_end_seconds: number
}

export interface TimelineAssemblyOptions {
  clips: readonly VideoCutInput[]
  audioPath: string
  songStartSeconds: number
  outputPath: string
  /** Logical frame size of the first approved source, capped to 720p.
   * All sources are letterboxed to preserve framing; no hidden cropping.
   */
}

/** Real native short-form assembly.
 * Render each approved visual trim as a silent, CFR/H.264 standardized segment,
 * concatenate straight cuts, then bind the precise original audio recording.
 * No transitions, time stretching, captions, publication, model/provider calls
 * or invented synchronization. Every file is ffprobe-verified before return.
 */
export async function assembleMusicTimeline(input: TimelineAssemblyOptions): Promise<{
  path:string;durationSeconds:number;width:number;height:number;audioEmbedded:true
}> {
  if (!input.clips.length || input.clips.length > 16 ||
      !Number.isFinite(input.songStartSeconds) || input.songStartSeconds < 0) {
    throw new AppError({kind:'validation',code:'timeline.assembly_input',message:'1–16 clips and a valid song start are required'})
  }
  let sum = 0
  for (const clip of input.clips) {
    const length = clip.source_end_seconds - clip.source_start_seconds
    if (!(length >= .5 && length <= 60) || !Number.isFinite(length)) {
      throw new AppError({kind:'validation',code:'timeline.assembly_trim',message:'invalid source clip trim'})
    }
    sum += length
  }
  if (sum > 60.001) throw new AppError({kind:'validation',code:'timeline.assembly_length',message:'assembly exceeds sixty seconds'})
  const first = await probe(input.clips[0]!.path)
  if (!first.video || first.video.width <= 0 || first.video.height <= 0) {
    throw new AppError({kind:'validation',code:'timeline.assembly_video',message:'first source is not a decodable video'})
  }
  const aspect = first.video.width / first.video.height
  const targetHeight = aspect >= 1 ? 720 : Math.round(720 / aspect / 2) * 2
  const targetWidth = aspect >= 1 ? Math.round(720 * aspect / 2) * 2 : 720
  const work = await mkdtemp(join(tmpdir(),'motion-timeline-assemble-'))
  try {
    const files:string[] = []
    for (const [index,clip] of input.clips.entries()) {
      const metadata = index === 0 ? first : await probe(clip.path)
      if (!metadata.video || metadata.durationSeconds + .05 < clip.source_end_seconds) {
        throw new AppError({kind:'validation',code:'timeline.assembly_source_short',message:'approved source clip does not contain its requested trim'})
      }
      const segment = join(work, 'part-'+index+'.mp4')
      const duration = clip.source_end_seconds - clip.source_start_seconds
      await ffmpeg([
        '-ss',clip.source_start_seconds.toFixed(3),'-i',clip.path,
        '-t',duration.toFixed(3),'-an',
        '-vf',`scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1,format=yuv420p`,
        '-c:v','libx264','-preset','fast','-crf','20','-movflags','+faststart',segment,
      ],{timeoutMs:240_000})
      files.push(segment)
    }
    const joined = join(work,'silent-cut.mp4')
    await concat(files,joined,{reencode:false})
    await mkdir(dirname(input.outputPath),{recursive:true})
    const result = await replaceAudioMoment(
      joined,input.audioPath,input.outputPath,input.songStartSeconds,
      input.songStartSeconds+sum,{timeoutMs:240_000},
    )
    const verified = await probe(input.outputPath)
    if (!verified.video||!verified.audio||verified.durationSeconds < sum-.45||
        verified.durationSeconds > sum+.45) {
      throw new AppError({kind:'io',code:'timeline.assembly_invalid_output',message:'composed MP4 failed technical verification'})
    }
    return {
      path:result.path,durationSeconds:verified.durationSeconds,
      width:verified.video.width,height:verified.video.height,audioEmbedded:true,
    }
  } finally { await rm(work,{recursive:true,force:true}) }
}
