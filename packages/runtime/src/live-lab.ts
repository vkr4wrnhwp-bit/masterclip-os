import { AudioProviderRegistry, MockAudioProvider, PlatformMusicProvider, durationMsOf, synthesizeWav, type MusicComposer } from '@masterclip/ai-audio'
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

export interface SetSuggestion {
  /** Stable within a plan; the client passes approved ids back to apply. */
  id: string
  kind: 'add_item' | 'add_click' | 'pad_map' | 'needs_bpm'
  title: string
  description: string
}

export interface LiveLabServiceDeps {
  liveLab: LiveLabRepo
  storage: StorageDriver
  clock: Clock
  logger: Logger
  aiProviderId: string
  /**
   * The platform's music generator, when the Audio Intelligence layer is
   * present. Optional so Live Lab still runs — on the mock — in a build that
   * does not compose the audio platform at all.
   */
  musicComposer?: MusicComposer | null
  /**
   * Prices a generation using the operator's configured rate card.
   *
   * A function rather than the rate card itself, so this service never learns
   * what anything costs: the platform prices its own music the same way for
   * every other feature, and an operator who has configured no rate gets zero
   * here exactly as they do everywhere else.
   */
  estimateSceneCostMicros?: ((tracks: number) => number) | null
  /**
   * The platform's usage ledger, when this build has one.
   *
   * Structurally typed for the same reason the composer is: Live Lab must
   * still build in a deployment that does not compose the audio platform.
   */
  usageLedger?: UsageLedger | null
}

/** The slice of the audio layer's usage ledger this service writes to. */
export interface UsageLedger {
  record(entry: {
    orgId: string
    userId: string
    projectType: string
    projectId: string | null
    provider: string
    operation: string
    model: string
    unit: string
    inputUnits: number
    outputUnits: number
    estimatedCostMicros: number
    finalCostMicros: number
    currency: string
    providerRequestId: string | null
    jobId: string | null
  }): Promise<unknown>
}

export class LiveLabService {
  readonly audioProviders = new AudioProviderRegistry()

  constructor(private readonly deps: LiveLabServiceDeps) {
    // The mock is always registered — same philosophy as the video mock
    // provider: the entire AI pipeline must be exercisable with no credentials.
    this.audioProviders.register(new MockAudioProvider())
    // The platform's music layer, when this build has one. Registered whether
    // or not it is configured: `available()` decides at request time, so a key
    // added later starts being used without a redeploy of this wiring.
    if (deps.musicComposer) this.audioProviders.register(new PlatformMusicProvider(deps.musicComposer))
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
        orgId: job.organizationId,
        request: config,
        bpm,
        beatsPerBar: parseTimeSignature(project.timeSignature).beatsPerBar,
        sourceAudio,
        seed: seedFrom(job.id),
      })

      const outputAssetIds: string[] = []
      for (const option of result.options) {
        // Sniffed, not assumed: the mock synthesizes WAV but a hosted music
        // model returns mp3, and a package manifest that mislabels its audio
        // fails verification on the performance device rather than here.
        const mime = sniffAudioMime(option.wavBytes)
        const extension = mime === 'audio/mpeg' ? 'mp3' : 'wav'
        const filename = `${job.id}-${option.label.toLowerCase().replace(/\s+/g, '-')}.${extension}`
        const key = objectKey({ projectId: job.liveProjectId, kind: 'live-generated', id: job.id, filename })
        const digest = sha256Hex(option.wavBytes)
        await storage.putBuffer(key, option.wavBytes, { contentType: mime, sha256: digest })
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
          mime,
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

      // What the provider measured goes in the platform's ledger, so Live Lab
      // spend is visible beside every other audio purchase. Without this the
      // org's month-to-date figure understated real spend, and the budget
      // layer that reads it gave the rest of the platform more headroom than
      // it had. Recorded in units, never priced here: cost reconciliation is
      // the ledger's job and a price table in product logic is what its design
      // refuses.
      //
      // A provider that bought nothing reports no usage — the local
      // synthesizer generates for free and does not belong in a purchase
      // ledger.
      if (result.usage && this.deps.usageLedger) {
        // Priced by the platform's own rate card, so Live Lab counts toward an
        // org's month-to-date spend like every other audio purchase. Recording
        // the units alone left it at zero, which read as "free" to the budget
        // layer rather than as "not yet priced".
        const estimatedCostMicros = this.deps.estimateSceneCostMicros?.(result.options.length) ?? 0
        try {
          await this.deps.usageLedger.record({
            orgId: job.organizationId,
            userId: job.createdBy,
            projectType: 'live_lab',
            projectId: job.liveProjectId,
            provider: provider.id,
            operation: 'scene_generation',
            model: result.model,
            unit: result.usage.unit,
            inputUnits: result.usage.inputUnits,
            outputUnits: result.usage.outputUnits,
            estimatedCostMicros,
            finalCostMicros: result.costMicros,
            currency: 'USD',
            providerRequestId: result.usage.providerRequestId ?? null,
            jobId: job.id,
          })
        } catch (err) {
          // The audio is generated and stored; losing the ledger row must not
          // fail the job, but it must not pass silently either.
          logger.warn('live.ai.usage_unrecorded', { job_id: jobId, error: err instanceof Error ? err.message : String(err) })
        }
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

  // ---------------------------------------------------------- set builder ----

  /**
   * BUILD MY LIVE SET: inspects the current set and proposes what a stage-ready
   * show still needs — walk-on, interlude, encore, outro, click tracks for
   * songs that lack them, and a default pad mapping. Suggestions only:
   * applySetPlan() runs the ones the artist explicitly approved, and nothing
   * here ever modifies original masters or existing set items.
   */
  async buildSetPlan(liveProjectId: string): Promise<{ suggestions: SetSuggestion[] }> {
    const { liveLab } = this.deps
    const project = await liveLab.getProject(liveProjectId)
    const [items, stems, scenes] = await Promise.all([
      liveLab.listItems(liveProjectId),
      liveLab.listStems(liveProjectId),
      liveLab.listScenes(liveProjectId),
    ])
    const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder)
    const songs = ordered.filter((i) => i.type === 'song')
    const suggestions: SetSuggestion[] = []

    if (!ordered.some((i) => i.type === 'walk_on')) {
      suggestions.push({
        id: 'walk_on',
        kind: 'add_item',
        title: 'Add walk-on music',
        description: `A sparse ${project.masterTempo} BPM walk-on intro placeholder, first in the set. Replace it with owned or generated audio when ready.`,
      })
    }
    if (songs.length >= 3 && !ordered.some((i) => i.type === 'interlude')) {
      suggestions.push({
        id: 'interlude',
        kind: 'add_item',
        title: 'Add a mid-set interlude',
        description: 'An 8-bar breathing point placed mid-set — a costume change, a talk break, a reset.',
      })
    }
    if (songs.length >= 2 && !ordered.some((i) => i.type === 'encore')) {
      suggestions.push({
        id: 'encore',
        kind: 'add_item',
        title: 'Add an encore slot',
        description: 'A high-energy encore placeholder before the outro.',
      })
    }
    if (!ordered.some((i) => i.type === 'outro')) {
      suggestions.push({
        id: 'outro',
        kind: 'add_item',
        title: 'Add outro / walk-off music',
        description: 'Sparse outro placeholder to close the show instead of dead air.',
      })
    }

    for (const song of songs) {
      const hasClick = stems.some((s) => s.liveSetItemId === song.id && s.stemType === 'click')
      if (!hasClick && song.bpm) {
        suggestions.push({
          id: `click:${song.id}`,
          kind: 'add_click',
          title: `Build click track for ${song.title}`,
          description: `A ${song.bpm} BPM click stem routed to the click output, matched to the song length.`,
        })
      }
      if (!song.bpm) {
        suggestions.push({
          id: `bpm:${song.id}`,
          kind: 'needs_bpm',
          title: `${song.title} has no BPM`,
          description: 'Click tracks and quantized launching need a tempo — set it on the set item. (Not automatable: tempo detection from audio is a later phase.)',
        })
      }
    }

    const padsAssigned = project.padMap.filter((p) => p.mode !== 'empty' && p.mode !== 'stop').length
    if (padsAssigned === 0 && scenes.length > 0) {
      suggestions.push({
        id: 'pad_map',
        kind: 'pad_map',
        title: 'Create a default pad mapping',
        description: 'Row 1: first song’s scenes · Row 2: its stem mutes · Row 3: more scenes · Row 4: other songs + STOP.',
      })
    }

    return { suggestions }
  }

  /** Applies exactly the approved suggestions. Additive only; re-derives the plan first. */
  async applySetPlan(orgId: string, liveProjectId: string, userId: string, suggestionIds: string[]): Promise<{ applied: string[] }> {
    const { liveLab, storage, clock } = this.deps
    const project = await liveLab.getProject(liveProjectId)
    const { suggestions } = await this.buildSetPlan(liveProjectId)
    const approved = suggestions.filter((s) => suggestionIds.includes(s.id) && s.kind !== 'needs_bpm')
    const applied: string[] = []

    const storeSynth = async (
      name: string,
      kind: 'audio' | 'click',
      spec: { bpm: number; bars: number; energy: number; layers: Record<string, boolean> },
    ) => {
      const wav = synthesizeWav({ ...spec, seed: seedFrom(`${liveProjectId}:${name}`) })
      const filename = `${name}.wav`
      const key = objectKey({ projectId: liveProjectId, kind: `live-${kind}`, id: `builder-${seedFrom(name)}`, filename })
      const digest = sha256Hex(wav)
      await storage.putBuffer(key, wav, { contentType: 'audio/wav', sha256: digest })
      return liveLab.createAsset({
        orgId,
        liveProjectId,
        kind,
        storageKey: key,
        filename,
        mime: 'audio/wav',
        bytes: wav.length,
        sha256: digest,
        durationMs: durationMsOf({ bpm: spec.bpm, bars: spec.bars }),
        metadata: { setBuilder: true },
        rightsOwner: 'locally synthesized placeholder',
        rightsConfirmed: true,
        rightsConfirmedBy: userId,
        lineage: {
          sourceAssetId: null,
          sourceVersion: null,
          provider: 'local-synth',
          model: 'mock-synth-1',
          prompt: `set builder: ${name}`,
          settings: spec,
          generatedAt: clock.isoNow(),
          approvedBy: userId,
          approvedAt: clock.isoNow(),
          rightsConfirmed: true,
        },
        createdBy: userId,
      })
    }

    const ITEM_SPECS: Record<string, { type: 'walk_on' | 'interlude' | 'encore' | 'outro'; title: string; bars: number; energy: number; layers: Record<string, boolean>; sceneType: 'intro' | 'interlude' | 'custom' | 'outro' }> = {
      walk_on: { type: 'walk_on', title: 'WALK ON', bars: 16, energy: 0.2, layers: { pad: true }, sceneType: 'intro' },
      interlude: { type: 'interlude', title: 'INTERLUDE', bars: 8, energy: 0.3, layers: { pad: true, bass: true }, sceneType: 'interlude' },
      encore: { type: 'encore', title: 'ENCORE', bars: 8, energy: 0.9, layers: { kick: true, hat: true, bass: true }, sceneType: 'custom' },
      outro: { type: 'outro', title: 'OUTRO', bars: 8, energy: 0.2, layers: { pad: true }, sceneType: 'outro' },
    }

    for (const suggestion of approved) {
      if (suggestion.kind === 'add_item') {
        const spec = ITEM_SPECS[suggestion.id]
        if (!spec) continue
        const asset = await storeSynth(spec.title.toLowerCase().replace(/\s+/g, '-'), 'audio', {
          bpm: project.masterTempo,
          bars: spec.bars,
          energy: spec.energy,
          layers: spec.layers,
        })
        const item = await liveLab.createItem({
          orgId,
          liveProjectId,
          type: spec.type,
          title: spec.title,
          bpm: project.masterTempo,
          durationMs: asset.durationMs,
          notes: 'added by the set builder — placeholder audio, replace when ready',
        })
        const scene = await liveLab.createScene({
          orgId,
          liveProjectId,
          liveSetItemId: item.id,
          name: spec.title,
          sceneType: spec.sceneType,
          bars: spec.bars,
        })
        await liveLab.createClip({ orgId, liveProjectId, liveSceneId: scene.id, name: spec.title, sourceAssetId: asset.id })
        applied.push(suggestion.id)
      } else if (suggestion.kind === 'add_click') {
        const itemId = suggestion.id.slice('click:'.length)
        const item = await liveLab.getItem(itemId)
        if (!item.bpm) continue
        const beatMs = 60000 / item.bpm
        const bars = Math.min(128, Math.max(8, item.durationMs ? Math.ceil(item.durationMs / (beatMs * 4)) : 16))
        const asset = await storeSynth(`click-${item.title.toLowerCase().replace(/\s+/g, '-')}`, 'click', {
          bpm: item.bpm,
          bars,
          energy: 0.5,
          layers: { click: true },
        })
        await liveLab.createStem({
          orgId,
          liveProjectId,
          liveSetItemId: itemId,
          stemType: 'click',
          sourceAssetId: asset.id,
          outputId: 'click',
        })
        applied.push(suggestion.id)
      } else if (suggestion.kind === 'pad_map') {
        await this.applyDefaultPadMap(liveProjectId)
        applied.push(suggestion.id)
      }
    }

    // Put the set in show order: walk-on first, then songs/interlude as laid
    // out, encore, outro last. Only newly added structural items move.
    if (approved.some((s) => s.kind === 'add_item')) {
      const items = [...(await liveLab.listItems(liveProjectId))].sort((a, b) => a.sortOrder - b.sortOrder)
      const walkOns = items.filter((i) => i.type === 'walk_on')
      const outros = items.filter((i) => i.type === 'outro')
      const encores = items.filter((i) => i.type === 'encore')
      const middle = items.filter((i) => i.type !== 'walk_on' && i.type !== 'outro' && i.type !== 'encore')
      await liveLab.reorderItems(liveProjectId, [...walkOns, ...middle, ...encores, ...outros].map((i) => i.id))
    }

    return { applied }
  }

  /** Row 1: first song's scenes · Row 2: its stems · Row 3: more scenes · Row 4: other songs + STOP. */
  private async applyDefaultPadMap(liveProjectId: string): Promise<void> {
    const { liveLab } = this.deps
    const [project, items, scenes, stems] = await Promise.all([
      liveLab.getProject(liveProjectId),
      liveLab.listItems(liveProjectId),
      liveLab.listScenes(liveProjectId),
      liveLab.listStems(liveProjectId),
    ])
    const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder)
    const firstSong = ordered.find((i) => i.type === 'song') ?? ordered[0]
    const padMap = project.padMap.map((p) => ({ ...p }))
    const setPad = (index: number, mode: 'scene' | 'stem_mute' | 'stop', label: string, targetId: string | null) => {
      padMap[index] = { index, mode, label: label.slice(0, 12), targetId, color: '' }
    }

    if (firstSong) {
      const firstScenes = scenes.filter((s) => s.liveSetItemId === firstSong.id).sort((a, b) => a.sortOrder - b.sortOrder)
      firstScenes.slice(0, 4).forEach((scene, i) => setPad(i, 'scene', scene.name, scene.id))
      const firstStems = stems.filter((s) => s.liveSetItemId === firstSong.id && s.stemType !== 'click')
      firstStems.slice(0, 4).forEach((stem, i) => setPad(4 + i, 'stem_mute', stem.label || stem.stemType, stem.id))
      firstScenes.slice(4, 8).forEach((scene, i) => setPad(8 + i, 'scene', scene.name, scene.id))
    }
    const otherFirstScenes = ordered
      .filter((i) => i.id !== firstSong?.id)
      .map((item) => scenes.filter((s) => s.liveSetItemId === item.id).sort((a, b) => a.sortOrder - b.sortOrder)[0])
      .filter((scene): scene is NonNullable<typeof scene> => scene !== undefined)
    otherFirstScenes.slice(0, 3).forEach((scene, i) => setPad(12 + i, 'scene', scene.name, scene.id))
    setPad(15, 'stop', 'STOP', null)
    await liveLab.updateProject(liveProjectId, { padMap })
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

/** Container sniffing for generated audio. Mirrors the upload path's rules. */
function sniffAudioMime(bytes: Uint8Array): string {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav'
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg'
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg'
  if (ascii(4, 4) === 'ftyp') return 'audio/mp4'
  return 'audio/wav'
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
