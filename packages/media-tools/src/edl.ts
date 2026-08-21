export interface SequenceClip {
  name: string
  /** Path or file name as it will appear in the delivery package. */
  file: string
  durationSeconds: number
  fps: number
  width: number
  height: number
}

function timecode(seconds: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(seconds * fps))
  const f = totalFrames % Math.round(fps)
  const totalSeconds = Math.floor(totalFrames / fps)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`
}

/**
 * CMX3600 EDL for handing an approved sequence to an editor.
 *
 * Deliberately minimal: video-only, straight cuts, one event per approved
 * master. An EDL that claims transitions or audio tracks the package does not
 * contain would be worse than none.
 */
export function buildEdl(title: string, clips: SequenceClip[]): string {
  const fps = clips[0]?.fps ?? 24
  const lines = [`TITLE: ${title.replace(/[\r\n]/g, ' ')}`, 'FCM: NON-DROP FRAME', '']
  let recordIn = 0
  clips.forEach((clip, index) => {
    const event = String(index + 1).padStart(3, '0')
    const sourceOut = clip.durationSeconds
    const recordOut = recordIn + clip.durationSeconds
    lines.push(
      `${event}  AX       V     C        ${timecode(0, clip.fps)} ${timecode(sourceOut, clip.fps)} ${timecode(recordIn, fps)} ${timecode(recordOut, fps)}`,
    )
    lines.push(`* FROM CLIP NAME: ${clip.name}`)
    lines.push(`* SOURCE FILE: ${clip.file}`)
    lines.push('')
    recordIn = recordOut
  })
  return lines.join('\n')
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c)
}

/** FCPXML 1.9 sequence for Final Cut / Resolve import. */
export function buildFcpXml(title: string, clips: SequenceClip[]): string {
  const fps = clips[0]?.fps ?? 24
  const width = clips[0]?.width ?? 1920
  const height = clips[0]?.height ?? 1080
  const frameDuration = `1/${Math.round(fps)}s`
  const assets = clips
    .map(
      (clip, index) =>
        `      <asset id="a${index + 1}" name="${xmlEscape(clip.name)}" start="0s" hasVideo="1" format="r1" duration="${Math.round(
          clip.durationSeconds * fps,
        )}/${Math.round(fps)}s"><media-rep kind="original-media" src="file://${xmlEscape(clip.file)}"/></asset>`,
    )
    .join('\n')

  let offsetFrames = 0
  const spine = clips
    .map((clip, index) => {
      const frames = Math.round(clip.durationSeconds * fps)
      const element = `          <asset-clip ref="a${index + 1}" name="${xmlEscape(clip.name)}" offset="${offsetFrames}/${Math.round(
        fps,
      )}s" duration="${frames}/${Math.round(fps)}s" start="0s"/>`
      offsetFrames += frames
      return element
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r1" name="FFVideoFormat${height}p${Math.round(fps)}" frameDuration="${frameDuration}" width="${width}" height="${height}"/>
${assets}
  </resources>
  <library>
    <event name="${xmlEscape(title)}">
      <project name="${xmlEscape(title)}">
        <sequence format="r1" duration="${offsetFrames}/${Math.round(fps)}s" tcStart="0s" tcFormat="NDF">
          <spine>
${spine}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`
}
