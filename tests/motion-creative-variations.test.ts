import { describe, expect, it } from 'vitest'
import { emptyShot, validateShot } from '@masterclip/shot-schema'

const shot = () => emptyShot({
  generation_mode: 'text_to_video',
  action: 'Artist performs beneath one practical lamp.',
  duration_seconds: 8,
  music_cue: {
    asset_id: 'authorized-audio', start_seconds: 10, end_seconds: 18,
    promotional_use_attested: true, creative_look: 'editorial',
  },
})

describe('MOTION timed captions and variations', () => {
  it('preserves non-overlapping caption lines', () => {
    const actual = shot()
    actual.timed_captions = [
      {start_seconds:0,end_seconds:2,text:'First approved line'},
      {start_seconds:2.5,end_seconds:5,text:'Second approved line'},
    ]
    expect(validateShot(actual).ok).toBe(true)
    expect(actual.timed_captions).toHaveLength(2)
  })
  it('refuses overlapping and out-of-range captions', () => {
    const actual = shot()
    actual.timed_captions = [
      {start_seconds:0,end_seconds:3,text:'Line one'},
      {start_seconds:2,end_seconds:4,text:'Line two'},
      {start_seconds:7,end_seconds:9,text:'Out of range'},
    ]
    const issues = validateShot(actual).issues.map(issue => issue.code)
    expect(issues).toContain('captions.overlap')
    expect(issues).toContain('captions.outside_shot')
  })
  it('keeps original shot immutable while parsing alternative shot metadata', () => {
    const original = shot()
    const variation = emptyShot({
      ...original,
      shot_id: 'ALT-01',
      creative_variant: {source_shot_id:'source-01',label:'Performance alternate'},
      music_cue: {...original.music_cue!,creative_look:'performance'},
    })
    expect(validateShot(variation).ok).toBe(true)
    expect(original.creative_variant).toBeNull()
    expect(original.music_cue?.creative_look).toBe('editorial')
  })
})
