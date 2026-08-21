import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile, readdir, copyFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AppError, hmacHex, safeEqual, sha256File, sha256Hex } from '@masterclip/shared'
import type { PutOptions, StorageDriver, StoredObject } from './driver.js'
import { stableExpiry } from './expiry.js'

export interface LocalStorageOptions {
  root: string
  /** HMAC key for signed URLs. Required — an unsigned asset URL is a public one. */
  signingSecret: string
  urlPrefix?: string
  now?: () => number
}

/**
 * Filesystem-backed object storage, used by default in development and by any
 * single-node deployment. The API never serves files by raw path: reads go
 * through {@link verifySignedUrl}, which is why the signing secret is required
 * rather than optional.
 */
export class LocalStorage implements StorageDriver {
  readonly name = 'local' as const
  private readonly root: string
  private readonly secret: string
  private readonly urlPrefix: string
  private readonly now: () => number

  constructor(opts: LocalStorageOptions) {
    if (!opts.signingSecret) throw new Error('LocalStorage requires a signingSecret (set ASSET_SIGNING_SECRET)')
    this.root = resolve(opts.root)
    this.secret = opts.signingSecret
    this.urlPrefix = opts.urlPrefix ?? '/api/assets/raw'
    this.now = opts.now ?? Date.now
  }

  /** Resolves a key under the root and refuses anything that escapes it. */
  private pathFor(key: string): string {
    const target = resolve(this.root, key)
    const rel = relative(this.root, target)
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(this.root, rel) !== target) {
      throw new AppError({ kind: 'validation', code: 'storage.path_escape', message: `invalid storage key: ${key}` })
    }
    return target
  }

  async putFile(key: string, sourcePath: string, opts: PutOptions = {}): Promise<StoredObject> {
    const target = this.pathFor(key)
    await mkdir(dirname(target), { recursive: true })
    if (resolve(sourcePath) !== target) {
      await pipeline(createReadStream(sourcePath), createWriteStream(target))
    }
    const info = await stat(target)
    return {
      key,
      bytes: info.size,
      sha256: opts.sha256 ?? (await sha256File(target)),
      contentType: opts.contentType ?? 'application/octet-stream',
    }
  }

  async putBuffer(key: string, data: Uint8Array, opts: PutOptions = {}): Promise<StoredObject> {
    const target = this.pathFor(key)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
    return {
      key,
      bytes: data.byteLength,
      sha256: opts.sha256 ?? sha256Hex(data),
      contentType: opts.contentType ?? 'application/octet-stream',
    }
  }

  async getBuffer(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)))
  }

  localPath(key: string): string {
    return this.pathFor(key)
  }

  async materialize(key: string, destPath: string): Promise<string> {
    const source = this.pathFor(key)
    if (resolve(destPath) === source) return source
    await mkdir(dirname(destPath), { recursive: true })
    await copyFile(source, destPath)
    return destPath
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key))
      return true
    } catch {
      return false
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true })
  }

  async signedUrl(key: string, ttlSeconds = 3600): Promise<string> {
    // Anchored to a window boundary so repeated requests for the same key
    // produce the identical string and the browser can actually reuse what it
    // already downloaded. See stableExpiry().
    const { expiresAtEpochSeconds: expires } = stableExpiry(this.now(), ttlSeconds)
    const sig = signAssetKey(this.secret, key, expires)
    return `${this.urlPrefix}?key=${encodeURIComponent(key)}&exp=${expires}&sig=${sig}`
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.pathFor(prefix)
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else out.push(relative(this.root, full).split(sep).join('/'))
      }
    }
    await walk(base)
    return out
  }
}

export function signAssetKey(secret: string, key: string, expiresAtEpochSeconds: number): string {
  return hmacHex(secret, `${key}:${expiresAtEpochSeconds}`)
}

/**
 * Verifies a signed asset URL. Returns the key only when the signature matches
 * and the deadline has not passed — expiry is checked after the comparison so
 * the two failure modes are indistinguishable in timing.
 */
export function verifySignedUrl(
  secret: string,
  params: { key?: string; exp?: string; sig?: string },
  nowMs = Date.now(),
): string {
  const { key, exp, sig } = params
  if (!key || !exp || !sig) {
    throw new AppError({ kind: 'forbidden', code: 'storage.unsigned', message: 'missing asset signature' })
  }
  const expires = Number(exp)
  if (!Number.isFinite(expires)) {
    throw new AppError({ kind: 'forbidden', code: 'storage.bad_signature', message: 'invalid asset signature' })
  }
  const expected = signAssetKey(secret, key, expires)
  const signatureOk = safeEqual(expected, sig)
  if (!signatureOk || expires * 1000 < nowMs) {
    throw new AppError({
      kind: 'forbidden',
      code: signatureOk ? 'storage.expired' : 'storage.bad_signature',
      message: signatureOk ? 'asset link expired' : 'invalid asset signature',
    })
  }
  return key
}
