import { basename } from 'node:path'
import { type Db, insertRow, parseJsonColumn, toBool, toNum, toNumOrNull, toStr, toStrOrNull } from '@masterclip/database'
import { forbidden, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import type { Asset, AssetKind, AssetRights, LineageRelation } from './types.js'

export const DEFAULT_RIGHTS: AssetRights = {
  owner: '',
  source: '',
  license: '',
  consent: 'unverified',
  allowedUse: '',
  expiresAt: null,
  notes: '',
  authorized: false,
}

export interface CreateAssetInput {
  projectId: string
  kind: AssetKind
  storageKey: string
  filename: string
  mime: string
  bytes: number
  sha256: string
  width?: number | null
  height?: number | null
  durationSeconds?: number | null
  fps?: number | null
  hasAudio?: boolean | null
  metadata?: Record<string, unknown>
  rights?: Partial<AssetRights>
  createdBy: string
  /** Parent assets, recorded as lineage so provenance survives every transform. */
  parents?: Array<{ assetId: string; relation: LineageRelation }>
}

/**
 * Asset records, rights, and lineage.
 *
 * Two invariants live here:
 *  - every derived file (frame, proxy, master, delivery) records its parents,
 *    so a delivery can be traced back to the render and the render to the shot
 *    version and the references it used;
 *  - identity-preserving generation must call {@link requireAuthorizedForIdentity},
 *    which refuses anything not explicitly marked authorized. Consent is never
 *    inferred from an upload.
 */
export class AssetRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: CreateAssetInput): Promise<Asset> {
    const rights: AssetRights = { ...DEFAULT_RIGHTS, ...(input.rights ?? {}) }
    const asset: Asset = {
      id: newId('ast', this.clock.now()),
      projectId: input.projectId,
      kind: input.kind,
      storageKey: input.storageKey,
      filename: basename(input.filename),
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      width: input.width ?? null,
      height: input.height ?? null,
      durationSeconds: input.durationSeconds ?? null,
      fps: input.fps ?? null,
      hasAudio: input.hasAudio ?? null,
      metadata: input.metadata ?? {},
      rights,
      createdBy: input.createdBy,
      createdAt: this.clock.isoNow(),
    }

    await this.db.transaction(async (tx) => {
      await insertRow(tx, 'assets', {
        id: asset.id,
        project_id: asset.projectId,
        kind: asset.kind,
        storage_key: asset.storageKey,
        filename: asset.filename,
        mime: asset.mime,
        bytes: asset.bytes,
        sha256: asset.sha256,
        width: asset.width,
        height: asset.height,
        duration_seconds: asset.durationSeconds,
        fps: asset.fps,
        has_audio: asset.hasAudio === null ? null : asset.hasAudio ? 1 : 0,
        metadata: JSON.stringify(asset.metadata),
        rights_owner: rights.owner,
        rights_source: rights.source,
        rights_license: rights.license,
        rights_consent: rights.consent,
        rights_allowed_use: rights.allowedUse,
        rights_expires_at: rights.expiresAt,
        rights_notes: rights.notes,
        rights_authorized: rights.authorized ? 1 : 0,
        created_by: asset.createdBy,
        created_at: asset.createdAt,
      })
      for (const parent of input.parents ?? []) {
        await insertRow(tx, 'asset_lineage', {
          id: newId('ast', this.clock.now()),
          child_asset_id: asset.id,
          parent_asset_id: parent.assetId,
          relation: parent.relation,
          created_at: asset.createdAt,
        })
      }
    })

    return asset
  }

  async get(id: string): Promise<Asset> {
    const row = await this.db.get('SELECT * FROM assets WHERE id = ?', [id])
    if (!row) throw notFound('asset', id)
    return mapAsset(row)
  }

  async find(id: string): Promise<Asset | null> {
    const row = await this.db.get('SELECT * FROM assets WHERE id = ?', [id])
    return row ? mapAsset(row) : null
  }

  async list(projectId: string, kind?: AssetKind, limit = 500): Promise<Asset[]> {
    const rows = kind
      ? await this.db.query(`SELECT * FROM assets WHERE project_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`, [
          projectId,
          kind,
        ])
      : await this.db.query(`SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC LIMIT ${Math.floor(limit)}`, [projectId])
    return rows.map(mapAsset)
  }

  /** Content-addressed lookup: the same upload is never stored twice per project. */
  async findByHash(projectId: string, sha256: string): Promise<Asset | null> {
    const row = await this.db.get('SELECT * FROM assets WHERE project_id = ? AND sha256 = ? LIMIT 1', [projectId, sha256])
    return row ? mapAsset(row) : null
  }

  async setRights(id: string, rights: Partial<AssetRights>, actor: string): Promise<Asset> {
    const current = await this.get(id)
    const merged: AssetRights = { ...current.rights, ...rights }
    await this.db.run(
      `UPDATE assets SET rights_owner = ?, rights_source = ?, rights_license = ?, rights_consent = ?,
                          rights_allowed_use = ?, rights_expires_at = ?, rights_notes = ?, rights_authorized = ?
        WHERE id = ?`,
      [
        merged.owner,
        merged.source,
        merged.license,
        merged.consent,
        merged.allowedUse,
        merged.expiresAt,
        merged.notes,
        merged.authorized ? 1 : 0,
        id,
      ],
    )
    await insertRow(this.db, 'audit_log', {
      id: newId('audit', this.clock.now()),
      org_id: '',
      project_id: current.projectId,
      actor,
      action: 'asset.rights_updated',
      target_type: 'asset',
      target_id: id,
      data: JSON.stringify(merged),
      created_at: this.clock.isoNow(),
    })
    return this.get(id)
  }

  async lineage(assetId: string): Promise<{ parents: Array<{ assetId: string; relation: string }>; children: Array<{ assetId: string; relation: string }> }> {
    const [parents, children] = await Promise.all([
      this.db.query('SELECT parent_asset_id, relation FROM asset_lineage WHERE child_asset_id = ?', [assetId]),
      this.db.query('SELECT child_asset_id, relation FROM asset_lineage WHERE parent_asset_id = ?', [assetId]),
    ])
    return {
      parents: parents.map((r) => ({ assetId: toStr(r.parent_asset_id), relation: toStr(r.relation) })),
      children: children.map((r) => ({ assetId: toStr(r.child_asset_id), relation: toStr(r.relation) })),
    }
  }

  /** Walks the full provenance chain to the original uploads. */
  async provenanceChain(assetId: string, depth = 8): Promise<string[]> {
    const seen = new Set<string>([assetId])
    let frontier = [assetId]
    for (let i = 0; i < depth && frontier.length > 0; i++) {
      const rows = await this.db.query(
        `SELECT parent_asset_id FROM asset_lineage WHERE child_asset_id IN (${frontier.map(() => '?').join(', ')})`,
        frontier,
      )
      frontier = rows.map((r) => toStr(r.parent_asset_id)).filter((id) => !seen.has(id))
      for (const id of frontier) seen.add(id)
    }
    return [...seen]
  }

  /**
   * Gate for identity-preserving generation.
   *
   * Refuses unless the reference pack is explicitly marked authorized with
   * recorded consent — the failure mode this prevents is generating a real
   * person's likeness because someone dropped a photo in a folder.
   */
  async requireAuthorizedForIdentity(assetIds: string[]): Promise<Asset[]> {
    const assets: Asset[] = []
    for (const id of assetIds) {
      const asset = await this.get(id)
      if (!asset.rights.authorized || asset.rights.consent !== 'authorized') {
        throw forbidden(
          `asset ${asset.filename} is not cleared for identity work (consent: ${asset.rights.consent}, authorized: ${asset.rights.authorized}). Record ownership and consent before using it as a character reference.`,
        )
      }
      if (asset.rights.expiresAt && Date.parse(asset.rights.expiresAt) < this.clock.now()) {
        throw forbidden(`rights for asset ${asset.filename} expired on ${asset.rights.expiresAt}`)
      }
      assets.push(asset)
    }
    return assets
  }
}

function mapAsset(row: Record<string, unknown>): Asset {
  return {
    id: toStr(row.id),
    projectId: toStr(row.project_id),
    kind: toStr(row.kind) as AssetKind,
    storageKey: toStr(row.storage_key),
    filename: toStr(row.filename),
    mime: toStr(row.mime),
    bytes: toNum(row.bytes),
    sha256: toStr(row.sha256),
    width: toNumOrNull(row.width),
    height: toNumOrNull(row.height),
    durationSeconds: toNumOrNull(row.duration_seconds),
    fps: toNumOrNull(row.fps),
    hasAudio: row.has_audio === null || row.has_audio === undefined ? null : toBool(row.has_audio),
    metadata: parseJsonColumn(row.metadata, {}),
    rights: {
      owner: toStr(row.rights_owner),
      source: toStr(row.rights_source),
      license: toStr(row.rights_license),
      consent: toStr(row.rights_consent) as AssetRights['consent'],
      allowedUse: toStr(row.rights_allowed_use),
      expiresAt: toStrOrNull(row.rights_expires_at),
      notes: toStr(row.rights_notes),
      authorized: toBool(row.rights_authorized),
    },
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
  }
}
