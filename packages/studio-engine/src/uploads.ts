import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError, sha256Hex, type Logger } from '@masterclip/shared'
import { sanitizeFilename } from '@masterclip/asset-storage'
import type { StudioVersionType, UploadPartRecord, UploadSessionRecord } from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'
import type { StudioProjectService } from './projects.js'

/**
 * Resumable uploads.
 *
 * A 100 MB mix used to arrive as one multipart request: buffered in the API
 * process, hashed in memory, and lost entirely if the connection dropped at
 * 95%. That is not a correctness bug, it is a shape problem, and chunking is
 * the fix.
 *
 * Three properties this service exists to hold:
 *
 *   - **Resume is a question the server can answer.** Parts are stored as
 *     individual objects and recorded, so a client that lost its connection
 *     asks which parts exist and sends only the rest.
 *   - **No request holds the whole file.** Parts are assembled by streaming to
 *     a temporary file, which is handed to storage by path. Gathering them in
 *     memory would put the buffering back exactly where chunking removed it.
 *   - **The bytes are verified before anything is built from them.** The
 *     assembled size, and the client's declared checksum where it gave one,
 *     are checked before an asset or a version exists.
 */

/**
 * 8 MiB by default, from `STUDIO_UPLOAD_PART_SIZE`.
 *
 * Large enough that a 100 MB upload is thirteen requests rather than hundreds,
 * small enough that losing one to a flaky connection costs seconds. S3's
 * multipart minimum is 5 MiB, so the default stays valid if a future adapter
 * maps parts onto real multipart uploads.
 *
 * The floor is what stops one upload becoming a million requests. It is a
 * deployment setting rather than a client one for exactly that reason.
 */
export const UPLOAD_PART_SIZE = 8 * 1024 * 1024
export const MIN_UPLOAD_PART_SIZE = 64 * 1024

/** Sessions are swept after this. An abandoned upload must not hold storage forever. */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

export interface UploadPlan {
  session: UploadSessionRecord
  partSize: number
  partCount: number
  /**
   * Where each part goes. A `url` means the client PUTs it straight to object
   * storage; null means it comes through the API endpoint instead.
   */
  parts: Array<{ index: number; url: string | null; bytes: number }>
  received: number[]
}

export class StudioUploadService {
  constructor(
    private readonly deps: StudioDeps,
    /**
     * Completion queues the same analysis a single-request upload does, through
     * the same service. A second implementation of "attach audio and measure
     * it" is a second place for the two paths to diverge.
     */
    private readonly projects: StudioProjectService,
  ) {}

  private get logger(): Logger {
    return this.deps.logger.child({ component: 'studio-upload' })
  }

  /**
   * The configured chunk size, floored.
   *
   * A session stores the size it was opened with, so lowering the setting never
   * invalidates an upload that is already in flight.
   */
  private partSize(): number {
    return Math.max(MIN_UPLOAD_PART_SIZE, Math.floor(this.deps.config.STUDIO_UPLOAD_PART_SIZE ?? UPLOAD_PART_SIZE))
  }

  /**
   * Opens a session.
   *
   * The rights confirmation is taken from the project, which already holds the
   * consent record written when it was created — the same rule as the
   * single-request upload path, applied before a byte is accepted rather than
   * after the file has landed.
   */
  async begin(input: {
    actor: Actor
    projectId: string
    fileName: string
    contentType: string
    totalBytes: number
    declaredSha256?: string | null
    versionType: string
    label?: string | null
  }): Promise<UploadPlan> {
    if (input.totalBytes <= 0) {
      throw new AppError({ kind: 'validation', code: 'studio.upload_empty', message: 'an upload needs a size greater than zero' })
    }
    if (input.totalBytes > MAX_UPLOAD_BYTES) {
      throw new AppError({ kind: 'validation', code: 'studio.upload_too_large', message: 'the file exceeds the 512MB limit' })
    }

    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)
    const partSize = this.partSize()
    const partCount = Math.max(1, Math.ceil(input.totalBytes / partSize))
    const fileName = sanitizeFilename(input.fileName)
    // The prefix is built here and never from client input, so a signed part
    // URL can only ever write inside this org's own upload area.
    const storagePrefix = ['organizations', input.actor.orgId, 'studio-uploads', input.projectId].join('/')

    // Probed once against a key in this session's own prefix. A driver that
    // cannot hand out a write URL says so, and the parts come through the API.
    const probe = await this.deps.storage.signedUploadUrl(`${storagePrefix}/probe`, 60).catch(() => null)

    const session = await this.deps.repos.uploads.create({
      orgId: input.actor.orgId,
      studioProjectId: project.id,
      fileName,
      contentType: input.contentType,
      totalBytes: input.totalBytes,
      partSize,
      partCount,
      declaredSha256: input.declaredSha256 ?? null,
      storagePrefix,
      transport: probe ? 'direct' : 'api',
      versionType: input.versionType,
      label: input.label ?? null,
      rightsConfirmationId: project.rightsConfirmationId,
      expiresAt: new Date(this.deps.clock.now() + UPLOAD_SESSION_TTL_MS).toISOString(),
      createdBy: input.actor.userId,
    })

    this.logger.info('studio.upload_opened', {
      session_id: session.id,
      project_id: project.id,
      parts: partCount,
      transport: session.transport,
      // Size, not name. A private track title does not belong in a log line.
      bytes: input.totalBytes,
    })
    return this.plan(session, [])
  }

  /** Where the client is up to. This is the resume call. */
  async status(actor: Actor, sessionId: string): Promise<UploadPlan> {
    const session = await this.deps.repos.uploads.get(actor.orgId, sessionId)
    return this.plan(session, await this.deps.repos.uploads.parts(actor.orgId, sessionId))
  }

  private async plan(session: UploadSessionRecord, parts: UploadPartRecord[]): Promise<UploadPlan> {
    const received = parts.map((part) => part.partIndex).sort((a, b) => a - b)
    const planned: UploadPlan['parts'] = []
    for (let index = 0; index < session.partCount; index++) {
      const offset = index * session.partSize
      const bytes = Math.min(session.partSize, session.totalBytes - offset)
      planned.push({
        index,
        bytes,
        url: received.includes(index) ? null : await this.partUrl(session, index),
      })
    }
    return { session, partSize: session.partSize, partCount: session.partCount, parts: planned, received }
  }

  private partKey(session: UploadSessionRecord, index: number): string {
    return `${session.storagePrefix}/${session.id}/part-${String(index).padStart(5, '0')}`
  }

  private async partUrl(session: UploadSessionRecord, index: number): Promise<string | null> {
    if (session.transport !== 'direct') return null
    return this.deps.storage.signedUploadUrl(this.partKey(session, index), 3600).catch(() => null)
  }

  /**
   * Accepts one part through the API.
   *
   * Used when the driver has no direct-upload path — local disk — and as the
   * fallback for a client whose signed URL expired mid-upload.
   */
  async receivePart(input: { actor: Actor; sessionId: string; index: number; bytes: Uint8Array }): Promise<UploadPlan> {
    const session = await this.requireOpen(input.actor.orgId, input.sessionId)
    if (input.index < 0 || input.index >= session.partCount) {
      throw new AppError({ kind: 'validation', code: 'studio.upload_bad_part', message: `part ${input.index} is not part of this upload` })
    }
    const expected = Math.min(session.partSize, session.totalBytes - input.index * session.partSize)
    if (input.bytes.length !== expected) {
      // A short part is how a truncated upload becomes a corrupt file that
      // analyses cleanly. Refused here rather than discovered later.
      throw new AppError({
        kind: 'validation',
        code: 'studio.upload_part_size',
        message: `part ${input.index} should be ${expected} bytes but ${input.bytes.length} arrived`,
      })
    }

    const key = this.partKey(session, input.index)
    const checksum = sha256Hex(Buffer.from(input.bytes))
    await this.deps.storage.putBuffer(key, input.bytes, { contentType: 'application/octet-stream', sha256: checksum })
    await this.deps.repos.uploads.recordPart({
      orgId: input.actor.orgId,
      sessionId: session.id,
      partIndex: input.index,
      storageKey: key,
      bytes: input.bytes.length,
      sha256: checksum,
    })
    return this.status(input.actor, session.id)
  }

  /**
   * Assembles the parts, verifies them, and creates the version.
   *
   * On a `direct` session the parts were never seen by this process, so their
   * presence is confirmed against storage and recorded before assembly. That
   * is also the check that a client claiming completion actually uploaded
   * anything.
   */
  async complete(input: { actor: Actor; sessionId: string }): Promise<{ session: UploadSessionRecord; versionId: string; analysisId: string | null }> {
    const session = await this.requireOpen(input.actor.orgId, input.sessionId)

    if (session.transport === 'direct') await this.adoptDirectParts(input.actor.orgId, session)
    const parts = await this.deps.repos.uploads.parts(input.actor.orgId, session.id)
    const missing = []
    for (let index = 0; index < session.partCount; index++) {
      if (!parts.some((part) => part.partIndex === index)) missing.push(index)
    }
    if (missing.length > 0) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.upload_incomplete',
        message: `${missing.length} part${missing.length === 1 ? '' : 's'} of this upload have not arrived`,
        details: { missing: missing.slice(0, 20) },
      })
    }

    const workDir = await mkdtemp(join(tmpdir(), 'studio-upload-'))
    const assembled = join(workDir, sanitizeFilename(session.fileName))
    try {
      await this.assemble(parts, assembled)

      const total = parts.reduce((sum, part) => sum + part.bytes, 0)
      if (total !== session.totalBytes) {
        throw new AppError({
          kind: 'validation',
          code: 'studio.upload_size_mismatch',
          message: `the assembled file is ${total} bytes but ${session.totalBytes} were declared`,
        })
      }

      const asset = await this.deps.platform.audioAssets.storeUploadFromFile({
        actor: input.actor,
        filePath: assembled,
        filename: session.fileName,
        area: 'studio',
        projectType: 'song_lab',
        projectId: session.studioProjectId,
        assetType: 'studio_version',
        retentionKind: 'source',
        rightsStatus: 'authorized_upload',
        consentRecordId: session.rightsConfirmationId,
      })

      if (session.declaredSha256 && session.declaredSha256.toLowerCase() !== asset.checksum.toLowerCase()) {
        // Checked against the asset's own checksum, which was computed from
        // the bytes on disk rather than from anything the client said.
        throw new AppError({
          kind: 'validation',
          code: 'studio.upload_checksum_mismatch',
          message: 'the uploaded file does not match the checksum that was declared for it',
        })
      }

      const attached = await this.deps.repos.versions.create({
        orgId: input.actor.orgId,
        studioProjectId: session.studioProjectId,
        versionType: session.versionType as StudioVersionType,
        label: session.label ?? session.fileName,
        assetId: asset.id,
        assetChecksum: asset.checksum,
        sourceKind: 'upload',
        createdBy: input.actor.userId,
      })
      await this.deps.repos.projects.setCurrentVersion(input.actor.orgId, session.studioProjectId, attached.id)

      const analysisId = await this.projects
        .queueAnalysis(input.actor, session.studioProjectId, attached.id, asset.id, asset.checksum)
        .catch((err: unknown) => {
          // A version that exists without an analysis is recoverable — the user
          // can re-run it. Losing the version because the queue hiccuped is not.
          this.logger.warn('studio.upload_analysis_not_queued', { session_id: session.id, reason: err instanceof Error ? err.message : String(err) })
          return null
        })

      await this.deps.repos.activity.record({
        orgId: input.actor.orgId,
        studioProjectId: session.studioProjectId,
        actorUserId: input.actor.userId,
        actorLabel: actorLabel(input.actor),
        action: 'version.added',
        subjectType: 'version',
        subjectId: attached.id,
        detail: `${attached.label} (resumable upload, ${session.partCount} part${session.partCount === 1 ? '' : 's'})`,
      })

      const settled = await this.deps.repos.uploads.settle(input.actor.orgId, session.id, {
        status: 'completed',
        studioVersionId: attached.id,
        audioAssetId: asset.id,
      })
      await this.discardParts(input.actor.orgId, session.id, parts)
      this.logger.info('studio.upload_completed', { session_id: session.id, version_id: attached.id, transport: session.transport })
      return { session: settled, versionId: attached.id, analysisId }
    } catch (err) {
      await this.deps.repos.uploads.settle(input.actor.orgId, session.id, {
        status: 'open',
        failureReason: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  /** Abandons a session and reclaims what it held. */
  async abort(actor: Actor, sessionId: string): Promise<UploadSessionRecord> {
    const session = await this.deps.repos.uploads.get(actor.orgId, sessionId)
    await this.discardParts(actor.orgId, sessionId, await this.deps.repos.uploads.parts(actor.orgId, sessionId))
    return this.deps.repos.uploads.settle(actor.orgId, session.id, { status: 'aborted' })
  }

  /**
   * Reclaims abandoned sessions.
   *
   * An upload nobody finished holds storage indefinitely otherwise, and the
   * parts are useless on their own — they are fragments of a file that was
   * never assembled.
   */
  async sweep(limit = 100): Promise<number> {
    const stale = await this.deps.repos.uploads.expired(this.deps.clock.isoNow(), limit)
    for (const session of stale) {
      await this.discardParts(session.orgId, session.id, await this.deps.repos.uploads.parts(session.orgId, session.id))
      await this.deps.repos.uploads.settle(session.orgId, session.id, { status: 'expired', failureReason: 'the upload was not completed before it expired' })
    }
    if (stale.length > 0) this.logger.info('studio.uploads_expired', { sessions: stale.length })
    return stale.length
  }

  // --- internals ----------------------------------------------------------

  private async requireOpen(orgId: string, sessionId: string): Promise<UploadSessionRecord> {
    const session = await this.deps.repos.uploads.get(orgId, sessionId)
    if (session.status !== 'open') {
      throw new AppError({
        kind: 'validation',
        code: 'studio.upload_not_open',
        message: `this upload is ${session.status} and cannot accept more parts`,
      })
    }
    if (Date.parse(session.expiresAt) < this.deps.clock.now()) {
      throw new AppError({ kind: 'validation', code: 'studio.upload_expired', message: 'this upload expired — start a new one' })
    }
    return session
  }

  /**
   * Records parts that went straight to storage.
   *
   * Their checksums are computed here rather than taken from the client: a
   * checksum the uploader supplies for bytes the server never saw verifies
   * nothing.
   */
  private async adoptDirectParts(orgId: string, session: UploadSessionRecord): Promise<void> {
    const known = new Set((await this.deps.repos.uploads.parts(orgId, session.id)).map((part) => part.partIndex))
    for (let index = 0; index < session.partCount; index++) {
      if (known.has(index)) continue
      const key = this.partKey(session, index)
      if (!(await this.deps.storage.exists(key))) continue
      const bytes = await this.deps.storage.getBuffer(key)
      await this.deps.repos.uploads.recordPart({
        orgId,
        sessionId: session.id,
        partIndex: index,
        storageKey: key,
        bytes: bytes.length,
        sha256: sha256Hex(Buffer.from(bytes)),
      })
    }
  }

  /** Streams the parts into one file, in order, without holding them together. */
  private async assemble(parts: UploadPartRecord[], destPath: string): Promise<void> {
    const ordered = [...parts].sort((a, b) => a.partIndex - b.partIndex)
    const out = createWriteStream(destPath)
    try {
      for (const part of ordered) {
        const bytes = await this.deps.storage.getBuffer(part.storageKey)
        await new Promise<void>((resolve, reject) => {
          out.write(bytes, (err) => (err ? reject(err) : resolve()))
        })
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((err: unknown) => (err ? reject(err) : resolve())))
    }
  }

  private async discardParts(orgId: string, sessionId: string, parts: UploadPartRecord[]): Promise<void> {
    for (const part of parts) {
      await this.deps.storage.delete(part.storageKey).catch((err: unknown) => {
        this.logger.warn('studio.upload_part_not_deleted', { session_id: sessionId, reason: err instanceof Error ? err.message : String(err) })
      })
    }
    await this.deps.repos.uploads.clearParts(orgId, sessionId)
  }
}
