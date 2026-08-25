import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { packagePath, verifyPackage, type PackageFileStore, type PerformanceManifest } from '../src/manifest.js'
import { defaultPadMap } from '../src/types.js'

/** Minimal in-memory store implementing exactly the verifier's contract. */
class MapStore implements PackageFileStore {
  constructor(private readonly files = new Map<string, Uint8Array>()) {}
  put(path: string, bytes: Uint8Array) {
    this.files.set(path, bytes)
  }
  async exists(path: string) {
    return this.files.has(path)
  }
  async bytes(path: string) {
    return this.files.get(path)?.length ?? 0
  }
  async sha256(path: string) {
    const bytes = this.files.get(path)
    return bytes ? createHash('sha256').update(bytes).digest('hex') : ''
  }
  async decodable(path: string) {
    const bytes = this.files.get(path)
    return !!bytes && bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
  }
}

const wavBytes = (fill: number) => {
  const bytes = new Uint8Array(64)
  bytes.set([0x52, 0x49, 0x46, 0x46]) // RIFF
  bytes.fill(fill, 8)
  return bytes
}
const shaOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function manifest(over: Partial<PerformanceManifest> = {}): PerformanceManifest {
  const clipAudio = wavBytes(1)
  const stemAudio = wavBytes(2)
  return {
    manifestVersion: 1,
    projectId: 'proj',
    packageVersion: 1,
    artist: 'Example Artist',
    setName: 'Demo',
    createdAt: '2026-01-01T00:00:00.000Z',
    masterTempo: 120,
    timeSignature: '4/4',
    setlist: [
      {
        id: 'item1',
        organizationId: 'org',
        liveProjectId: 'proj',
        sortOrder: 0,
        type: 'song',
        title: 'TRACK ONE',
        sourceReleaseId: null,
        sourceTrackId: null,
        bpm: 120,
        key: null,
        durationMs: 60000,
        notes: '',
      },
    ],
    scenes: [
      {
        id: 'scene1',
        organizationId: 'org',
        liveProjectId: 'proj',
        liveSetItemId: 'item1',
        name: 'HOOK',
        sceneType: 'chorus',
        sortOrder: 0,
        color: '',
        bpm: null,
        key: null,
        bars: 8,
        quantization: '1bar',
        loopEnabled: false,
        followAction: 'stop',
        followTargetSceneId: null,
      },
    ],
    clips: [
      {
        id: 'clip1',
        organizationId: 'org',
        liveProjectId: 'proj',
        liveSceneId: 'scene1',
        name: 'hook',
        sourceAssetId: 'assetClip',
        startMs: 0,
        endMs: null,
        loopStartMs: null,
        loopEndMs: null,
        oneShot: false,
        gain: 1,
        pan: 0,
        outputId: null,
      },
    ],
    stems: [
      {
        id: 'stem1',
        organizationId: 'org',
        liveProjectId: 'proj',
        liveSetItemId: 'item1',
        stemType: 'click',
        label: 'click',
        sourceAssetId: 'assetStem',
        gain: 1,
        pan: 0,
        muted: false,
        solo: false,
        outputId: null,
      },
    ],
    padMap: defaultPadMap(),
    midiMappings: [],
    outputs: [{ id: 'master', name: 'Master', type: 'master' }],
    requiredFiles: [
      { path: packagePath('clip', 'assetClip', 'wav'), assetId: 'assetClip', kind: 'clip', sha256: shaOf(clipAudio), bytes: clipAudio.length },
      { path: packagePath('click', 'assetStem', 'wav'), assetId: 'assetStem', kind: 'click', sha256: shaOf(stemAudio), bytes: stemAudio.length },
    ],
    ...over,
  }
}

function readyStore(): MapStore {
  const store = new MapStore()
  store.put(packagePath('clip', 'assetClip', 'wav'), wavBytes(1))
  store.put(packagePath('click', 'assetStem', 'wav'), wavBytes(2))
  return store
}

describe('performance package verification', () => {
  it('is READY when every asset exists, matches, and decodes', async () => {
    const report = await verifyPackage(manifest(), readyStore())
    expect(report.issues).toEqual([])
    expect(report.status).toBe('ready')
    expect(report.checkedFiles).toBe(2)
  })

  it('a missing cached asset prevents READY', async () => {
    const store = new MapStore()
    store.put(packagePath('clip', 'assetClip', 'wav'), wavBytes(1))
    const report = await verifyPackage(manifest(), store)
    expect(report.status).toBe('error')
    expect(report.issues.some((i) => i.code === 'missing_file')).toBe(true)
  })

  it('a checksum mismatch prevents READY', async () => {
    const store = readyStore()
    store.put(packagePath('clip', 'assetClip', 'wav'), wavBytes(9)) // wrong bytes, same length
    const report = await verifyPackage(manifest(), store)
    expect(report.issues.some((i) => i.code === 'checksum_mismatch')).toBe(true)
  })

  it('an undecodable file prevents READY', async () => {
    const store = readyStore()
    const junk = new Uint8Array(64).fill(7) // no RIFF header
    const m = manifest()
    m.requiredFiles[0] = { ...m.requiredFiles[0]!, sha256: shaOf(junk), bytes: junk.length }
    store.put(m.requiredFiles[0]!.path, junk)
    const report = await verifyPackage(m, store)
    expect(report.issues.some((i) => i.code === 'undecodable')).toBe(true)
  })

  it('a stem whose asset is not in the package is a cloud-only asset error', async () => {
    const m = manifest()
    m.requiredFiles = m.requiredFiles.filter((f) => f.assetId !== 'assetStem')
    const report = await verifyPackage(m, readyStore())
    expect(report.issues.some((i) => i.code === 'cloud_only_asset')).toBe(true)
  })

  it('a MIDI mapping pointing at nothing is invalid', async () => {
    const m = manifest({
      midiMappings: [
        {
          id: 'map1',
          organizationId: 'org',
          liveProjectId: 'proj',
          deviceIdentifier: 'dev',
          channel: 0,
          messageType: 'note_on',
          noteOrController: 36,
          targetType: 'scene',
          targetId: 'no-such-scene',
          minimum: 0,
          maximum: 127,
          inversion: false,
        },
      ],
    })
    const report = await verifyPackage(m, readyStore())
    expect(report.issues.some((i) => i.code === 'invalid_midi_mapping')).toBe(true)
  })

  it('refuses when local storage cannot hold the package', async () => {
    const report = await verifyPackage(manifest(), readyStore(), { availableStorageBytes: 10 })
    expect(report.issues.some((i) => i.code === 'insufficient_storage')).toBe(true)
  })

  it('a scene with no audio anywhere is flagged', async () => {
    const m = manifest()
    m.clips = []
    m.stems = []
    m.requiredFiles = []
    const report = await verifyPackage(m, new MapStore())
    expect(report.issues.some((i) => i.code === 'scene_without_audio')).toBe(true)
  })
})
