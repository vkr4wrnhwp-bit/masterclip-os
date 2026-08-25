import { describe, expect, it } from 'vitest'
import { MemoryCacheStore, headerDecodeCheck, sha256HexOf } from '../src/store.js'

const wav = () => {
  const bytes = new Uint8Array(64)
  bytes.set([0x52, 0x49, 0x46, 0x46]) // RIFF
  bytes.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  return bytes
}

describe('memory cache store', () => {
  it('stores, hashes, sizes and lists files', async () => {
    const store = new MemoryCacheStore()
    await store.put('stems/a.wav', wav())
    expect(await store.exists('stems/a.wav')).toBe(true)
    expect(await store.bytes('stems/a.wav')).toBe(64)
    expect(await store.sha256('stems/a.wav')).toBe(await sha256HexOf(wav()))
    expect(await store.listPaths()).toEqual(['stems/a.wav'])
    expect(await store.totalBytes()).toBe(64)
    await store.delete('stems/a.wav')
    expect(await store.exists('stems/a.wav')).toBe(false)
  })

  it('reports decodability from real headers', async () => {
    const store = new MemoryCacheStore()
    await store.put('good.wav', wav())
    await store.put('junk.bin', new Uint8Array(64).fill(9))
    expect(await store.decodable('good.wav')).toBe(true)
    expect(await store.decodable('junk.bin')).toBe(false)
    expect(await store.decodable('missing')).toBe(false)
  })
})

describe('header decode check', () => {
  it('recognises common audio containers and rejects junk', async () => {
    expect(await headerDecodeCheck(wav())).toBe(true)
    const mp3 = new Uint8Array(64)
    mp3.set([0x49, 0x44, 0x33]) // ID3
    expect(await headerDecodeCheck(mp3)).toBe(true)
    expect(await headerDecodeCheck(new Uint8Array(10))).toBe(false)
  })
})
