import { z } from 'zod/v4'
import {
  LiveOutput,
  LiveClip,
  LiveScene,
  LiveSetItem,
  LiveStem,
  MidiMapping,
  PadAssignment,
  type PackageStatus,
} from './types.js'

/**
 * The offline performance package.
 *
 * Before a show, Live Lab assembles every asset the set needs into a local
 * cache and writes this manifest next to it. "SHOW READY" is a claim about the
 * cache, not the cloud: it is only made after every required file exists
 * locally, matches its checksum, and decodes. During Performance Mode the
 * player reads *only* from the package — never from the network.
 */

export const RequiredFile = z.object({
  /** Path inside the package, e.g. "stems/lstem_xxx.wav". */
  path: z.string().min(1),
  assetId: z.string(),
  kind: z.enum(['clip', 'stem', 'click', 'cue', 'waveform']),
  sha256: z.string().length(64),
  bytes: z.number().int().min(0),
})
export type RequiredFile = z.infer<typeof RequiredFile>

export const PerformanceManifest = z.object({
  manifestVersion: z.literal(1),
  projectId: z.string(),
  packageVersion: z.number().int().min(1),
  artist: z.string(),
  setName: z.string(),
  createdAt: z.string(),
  masterTempo: z.number(),
  timeSignature: z.string(),
  setlist: z.array(LiveSetItem),
  scenes: z.array(LiveScene),
  clips: z.array(LiveClip),
  stems: z.array(LiveStem),
  padMap: z.array(PadAssignment),
  midiMappings: z.array(MidiMapping),
  outputs: z.array(LiveOutput),
  requiredFiles: z.array(RequiredFile),
})
export type PerformanceManifest = z.infer<typeof PerformanceManifest>

/** What the verifier needs from whatever holds the cached bytes (IndexedDB, disk, memory). */
export interface PackageFileStore {
  exists(path: string): Promise<boolean>
  bytes(path: string): Promise<number>
  sha256(path: string): Promise<string>
  /** True when the audio decodes. Implementations without a decoder may return true and say so. */
  decodable(path: string): Promise<boolean>
}

export interface VerificationIssue {
  path: string | null
  code:
    | 'missing_file'
    | 'checksum_mismatch'
    | 'size_mismatch'
    | 'undecodable'
    | 'missing_click'
    | 'cloud_only_asset'
    | 'invalid_midi_mapping'
    | 'scene_without_audio'
    | 'insufficient_storage'
  message: string
}

export interface VerificationReport {
  status: PackageStatus
  issues: VerificationIssue[]
  checkedFiles: number
  totalBytes: number
}

export interface VerifyOptions {
  /** Bytes of local storage still available; verification fails when the package cannot fit. */
  availableStorageBytes?: number
}

/**
 * Full package verification. Every failure is reported, not just the first —
 * a tech fixing a package at soundcheck needs the complete list.
 */
export async function verifyPackage(
  manifest: PerformanceManifest,
  store: PackageFileStore,
  opts: VerifyOptions = {},
): Promise<VerificationReport> {
  const issues: VerificationIssue[] = []
  let totalBytes = 0
  for (const file of manifest.requiredFiles) totalBytes += file.bytes

  if (opts.availableStorageBytes !== undefined && opts.availableStorageBytes < totalBytes) {
    issues.push({
      path: null,
      code: 'insufficient_storage',
      message: `package needs ${totalBytes} bytes but only ${opts.availableStorageBytes} are available`,
    })
  }

  for (const file of manifest.requiredFiles) {
    if (!(await store.exists(file.path))) {
      issues.push({ path: file.path, code: 'missing_file', message: `${file.path} is not cached locally` })
      continue
    }
    const bytes = await store.bytes(file.path)
    if (bytes !== file.bytes) {
      issues.push({ path: file.path, code: 'size_mismatch', message: `${file.path} is ${bytes} bytes, manifest says ${file.bytes}` })
      continue
    }
    const digest = await store.sha256(file.path)
    if (digest !== file.sha256) {
      issues.push({ path: file.path, code: 'checksum_mismatch', message: `${file.path} checksum does not match the manifest` })
      continue
    }
    if (!(await store.decodable(file.path))) {
      issues.push({ path: file.path, code: 'undecodable', message: `${file.path} exists but does not decode as audio` })
    }
  }

  // Structural checks: a scene must have playable audio, mappings must point at
  // real targets, click must be cached where a song requires it.
  const clipsByScene = new Map<string, number>()
  for (const clip of manifest.clips) clipsByScene.set(clip.liveSceneId, (clipsByScene.get(clip.liveSceneId) ?? 0) + 1)
  const stemsByItem = new Map<string, number>()
  for (const stem of manifest.stems) stemsByItem.set(stem.liveSetItemId, (stemsByItem.get(stem.liveSetItemId) ?? 0) + 1)
  for (const scene of manifest.scenes) {
    if (!clipsByScene.has(scene.id) && !stemsByItem.has(scene.liveSetItemId)) {
      issues.push({ path: null, code: 'scene_without_audio', message: `scene "${scene.name}" has no clip and its song has no stems` })
    }
  }

  const targetIds = new Set<string>()
  for (const scene of manifest.scenes) targetIds.add(scene.id)
  for (const clip of manifest.clips) targetIds.add(clip.id)
  for (const stem of manifest.stems) targetIds.add(stem.id)
  for (const pad of manifest.padMap) targetIds.add(`pad:${pad.index}`)
  for (const mapping of manifest.midiMappings) {
    const needsTarget = ['pad', 'scene', 'stem_mute', 'stem_solo', 'stem_volume'].includes(mapping.targetType)
    if (needsTarget && (!mapping.targetId || !targetIds.has(mapping.targetId))) {
      issues.push({
        path: null,
        code: 'invalid_midi_mapping',
        message: `MIDI mapping ${mapping.id} targets ${mapping.targetType} "${mapping.targetId ?? ''}" which is not in this package`,
      })
    }
  }

  const cachedAssetIds = new Set(manifest.requiredFiles.map((f) => f.assetId))
  for (const stem of manifest.stems) {
    if (!cachedAssetIds.has(stem.sourceAssetId)) {
      issues.push({ path: null, code: 'cloud_only_asset', message: `stem "${stem.label || stem.stemType}" points at an asset with no cached file` })
    }
    if (stem.stemType === 'click' && !manifest.requiredFiles.some((f) => f.assetId === stem.sourceAssetId && f.kind === 'click')) {
      issues.push({ path: null, code: 'missing_click', message: `click stem for set item ${stem.liveSetItemId} is not cached as a click file` })
    }
  }
  for (const clip of manifest.clips) {
    if (!cachedAssetIds.has(clip.sourceAssetId)) {
      issues.push({ path: null, code: 'cloud_only_asset', message: `clip "${clip.name}" points at an asset with no cached file` })
    }
  }

  return {
    status: issues.length === 0 ? 'ready' : 'error',
    issues,
    checkedFiles: manifest.requiredFiles.length,
    totalBytes,
  }
}

/** Stable path inside the package for an asset. */
export function packagePath(kind: RequiredFile['kind'], assetId: string, extension: string): string {
  const dir = kind === 'clip' ? 'clips' : kind === 'stem' ? 'stems' : kind === 'click' ? 'click' : kind === 'cue' ? 'cue' : 'waveforms'
  return `${dir}/${assetId}.${extension.replace(/^\./, '')}`
}
