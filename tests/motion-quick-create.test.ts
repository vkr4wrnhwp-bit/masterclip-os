import { describe, expect, it } from 'vitest'
import { emptyShot, validateShot, shotJsonSchema } from '@masterclip/shot-schema'

describe('MOTION native Quick Create cue contract', () => {
  const cue = { asset_id: 'ast-authorized-test', start_seconds: 12, end_seconds: 27, creative_look: 'cinematic', promotional_use_attested: true }
  const valid = () => emptyShot({
    generation_mode: 'text_to_video',
    action: 'Camera moves through an actual recording room.',
    music_cue: cue,
  })

  it('preserves exact song source, trim, and look through schema parsing', () => {
    const parsed = valid()
    expect(parsed.music_cue).toEqual(cue)
    expect(validateShot(parsed).ok).toBe(true)
  })

  it('refuses reversed, zero-length and overlong moments', () => {
    for (const [start, end] of [[5, 4], [5, 5], [5, 5.3], [1, 63]]) {
      const shot = valid()
      shot.music_cue = { ...cue, start_seconds: start, end_seconds: end }
      expect(validateShot(shot).issues.some(i => i.code === 'audio.invalid_song_moment')).toBe(true)
    }
  })

  it('refuses invalid audio metadata at schema boundaries', () => {
    const shot = valid()
    expect(validateShot({ ...shot, music_cue: { ...cue, asset_id: '' } }).ok).toBe(false)
    expect(validateShot({ ...shot, music_cue: { ...cue, start_seconds: -1 } }).ok).toBe(false)
    expect(validateShot({ ...shot, music_cue: { ...cue, end_seconds: Number.NaN } }).ok).toBe(false)
  })

  it('keeps professional legacy shots valid without a music cue', () => {
    const old = emptyShot({ generation_mode: 'text_to_video', action: 'A performer enters a recording booth.' })
    expect(old.music_cue).toBeNull()
    expect(validateShot(old).ok).toBe(true)
  })

  it('publishes a versioned schema describing the new optional cue', () => {
    expect(JSON.stringify(shotJsonSchema())).toContain('music_cue')
  })
})
