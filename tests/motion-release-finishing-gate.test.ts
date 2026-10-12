import { describe, expect, it } from 'vitest'
import { nativeFinishingEnabled, requireNativeFinishing } from '@masterclip/runtime'

describe('MOTION controlled-release FFmpeg safety gate', () => {
  it('fails closed in production with no explicit enablement', () => {
    expect(nativeFinishingEnabled({NODE_ENV:'production'},{})).toBe(false)
    expect(() => requireNativeFinishing({NODE_ENV:'production'},{})).toThrow(/paused during controlled release/)
  })
  it('allows explicit controlled feature enablement', () => {
    const env={MOTION_ENABLE_NEW_MEDIA_FINISHING:'true'}
    expect(nativeFinishingEnabled({NODE_ENV:'production'},env)).toBe(true)
    expect(() => requireNativeFinishing({NODE_ENV:'production'},env)).not.toThrow()
  })
  it('preserves the pre-existing test/development finishing workflows', () => {
    expect(nativeFinishingEnabled({NODE_ENV:'test'},{})).toBe(true)
    expect(nativeFinishingEnabled({NODE_ENV:'development'},{})).toBe(true)
    expect(nativeFinishingEnabled({NODE_ENV:'production'},
      {MOTION_ENABLE_NEW_MEDIA_FINISHING:'yes'})).toBe(false)
  })
})
