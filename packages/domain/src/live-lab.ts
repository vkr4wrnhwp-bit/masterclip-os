import { type Db, insertRow, parseJsonColumn, toBool, toNum, toNumOrNull, toStr, toStrOrNull, updateRow, upsertRow } from '@masterclip/database'
import { newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import {
  defaultPadMap,
  normalizePadMap,
  type AiJobStatus,
  type AiSceneRequest,
  type GenerationLineage,
  type LiveAiJob,
  type LiveClip,
  type LiveOutput,
  type LiveProject,
  type LiveScene,
  type LiveSetItem,
  type LiveStem,
  type MidiMapping,
  type PadAssignment,
  type PerformanceEventType,
  type PerformanceManifest,
} from '@masterclip/performance-project'

/**
 * Live Lab persistence.
 *
 * Every record carries org_id and every read used by the API filters on it —
 * tenant isolation is enforced in SQL, not by hoping the caller checked.
 * Types come from @masterclip/performance-project so the server, the web
 * workspace, and the offline package all speak the same schema.
 */

export interface LiveAsset {
  id: string
  organizationId: string
  liveProjectId: string
  kind: 'audio' | 'stem' | 'click' | 'generated'
  storageKey: string
  filename: string
  mime: string
  bytes: number
  sha256: string
  durationMs: number | null
  metadata: Record<string, unknown>
  rightsOwner: string
  rightsConfirmed: boolean
  rightsConfirmedBy: string | null
  rightsConfirmedAt: string | null
  lineage: GenerationLineage | null
  createdBy: string
  createdAt: string
}

export interface LivePerformancePackage {
  id: string
  organizationId: string
  liveProjectId: string
  version: number
  status: string
  manifest: PerformanceManifest | null
  storageSize: number
  createdAt: string
  verifiedAt: string | null
}

export class LiveLabRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  // ------------------------------------------------------------ projects ----

  async createProject(input: {
    orgId: string
    name: string
    description?: string
    artistId?: string | null
    masterTempo?: number
    timeSignature?: string
    createdBy: string
  }): Promise<LiveProject> {
    const now = this.clock.isoNow()
    const project: LiveProject = {
      id: newId('lproj', this.clock.now()),
      organizationId: input.orgId,
      artistId: input.artistId ?? null,
      name: input.name,
      description: input.description ?? '',
      status: 'active',
      masterTempo: input.masterTempo ?? 120,
      timeSignature: input.timeSignature ?? '4/4',
      sourceReleaseIds: [],
      padMap: defaultPadMap(),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'live_projects', {
      id: project.id,
      org_id: project.organizationId,
      artist_id: project.artistId,
      name: project.name,
      description: project.description,
      status: project.status,
      master_tempo: project.masterTempo,
      time_signature: project.timeSignature,
      source_release_ids: JSON.stringify(project.sourceReleaseIds),
      pad_map: JSON.stringify(project.padMap),
      created_by: project.createdBy,
      created_at: now,
      updated_at: now,
    })
    return project
  }

  async getProject(id: string): Promise<LiveProject> {
    const row = await this.db.get('SELECT * FROM live_projects WHERE id = ?', [id])
    if (!row) throw notFound('live project', id)
    return mapProject(row)
  }

  async listProjects(orgId: string): Promise<LiveProject[]> {
    const rows = await this.db.query('SELECT * FROM live_projects WHERE org_id = ? ORDER BY updated_at DESC', [orgId])
    return rows.map(mapProject)
  }

  async countProjects(orgId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM live_projects WHERE org_id = ? AND status = ?', [orgId, 'active'])
    return toNum(row?.n)
  }

  async updateProject(
    id: string,
    patch: {
      name?: string
      description?: string
      status?: 'active' | 'archived'
      masterTempo?: number
      timeSignature?: string
      artistId?: string | null
      sourceReleaseIds?: string[]
      padMap?: PadAssignment[]
    },
  ): Promise<LiveProject> {
    const values: Record<string, string | number | null> = { updated_at: this.clock.isoNow() }
    if (patch.name !== undefined) values.name = patch.name
    if (patch.description !== undefined) values.description = patch.description
    if (patch.status !== undefined) values.status = patch.status
    if (patch.masterTempo !== undefined) values.master_tempo = patch.masterTempo
    if (patch.timeSignature !== undefined) values.time_signature = patch.timeSignature
    if (patch.artistId !== undefined) values.artist_id = patch.artistId
    if (patch.sourceReleaseIds !== undefined) values.source_release_ids = JSON.stringify(patch.sourceReleaseIds)
    // Normalized on the way in as well as out: the grid is addressed by index
    // everywhere, so a short or sparse map must never reach the column.
    if (patch.padMap !== undefined) values.pad_map = JSON.stringify(normalizePadMap(patch.padMap))
    await updateRow(this.db, 'live_projects', id, values)
    return this.getProject(id)
  }

  /** Removes the project and everything under it, children first. */
  async deleteProject(id: string): Promise<void> {
    for (const table of [
      'live_performance_events',
      'live_performance_packages',
      'live_ai_jobs',
      'live_midi_mappings',
      'live_outputs',
      'live_clips',
      'live_stems',
      'live_scenes',
      'live_set_items',
      'live_assets',
    ]) {
      await this.db.run(`DELETE FROM ${table} WHERE live_project_id = ?`, [id])
    }
    await this.db.run('DELETE FROM live_projects WHERE id = ?', [id])
  }

  async touchProject(id: string): Promise<void> {
    await updateRow(this.db, 'live_projects', id, { updated_at: this.clock.isoNow() })
  }

  // ----------------------------------------------------------- set items ----

  async createItem(input: {
    orgId: string
    liveProjectId: string
    type: LiveSetItem['type']
    title: string
    sortOrder?: number
    sourceReleaseId?: string | null
    sourceTrackId?: string | null
    bpm?: number | null
    key?: string | null
    durationMs?: number | null
    notes?: string
  }): Promise<LiveSetItem> {
    const sortOrder = input.sortOrder ?? (await this.nextSortOrder('live_set_items', input.liveProjectId))
    const item: LiveSetItem = {
      id: newId('lset', this.clock.now()),
      organizationId: input.orgId,
      liveProjectId: input.liveProjectId,
      sortOrder,
      type: input.type,
      title: input.title,
      sourceReleaseId: input.sourceReleaseId ?? null,
      sourceTrackId: input.sourceTrackId ?? null,
      bpm: input.bpm ?? null,
      key: input.key ?? null,
      durationMs: input.durationMs ?? null,
      notes: input.notes ?? '',
    }
    await insertRow(this.db, 'live_set_items', {
      id: item.id,
      org_id: item.organizationId,
      live_project_id: item.liveProjectId,
      sort_order: item.sortOrder,
      item_type: item.type,
      title: item.title,
      source_release_id: item.sourceReleaseId,
      source_track_id: item.sourceTrackId,
      bpm: item.bpm,
      song_key: item.key,
      duration_ms: item.durationMs,
      notes: item.notes,
    })
    await this.touchProject(item.liveProjectId)
    return item
  }

  async getItem(id: string): Promise<LiveSetItem> {
    const row = await this.db.get('SELECT * FROM live_set_items WHERE id = ?', [id])
    if (!row) throw notFound('set item', id)
    return mapItem(row)
  }

  async listItems(liveProjectId: string): Promise<LiveSetItem[]> {
    const rows = await this.db.query('SELECT * FROM live_set_items WHERE live_project_id = ? ORDER BY sort_order ASC', [liveProjectId])
    return rows.map(mapItem)
  }

  async updateItem(
    id: string,
    patch: Partial<Pick<LiveSetItem, 'title' | 'sortOrder' | 'bpm' | 'key' | 'durationMs' | 'notes' | 'type'>>,
  ): Promise<LiveSetItem> {
    const values: Record<string, string | number | null> = {}
    if (patch.title !== undefined) values.title = patch.title
    if (patch.sortOrder !== undefined) values.sort_order = patch.sortOrder
    if (patch.bpm !== undefined) values.bpm = patch.bpm
    if (patch.key !== undefined) values.song_key = patch.key
    if (patch.durationMs !== undefined) values.duration_ms = patch.durationMs
    if (patch.notes !== undefined) values.notes = patch.notes
    if (patch.type !== undefined) values.item_type = patch.type
    await updateRow(this.db, 'live_set_items', id, values)
    return this.getItem(id)
  }

  async reorderItems(liveProjectId: string, orderedIds: string[]): Promise<void> {
    for (const [index, id] of orderedIds.entries()) {
      await this.db.run('UPDATE live_set_items SET sort_order = ? WHERE id = ? AND live_project_id = ?', [index, id, liveProjectId])
    }
    await this.touchProject(liveProjectId)
  }

  async deleteItem(id: string): Promise<void> {
    const item = await this.getItem(id)
    const scenes = await this.db.query('SELECT id FROM live_scenes WHERE live_set_item_id = ?', [id])
    for (const scene of scenes) {
      await this.db.run('DELETE FROM live_clips WHERE live_scene_id = ?', [toStr(scene.id)])
    }
    await this.db.run('DELETE FROM live_scenes WHERE live_set_item_id = ?', [id])
    await this.db.run('DELETE FROM live_stems WHERE live_set_item_id = ?', [id])
    await this.db.run('DELETE FROM live_set_items WHERE id = ?', [id])
    await this.touchProject(item.liveProjectId)
  }

  // -------------------------------------------------------------- scenes ----

  async createScene(input: {
    orgId: string
    liveProjectId: string
    liveSetItemId: string
    name: string
    sceneType?: LiveScene['sceneType']
    sortOrder?: number
    color?: string
    bpm?: number | null
    key?: string | null
    bars?: number | null
    quantization?: LiveScene['quantization']
    loopEnabled?: boolean
    followAction?: LiveScene['followAction']
    followTargetSceneId?: string | null
  }): Promise<LiveScene> {
    const sortOrder = input.sortOrder ?? (await this.nextSortOrder('live_scenes', input.liveProjectId, 'live_set_item_id', input.liveSetItemId))
    const scene: LiveScene = {
      id: newId('lscn', this.clock.now()),
      organizationId: input.orgId,
      liveProjectId: input.liveProjectId,
      liveSetItemId: input.liveSetItemId,
      name: input.name,
      sceneType: input.sceneType ?? 'custom',
      sortOrder,
      color: input.color ?? '',
      bpm: input.bpm ?? null,
      key: input.key ?? null,
      bars: input.bars ?? null,
      quantization: input.quantization ?? '1bar',
      loopEnabled: input.loopEnabled ?? false,
      followAction: input.followAction ?? 'stop',
      followTargetSceneId: input.followTargetSceneId ?? null,
    }
    await insertRow(this.db, 'live_scenes', {
      id: scene.id,
      org_id: scene.organizationId,
      live_project_id: scene.liveProjectId,
      live_set_item_id: scene.liveSetItemId,
      name: scene.name,
      scene_type: scene.sceneType,
      sort_order: scene.sortOrder,
      color: scene.color,
      bpm: scene.bpm,
      song_key: scene.key,
      bars: scene.bars,
      quantization: scene.quantization,
      loop_enabled: scene.loopEnabled ? 1 : 0,
      follow_action: scene.followAction,
      follow_target_scene_id: scene.followTargetSceneId,
    })
    await this.touchProject(scene.liveProjectId)
    return scene
  }

  async getScene(id: string): Promise<LiveScene> {
    const row = await this.db.get('SELECT * FROM live_scenes WHERE id = ?', [id])
    if (!row) throw notFound('scene', id)
    return mapScene(row)
  }

  async listScenes(liveProjectId: string): Promise<LiveScene[]> {
    const rows = await this.db.query('SELECT * FROM live_scenes WHERE live_project_id = ? ORDER BY sort_order ASC', [liveProjectId])
    return rows.map(mapScene)
  }

  async updateScene(
    id: string,
    patch: Partial<Pick<LiveScene, 'name' | 'sceneType' | 'sortOrder' | 'color' | 'bpm' | 'key' | 'bars' | 'quantization' | 'loopEnabled' | 'followAction' | 'followTargetSceneId'>>,
  ): Promise<LiveScene> {
    const values: Record<string, string | number | null> = {}
    if (patch.name !== undefined) values.name = patch.name
    if (patch.sceneType !== undefined) values.scene_type = patch.sceneType
    if (patch.sortOrder !== undefined) values.sort_order = patch.sortOrder
    if (patch.color !== undefined) values.color = patch.color
    if (patch.bpm !== undefined) values.bpm = patch.bpm
    if (patch.key !== undefined) values.song_key = patch.key
    if (patch.bars !== undefined) values.bars = patch.bars
    if (patch.quantization !== undefined) values.quantization = patch.quantization
    if (patch.loopEnabled !== undefined) values.loop_enabled = patch.loopEnabled ? 1 : 0
    if (patch.followAction !== undefined) values.follow_action = patch.followAction
    if (patch.followTargetSceneId !== undefined) values.follow_target_scene_id = patch.followTargetSceneId
    await updateRow(this.db, 'live_scenes', id, values)
    return this.getScene(id)
  }

  async deleteScene(id: string): Promise<void> {
    await this.db.run('DELETE FROM live_clips WHERE live_scene_id = ?', [id])
    await this.db.run('DELETE FROM live_scenes WHERE id = ?', [id])
  }

  // --------------------------------------------------------------- clips ----

  async createClip(input: {
    orgId: string
    liveProjectId: string
    liveSceneId: string
    name: string
    sourceAssetId: string
    startMs?: number
    endMs?: number | null
    loopStartMs?: number | null
    loopEndMs?: number | null
    oneShot?: boolean
    gain?: number
    pan?: number
    outputId?: string | null
  }): Promise<LiveClip> {
    const clip: LiveClip = {
      id: newId('lclip', this.clock.now()),
      organizationId: input.orgId,
      liveProjectId: input.liveProjectId,
      liveSceneId: input.liveSceneId,
      name: input.name,
      sourceAssetId: input.sourceAssetId,
      startMs: input.startMs ?? 0,
      endMs: input.endMs ?? null,
      loopStartMs: input.loopStartMs ?? null,
      loopEndMs: input.loopEndMs ?? null,
      oneShot: input.oneShot ?? false,
      gain: input.gain ?? 1,
      pan: input.pan ?? 0,
      outputId: input.outputId ?? null,
    }
    await insertRow(this.db, 'live_clips', {
      id: clip.id,
      org_id: clip.organizationId,
      live_project_id: clip.liveProjectId,
      live_scene_id: clip.liveSceneId,
      name: clip.name,
      source_asset_id: clip.sourceAssetId,
      start_ms: clip.startMs,
      end_ms: clip.endMs,
      loop_start_ms: clip.loopStartMs,
      loop_end_ms: clip.loopEndMs,
      one_shot: clip.oneShot ? 1 : 0,
      gain: clip.gain,
      pan: clip.pan,
      output_id: clip.outputId,
    })
    return clip
  }

  async listClips(liveProjectId: string): Promise<LiveClip[]> {
    const rows = await this.db.query('SELECT * FROM live_clips WHERE live_project_id = ?', [liveProjectId])
    return rows.map(mapClip)
  }

  async deleteClip(id: string): Promise<void> {
    await this.db.run('DELETE FROM live_clips WHERE id = ?', [id])
  }

  // --------------------------------------------------------------- stems ----

  async createStem(input: {
    orgId: string
    liveProjectId: string
    liveSetItemId: string
    stemType: LiveStem['stemType']
    label?: string
    sourceAssetId: string
    gain?: number
    pan?: number
    outputId?: string | null
  }): Promise<LiveStem> {
    const stem: LiveStem = {
      id: newId('lstem', this.clock.now()),
      organizationId: input.orgId,
      liveProjectId: input.liveProjectId,
      liveSetItemId: input.liveSetItemId,
      stemType: input.stemType,
      label: input.label ?? input.stemType,
      sourceAssetId: input.sourceAssetId,
      gain: input.gain ?? 1,
      pan: input.pan ?? 0,
      muted: false,
      solo: false,
      outputId: input.outputId ?? null,
    }
    await insertRow(this.db, 'live_stems', {
      id: stem.id,
      org_id: stem.organizationId,
      live_project_id: stem.liveProjectId,
      live_set_item_id: stem.liveSetItemId,
      stem_type: stem.stemType,
      label: stem.label,
      source_asset_id: stem.sourceAssetId,
      gain: stem.gain,
      pan: stem.pan,
      muted: 0,
      solo: 0,
      output_id: stem.outputId,
    })
    return stem
  }

  async getStem(id: string): Promise<LiveStem> {
    const row = await this.db.get('SELECT * FROM live_stems WHERE id = ?', [id])
    if (!row) throw notFound('stem', id)
    return mapStem(row)
  }

  async listStems(liveProjectId: string): Promise<LiveStem[]> {
    const rows = await this.db.query('SELECT * FROM live_stems WHERE live_project_id = ?', [liveProjectId])
    return rows.map(mapStem)
  }

  async updateStem(id: string, patch: Partial<Pick<LiveStem, 'label' | 'gain' | 'pan' | 'muted' | 'solo' | 'outputId'>>): Promise<LiveStem> {
    const values: Record<string, string | number | null> = {}
    if (patch.label !== undefined) values.label = patch.label
    if (patch.gain !== undefined) values.gain = patch.gain
    if (patch.pan !== undefined) values.pan = patch.pan
    if (patch.muted !== undefined) values.muted = patch.muted ? 1 : 0
    if (patch.solo !== undefined) values.solo = patch.solo ? 1 : 0
    if (patch.outputId !== undefined) values.output_id = patch.outputId
    await updateRow(this.db, 'live_stems', id, values)
    return this.getStem(id)
  }

  async deleteStem(id: string): Promise<void> {
    await this.db.run('DELETE FROM live_stems WHERE id = ?', [id])
  }

  // ------------------------------------------------------- MIDI mappings ----

  async createMapping(input: Omit<MidiMapping, 'id'>): Promise<MidiMapping> {
    const mapping: MidiMapping = { ...input, id: newId('lmap', this.clock.now()) }
    await insertRow(this.db, 'live_midi_mappings', {
      id: mapping.id,
      org_id: mapping.organizationId,
      live_project_id: mapping.liveProjectId,
      device_identifier: mapping.deviceIdentifier,
      channel: mapping.channel,
      message_type: mapping.messageType,
      note_or_controller: mapping.noteOrController,
      target_type: mapping.targetType,
      target_id: mapping.targetId,
      minimum: mapping.minimum,
      maximum: mapping.maximum,
      inversion: mapping.inversion ? 1 : 0,
    })
    return mapping
  }

  async getMapping(id: string): Promise<MidiMapping> {
    const row = await this.db.get('SELECT * FROM live_midi_mappings WHERE id = ?', [id])
    if (!row) throw notFound('midi mapping', id)
    return mapMapping(row)
  }

  async listMappings(liveProjectId: string): Promise<MidiMapping[]> {
    const rows = await this.db.query('SELECT * FROM live_midi_mappings WHERE live_project_id = ?', [liveProjectId])
    return rows.map(mapMapping)
  }

  async updateMapping(id: string, patch: Partial<Omit<MidiMapping, 'id' | 'organizationId' | 'liveProjectId'>>): Promise<MidiMapping> {
    const values: Record<string, string | number | null> = {}
    if (patch.deviceIdentifier !== undefined) values.device_identifier = patch.deviceIdentifier
    if (patch.channel !== undefined) values.channel = patch.channel
    if (patch.messageType !== undefined) values.message_type = patch.messageType
    if (patch.noteOrController !== undefined) values.note_or_controller = patch.noteOrController
    if (patch.targetType !== undefined) values.target_type = patch.targetType
    if (patch.targetId !== undefined) values.target_id = patch.targetId
    if (patch.minimum !== undefined) values.minimum = patch.minimum
    if (patch.maximum !== undefined) values.maximum = patch.maximum
    if (patch.inversion !== undefined) values.inversion = patch.inversion ? 1 : 0
    await updateRow(this.db, 'live_midi_mappings', id, values)
    return this.getMapping(id)
  }

  async deleteMapping(id: string): Promise<void> {
    await this.db.run('DELETE FROM live_midi_mappings WHERE id = ?', [id])
  }

  // -------------------------------------------------------------- outputs ----

  /**
   * The three default buses, created idempotently.
   *
   * Called from GET endpoints, so two concurrent reads race — a check-then-
   * insert produced six outputs that then flowed into the manifest and the
   * Stage Control handoff. Deterministic ids make the insert a no-op on
   * conflict instead, which both dialects support.
   */
  async ensureDefaultOutputs(orgId: string, liveProjectId: string): Promise<LiveOutput[]> {
    const suffix = liveProjectId.replace(/^lproj_/, '')
    for (const [name, type] of [
      ['Master', 'master'],
      ['Cue', 'cue'],
      ['Click', 'click'],
    ] as const) {
      await upsertRow(
        this.db,
        'live_outputs',
        {
          id: `lout_${type}_${suffix}`,
          org_id: orgId,
          live_project_id: liveProjectId,
          name,
          output_type: type,
          device_id: null,
          channel_index: null,
        },
        ['id'],
        [],
      )
    }
    return this.listOutputs(liveProjectId)
  }

  async listOutputs(liveProjectId: string): Promise<LiveOutput[]> {
    const rows = await this.db.query('SELECT * FROM live_outputs WHERE live_project_id = ?', [liveProjectId])
    return rows.map((row) => ({
      id: toStr(row.id),
      name: toStr(row.name),
      type: toStr(row.output_type) as LiveOutput['type'],
      ...(toStrOrNull(row.device_id) !== null ? { deviceId: toStr(row.device_id) } : {}),
      ...(toNumOrNull(row.channel_index) !== null ? { channelIndex: toNum(row.channel_index) } : {}),
    }))
  }

  async countOutputs(liveProjectId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM live_outputs WHERE live_project_id = ?', [liveProjectId])
    return toNum(row?.n)
  }

  async createOutput(input: { orgId: string; liveProjectId: string; name: string; type: LiveOutput['type']; deviceId?: string; channelIndex?: number }): Promise<LiveOutput> {
    const id = newId('lout', this.clock.now())
    await insertRow(this.db, 'live_outputs', {
      id,
      org_id: input.orgId,
      live_project_id: input.liveProjectId,
      name: input.name,
      output_type: input.type,
      device_id: input.deviceId ?? null,
      channel_index: input.channelIndex ?? null,
    })
    return { id, name: input.name, type: input.type, ...(input.deviceId ? { deviceId: input.deviceId } : {}), ...(input.channelIndex !== undefined ? { channelIndex: input.channelIndex } : {}) }
  }

  // --------------------------------------------------------------- assets ----

  async createAsset(input: {
    orgId: string
    liveProjectId: string
    kind: LiveAsset['kind']
    storageKey: string
    filename: string
    mime: string
    bytes: number
    sha256: string
    durationMs?: number | null
    metadata?: Record<string, unknown>
    rightsOwner?: string
    rightsConfirmed: boolean
    rightsConfirmedBy?: string | null
    lineage?: GenerationLineage | null
    createdBy: string
  }): Promise<LiveAsset> {
    const now = this.clock.isoNow()
    const asset: LiveAsset = {
      id: newId('last', this.clock.now()),
      organizationId: input.orgId,
      liveProjectId: input.liveProjectId,
      kind: input.kind,
      storageKey: input.storageKey,
      filename: input.filename,
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      durationMs: input.durationMs ?? null,
      metadata: input.metadata ?? {},
      rightsOwner: input.rightsOwner ?? '',
      rightsConfirmed: input.rightsConfirmed,
      rightsConfirmedBy: input.rightsConfirmed ? (input.rightsConfirmedBy ?? input.createdBy) : null,
      rightsConfirmedAt: input.rightsConfirmed ? now : null,
      lineage: input.lineage ?? null,
      createdBy: input.createdBy,
      createdAt: now,
    }
    await insertRow(this.db, 'live_assets', {
      id: asset.id,
      org_id: asset.organizationId,
      live_project_id: asset.liveProjectId,
      kind: asset.kind,
      storage_key: asset.storageKey,
      filename: asset.filename,
      mime: asset.mime,
      bytes: asset.bytes,
      sha256: asset.sha256,
      duration_ms: asset.durationMs,
      metadata: JSON.stringify(asset.metadata),
      rights_owner: asset.rightsOwner,
      rights_confirmed: asset.rightsConfirmed ? 1 : 0,
      rights_confirmed_by: asset.rightsConfirmedBy,
      rights_confirmed_at: asset.rightsConfirmedAt,
      lineage: asset.lineage ? JSON.stringify(asset.lineage) : null,
      created_by: asset.createdBy,
      created_at: asset.createdAt,
    })
    return asset
  }

  async getAsset(id: string): Promise<LiveAsset> {
    const row = await this.db.get('SELECT * FROM live_assets WHERE id = ?', [id])
    if (!row) throw notFound('live asset', id)
    return mapAsset(row)
  }

  async listAssets(liveProjectId: string): Promise<LiveAsset[]> {
    const rows = await this.db.query('SELECT * FROM live_assets WHERE live_project_id = ? ORDER BY created_at DESC', [liveProjectId])
    return rows.map(mapAsset)
  }

  async approveAssetLineage(id: string, approvedBy: string): Promise<void> {
    const asset = await this.getAsset(id)
    if (!asset.lineage) return
    const lineage: GenerationLineage = { ...asset.lineage, approvedBy, approvedAt: this.clock.isoNow() }
    await updateRow(this.db, 'live_assets', id, { lineage: JSON.stringify(lineage) })
  }

  // -------------------------------------------------------------- AI jobs ----

  async createAiJob(input: {
    orgId: string
    liveProjectId: string
    liveSetItemId?: string | null
    sourceAssetId?: string | null
    provider: string
    operation: string
    configuration: AiSceneRequest
    estimatedCostMicros?: number
    createdBy: string
  }): Promise<LiveAiJob> {
    const now = this.clock.isoNow()
    const job: LiveAiJob = {
      id: newId('laij', this.clock.now()),
      organizationId: input.orgId,
      liveProjectId: input.liveProjectId,
      liveSetItemId: input.liveSetItemId ?? null,
      sourceAssetId: input.sourceAssetId ?? null,
      provider: input.provider,
      operation: input.operation,
      prompt: input.configuration.prompt,
      configuration: input.configuration,
      status: 'queued',
      outputAssetIds: [],
      error: null,
      estimatedCostMicros: input.estimatedCostMicros ?? 0,
      finalCostMicros: null,
      createdBy: input.createdBy,
      createdAt: now,
      completedAt: null,
    }
    await insertRow(this.db, 'live_ai_jobs', {
      id: job.id,
      org_id: job.organizationId,
      live_project_id: job.liveProjectId,
      live_set_item_id: job.liveSetItemId,
      source_asset_id: job.sourceAssetId,
      provider: job.provider,
      operation: job.operation,
      prompt: job.prompt,
      configuration: JSON.stringify(job.configuration),
      status: job.status,
      output_asset_ids: JSON.stringify(job.outputAssetIds),
      error: null,
      estimated_cost_micros: job.estimatedCostMicros,
      final_cost_micros: null,
      created_by: job.createdBy,
      created_at: now,
      completed_at: null,
    })
    return job
  }

  async getAiJob(id: string): Promise<LiveAiJob> {
    const row = await this.db.get('SELECT * FROM live_ai_jobs WHERE id = ?', [id])
    if (!row) throw notFound('ai job', id)
    return mapAiJob(row)
  }

  async listAiJobs(liveProjectId: string): Promise<LiveAiJob[]> {
    const rows = await this.db.query('SELECT * FROM live_ai_jobs WHERE live_project_id = ? ORDER BY created_at DESC', [liveProjectId])
    return rows.map(mapAiJob)
  }

  async updateAiJob(
    id: string,
    patch: { status?: AiJobStatus; outputAssetIds?: string[]; error?: string | null; finalCostMicros?: number | null; completedAt?: string | null },
  ): Promise<LiveAiJob> {
    const values: Record<string, string | number | null> = {}
    if (patch.status !== undefined) values.status = patch.status
    if (patch.outputAssetIds !== undefined) values.output_asset_ids = JSON.stringify(patch.outputAssetIds)
    if (patch.error !== undefined) values.error = patch.error
    if (patch.finalCostMicros !== undefined) values.final_cost_micros = patch.finalCostMicros
    if (patch.completedAt !== undefined) values.completed_at = patch.completedAt
    await updateRow(this.db, 'live_ai_jobs', id, values)
    return this.getAiJob(id)
  }

  /** Generations started by the org since `sinceIso` — feeds the monthly usage limit. */
  async countAiJobsSince(orgId: string, sinceIso: string): Promise<number> {
    const row = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM live_ai_jobs WHERE org_id = ? AND created_at >= ?', [orgId, sinceIso])
    return toNum(row?.n)
  }

  // ------------------------------------------------------------- packages ----

  async createPackage(input: { orgId: string; liveProjectId: string; manifest: PerformanceManifest; storageSize: number }): Promise<LivePerformancePackage> {
    const versionRow = await this.db.get<{ v: number }>('SELECT MAX(version) AS v FROM live_performance_packages WHERE live_project_id = ?', [
      input.liveProjectId,
    ])
    const version = toNum(versionRow?.v) + 1
    const record: LivePerformancePackage = {
      id: newId('lpkg', this.clock.now()),
      organizationId: input.orgId,
      liveProjectId: input.liveProjectId,
      version,
      status: 'caching',
      manifest: input.manifest,
      storageSize: input.storageSize,
      createdAt: this.clock.isoNow(),
      verifiedAt: null,
    }
    await insertRow(this.db, 'live_performance_packages', {
      id: record.id,
      org_id: record.organizationId,
      live_project_id: record.liveProjectId,
      version,
      status: record.status,
      manifest: JSON.stringify(record.manifest),
      storage_size: record.storageSize,
      created_at: record.createdAt,
      verified_at: null,
    })
    return record
  }

  async getPackage(id: string): Promise<LivePerformancePackage> {
    const row = await this.db.get('SELECT * FROM live_performance_packages WHERE id = ?', [id])
    if (!row) throw notFound('performance package', id)
    return mapPackage(row)
  }

  async listPackages(liveProjectId: string): Promise<LivePerformancePackage[]> {
    const rows = await this.db.query('SELECT * FROM live_performance_packages WHERE live_project_id = ? ORDER BY version DESC', [liveProjectId])
    return rows.map(mapPackage)
  }

  async updatePackage(id: string, patch: { status?: string; verifiedAt?: string | null; storageSize?: number }): Promise<LivePerformancePackage> {
    const values: Record<string, string | number | null> = {}
    if (patch.status !== undefined) values.status = patch.status
    if (patch.verifiedAt !== undefined) values.verified_at = patch.verifiedAt
    if (patch.storageSize !== undefined) values.storage_size = patch.storageSize
    await updateRow(this.db, 'live_performance_packages', id, values)
    return this.getPackage(id)
  }

  // --------------------------------------------------------------- events ----

  async recordEvents(
    orgId: string,
    liveProjectId: string,
    events: Array<{ eventType: PerformanceEventType; payload: Record<string, unknown>; localTimestamp: string; performancePackageId?: string | null }>,
  ): Promise<number> {
    const now = this.clock.isoNow()
    for (const event of events) {
      await insertRow(this.db, 'live_performance_events', {
        id: newId('lpev', this.clock.now()),
        org_id: orgId,
        live_project_id: liveProjectId,
        performance_package_id: event.performancePackageId ?? null,
        event_type: event.eventType,
        payload: JSON.stringify(event.payload),
        local_timestamp: event.localTimestamp,
        synchronized_at: now,
        created_at: now,
      })
    }
    return events.length
  }

  private async nextSortOrder(table: 'live_set_items' | 'live_scenes', liveProjectId: string, scopeColumn?: string, scopeValue?: string): Promise<number> {
    const where = scopeColumn ? `${scopeColumn} = ?` : 'live_project_id = ?'
    const row = await this.db.get<{ v: number }>(`SELECT MAX(sort_order) AS v FROM ${table} WHERE ${where}`, [scopeValue ?? liveProjectId])
    const max = row?.v
    return max === null || max === undefined ? 0 : toNum(max) + 1
  }
}

// ----------------------------------------------------------------- mappers ----

function mapProject(row: Record<string, unknown>): LiveProject {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    artistId: toStrOrNull(row.artist_id),
    name: toStr(row.name),
    description: toStr(row.description),
    status: toStr(row.status) as LiveProject['status'],
    masterTempo: toNum(row.master_tempo),
    timeSignature: toStr(row.time_signature),
    sourceReleaseIds: parseJsonColumn<string[]>(row.source_release_ids, []),
    padMap: normalizePadMap(parseJsonColumn<unknown>(row.pad_map, defaultPadMap())),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapItem(row: Record<string, unknown>): LiveSetItem {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    liveProjectId: toStr(row.live_project_id),
    sortOrder: toNum(row.sort_order),
    type: toStr(row.item_type) as LiveSetItem['type'],
    title: toStr(row.title),
    sourceReleaseId: toStrOrNull(row.source_release_id),
    sourceTrackId: toStrOrNull(row.source_track_id),
    bpm: toNumOrNull(row.bpm),
    key: toStrOrNull(row.song_key),
    durationMs: toNumOrNull(row.duration_ms),
    notes: toStr(row.notes),
  }
}

function mapScene(row: Record<string, unknown>): LiveScene {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    liveProjectId: toStr(row.live_project_id),
    liveSetItemId: toStr(row.live_set_item_id),
    name: toStr(row.name),
    sceneType: toStr(row.scene_type) as LiveScene['sceneType'],
    sortOrder: toNum(row.sort_order),
    color: toStr(row.color),
    bpm: toNumOrNull(row.bpm),
    key: toStrOrNull(row.song_key),
    bars: toNumOrNull(row.bars),
    quantization: toStr(row.quantization) as LiveScene['quantization'],
    loopEnabled: toBool(row.loop_enabled),
    followAction: toStr(row.follow_action) as LiveScene['followAction'],
    followTargetSceneId: toStrOrNull(row.follow_target_scene_id),
  }
}

function mapClip(row: Record<string, unknown>): LiveClip {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    liveProjectId: toStr(row.live_project_id),
    liveSceneId: toStr(row.live_scene_id),
    name: toStr(row.name),
    sourceAssetId: toStr(row.source_asset_id),
    startMs: toNum(row.start_ms),
    endMs: toNumOrNull(row.end_ms),
    loopStartMs: toNumOrNull(row.loop_start_ms),
    loopEndMs: toNumOrNull(row.loop_end_ms),
    oneShot: toBool(row.one_shot),
    gain: toNum(row.gain, 1),
    pan: toNum(row.pan),
    outputId: toStrOrNull(row.output_id),
  }
}

function mapStem(row: Record<string, unknown>): LiveStem {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    liveProjectId: toStr(row.live_project_id),
    liveSetItemId: toStr(row.live_set_item_id),
    stemType: toStr(row.stem_type) as LiveStem['stemType'],
    label: toStr(row.label),
    sourceAssetId: toStr(row.source_asset_id),
    gain: toNum(row.gain, 1),
    pan: toNum(row.pan),
    muted: toBool(row.muted),
    solo: toBool(row.solo),
    outputId: toStrOrNull(row.output_id),
  }
}

function mapMapping(row: Record<string, unknown>): MidiMapping {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    liveProjectId: toStr(row.live_project_id),
    deviceIdentifier: toStr(row.device_identifier),
    channel: toNum(row.channel),
    messageType: toStr(row.message_type) as MidiMapping['messageType'],
    noteOrController: toNum(row.note_or_controller),
    targetType: toStr(row.target_type) as MidiMapping['targetType'],
    targetId: toStrOrNull(row.target_id),
    minimum: toNum(row.minimum),
    maximum: toNum(row.maximum, 127),
    inversion: toBool(row.inversion),
  }
}

function mapAsset(row: Record<string, unknown>): LiveAsset {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    liveProjectId: toStr(row.live_project_id),
    kind: toStr(row.kind) as LiveAsset['kind'],
    storageKey: toStr(row.storage_key),
    filename: toStr(row.filename),
    mime: toStr(row.mime),
    bytes: toNum(row.bytes),
    sha256: toStr(row.sha256),
    durationMs: toNumOrNull(row.duration_ms),
    metadata: parseJsonColumn<Record<string, unknown>>(row.metadata, {}),
    rightsOwner: toStr(row.rights_owner),
    rightsConfirmed: toBool(row.rights_confirmed),
    rightsConfirmedBy: toStrOrNull(row.rights_confirmed_by),
    rightsConfirmedAt: toStrOrNull(row.rights_confirmed_at),
    lineage: parseJsonColumn<GenerationLineage | null>(row.lineage, null),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}

function mapAiJob(row: Record<string, unknown>): LiveAiJob {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    liveProjectId: toStr(row.live_project_id),
    liveSetItemId: toStrOrNull(row.live_set_item_id),
    sourceAssetId: toStrOrNull(row.source_asset_id),
    provider: toStr(row.provider),
    operation: toStr(row.operation),
    prompt: toStr(row.prompt),
    configuration: parseJsonColumn(row.configuration, {} as AiSceneRequest),
    status: toStr(row.status) as AiJobStatus,
    outputAssetIds: parseJsonColumn<string[]>(row.output_asset_ids, []),
    error: toStrOrNull(row.error),
    estimatedCostMicros: toNum(row.estimated_cost_micros),
    finalCostMicros: toNumOrNull(row.final_cost_micros),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    completedAt: toStrOrNull(row.completed_at),
  }
}

function mapPackage(row: Record<string, unknown>): LivePerformancePackage {
  return {
    id: toStr(row.id),
    organizationId: toStr(row.org_id),
    liveProjectId: toStr(row.live_project_id),
    version: toNum(row.version),
    status: toStr(row.status),
    manifest: parseJsonColumn<PerformanceManifest | null>(row.manifest, null),
    storageSize: toNum(row.storage_size),
    createdAt: toStr(row.created_at),
    verifiedAt: toStrOrNull(row.verified_at),
  }
}
