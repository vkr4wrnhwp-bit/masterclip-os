import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, test, type Page } from '@playwright/test'

/**
 * The two Live Lab subsystems Node cannot exercise at all: the IndexedDB show
 * cache and the Web Audio output path. Both were previously verified only
 * through in-memory stand-ins (`MemoryCacheStore`, `TestAudioBackend`), which
 * says nothing about whether the browser implementations work.
 *
 * These run the shipping classes in real Chromium, against real IndexedDB,
 * real WebCrypto and a real AudioContext, on the app's own origin — localhost
 * is a secure context, so `crypto.subtle`, `navigator.storage` and
 * `audioWorklet` are all present, exactly as they are in production.
 *
 * What this still does NOT prove: that anything is *audible*. Rendering the
 * right samples and driving a loudspeaker are different claims, and only a
 * rehearsal on real hardware settles the second one.
 */

const here = dirname(fileURLToPath(import.meta.url))
let fixtureBundle = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // Bundled rather than imported: the classes under test are workspace TS, and
  // production deliberately exposes none of them on `window`.
  const result = await build({
    entryPoints: [join(here, 'fixtures/browser-runtime.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
  })
  fixtureBundle = result.outputFiles[0]?.text ?? ''
  expect(fixtureBundle.length).toBeGreaterThan(0)
})

/** Loads the app origin and injects the real implementations. */
async function withRuntime(page: Page): Promise<void> {
  await page.goto('/')
  await page.addScriptTag({ content: fixtureBundle })
  await page.waitForFunction(() => typeof window.__liveLab === 'object')
}

// ------------------------------------------------------- IndexedDB cache --

test('the show cache round-trips audio through real IndexedDB byte-identically', async ({ page }) => {
  await withRuntime(page)

  const result = await page.evaluate(async () => {
    const { IndexedDbCacheStore, encodeWavPcm16, synthesize, sha256HexOf } = window.__liveLab
    const wav = encodeWavPcm16(synthesize({ bpm: 120, bars: 1, seed: 7, energy: 0.8, layers: { kick: true, bass: true } }))

    const store = await IndexedDbCacheStore.open('e2e-roundtrip')
    await store.clear()
    await store.put('audio/scene-a.wav', wav)

    const back = await store.get('audio/scene-a.wav')
    const identical = !!back && back.length === wav.length && back.every((b, i) => b === wav[i])

    const out = {
      identical,
      storedBytes: await store.bytes('audio/scene-a.wav'),
      sourceBytes: wav.length,
      exists: await store.exists('audio/scene-a.wav'),
      missing: await store.exists('audio/nope.wav'),
      // The store's digest must agree with a digest of the original bytes:
      // package verification compares exactly these two numbers.
      storeDigest: await store.sha256('audio/scene-a.wav'),
      sourceDigest: await sha256HexOf(wav),
      digestOfMissing: await store.sha256('audio/nope.wav'),
      paths: await store.listPaths(),
      total: await store.totalBytes(),
    }
    store.close()
    return out
  })

  expect(result.identical).toBe(true)
  expect(result.storedBytes).toBe(result.sourceBytes)
  expect(result.exists).toBe(true)
  expect(result.missing).toBe(false)
  expect(result.storeDigest).toHaveLength(64)
  expect(result.storeDigest).toBe(result.sourceDigest)
  // A file that is not there has no digest — it must not read as "matches".
  expect(result.digestOfMissing).toBe('')
  expect(result.paths).toEqual(['audio/scene-a.wav'])
  expect(result.total).toBe(result.sourceBytes)
})

test('a single corrupted byte changes the cached digest', async ({ page }) => {
  await withRuntime(page)

  const { before, after, decodableClean, decodableGarbage } = await page.evaluate(async () => {
    const { IndexedDbCacheStore, encodeWavPcm16, synthesize } = window.__liveLab
    const wav = encodeWavPcm16(synthesize({ bpm: 120, bars: 1, seed: 11, energy: 0.5, layers: { kick: true, hat: true } }))

    const store = await IndexedDbCacheStore.open('e2e-corruption')
    await store.clear()
    await store.put('audio/scene.wav', wav)
    const before = await store.sha256('audio/scene.wav')
    const decodableClean = await store.decodable('audio/scene.wav')

    // Flip one bit deep in the audio data — the kind of corruption a truncated
    // write or a failing disk produces, invisible to a length check.
    const damaged = new Uint8Array(wav)
    damaged[Math.floor(damaged.length / 2)] ^= 0x01
    await store.put('audio/scene.wav', damaged)
    const after = await store.sha256('audio/scene.wav')

    await store.put('audio/garbage.wav', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    const decodableGarbage = await store.decodable('audio/garbage.wav')

    store.close()
    return { before, after, decodableClean, decodableGarbage }
  })

  expect(before).toHaveLength(64)
  expect(after).not.toBe(before)
  expect(decodableClean).toBe(true)
  // Not a WAV: the header check must refuse it rather than let a package verify.
  expect(decodableGarbage).toBe(false)
})

test('a cached show survives a page reload', async ({ page }) => {
  // The whole point of the offline package: the audio is still there after the
  // browser is closed and reopened at the venue, with no network.
  await withRuntime(page)

  const written = await page.evaluate(async () => {
    const { IndexedDbCacheStore, encodeWavPcm16, synthesize } = window.__liveLab
    const wav = encodeWavPcm16(synthesize({ bpm: 100, bars: 1, seed: 23, energy: 0.6, layers: { kick: true, pad: true } }))
    const store = await IndexedDbCacheStore.open('e2e-persistence')
    await store.clear()
    await store.put('audio/opening.wav', wav)
    const digest = await store.sha256('audio/opening.wav')
    store.close()
    return { digest, bytes: wav.length }
  })

  await page.reload()
  await page.addScriptTag({ content: fixtureBundle })
  await page.waitForFunction(() => typeof window.__liveLab === 'object')

  const survived = await page.evaluate(async () => {
    const { IndexedDbCacheStore } = window.__liveLab
    const store = await IndexedDbCacheStore.open('e2e-persistence')
    const out = {
      paths: await store.listPaths(),
      digest: await store.sha256('audio/opening.wav'),
      bytes: await store.bytes('audio/opening.wav'),
    }
    store.close()
    return out
  })

  expect(survived.paths).toEqual(['audio/opening.wav'])
  expect(survived.bytes).toBe(written.bytes)
  expect(survived.digest).toBe(written.digest)
})

test('storage headroom and persistence are reported honestly', async ({ page }) => {
  await withRuntime(page)

  const { available, persisted } = await page.evaluate(async () => {
    const { estimateAvailableStorageBytes, requestPersistentStorage } = window.__liveLab
    return {
      available: await estimateAvailableStorageBytes(),
      persisted: await requestPersistentStorage(),
    }
  })

  // Present in this browser, so it must be a real number rather than undefined.
  expect(typeof available).toBe('number')
  expect(available).toBeGreaterThan(0)
  // Granting is the browser's decision; the contract is that we report it.
  expect(typeof persisted).toBe('boolean')
})

// --------------------------------------------------------- Web Audio path --

test('the Web Audio backend decodes generated scene audio in a real AudioContext', async ({ page }) => {
  await withRuntime(page)

  const result = await page.evaluate(async () => {
    const { WebAudioBackend, encodeWavPcm16, synthesize } = window.__liveLab
    const wav = encodeWavPcm16(synthesize({ bpm: 120, bars: 2, seed: 5, energy: 0.7, layers: { kick: true, bass: true, hat: true } }))

    const backend = new WebAudioBackend()
    await backend.resume()
    const loaded = await backend.load('scene-a', wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength))

    return {
      name: backend.name,
      durationSeconds: loaded.durationSeconds,
      isLoaded: backend.isLoaded('scene-a'),
      unknownLoaded: backend.isLoaded('nope'),
      reportedDuration: backend.duration('scene-a'),
      // 2 bars at 120bpm = 4 seconds.
      expectedSeconds: 4,
    }
  })

  expect(result.name).toBe('web-audio')
  expect(result.isLoaded).toBe(true)
  expect(result.unknownLoaded).toBe(false)
  expect(result.durationSeconds).toBeCloseTo(result.expectedSeconds, 1)
  expect(result.reportedDuration).toBeCloseTo(result.expectedSeconds, 1)
})

test('gain is genuinely applied to the rendered samples', async ({ page }) => {
  await withRuntime(page)

  // Renders the real backend's graph offline and measures the output. This is
  // the strongest claim available without hardware: the nodes the product
  // builds produce the amplitudes the product intends.
  const peaks = await page.evaluate(async () => {
    const { WebAudioBackend, encodeWavPcm16 } = window.__liveLab

    async function renderAt(gain: number): Promise<number> {
      const sampleRate = 22050
      const seconds = 0.5
      // Full-scale DC so the measurement is about gain, not about the signal.
      const samples = new Float32Array(Math.round(sampleRate * seconds)).fill(1)
      const wav = encodeWavPcm16(samples, sampleRate)

      const offline = new OfflineAudioContext(2, Math.round(sampleRate * seconds), sampleRate)
      const backend = new WebAudioBackend(offline as unknown as AudioContext)
      await backend.load('tone', wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength))
      backend.play({ sampleId: 'tone', when: 0, gain, pan: 0 })

      const rendered = await offline.startRendering()
      const channel = rendered.getChannelData(0)
      let peak = 0
      for (const sample of channel) peak = Math.max(peak, Math.abs(sample))
      return peak
    }

    return { full: await renderAt(1), half: await renderAt(0.5), silent: await renderAt(0) }
  })

  // Something actually came out.
  expect(peaks.full).toBeGreaterThan(0.1)
  // Halving the gain halves the output. Compared as a ratio because a centred
  // StereoPanner applies its own equal-power factor to a mono source.
  expect(peaks.half / peaks.full).toBeCloseTo(0.5, 2)
  // Zero gain is silence, not "quiet".
  expect(peaks.silent).toBeLessThan(1e-4)
})

test('the AudioWorklet click processor compiles and registers', async ({ page }) => {
  await withRuntime(page)

  const result = await page.evaluate(async () => {
    const { createClickNode } = window.__liveLab
    const context = new AudioContext()
    try {
      const node = await createClickNode(context)
      // Reaching here means the Blob-URL module parsed and registerProcessor
      // ran under a real AudioWorkletGlobalScope.
      const shape = { isNode: node instanceof AudioWorkletNode, outputs: node.numberOfOutputs, inputs: node.numberOfInputs }
      node.port.postMessage({ type: 'tick', when: context.currentTime + 0.05, accent: true, gain: 0.5 })
      return { ok: true, ...shape, error: null as string | null }
    } catch (error) {
      return { ok: false, isNode: false, outputs: 0, inputs: 0, error: String(error) }
    } finally {
      await context.close()
    }
  })

  expect(result.error).toBeNull()
  expect(result.ok).toBe(true)
  expect(result.isNode).toBe(true)
  expect(result.inputs).toBe(0)
  expect(result.outputs).toBe(1)
})
