import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError, DEV_ASSET_SIGNING_SECRET, newId, sha256File } from '@masterclip/shared'
import { LocalStorage, objectKey, sanitizeFilename, verifySignedUrl } from '@masterclip/asset-storage'
import { probe } from '@masterclip/media-tools'
import type { Runtime } from '@masterclip/runtime'
import { requireAuth, requireProject } from '../server.js'

/**
 * Accepted upload types.
 *
 * Enforced against the sniffed magic bytes, not the declared Content-Type or
 * the filename — both are attacker-controlled.
 */
const ALLOWED = new Map<string, { mime: string; kind: 'reference_image' | 'reference_video' | 'audio' }>([
  ['image/png', { mime: 'image/png', kind: 'reference_image' }],
  ['image/jpeg', { mime: 'image/jpeg', kind: 'reference_image' }],
  ['image/webp', { mime: 'image/webp', kind: 'reference_image' }],
  ['video/mp4', { mime: 'video/mp4', kind: 'reference_video' }],
  ['video/quicktime', { mime: 'video/quicktime', kind: 'reference_video' }],
  ['audio/wav', { mime: 'audio/wav', kind: 'audio' }],
  ['audio/mpeg', { mime: 'audio/mpeg', kind: 'audio' }],
])

/** Magic-byte sniffing. A .png that is really a script does not get stored as one. */
export function sniffMime(head: Uint8Array): string | null {
  const bytes = Array.from(head.slice(0, 16))
  const startsWith = (...sig: number[]) => sig.every((byte, index) => bytes[index] === byte)
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x52, 0x49, 0x46, 0x46)) {
    const format = String.fromCharCode(...bytes.slice(8, 12))
    if (format === 'WEBP') return 'image/webp'
    if (format === 'WAVE') return 'audio/wav'
  }
  if (String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...bytes.slice(8, 12))
    if (brand.startsWith('qt')) return 'video/quicktime'
    return 'video/mp4'
  }
  // ID3-tagged, or a bare MPEG frame sync (11 set bits). Matching only the
  // common `FF FB` refused perfectly valid tagless MP3s — `FF FA`, `FF F3`
  // and friends differ only in layer/bitrate bits.
  if (startsWith(0x49, 0x44, 0x33)) return 'audio/mpeg'
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'audio/mpeg'
  return null
}

export async function registerAssetRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  /**
   * Signed asset delivery.
   *
   * The only path that serves bytes. Access requires a valid HMAC and an
   * unexpired deadline; a raw storage key is never enough.
   */
  app.get('/api/assets/raw', async (request, reply) => {
    if (runtime.storage.name !== 'local') {
      throw new AppError({ kind: 'validation', code: 'assets.remote_storage', message: 'remote storage serves assets via presigned URLs' })
    }
    const query = request.query as { key?: string; exp?: string; sig?: string }
    const secret = runtime.config.ASSET_SIGNING_SECRET || DEV_ASSET_SIGNING_SECRET
    const key = verifySignedUrl(secret, query, runtime.clock.now())
    const path = (runtime.storage as LocalStorage).localPath(key)
    const asset = await runtime.db.get<{ mime: string; filename: string }>('SELECT mime, filename FROM assets WHERE storage_key = ?', [key])
    void reply.type(String(asset?.mime ?? 'application/octet-stream'))
    void reply.header('cache-control', 'private, max-age=3600')
    return reply.send(createReadStream(path))
  })

  app.get('/api/assets/:assetId/url', async (request) => {
    const { assetId } = request.params as { assetId: string }
    const asset = await runtime.assets.get(assetId)
    await requireProject(runtime, request, asset.projectId)
    return { url: await runtime.storage.signedUrl(asset.storageKey, 3600), asset }
  })

  app.get('/api/projects/:projectId/assets', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const kind = (request.query as { kind?: string }).kind
    const assets = await runtime.assets.list(projectId, kind as never)
    return {
      assets: await Promise.all(assets.map(async (asset) => ({ ...asset, url: await runtime.storage.signedUrl(asset.storageKey, 3600) }))),
    }
  })

  /**
   * Reference upload.
   *
   * Rights metadata is required at upload time, not bolted on later — an asset
   * with no recorded owner and no consent status is unusable for identity work
   * by construction, which is the point.
   */
  app.post('/api/projects/:projectId/assets', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')

    const parts = request.parts()
    let fileBuffer: Buffer | null = null
    let filename = 'upload'
    const fields: Record<string, string> = {}

    for await (const part of parts) {
      if (part.type === 'file') {
        // One asset per request. Silently keeping the last of several was worse
        // than refusing: a dropped set of character references returned 200 with
        // a single row, and the gap only showed up later as identity work that
        // had seen one image.
        if (fileBuffer) {
          throw new AppError({
            kind: 'validation',
            code: 'assets.too_many_files',
            message: 'upload one file per request — send each reference separately',
          })
        }
        filename = sanitizeFilename(part.filename ?? 'upload')
        fileBuffer = await part.toBuffer()
      } else {
        fields[part.fieldname] = String(part.value)
      }
    }
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new AppError({ kind: 'validation', code: 'assets.no_file', message: 'no file was uploaded' })
    }

    const sniffed = sniffMime(new Uint8Array(fileBuffer))
    const allowed = sniffed ? ALLOWED.get(sniffed) : undefined
    if (!allowed) {
      throw new AppError({
        kind: 'validation',
        code: 'assets.unsupported_type',
        message: `unsupported or unrecognised file type${sniffed ? ` (${sniffed})` : ''} — allowed: ${[...ALLOWED.keys()].join(', ')}`,
      })
    }

    const rights = z
      .object({
        owner: z.string().default(''),
        source: z.string().default(''),
        license: z.string().default(''),
        consent: z.enum(['not_applicable', 'unverified', 'authorized', 'revoked']).default('unverified'),
        allowedUse: z.string().default(''),
        expiresAt: z.string().nullable().default(null),
        notes: z.string().default(''),
        authorized: z.boolean().default(false),
      })
      .parse({
        owner: fields.rights_owner,
        source: fields.rights_source,
        license: fields.rights_license,
        consent: fields.rights_consent,
        allowedUse: fields.rights_allowed_use,
        expiresAt: fields.rights_expires_at || null,
        notes: fields.rights_notes,
        authorized: fields.rights_authorized === 'true',
      })

    const tempDir = await mkdtemp(join(tmpdir(), 'masterclip-upload-'))
    try {
      const tempPath = join(tempDir, filename)
      await writeFile(tempPath, fileBuffer)
      const sha = await sha256File(tempPath)

      const duplicate = await runtime.assets.findByHash(projectId, sha)
      if (duplicate) {
        return { asset: duplicate, deduplicated: true, url: await runtime.storage.signedUrl(duplicate.storageKey, 3600) }
      }

      const info = allowed.kind === 'reference_image' ? null : await probe(tempPath).catch(() => null)
      const assetId = newId('ast', runtime.clock.now())
      const key = objectKey({ projectId, kind: allowed.kind, id: assetId, filename })
      const stored = await runtime.storage.putFile(key, tempPath, { contentType: allowed.mime, sha256: sha })

      const asset = await runtime.assets.create({
        projectId,
        kind: allowed.kind,
        storageKey: stored.key,
        filename,
        mime: allowed.mime,
        bytes: stored.bytes,
        sha256: stored.sha256,
        width: info?.video?.width ?? null,
        height: info?.video?.height ?? null,
        durationSeconds: info?.durationSeconds ?? null,
        fps: info?.video?.fps ?? null,
        hasAudio: info ? Boolean(info.audio) : null,
        metadata: { uploaded: true, declaredType: fields.content_type ?? null, sniffedType: sniffed },
        rights,
        createdBy: auth.userId,
      })

      await runtime.audit.record({
        orgId: auth.orgId,
        projectId,
        actor: auth.userId,
        action: 'asset.uploaded',
        targetType: 'asset',
        targetId: asset.id,
        data: { filename, bytes: stored.bytes, rightsAuthorized: rights.authorized },
      })

      return { asset, deduplicated: false, url: await runtime.storage.signedUrl(asset.storageKey, 3600) }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  app.put('/api/assets/:assetId/rights', async (request) => {
    const { assetId } = request.params as { assetId: string }
    const asset = await runtime.assets.get(assetId)
    const { auth } = await requireProject(runtime, request, asset.projectId, 'producer')
    const rights = z
      .object({
        owner: z.string().optional(),
        source: z.string().optional(),
        license: z.string().optional(),
        consent: z.enum(['not_applicable', 'unverified', 'authorized', 'revoked']).optional(),
        allowedUse: z.string().optional(),
        expiresAt: z.string().nullable().optional(),
        notes: z.string().optional(),
        authorized: z.boolean().optional(),
      })
      .parse(request.body)
    return { asset: await runtime.assets.setRights(assetId, rights, auth.userId) }
  })

  app.get('/api/assets/:assetId/lineage', async (request) => {
    const { assetId } = request.params as { assetId: string }
    const asset = await runtime.assets.get(assetId)
    await requireProject(runtime, request, asset.projectId)
    const [lineage, chain] = await Promise.all([runtime.assets.lineage(assetId), runtime.assets.provenanceChain(assetId)])
    return { lineage, provenanceChain: chain }
  })

  app.get('/api/whoami', async (request) => ({ user: await requireAuth(runtime, request) }))
}
