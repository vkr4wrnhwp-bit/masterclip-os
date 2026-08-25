import { AudioProviderRegistry, MockAudioProvider } from '@masterclip/ai-audio'
import { objectKey } from '@masterclip/asset-storage'
import type { StorageDriver } from '@masterclip/asset-storage'
import type { LiveAsset, LiveLabRepo } from '@masterclip/domain'
import {
  packagePath,
  verifyPackage,
  type GenerationLineage,
  type PackageFileStore,
  type PerformanceManifest,
  type VerificationReport,
} from '@masterclip/performance-project'
import { parseTimeSignature } from '@masterclip/live-engine'
import { AppError, sha256Hex, type Clock, type Logger } from '@masterclip/shared'

/**
 * Live Lab services that need the composition root: AI scene generation (runs
 * on the worker, never inside an HTTP request) and server-side performance
 * package assembly/verification.
 */

export interface LiveLabServiceDeps {
  liveLab: LiveLabRepo
  storage: StorageDriver
  clock: Clock
  logger: Logger
  aiProviderId: string
}

export class LiveLabService {
  readonly audioProviders = new AudioProviderRegistry()

  constructor(private readonly deps: LiveLabServiceDeps) {
    // The mock is always registered — same philosophy as the video mock
    // provider: the entire AI pipeline must be exercisable with no credentials.
    this.audioProviders.register(new MockAudioProvider())
  }

  get aiProviderId(): string {
    const configured = this.deps.aiProviderId
    try {
      const provider = this.audioProviders.get(configured)
      if (provider.available()) return configured
    } catch {
      // fall through to mock
    }
    return 'mock-audio'
  }

  /**
   * Executes one queued AI generation job. Called by the worker. The project
   * stays fully usable while this runs, and nothing here ever touches the
   * currently-assigned scene audio: results land as new assets awaiting
   * explicit acceptance.
   */
  async runAiJob(jobId: string): Promise<void> {
    const { liveLab, storage, clock, logger } = this.deps
    const job = await liveLab.getAiJob(jobId)
    if (job.status !== 'queued' && job.status !== 'generating') return

    await liveLab.updateAiJob(jobId, { status: 'generating' })
    try {
      const project = await liveLab.getProject(job.liveProjectId)
      const item = job.liveSetItemId ? await liveLab.getItem(job.liveSetItemId) : null
      const config = job.configuration

      let bpm = item?.bpm ?? project.masterTempo
      if (config.tempoBehavior === 'half') bpm = bpm / 2
      else if (config.tempoBehavior === 'double') bpm = bpm * 2
      else if (config.tempoBehavior === 'custom' && config.customBpm) bpm = config.customBpm

      let sourceAudio: Uint8Array | null = null
      if (job.sourceAssetId) {
        const source = await liveLab.getAsset(job.sourceAssetId)
        if (!source.rightsConfirmed) {
          throw new AppError({ kind: 'forbidden', code: 'live.rights_unconfirmed', message: 'source asset has no rights confirmation' })
        }
        sourceAudio = await storage.getBuffer(source.storageKey)
      }

      const provider = this.audioProviders.get(job.provider)
      const result = await provider.generateScene({
        request: config,
        bpm,
        beatsPerBar: parseTimeSignature(project.timeSignature).beatsPerBar,
        sourceAudio,
        seed: seedFrom(job.id),
      })

      const outputAssetIds: string[] = []
      for (const option of result.options) {
        const filename = `${job.id}-${option.label.toLowerCase().replace(/\s+/g, '-')}.wav`
        const key = objectKey({ projectId: job.liveProjectId, kind: 'live-generated', id: job.id, filename })
        const digest = sha256Hex(option.wavBytes)
        await storage.putBuffer(key, option.wavBytes, { contentType: 'audio/wav', sha256: digest })
        const lineage: GenerationLineage = {
          sourceAssetId: job.sourceAssetId,
          sourceVersion: null,
          provider: provider.id,
          model: result.model,
          prompt: config.prompt,
          settings: {
            bars: config.bars,
            tempoBehavior: config.tempoBehavior,
            keyBehavior: config.keyBehavior,
            energy: config.energy,
            instrumentation: config.instrumentation,
            intendedTransition: config.intendedTransition,
            bpm,
          },
          generatedAt: clock.isoNow(),
          approvedBy: null,
          approvedAt: null,
          rightsConfirmed: config.rightsConfirmed,
        }
        const asset = await liveLab.createAsset({
          orgId: job.organizationId,
          liveProjectId: job.liveProjectId,
          kind: 'generated',
          storageKey: key,
          filename,
          mime: 'audio/wav',
          bytes: option.wavBytes.length,
          sha256: digest,
          durationMs: option.durationMs,
          metadata: { label: option.label, description: option.description },
          rightsConfirmed: config.rightsConfirmed,
          rightsConfirmedBy: job.createdBy,
          lineage,
          createdBy: job.createdBy,
        })
        outputAssetIds.push(asset.id)
      }

      await liveLab.updateAiJob(jobId, {
        status: 'ready',
        outputAssetIds,
        finalCostMicros: result.costMicros,
        completedAt: clock.isoNow(),
      })
      logger.info('live.ai.ready', { job_id: jobId, options: outputAssetIds.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await liveLab.updateAiJob(jobId, { status: 'failed', error: message, completedAt: clock.isoNow() })
      logger.warn('live.ai.failed', { job_id: jobId, error: message })
    }
  }

  /**
   * Assembles the manifest for a project's offline performance package and
   * verifies it against what storage actually holds. The client then downloads
   * each required file into its local cache and re-verifies on-device — READY
   * is only ever claimed about bytes that exist where the show will run.
   */
  async buildPackage(orgId: string, liveProjectId: string): Promise<{ manifest: PerformanceManifest; report: VerificationReport; storageSize: number }> {
    const { liveLab } = this.deps
    const project = await liveLab.getProject(liveProjectId)
    const [items, scenes, clips, stems, mappings, outputs, assets] = await Promise.all([
      liveLab.listItems(liveProjectId),
      liveLab.listScenes(liveProjectId),
      liveLab.listClips(liveProjectId),
      liveLab.listStems(liveProjectId),
      liveLab.listMappings(liveProjectId),
      liveLab.ensureDefaultOutputs(orgId, liveProjectId),
      liveLab.listAssets(liveProjectId),
    ])

    const assetById = new Map(assets.map((asset) => [asset.id, asset]))
    const required = new Map<string, { asset: LiveAsset; kind: 'clip' | 'stem' | 'click' }>()
    for (const clip of clips) {
      const asset = assetById.get(clip.sourceAssetId)
      if (asset) required.set(asset.id, { asset, kind: 'clip' })
    }
    for (const stem of stems) {
      const asset = assetById.get(stem.sourceAssetId)
      if (asset) required.set(asset.id, { asset, kind: stem.stemType === 'click' ? 'click' : 'stem' })
    }

    const packageVersion = (await liveLab.listPackages(liveProjectId))[0]?.version ?? 0
    const manifest: PerformanceManifest = {
      manifestVersion: 1,
      projectId: project.id,
      packageVersion: packageVersion + 1,
      artist: project.artistId ?? '',
      setName: project.name,
      createdAt: this.deps.clock.isoNow(),
      masterTempo: project.masterTempo,
      timeSignature: project.timeSignature,
      setlist: items,
      scenes,
      clips,
      stems,
      padMap: project.padMap,
      midiMappings: mappings,
      outputs,
      requiredFiles: [...required.values()].map(({ asset, kind }) => ({
        path: packagePath(kind, asset.id, extensionOf(asset.filename)),
        assetId: asset.id,
        kind,
        sha256: asset.sha256,
        bytes: asset.bytes,
      })),
    }

    const store = new ServerPackageStore(this.deps.storage, manifest, assetById)
    const report = await verifyPackage(manifest, store)
    const storageSize = manifest.requiredFiles.reduce((total, file) => total + file.bytes, 0)
    return { manifest, report, storageSize }
  }
}

/** PackageFileStore over the server's object storage — used for server-side verification. */
class ServerPackageStore implements PackageFileStore {
  private readonly byPath = new Map<string, LiveAsset>()

  constructor(
    private readonly storage: StorageDriver,
    manifest: PerformanceManifest,
    assetById: Map<string, LiveAsset>,
  ) {
    for (const file of manifest.requiredFiles) {
      const asset = assetById.get(file.assetId)
      if (asset) this.byPath.set(file.path, asset)
    }
  }

  async exists(path: string): Promise<boolean> {
    const asset = this.byPath.get(path)
    if (!asset) return false
    return this.storage.exists(asset.storageKey)
  }

  async bytes(path: string): Promise<number> {
    const asset = this.byPath.get(path)
    if (!asset) return 0
    return (await this.storage.getBuffer(asset.storageKey)).length
  }

  async sha256(path: string): Promise<string> {
    const asset = this.byPath.get(path)
    if (!asset) return ''
    return sha256Hex(await this.storage.getBuffer(asset.storageKey))
  }

  async decodable(path: string): Promise<boolean> {
    const asset = this.byPath.get(path)
    if (!asset) return false
    const head = (await this.storage.getBuffer(asset.storageKey)).slice(0, 16)
    const ascii = (start: number, length: number) => String.fromCharCode(...head.slice(start, start + length))
    return (
      (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') ||
      ascii(0, 3) === 'ID3' ||
      (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) ||
      ascii(4, 4) === 'ftyp'
    )
  }
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? 'wav' : filename.slice(dot + 1)
}

/** Deterministic numeric seed from a job id, so re-runs render identical audio. */
function seedFrom(id: string): number {
  let seed = 0
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0
  return seed
}
