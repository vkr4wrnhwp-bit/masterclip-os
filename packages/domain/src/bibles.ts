import { type Db, insertRow, parseJsonColumn, toBool, toNum, toStr, updateRow } from '@masterclip/database'
import { conflict, hashObject, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { CharacterRecord, EnvironmentRecord, type RightsStatus } from '@masterclip/shot-schema'

export interface VersionedCharacter {
  id: string
  projectId: string
  characterKey: string
  name: string
  version: number
  rightsStatus: RightsStatus
  record: CharacterRecord
  locked: boolean
  createdAt: string
}

export interface VersionedEnvironment {
  id: string
  projectId: string
  environmentKey: string
  name: string
  version: number
  record: EnvironmentRecord
  locked: boolean
  createdAt: string
}

/**
 * Character Bible and World Bible storage.
 *
 * Every edit creates a new version rather than mutating the current one, and a
 * render records the version it used. That is what makes continuity questions
 * answerable months later: "which reference pack produced this face" has an
 * exact answer, not an approximation.
 */
export class BibleRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  // --- characters -----------------------------------------------------------

  async createCharacter(input: { projectId: string; record: CharacterRecord; createdBy: string }): Promise<VersionedCharacter> {
    const record = CharacterRecord.parse({ ...input.record, version: 1 })
    const existing = await this.db.get('SELECT id FROM characters WHERE project_id = ? AND character_key = ?', [
      input.projectId,
      record.character_key,
    ])
    if (existing) throw conflict(`character "${record.character_key}" already exists in this project`)

    const now = this.clock.isoNow()
    const id = newId('char', this.clock.now())
    await this.db.transaction(async (tx) => {
      await insertRow(tx, 'characters', {
        id,
        project_id: input.projectId,
        character_key: record.character_key,
        name: record.name,
        current_version: 1,
        rights_status: record.rights_status,
        created_at: now,
        updated_at: now,
      })
      await insertRow(tx, 'character_versions', {
        id: newId('cver', this.clock.now()),
        character_id: id,
        version: 1,
        data: JSON.stringify(record),
        data_hash: hashObject(record),
        locked: record.locked ? 1 : 0,
        note: 'initial version',
        created_by: input.createdBy,
        created_at: now,
      })
    })
    return { id, projectId: input.projectId, characterKey: record.character_key, name: record.name, version: 1, rightsStatus: record.rights_status, record, locked: record.locked, createdAt: now }
  }

  async updateCharacter(input: { characterId: string; record: CharacterRecord; createdBy: string; note?: string }): Promise<VersionedCharacter> {
    const row = await this.db.get('SELECT * FROM characters WHERE id = ?', [input.characterId])
    if (!row) throw notFound('character', input.characterId)
    const nextVersion = toNum(row.current_version) + 1
    const record = CharacterRecord.parse({ ...input.record, version: nextVersion })
    const now = this.clock.isoNow()

    await this.db.transaction(async (tx) => {
      await insertRow(tx, 'character_versions', {
        id: newId('cver', this.clock.now()),
        character_id: input.characterId,
        version: nextVersion,
        data: JSON.stringify(record),
        data_hash: hashObject(record),
        locked: record.locked ? 1 : 0,
        note: input.note ?? '',
        created_by: input.createdBy,
        created_at: now,
      })
      await updateRow(tx, 'characters', input.characterId, {
        current_version: nextVersion,
        name: record.name,
        rights_status: record.rights_status,
        updated_at: now,
      })
    })

    return {
      id: input.characterId,
      projectId: toStr(row.project_id),
      characterKey: record.character_key,
      name: record.name,
      version: nextVersion,
      rightsStatus: record.rights_status,
      record,
      locked: record.locked,
      createdAt: now,
    }
  }

  async listCharacters(projectId: string): Promise<VersionedCharacter[]> {
    const rows = await this.db.query(
      `SELECT c.*, v.data, v.locked AS version_locked, v.created_at AS version_created_at
         FROM characters c
         JOIN character_versions v ON v.character_id = c.id AND v.version = c.current_version
        WHERE c.project_id = ? ORDER BY c.character_key ASC`,
      [projectId],
    )
    return rows.map(mapCharacter)
  }

  /** Resolves `version = 0` to "current at read time"; anything else is pinned. */
  async getCharacter(projectId: string, characterKey: string, version = 0): Promise<VersionedCharacter> {
    const row =
      version > 0
        ? await this.db.get(
            `SELECT c.*, v.data, v.locked AS version_locked, v.created_at AS version_created_at, v.version AS pinned_version
               FROM characters c JOIN character_versions v ON v.character_id = c.id
              WHERE c.project_id = ? AND c.character_key = ? AND v.version = ?`,
            [projectId, characterKey, version],
          )
        : await this.db.get(
            `SELECT c.*, v.data, v.locked AS version_locked, v.created_at AS version_created_at
               FROM characters c JOIN character_versions v ON v.character_id = c.id AND v.version = c.current_version
              WHERE c.project_id = ? AND c.character_key = ?`,
            [projectId, characterKey],
          )
    if (!row) throw notFound(`character ${characterKey}${version > 0 ? ` v${version}` : ''}`)
    return mapCharacter(row)
  }

  async characterVersions(characterId: string): Promise<Array<{ version: number; createdAt: string; createdBy: string; note: string; hash: string }>> {
    const rows = await this.db.query('SELECT version, created_at, created_by, note, data_hash FROM character_versions WHERE character_id = ? ORDER BY version DESC', [
      characterId,
    ])
    return rows.map((r) => ({
      version: toNum(r.version),
      createdAt: toStr(r.created_at),
      createdBy: toStr(r.created_by),
      note: toStr(r.note),
      hash: toStr(r.data_hash),
    }))
  }

  // --- environments ---------------------------------------------------------

  async createEnvironment(input: { projectId: string; record: EnvironmentRecord; createdBy: string }): Promise<VersionedEnvironment> {
    const record = EnvironmentRecord.parse({ ...input.record, version: 1 })
    const existing = await this.db.get('SELECT id FROM environments WHERE project_id = ? AND environment_key = ?', [
      input.projectId,
      record.environment_key,
    ])
    if (existing) throw conflict(`environment "${record.environment_key}" already exists in this project`)

    const now = this.clock.isoNow()
    const id = newId('env', this.clock.now())
    await this.db.transaction(async (tx) => {
      await insertRow(tx, 'environments', {
        id,
        project_id: input.projectId,
        environment_key: record.environment_key,
        name: record.name,
        current_version: 1,
        created_at: now,
        updated_at: now,
      })
      await insertRow(tx, 'environment_versions', {
        id: newId('ever', this.clock.now()),
        environment_id: id,
        version: 1,
        data: JSON.stringify(record),
        data_hash: hashObject(record),
        locked: record.locked ? 1 : 0,
        note: 'initial version',
        created_by: input.createdBy,
        created_at: now,
      })
    })
    return { id, projectId: input.projectId, environmentKey: record.environment_key, name: record.name, version: 1, record, locked: record.locked, createdAt: now }
  }

  async updateEnvironment(input: { environmentId: string; record: EnvironmentRecord; createdBy: string; note?: string }): Promise<VersionedEnvironment> {
    const row = await this.db.get('SELECT * FROM environments WHERE id = ?', [input.environmentId])
    if (!row) throw notFound('environment', input.environmentId)
    const nextVersion = toNum(row.current_version) + 1
    const record = EnvironmentRecord.parse({ ...input.record, version: nextVersion })
    const now = this.clock.isoNow()

    await this.db.transaction(async (tx) => {
      await insertRow(tx, 'environment_versions', {
        id: newId('ever', this.clock.now()),
        environment_id: input.environmentId,
        version: nextVersion,
        data: JSON.stringify(record),
        data_hash: hashObject(record),
        locked: record.locked ? 1 : 0,
        note: input.note ?? '',
        created_by: input.createdBy,
        created_at: now,
      })
      await updateRow(tx, 'environments', input.environmentId, { current_version: nextVersion, name: record.name, updated_at: now })
    })

    return {
      id: input.environmentId,
      projectId: toStr(row.project_id),
      environmentKey: record.environment_key,
      name: record.name,
      version: nextVersion,
      record,
      locked: record.locked,
      createdAt: now,
    }
  }

  async listEnvironments(projectId: string): Promise<VersionedEnvironment[]> {
    const rows = await this.db.query(
      `SELECT e.*, v.data, v.locked AS version_locked, v.created_at AS version_created_at
         FROM environments e
         JOIN environment_versions v ON v.environment_id = e.id AND v.version = e.current_version
        WHERE e.project_id = ? ORDER BY e.environment_key ASC`,
      [projectId],
    )
    return rows.map(mapEnvironment)
  }

  async getEnvironment(projectId: string, environmentKey: string, version = 0): Promise<VersionedEnvironment> {
    const row =
      version > 0
        ? await this.db.get(
            `SELECT e.*, v.data, v.locked AS version_locked, v.created_at AS version_created_at
               FROM environments e JOIN environment_versions v ON v.environment_id = e.id
              WHERE e.project_id = ? AND e.environment_key = ? AND v.version = ?`,
            [projectId, environmentKey, version],
          )
        : await this.db.get(
            `SELECT e.*, v.data, v.locked AS version_locked, v.created_at AS version_created_at
               FROM environments e JOIN environment_versions v ON v.environment_id = e.id AND v.version = e.current_version
              WHERE e.project_id = ? AND e.environment_key = ?`,
            [projectId, environmentKey],
          )
    if (!row) throw notFound(`environment ${environmentKey}${version > 0 ? ` v${version}` : ''}`)
    return mapEnvironment(row)
  }

  /** Resolves every bible entry a shot's locks reference, at the pinned versions. */
  async resolveForShot(
    projectId: string,
    locks: { identity: Array<{ character_key: string; character_version: number }>; environment: { environment_key: string; environment_version: number } | null },
  ): Promise<{ characters: Map<string, CharacterRecord>; environments: Map<string, EnvironmentRecord>; versions: Record<string, number> }> {
    const characters = new Map<string, CharacterRecord>()
    const environments = new Map<string, EnvironmentRecord>()
    const versions: Record<string, number> = {}

    for (const lock of locks.identity) {
      const resolved = await this.getCharacter(projectId, lock.character_key, lock.character_version)
      characters.set(lock.character_key, resolved.record)
      versions[`character:${lock.character_key}`] = resolved.version
    }
    if (locks.environment) {
      const resolved = await this.getEnvironment(projectId, locks.environment.environment_key, locks.environment.environment_version)
      environments.set(locks.environment.environment_key, resolved.record)
      versions[`environment:${locks.environment.environment_key}`] = resolved.version
    }
    return { characters, environments, versions }
  }
}

function mapCharacter(row: Record<string, unknown>): VersionedCharacter {
  const record = CharacterRecord.parse(parseJsonColumn(row.data, {}))
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    characterKey: record.character_key,
    name: record.name,
    version: record.version,
    rightsStatus: record.rights_status,
    record,
    locked: toBool(row.version_locked),
    createdAt: toStr(row.version_created_at),
  }
}

function mapEnvironment(row: Record<string, unknown>): VersionedEnvironment {
  const record = EnvironmentRecord.parse(parseJsonColumn(row.data, {}))
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    environmentKey: record.environment_key,
    name: record.name,
    version: record.version,
    record,
    locked: toBool(row.version_locked),
    createdAt: toStr(row.version_created_at),
  }
}
