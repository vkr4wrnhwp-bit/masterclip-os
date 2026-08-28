import { insertRow, toBool, toNum, toStr, toStrOrNull, type Db, type Row } from '@masterclip/database'
import { AppError, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import {
  RACK_STAGES,
  type RackChainRecord,
  type RackHistoryRecord,
  type RackModuleRecord,
  type RackModuleSnapshot,
  type RackPresetRecord,
  type RackStage,
  type RackType,
} from './types.js'

/**
 * Racks.
 *
 * Every mutation snapshots the whole chain into `studio_rack_history` before
 * applying, and undo restores a snapshot. Inverse operations would be smaller
 * but they stop being correct the moment modules can be added, removed and
 * reordered — the undo of "remove the third module" depends on what the third
 * module was, and reconstructing that from an inverse log is how undo trees
 * quietly corrupt themselves.
 */
export class RackRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  // --- chains --------------------------------------------------------------

  async createChain(input: {
    orgId: string
    studioProjectId: string
    studioVersionId?: string | null
    rackType: RackType
    name: string
    abSlot?: 'a' | 'b'
    createdBy: string
  }): Promise<RackChainRecord> {
    const now = this.clock.isoNow()
    const record: RackChainRecord = {
      id: newId('strk', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      rackType: input.rackType,
      name: input.name,
      abSlot: input.abSlot ?? 'a',
      stateVersion: 1,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_rack_chains', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      rack_type: record.rackType,
      name: record.name,
      ab_slot: record.abSlot,
      state_version: record.stateVersion,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    await this.snapshot(record.orgId, record.id, 1, 'created', [], record.createdBy)
    return record
  }

  async getChain(orgId: string, id: string): Promise<RackChainRecord> {
    const row = await this.db.get('SELECT * FROM studio_rack_chains WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('rack', id)
    return mapChain(row)
  }

  async listChains(orgId: string, projectId: string): Promise<RackChainRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_rack_chains WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at ASC', [orgId, projectId])
    return rows.map(mapChain)
  }

  async renameChain(orgId: string, id: string, name: string): Promise<void> {
    await this.db.run('UPDATE studio_rack_chains SET name = ?, updated_at = ? WHERE id = ? AND org_id = ?', [name, this.clock.isoNow(), id, orgId])
  }

  async deleteChain(orgId: string, id: string): Promise<void> {
    await this.getChain(orgId, id)
    await this.db.run('DELETE FROM studio_rack_modules WHERE org_id = ? AND rack_chain_id = ?', [orgId, id])
    await this.db.run('DELETE FROM studio_rack_history WHERE org_id = ? AND rack_chain_id = ?', [orgId, id])
    await this.db.run('DELETE FROM studio_rack_chains WHERE id = ? AND org_id = ?', [id, orgId])
  }

  // --- modules -------------------------------------------------------------

  async listModules(orgId: string, chainId: string): Promise<RackModuleRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_rack_modules WHERE org_id = ? AND rack_chain_id = ? ORDER BY order_index ASC', [orgId, chainId])
    return rows.map(mapModule).sort(byStageThenOrder)
  }

  /**
   * Applies a new module list wholesale.
   *
   * Add, remove, reorder and bypass all route through here, because every one
   * of them is "the chain is now this". One write path means one place that
   * snapshots history, one place that renumbers order indices, and no way for a
   * partial update to leave a chain with two modules at index 3.
   */
  async replaceModules(input: {
    orgId: string
    chainId: string
    modules: RackModuleSnapshot[]
    action: string
    actorUserId: string
  }): Promise<RackModuleRecord[]> {
    const chain = await this.getChain(input.orgId, input.chainId)
    const now = this.clock.isoNow()

    const ordered = normalize(input.modules)
    await this.db.run('DELETE FROM studio_rack_modules WHERE org_id = ? AND rack_chain_id = ?', [input.orgId, input.chainId])
    for (const module of ordered) {
      await insertRow(this.db, 'studio_rack_modules', {
        id: newId('stmd', this.clock.now()),
        org_id: input.orgId,
        rack_chain_id: input.chainId,
        stage: module.stage,
        module_type: module.moduleType,
        order_index: module.orderIndex,
        bypassed: module.bypassed ? 1 : 0,
        params: toJson(module.params),
        created_at: now,
        updated_at: now,
      })
    }

    const stateVersion = chain.stateVersion + 1
    await this.db.run('UPDATE studio_rack_chains SET state_version = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      stateVersion,
      now,
      input.chainId,
      input.orgId,
    ])
    await this.snapshot(input.orgId, input.chainId, stateVersion, input.action, ordered, input.actorUserId)
    return this.listModules(input.orgId, input.chainId)
  }

  // --- history / undo / redo ----------------------------------------------

  private async snapshot(orgId: string, chainId: string, stateVersion: number, action: string, modules: RackModuleSnapshot[], createdBy: string): Promise<void> {
    // Any redo branch above this version is discarded: once a new edit is made
    // from an undone state, the abandoned future is unreachable and keeping it
    // would make "redo" mean two different things.
    await this.db.run('DELETE FROM studio_rack_history WHERE org_id = ? AND rack_chain_id = ? AND state_version > ?', [orgId, chainId, stateVersion])
    await insertRow(this.db, 'studio_rack_history', {
      id: newId('stpr', this.clock.now()),
      org_id: orgId,
      rack_chain_id: chainId,
      state_version: stateVersion,
      action,
      snapshot: toJson(modules),
      created_by: createdBy,
      created_at: this.clock.isoNow(),
    })
  }

  async history(orgId: string, chainId: string): Promise<RackHistoryRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_rack_history WHERE org_id = ? AND rack_chain_id = ? ORDER BY state_version ASC', [orgId, chainId])
    return rows.map(mapHistory)
  }

  /**
   * Moves the chain to another point in its history.
   *
   * Restoring is a plain write of the stored module list and a move of the
   * chain's `state_version` pointer — the history itself is untouched, so
   * undo and redo are the same operation in two directions.
   */
  async restore(orgId: string, chainId: string, targetVersion: number): Promise<RackModuleRecord[]> {
    const entry = await this.db.get('SELECT * FROM studio_rack_history WHERE org_id = ? AND rack_chain_id = ? AND state_version = ?', [
      orgId,
      chainId,
      targetVersion,
    ])
    if (!entry) {
      throw new AppError({ kind: 'validation', code: 'studio.rack_no_history', message: 'there is nothing to move to in this direction' })
    }
    const snapshot = mapHistory(entry).snapshot
    const now = this.clock.isoNow()
    await this.db.run('DELETE FROM studio_rack_modules WHERE org_id = ? AND rack_chain_id = ?', [orgId, chainId])
    for (const module of normalize(snapshot)) {
      await insertRow(this.db, 'studio_rack_modules', {
        id: newId('stmd', this.clock.now()),
        org_id: orgId,
        rack_chain_id: chainId,
        stage: module.stage,
        module_type: module.moduleType,
        order_index: module.orderIndex,
        bypassed: module.bypassed ? 1 : 0,
        params: toJson(module.params),
        created_at: now,
        updated_at: now,
      })
    }
    await this.db.run('UPDATE studio_rack_chains SET state_version = ?, updated_at = ? WHERE id = ? AND org_id = ?', [targetVersion, now, chainId, orgId])
    return this.listModules(orgId, chainId)
  }

  // --- presets -------------------------------------------------------------

  async createPreset(input: {
    orgId: string
    scope: 'project' | 'artist' | 'org'
    studioProjectId?: string | null
    artistKey?: string | null
    rackType: RackType
    name: string
    modules: RackModuleSnapshot[]
    createdBy: string
  }): Promise<RackPresetRecord> {
    const now = this.clock.isoNow()
    const record: RackPresetRecord = {
      id: newId('stpr', this.clock.now()),
      orgId: input.orgId,
      scope: input.scope,
      studioProjectId: input.studioProjectId ?? null,
      artistKey: input.artistKey ?? null,
      rackType: input.rackType,
      name: input.name,
      modules: normalize(input.modules),
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_rack_presets', {
      id: record.id,
      org_id: record.orgId,
      scope: record.scope,
      studio_project_id: record.studioProjectId,
      artist_key: record.artistKey,
      rack_type: record.rackType,
      name: record.name,
      modules: toJson(record.modules),
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async listPresets(orgId: string, opts: { rackType?: RackType; projectId?: string; artistKey?: string } = {}): Promise<RackPresetRecord[]> {
    const where = ['org_id = ?']
    const params: string[] = [orgId]
    if (opts.rackType) {
      where.push('rack_type = ?')
      params.push(opts.rackType)
    }
    // Org presets always apply; project and artist presets only where they match.
    const scopes: string[] = ["scope = 'org'"]
    if (opts.projectId) {
      scopes.push('(scope = ? AND studio_project_id = ?)')
      params.push('project', opts.projectId)
    }
    if (opts.artistKey) {
      scopes.push('(scope = ? AND artist_key = ?)')
      params.push('artist', opts.artistKey)
    }
    where.push(`(${scopes.join(' OR ')})`)
    const rows = await this.db.query(`SELECT * FROM studio_rack_presets WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, params)
    return rows.map(mapPreset)
  }

  async getPreset(orgId: string, id: string): Promise<RackPresetRecord> {
    const row = await this.db.get('SELECT * FROM studio_rack_presets WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('rack preset', id)
    return mapPreset(row)
  }

  async deletePreset(orgId: string, id: string): Promise<void> {
    await this.getPreset(orgId, id)
    await this.db.run('DELETE FROM studio_rack_presets WHERE id = ? AND org_id = ?', [id, orgId])
  }
}

const STAGE_ORDER: Record<RackStage, number> = { clean: 0, tune: 1, shape: 2, color: 3, space: 4 }

function byStageThenOrder(a: { stage: RackStage; orderIndex: number }, b: { stage: RackStage; orderIndex: number }): number {
  return STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.orderIndex - b.orderIndex
}

/**
 * Sorts into signal order and renumbers.
 *
 * The stage sequence is the product's opinion about signal flow and is not
 * negotiable through the API: a caller that submits a reverb before a de-esser
 * gets a correctly ordered chain back rather than an error, because the
 * ordering it asked for is not a thing this rack can be in.
 */
function normalize(modules: RackModuleSnapshot[]): RackModuleSnapshot[] {
  return [...modules]
    .filter((module) => (RACK_STAGES as readonly string[]).includes(module.stage))
    .sort(byStageThenOrder)
    .map((module, index) => ({ ...module, orderIndex: index, params: module.params ?? {} }))
}

function mapChain(row: Row): RackChainRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    studioVersionId: toStrOrNull(row.studio_version_id),
    rackType: toStr(row.rack_type) as RackType,
    name: toStr(row.name),
    abSlot: toStr(row.ab_slot) === 'b' ? 'b' : 'a',
    stateVersion: toNum(row.state_version),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapModule(row: Row): RackModuleRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    rackChainId: toStr(row.rack_chain_id),
    stage: toStr(row.stage) as RackStage,
    moduleType: toStr(row.module_type),
    orderIndex: toNum(row.order_index),
    bypassed: toBool(row.bypassed),
    params: parseJson<Record<string, number | string | boolean>>(row.params, {}),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapHistory(row: Row): RackHistoryRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    rackChainId: toStr(row.rack_chain_id),
    stateVersion: toNum(row.state_version),
    action: toStr(row.action),
    snapshot: parseJson<RackModuleSnapshot[]>(row.snapshot, []),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}

function mapPreset(row: Row): RackPresetRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    scope: toStr(row.scope) as 'project' | 'artist' | 'org',
    studioProjectId: toStrOrNull(row.studio_project_id),
    artistKey: toStrOrNull(row.artist_key),
    rackType: toStr(row.rack_type) as RackType,
    name: toStr(row.name),
    modules: parseJson<RackModuleSnapshot[]>(row.modules, []),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

export { normalize as normalizeRackModules }
