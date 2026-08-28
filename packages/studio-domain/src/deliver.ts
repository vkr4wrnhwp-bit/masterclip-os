import { insertRow, toNum, toStr, toStrOrNull, upsertRow, type Db, type Row } from '@masterclip/database'
import { AppError, newId, notFound, systemClock, type Clock } from '@masterclip/shared'
import { parseJson, toJson } from './json.js'
import type {
  CreditEntry,
  DeliverableKind,
  DeliverableStatus,
  DeliveryCheckOutcome,
  DeliveryCheckRecord,
  ReleaseMetadataRecord,
  SplitEntry,
  StudioDeliverableRecord,
} from './types.js'

/** Delivery assets, their check runs, and the release metadata they are checked against. */
export class StudioDeliverableRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    orgId: string
    studioProjectId: string
    studioVersionId?: string | null
    assetKind: DeliverableKind
    assetId?: string | null
    fileName: string
    createdBy: string
  }): Promise<StudioDeliverableRecord> {
    const now = this.clock.isoNow()
    const record: StudioDeliverableRecord = {
      id: newId('stdl', this.clock.now()),
      orgId: input.orgId,
      studioProjectId: input.studioProjectId,
      studioVersionId: input.studioVersionId ?? null,
      assetKind: input.assetKind,
      assetId: input.assetId ?? null,
      fileName: input.fileName,
      status: 'draft',
      sentReleaseId: null,
      sentAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await insertRow(this.db, 'studio_deliverables', {
      id: record.id,
      org_id: record.orgId,
      studio_project_id: record.studioProjectId,
      studio_version_id: record.studioVersionId,
      asset_kind: record.assetKind,
      asset_id: record.assetId,
      file_name: record.fileName,
      status: record.status,
      sent_release_id: null,
      sent_at: null,
      created_by: record.createdBy,
      created_at: now,
      updated_at: now,
    })
    return record
  }

  async get(orgId: string, id: string): Promise<StudioDeliverableRecord> {
    const row = await this.db.get('SELECT * FROM studio_deliverables WHERE id = ? AND org_id = ?', [id, orgId])
    if (!row) throw notFound('deliverable', id)
    return mapDeliverable(row)
  }

  async list(orgId: string, projectId: string): Promise<StudioDeliverableRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_deliverables WHERE org_id = ? AND studio_project_id = ? ORDER BY created_at ASC', [orgId, projectId])
    return rows.map(mapDeliverable)
  }

  async setStatus(orgId: string, id: string, status: DeliverableStatus): Promise<void> {
    await this.db.run('UPDATE studio_deliverables SET status = ?, updated_at = ? WHERE id = ? AND org_id = ?', [status, this.clock.isoNow(), id, orgId])
  }

  async markSent(orgId: string, id: string, releaseId: string): Promise<void> {
    const now = this.clock.isoNow()
    await this.db.run("UPDATE studio_deliverables SET status = 'sent', sent_release_id = ?, sent_at = ?, updated_at = ? WHERE id = ? AND org_id = ?", [
      releaseId,
      now,
      now,
      id,
      orgId,
    ])
  }

  async delete(orgId: string, id: string): Promise<void> {
    const deliverable = await this.get(orgId, id)
    if (deliverable.status === 'sent') {
      // What was delivered to a DSP is part of the record's history, and the
      // delivery log is one of the things the passport points at.
      throw new AppError({
        kind: 'validation',
        code: 'studio.deliverable_sent',
        message: 'a deliverable that has already been sent to release cannot be removed',
      })
    }
    await this.db.run('DELETE FROM studio_delivery_checks WHERE org_id = ? AND deliverable_id = ?', [orgId, id])
    await this.db.run('DELETE FROM studio_deliverables WHERE id = ? AND org_id = ?', [id, orgId])
  }

  // --- checks --------------------------------------------------------------

  async replaceChecks(
    orgId: string,
    deliverableId: string,
    checks: Array<{ checkKey: string; outcome: DeliveryCheckOutcome; detail: string; measured?: string | null; expected?: string | null }>,
  ): Promise<DeliveryCheckRecord[]> {
    await this.db.run('DELETE FROM studio_delivery_checks WHERE org_id = ? AND deliverable_id = ?', [orgId, deliverableId])
    const now = this.clock.isoNow()
    const written: DeliveryCheckRecord[] = []
    for (const check of checks) {
      const record: DeliveryCheckRecord = {
        id: newId('stdc', this.clock.now()),
        orgId,
        deliverableId,
        checkKey: check.checkKey,
        outcome: check.outcome,
        detail: check.detail,
        measured: check.measured ?? null,
        expected: check.expected ?? null,
        createdAt: now,
      }
      await insertRow(this.db, 'studio_delivery_checks', {
        id: record.id,
        org_id: orgId,
        deliverable_id: deliverableId,
        check_key: record.checkKey,
        outcome: record.outcome,
        detail: record.detail,
        measured: record.measured,
        expected: record.expected,
        created_at: now,
      })
      written.push(record)
    }
    return written
  }

  async checks(orgId: string, deliverableId: string): Promise<DeliveryCheckRecord[]> {
    const rows = await this.db.query('SELECT * FROM studio_delivery_checks WHERE org_id = ? AND deliverable_id = ? ORDER BY created_at ASC', [orgId, deliverableId])
    return rows.map((row) => ({
      id: toStr(row.id),
      orgId: toStr(row.org_id),
      deliverableId: toStr(row.deliverable_id),
      checkKey: toStr(row.check_key),
      outcome: toStr(row.outcome) as DeliveryCheckOutcome,
      detail: toStr(row.detail),
      measured: toStrOrNull(row.measured),
      expected: toStrOrNull(row.expected),
      createdAt: toStr(row.created_at),
    }))
  }
}

export class ReleaseMetadataRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(orgId: string, projectId: string): Promise<ReleaseMetadataRecord | null> {
    const row = await this.db.get('SELECT * FROM studio_release_metadata WHERE studio_project_id = ? AND org_id = ?', [projectId, orgId])
    return row ? mapMetadata(row) : null
  }

  async upsert(
    orgId: string,
    projectId: string,
    patch: Partial<Omit<ReleaseMetadataRecord, 'studioProjectId' | 'orgId' | 'updatedBy' | 'updatedAt'>>,
    updatedBy: string,
  ): Promise<ReleaseMetadataRecord> {
    const existing = await this.get(orgId, projectId)
    const now = this.clock.isoNow()
    const merged: ReleaseMetadataRecord = {
      studioProjectId: projectId,
      orgId,
      isrc: patch.isrc ?? existing?.isrc ?? null,
      upc: patch.upc ?? existing?.upc ?? null,
      primaryArtist: patch.primaryArtist ?? existing?.primaryArtist ?? '',
      featuredArtists: patch.featuredArtists ?? existing?.featuredArtists ?? '',
      labelName: patch.labelName ?? existing?.labelName ?? '',
      // Undeclared is the honest default and the delivery check flags it.
      // Defaulting to "not explicit" would be a claim nobody made.
      explicit: patch.explicit ?? existing?.explicit ?? 'undeclared',
      language: patch.language ?? existing?.language ?? '',
      genre: patch.genre ?? existing?.genre ?? '',
      secondaryGenre: patch.secondaryGenre ?? existing?.secondaryGenre ?? '',
      copyrightLine: patch.copyrightLine ?? existing?.copyrightLine ?? '',
      publishingLine: patch.publishingLine ?? existing?.publishingLine ?? '',
      artworkAssetId: patch.artworkAssetId ?? existing?.artworkAssetId ?? null,
      credits: patch.credits ?? existing?.credits ?? [],
      splits: patch.splits ?? existing?.splits ?? [],
      updatedBy,
      updatedAt: now,
    }
    await upsertRow(
      this.db,
      'studio_release_metadata',
      {
        studio_project_id: projectId,
        org_id: orgId,
        isrc: merged.isrc,
        upc: merged.upc,
        primary_artist: merged.primaryArtist,
        featured_artists: merged.featuredArtists,
        label_name: merged.labelName,
        explicit: merged.explicit,
        language: merged.language,
        genre: merged.genre,
        secondary_genre: merged.secondaryGenre,
        copyright_line: merged.copyrightLine,
        publishing_line: merged.publishingLine,
        artwork_asset_id: merged.artworkAssetId,
        credits: toJson(merged.credits),
        splits: toJson(merged.splits),
        updated_by: updatedBy,
        updated_at: now,
      },
      ['studio_project_id'],
    )
    return merged
  }
}

function mapDeliverable(row: Row): StudioDeliverableRecord {
  return {
    id: toStr(row.id),
    orgId: toStr(row.org_id),
    studioProjectId: toStr(row.studio_project_id),
    studioVersionId: toStrOrNull(row.studio_version_id),
    assetKind: toStr(row.asset_kind) as DeliverableKind,
    assetId: toStrOrNull(row.asset_id),
    fileName: toStr(row.file_name),
    status: toStr(row.status) as DeliverableStatus,
    sentReleaseId: toStrOrNull(row.sent_release_id),
    sentAt: toStrOrNull(row.sent_at),
    createdBy: toStr(row.created_by),
    createdAt: toStr(row.created_at),
    updatedAt: toStr(row.updated_at),
  }
}

function mapMetadata(row: Row): ReleaseMetadataRecord {
  return {
    studioProjectId: toStr(row.studio_project_id),
    orgId: toStr(row.org_id),
    isrc: toStrOrNull(row.isrc),
    upc: toStrOrNull(row.upc),
    primaryArtist: toStr(row.primary_artist),
    featuredArtists: toStr(row.featured_artists),
    labelName: toStr(row.label_name),
    explicit: toStr(row.explicit) as ReleaseMetadataRecord['explicit'],
    language: toStr(row.language),
    genre: toStr(row.genre),
    secondaryGenre: toStr(row.secondary_genre),
    copyrightLine: toStr(row.copyright_line),
    publishingLine: toStr(row.publishing_line),
    artworkAssetId: toStrOrNull(row.artwork_asset_id),
    credits: parseJson<CreditEntry[]>(row.credits, []),
    splits: parseJson<SplitEntry[]>(row.splits, []),
    updatedBy: toStr(row.updated_by),
    updatedAt: toStr(row.updated_at),
  }
}

