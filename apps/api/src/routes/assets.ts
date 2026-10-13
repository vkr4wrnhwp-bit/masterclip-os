import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError, DEV_ASSET_SIGNING_SECRET, newId, sha256File } from '@masterclip/shared'
import { LocalStorage, objectKey, sanitizeFilename, verifySignedUrl } from '@masterclip/asset-storage'
import { beatAnalysis, probe, waveformPeaks } from '@masterclip/media-tools'
import { assertMediaReadable, signedReadableUrl, type Runtime } from '@masterclip/runtime'
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
  if (startsWith(0x49, 0x44, 0x33) || startsWith(0xff, 0xfb)) return 'audio/mpeg'
  return null
}

/**
 * Stores one file for a project with its rights, the way every way in does: a
 * file from this computer (POST /api/projects/:id/assets) and a song from the
 * artist's Street Banker Vault (POST /api/projects/:id/vault-import). The type
 * is sniffed from the bytes; the same bytes twice return the one asset.
 */
export async function storeProjectFile(
  runtime: Runtime,
  input: {
    projectId: string
    auth: { userId: string; orgId: string }
    fileBuffer: Buffer
    filename: string
    fields: Record<string, string>
    metadata?: Record<string, unknown>
  },
) {
  const { projectId, auth, fileBuffer, filename, fields } = input
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
      metadata: { uploaded: true, declaredType: fields.content_type ?? null, sniffedType: sniffed, ...(input.metadata ?? {}) },
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
    const assets = await runtime.db.query<{ id: string; mime: string }>(
      'SELECT id, mime FROM assets WHERE storage_key = ?', [key],
    )
    if (assets.length === 0) {
      throw new AppError({ kind: 'not_found', code: 'assets.unknown_key', message: 'signed asset key is not registered' })
    }
    // A signed key can theoretically point to multiple asset records. Every
    // reference must remain cleared; a duplicate record cannot bypass a
    // revoked source's recorded lineage.
    let containsAudio = false
    for (const item of assets) {
      const checked = await assertMediaReadable(runtime, item.id)
      containsAudio ||= checked.containsAudio
    }
    void reply.type(assets[0]!.mime)
    void reply.header('cache-control', containsAudio ? 'private, no-store' : 'private, max-age=3600')
    return reply.send(createReadStream(path))
  })

  // Actual decoded signal, never a decorative waveform. This route is
  // project-scoped even when storage uses otherwise reusable signed URLs.
  const waveCache = new Map<string, Awaited<ReturnType<typeof waveformPeaks>>>()
  app.get('/api/assets/:assetId/waveform', async (request) => {
    const { assetId } = request.params as { assetId: string }
    const asset = await runtime.assets.get(assetId)
    await requireProject(runtime, request, asset.projectId)
    if (asset.kind !== 'audio') {
      throw new AppError({ kind: 'validation', code: 'waveform.asset_kind', message: 'waveform requires an audio asset' })
    }
    // A revoked recording's waveform is its shape in time; refuse it as a
    // signed link to the file would be refused.
    await assertMediaReadable(runtime, asset.id)

    const cached = waveCache.get(asset.sha256)
    if (cached) return { ...cached, assetId }
    const dir = await mkdtemp(join(tmpdir(), 'masterclip-waveform-'))
    try {
      const path = runtime.storage.localPath(asset.storageKey) ?? await runtime.storage.materialize(asset.storageKey, join(dir, 'source-audio'))
      const waveform = await waveformPeaks(path)
      if (waveCache.size >= 48) waveCache.delete(waveCache.keys().next().value ?? '')
      waveCache.set(asset.sha256, waveform)
      return { ...waveform, assetId }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Conservative beat estimates from the actual recording. No song is
  // uploaded to a third party; rights are rechecked on each request.
  const beatsCache = new Map<string, Awaited<ReturnType<typeof beatAnalysis>>>()
  app.get('/api/assets/:assetId/beats', async request => {
    const { assetId } = request.params as { assetId: string }
    const asset = await runtime.assets.get(assetId)
    await requireProject(runtime, request, asset.projectId)
    if (asset.kind !== 'audio') {
      throw new AppError({ kind: 'validation', code: 'beats.asset_kind', message: 'beat analysis requires a recording' })
    }
    await assertMediaReadable(runtime, asset.id)
    if (!asset.rights.authorized || asset.rights.consent !== 'authorized') {
      throw new AppError({ kind: 'forbidden', code: 'beats.rights', message: 'recording needs current authorization' })
    }
    const cacheKey = asset.sha256 + ':beat-v1'
    const cached = beatsCache.get(cacheKey)
    if (cached) return { ...cached, assetId }
    const directory = await mkdtemp(join(tmpdir(), 'motion-beats-'))
    try {
      const path = runtime.storage.localPath(asset.storageKey) ??
        await runtime.storage.materialize(asset.storageKey, join(directory, 'track'))
      const analysis = await beatAnalysis(path)
      if (beatsCache.size >= 32) beatsCache.delete(beatsCache.keys().next().value ?? '')
      beatsCache.set(cacheKey, analysis)
      return { ...analysis, assetId }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  app.get('/api/assets/:assetId/url', async (request) => {
    const { assetId } = request.params as { assetId: string }
    const asset = await runtime.assets.get(assetId)
    await requireProject(runtime, request, asset.projectId)
    return { url: await signedReadableUrl(runtime, asset.id), asset }
  })

  app.get('/api/projects/:projectId/assets', async (request) => {
    const { projectId } = request.params as { projectId: string }
    await requireProject(runtime, request, projectId)
    const kind = (request.query as { kind?: string }).kind
    const assets = await runtime.assets.list(projectId, kind as never)
    return {
      assets: await Promise.all(assets.map(async (asset) => {
        let url: string | null = null
        try {
          url = await signedReadableUrl(runtime, asset.id)
        } catch (err) {
          if (!(err instanceof AppError) || err.kind !== 'forbidden') throw err
        }
        return { ...asset, url }
      })),
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

    return storeProjectFile(runtime, { projectId, auth, fileBuffer, filename, fields })
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
