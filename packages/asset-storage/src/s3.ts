import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AppError, classifyStatus, sha256File, sha256Hex } from '@masterclip/shared'
import type { PutOptions, StorageDriver, StoredObject } from './driver.js'
import { presignUrl, signRequest, uriEncode, type SigV4Credentials } from './sigv4.js'
import { stableExpiry } from './expiry.js'

export interface S3StorageOptions {
  endpoint: string
  bucket: string
  region: string
  credentials: SigV4Credentials
  /** MinIO/R2 want path-style; AWS accepts it too. */
  forcePathStyle?: boolean
  /** Injectable clock, so presign stability is testable without waiting. */
  now?: () => number
}

/**
 * S3-compatible driver.
 *
 * DEV-LABELED: the SigV4 signer is unit-tested against the published AWS test
 * vector, but this driver has not been exercised against a live bucket in this
 * build. Run `masterclip doctor` with STORAGE_DRIVER=s3 before relying on it.
 */
export class S3Storage implements StorageDriver {
  readonly name = 's3' as const

  private readonly now: () => number

  constructor(private readonly opts: S3StorageOptions) {
    if (!opts.bucket) throw new Error('S3Storage requires a bucket')
    if (!opts.endpoint) throw new Error('S3Storage requires an endpoint')
    this.now = opts.now ?? Date.now
  }

  private urlFor(key: string): URL {
    const base = new URL(this.opts.endpoint)
    const encodedKey = key.split('/').map((s) => uriEncode(s)).join('/')
    if (this.opts.forcePathStyle !== false) {
      base.pathname = `/${this.opts.bucket}/${encodedKey}`
    } else {
      base.host = `${this.opts.bucket}.${base.host}`
      base.pathname = `/${encodedKey}`
    }
    return base
  }

  private async send(
    method: string,
    key: string,
    body?: Uint8Array,
    contentType?: string,
  ): Promise<{ status: number; body: Uint8Array; headers: Headers }> {
    const url = this.urlFor(key)
    const payloadHash = body ? sha256Hex(body) : sha256Hex('')
    const headers = signRequest({
      method,
      url,
      region: this.opts.region,
      credentials: this.opts.credentials,
      payloadHash,
      headers: contentType ? { 'content-type': contentType } : {},
    })
    const response = await fetch(url.toString(), { method, headers, body: body as BodyInit | undefined })
    const buf = new Uint8Array(await response.arrayBuffer())
    if (!response.ok && response.status !== 404) {
      throw new AppError({
        kind: classifyStatus(response.status),
        code: `s3.${response.status}`,
        message: `S3 ${method} ${key} → ${response.status}`,
        details: { body: Buffer.from(buf).toString('utf8').slice(0, 500) },
      })
    }
    return { status: response.status, body: buf, headers: response.headers }
  }

  async putFile(key: string, sourcePath: string, opts: PutOptions = {}): Promise<StoredObject> {
    const data = new Uint8Array(await readFile(sourcePath))
    const sha = opts.sha256 ?? (await sha256File(sourcePath))
    return this.putBuffer(key, data, { ...opts, sha256: sha })
  }

  async putBuffer(key: string, data: Uint8Array, opts: PutOptions = {}): Promise<StoredObject> {
    await this.send('PUT', key, data, opts.contentType ?? 'application/octet-stream')
    return {
      key,
      bytes: data.byteLength,
      sha256: opts.sha256 ?? sha256Hex(data),
      contentType: opts.contentType ?? 'application/octet-stream',
    }
  }

  async getBuffer(key: string): Promise<Uint8Array> {
    const res = await this.send('GET', key)
    if (res.status === 404) throw new AppError({ kind: 'not_found', message: `object ${key} not found` })
    return res.body
  }

  localPath(): null {
    return null
  }

  async materialize(key: string, destPath: string): Promise<string> {
    const data = await this.getBuffer(key)
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, data)
    return destPath
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.send('HEAD', key)
    return res.status >= 200 && res.status < 300
  }

  async delete(key: string): Promise<void> {
    await this.send('DELETE', key)
  }

  async signedUrl(key: string, ttlSeconds = 3600): Promise<string> {
    // SigV4 presigning embeds X-Amz-Date, so signing at the current instant
    // yields a different URL every second and defeats browser caching exactly
    // as the local driver did. Sign as of the window start instead.
    const { issuedAtEpochSeconds } = stableExpiry(this.now(), ttlSeconds)
    return presignUrl({
      url: this.urlFor(key),
      region: this.opts.region,
      credentials: this.opts.credentials,
      expiresSeconds: ttlSeconds,
      date: new Date(issuedAtEpochSeconds * 1000),
    })
  }

  async list(prefix: string): Promise<string[]> {
    const url = new URL(this.opts.endpoint)
    url.pathname = this.opts.forcePathStyle !== false ? `/${this.opts.bucket}` : '/'
    if (this.opts.forcePathStyle === false) url.host = `${this.opts.bucket}.${url.host}`
    url.searchParams.set('list-type', '2')
    url.searchParams.set('prefix', prefix)
    const headers = signRequest({
      method: 'GET',
      url,
      region: this.opts.region,
      credentials: this.opts.credentials,
      payloadHash: sha256Hex(''),
    })
    const response = await fetch(url.toString(), { headers })
    const xml = await response.text()
    if (!response.ok) {
      throw new AppError({ kind: classifyStatus(response.status), message: `S3 list → ${response.status}` })
    }
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1] ?? '').filter(Boolean)
  }
}

/** Streams a remote URL straight to disk without buffering it in memory. */
export async function downloadToFile(url: string, destPath: string, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(url, { headers })
  if (!response.ok || !response.body) {
    throw new AppError({
      kind: classifyStatus(response.status),
      code: `download.${response.status}`,
      message: `download failed with status ${response.status}`,
    })
  }
  await mkdir(dirname(destPath), { recursive: true })
  const out = createWriteStream(destPath)
  const reader = response.body.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve())
    out.on('error', reject)
  })
  return total
}
