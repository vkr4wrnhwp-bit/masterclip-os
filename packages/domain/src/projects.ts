import { type Db, insertRow, parseJsonColumn, toBool, toNum, toStr, toStrOrNull, updateRow } from '@masterclip/database'
import { conflict, hashObject, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { CanonicalShot, StyleBible, defaultStyleBible, type CanonicalShot as Shot } from '@masterclip/shot-schema'
import type { Project, Scene, ShotVersion, Shot as ShotRow } from './types.js'

export class ProjectRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async createOrg(name: string): Promise<{ id: string; name: string; createdAt: string }> {
    const id = newId('org', this.clock.now())
    const createdAt = this.clock.isoNow()
    await insertRow(this.db, 'orgs', { id, name, created_at: createdAt })
    return { id, name, createdAt }
  }

  async create(input: { orgId: string; name: string; brief?: string; styleBible?: StyleBible; createdBy: string }): Promise<Project> {
    const slug = slugify(input.name)
    const existing = await this.db.get('SELECT id FROM projects WHERE org_id = ? AND slug = ?', [input.orgId, slug])
    if (existing) throw conflict(`a project named "${input.name}" already exists in this organization`)

    const now = this.clock.isoNow()
    const project: Project = {
      id: newId('proj', this.clock.now()),
      orgId: input.orgId,
      name: input.name,
      slug,
      brief: input.brief ?? '',
      styleBible: input.styleBible ?? defaultStyleBible(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'projects', {
      id: project.id,
      org_id: project.orgId,
      name: project.name,
      slug: project.slug,
      brief: project.brief,
      style_bible: JSON.stringify(project.styleBible),
      status: project.status,
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    return project
  }

  async get(id: string): Promise<Project> {
    const row = await this.db.get('SELECT * FROM projects WHERE id = ?', [id])
    if (!row) throw notFound('project', id)
    return mapProject(row)
  }

  async list(orgId: string): Promise<Project[]> {
    const rows = await this.db.query('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC', [orgId])
    return rows.map(mapProject)
  }

  async update(id: string, patch: { name?: string; brief?: string; styleBible?: StyleBible; status?: 'active' | 'archived' }): Promise<Project> {
    const values: Record<string, string | null> = { updated_at: this.clock.isoNow() }
    if (patch.name !== undefined) values.name = patch.name
    if (patch.brief !== undefined) values.brief = patch.brief
    if (patch.styleBible !== undefined) values.style_bible = JSON.stringify(StyleBible.parse(patch.styleBible))
    if (patch.status !== undefined) {
      values.status = patch.status
      values.archived_at = patch.status === 'archived' ? this.clock.isoNow() : null
    }
    await updateRow(this.db, 'projects', id, values)
    return this.get(id)
  }

  async createScene(input: { projectId: string; name: string; synopsis?: string; ordinal?: number }): Promise<Scene> {
    const ordinal = input.ordinal ?? (await this.nextOrdinal('scenes', 'project_id', input.projectId))
    const scene: Scene = {
      id: newId('scene', this.clock.now()),
      projectId: input.projectId,
      name: input.name,
      ordinal,
      synopsis: input.synopsis ?? '',
      createdAt: this.clock.isoNow(),
    }
    await insertRow(this.db, 'scenes', {
      id: scene.id,
      project_id: scene.projectId,
      name: scene.name,
      ordinal: scene.ordinal,
      synopsis: scene.synopsis,
      created_at: scene.createdAt,
    })
    return scene
  }

  async listScenes(projectId: string): Promise<Scene[]> {
    const rows = await this.db.query('SELECT * FROM scenes WHERE project_id = ? ORDER BY ordinal ASC', [projectId])
    return rows.map((row) => ({
      id: toStr(row.id),
      projectId: toStr(row.project_id),
      name: toStr(row.name),
      ordinal: toNum(row.ordinal),
      synopsis: toStr(row.synopsis),
      createdAt: toStr(row.created_at),
    }))
  }

  /**
   * Creates a shot and its first immutable version.
   *
   * Renders reference `shot_versions`, never `shots`, so editing a shot after a
   * render cannot rewrite what that render was asked to produce.
   */
  async createShot(input: {
    projectId: string
    sceneId?: string | null
    spec: Shot
    createdBy: string
    note?: string
  }): Promise<{ shot: ShotRow; version: ShotVersion }> {
    const spec = CanonicalShot.parse({ ...input.spec, project_id: input.projectId, version: 1 })
    const shotKey = spec.shot_id || `SH${Date.now().toString(36).toUpperCase()}`
    const existing = await this.db.get('SELECT id FROM shots WHERE project_id = ? AND shot_key = ?', [input.projectId, shotKey])
    if (existing) throw conflict(`shot "${shotKey}" already exists in this project`)

    const now = this.clock.isoNow()
    const shotId = newId('shot', this.clock.now())
    const ordinal = await this.nextOrdinal('shots', 'project_id', input.projectId)
    const normalized = { ...spec, shot_id: shotKey, scene_id: input.sceneId ?? spec.scene_id }

    await insertRow(this.db, 'shots', {
      id: shotId,
      project_id: input.projectId,
      scene_id: input.sceneId ?? null,
      shot_key: shotKey,
      title: spec.title || shotKey,
      current_version: 1,
      ordinal,
      created_at: now,
      updated_at: now,
    })

    const version = await this.addVersion({
      shotId,
      spec: normalized,
      createdBy: input.createdBy,
      note: input.note ?? 'initial version',
      versionNumber: 1,
    })

    return {
      shot: {
        id: shotId,
        projectId: input.projectId,
        sceneId: input.sceneId ?? null,
        shotKey,
        title: normalized.title || shotKey,
        currentVersion: 1,
        ordinal,
        createdAt: now,
        updatedAt: now,
      },
      version,
    }
  }

  async addVersion(input: {
    shotId: string
    spec: Shot
    createdBy: string
    note?: string
    versionNumber?: number
  }): Promise<ShotVersion> {
    const current = await this.db.get<{ current_version: number }>('SELECT current_version FROM shots WHERE id = ?', [input.shotId])
    if (!current && input.versionNumber === undefined) throw notFound('shot', input.shotId)
    const version = input.versionNumber ?? toNum(current?.current_version, 0) + 1
    const spec = CanonicalShot.parse({ ...input.spec, version })
    const record: ShotVersion = {
      id: newId('sver', this.clock.now()),
      shotId: input.shotId,
      version,
      spec,
      specHash: hashObject(spec),
      note: input.note ?? '',
      locked: false,
      createdBy: input.createdBy,
      createdAt: this.clock.isoNow(),
    }
    await insertRow(this.db, 'shot_versions', {
      id: record.id,
      shot_id: record.shotId,
      version: record.version,
      spec: JSON.stringify(record.spec),
      spec_hash: record.specHash,
      note: record.note,
      locked: 0,
      created_by: record.createdBy,
      created_at: record.createdAt,
    })
    // Only touch the title when the new spec actually names one. Passing
    // `undefined` here does not mean "leave it alone" — it reaches the update as
    // NULL and violates the NOT NULL column, so a shot whose spec carries an
    // empty title (which `emptyShot()` produces) failed to save at all.
    await updateRow(this.db, 'shots', input.shotId, {
      current_version: version,
      ...(spec.title ? { title: spec.title } : {}),
      updated_at: this.clock.isoNow(),
    })
    return record
  }

  async getShot(shotId: string): Promise<ShotRow> {
    const row = await this.db.get('SELECT * FROM shots WHERE id = ?', [shotId])
    if (!row) throw notFound('shot', shotId)
    return mapShot(row)
  }

  async listShots(projectId: string): Promise<ShotRow[]> {
    const rows = await this.db.query('SELECT * FROM shots WHERE project_id = ? ORDER BY ordinal ASC', [projectId])
    return rows.map(mapShot)
  }

  async getVersion(versionId: string): Promise<ShotVersion> {
    const row = await this.db.get('SELECT * FROM shot_versions WHERE id = ?', [versionId])
    if (!row) throw notFound('shot version', versionId)
    return mapVersion(row)
  }

  async currentVersion(shotId: string): Promise<ShotVersion> {
    const row = await this.db.get('SELECT * FROM shot_versions WHERE shot_id = ? ORDER BY version DESC LIMIT 1', [shotId])
    if (!row) throw notFound('shot version for shot', shotId)
    return mapVersion(row)
  }

  async listVersions(shotId: string): Promise<ShotVersion[]> {
    const rows = await this.db.query('SELECT * FROM shot_versions WHERE shot_id = ? ORDER BY version DESC', [shotId])
    return rows.map(mapVersion)
  }

  async lockVersion(versionId: string): Promise<void> {
    await updateRow(this.db, 'shot_versions', versionId, { locked: 1 })
  }

  private async nextOrdinal(table: 'shots' | 'scenes', column: string, value: string): Promise<number> {
    const row = await this.db.get<{ n: number | null }>(`SELECT MAX(ordinal) AS n FROM ${table} WHERE ${column} = ?`, [value])
    return toNum(row?.n, 0) + 1
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  )
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    name: toStr(row.name),
    slug: toStr(row.slug),
    brief: toStr(row.brief),
    styleBible: StyleBible.parse(parseJsonColumn(row.style_bible, {})),
    status: toStr(row.status) === 'archived' ? 'archived' : 'active',
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapShot(row: Record<string, unknown>): ShotRow {
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    sceneId: toStrOrNull(row.scene_id),
    shotKey: toStr(row.shot_key),
    title: toStr(row.title),
    currentVersion: toNum(row.current_version),
    ordinal: toNum(row.ordinal),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapVersion(row: Record<string, unknown>): ShotVersion {
  return {
    id: toStr(row.id),
    shotId: toStr(row.shot_id),
    version: toNum(row.version),
    spec: CanonicalShot.parse(parseJsonColumn(row.spec, {})),
    specHash: toStr(row.spec_hash),
    note: toStr(row.note),
    locked: toBool(row.locked),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}
