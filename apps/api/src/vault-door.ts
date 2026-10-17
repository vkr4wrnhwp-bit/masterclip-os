import { randomBytes } from 'node:crypto'
import { AppError } from '@masterclip/shared'
import { signSuiteProof } from '@masterclip/auth'

/**
 * Motion's side of Street Banker's Vault doors (vault_doors_api.py on the main
 * app; spec owner-notes/vault-doors-spec-2026-10-12.md). The artist's files live
 * in the main app's Vault; Motion reads them, it never keeps its own copy of the
 * list.
 *
 *   GET {STREET_BANKER_URL}/suites/token?suite=motion&scope=read
 *       Authorization: Suite <proof signed with SUITE_SSO_SECRET>
 *       -> {token, expires_in, uid}
 *   GET {STREET_BANKER_URL}/api/vault/files?kind=audio       Bearer <token>
 *   GET {STREET_BANKER_URL}/api/vault/files/<id>/content     Bearer <token>
 *
 *   GET {STREET_BANKER_URL}/suites/token?suite=motion&scope=deliver   (same proof)
 *   POST {STREET_BANKER_URL}/api/vault/deliver               Bearer <deliver token>
 *       multipart: file, kind=video, label, source=motion, release_id?, recording_id?
 *       -> 201 {ok, id, label, kind, deduped:false} | 200 {..., deduped:true}
 *
 * Only a session Street Banker's hand-off opened carries an email Street Banker
 * vouched for; callers pass that email and nothing else.
 */

export interface VaultDelivery {
  id: string
  label: string
  kind: string
  /** The Vault already held these exact bytes, so nothing was added twice. */
  deduped: boolean
}

/** What MOTION may send to the Vault through the delivery door. */
export type VaultDeliverKind = 'video'

/** Bytes in hand, or a stream that is read to the end (and capped) before anything is sent. */
export type DeliverBody = Uint8Array | AsyncIterable<Uint8Array>

export interface VaultAudioFile {
  id: string
  label: string
  extension: string
  size: number | null
  date: string
  /** Motion takes WAV and MP3; other audio in the Vault is listed but cannot be used yet. */
  usable: boolean
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

const USABLE = new Set(['wav', 'wave', 'mp3'])
/** The Vault's own limit for audio (vault_doors_api), so nothing bigger is ever asked for. */
export const VAULT_AUDIO_MAX_BYTES = 200 * 1024 * 1024
/** The Vault's own limit for a delivered video (vault_doors_api LIMITS["video"]). */
export const VAULT_VIDEO_MAX_BYTES = 200 * 1024 * 1024
const TIMEOUT_MS = 6000
const DOWNLOAD_TIMEOUT_MS = 120_000
/** A 200 MB upload on a slow line; Street Banker answers as soon as the file is filed. */
const DELIVER_TIMEOUT_MS = 10 * 60_000
const VIDEO_TYPES: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime' }

export const DELIVER_TOO_BIG = 'This video is bigger than 200 MB, so it was not sent. Your Vault takes videos up to 200 MB.'
export const DELIVER_SIGNED_OUT = 'Open MOTION from Street Banker again, then send it to your Vault.'
export const DELIVER_NO_ANSWER = 'Street Banker did not answer, so nothing was sent. Your video is still here in MOTION. Try again in a minute.'

export class VaultDoor {
  /** Tokens by "<email> <scope>": a read token never delivers and a deliver token never reads. */
  private readonly tokens = new Map<string, { token: string; uid: string; until: number }>()

  constructor(
    private readonly options: {
      baseUrl: string
      secret: string
      fetch?: FetchLike
      now?: () => number
    },
  ) {}

  static fromEnv(fetchImpl?: FetchLike): VaultDoor | null {
    const secret = (process.env.SUITE_SSO_SECRET ?? '').trim()
    if (!secret) return null
    const baseUrl = (process.env.STREET_BANKER_URL ?? 'https://app.streetbankermusic.com').replace(/\/+$/, '')
    return new VaultDoor({ baseUrl, secret, fetch: fetchImpl })
  }

  private get fetchImpl(): FetchLike {
    return this.options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private async call(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    extra: { method?: string; body?: unknown; unreachable?: string } = {},
  ) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const init: Record<string, unknown> = { headers, signal: controller.signal }
      if (extra.method) init.method = extra.method
      if (extra.body !== undefined) init.body = extra.body
      return await this.fetchImpl(url, init as never)
    } catch {
      throw new AppError({ kind: 'provider_unavailable', code: 'vault.unreachable', message: extra.unreachable ?? 'Your Vault did not answer. Try again in a minute.' })
    } finally {
      clearTimeout(timer)
    }
  }

  private refused(status: number): never {
    if (status === 401 || status === 403) {
      throw new AppError({ kind: 'forbidden', code: 'vault.signed_out', message: 'Open Motion from Street Banker again to reach your Vault.' })
    }
    if (status === 404) throw new AppError({ kind: 'not_found', code: 'vault.not_found', message: 'That file is no longer in your Vault.' })
    if (status === 429) throw new AppError({ kind: 'provider_unavailable', code: 'vault.busy', message: 'Your Vault is busy. Try again in a minute.' })
    if (status === 503) throw new AppError({ kind: 'provider_unavailable', code: 'vault.off', message: 'The Vault is not switched on for Motion yet.' })
    throw new AppError({ kind: 'provider_unavailable', code: 'vault.unreachable', message: 'Your Vault did not answer. Try again in a minute.' })
  }

  /**
   * A ten-minute token for this artist and scope. A read token is reused until
   * a minute before it runs out; a deliver token until 30 seconds before.
   */
  async token(email: string, scope: 'read' | 'deliver' = 'read', unreachable?: string): Promise<string> {
    const who = email.trim().toLowerCase()
    const key = `${who} ${scope}`
    const held = this.tokens.get(key)
    if (held && held.until > this.now()) return held.token
    const knownUid = held?.uid ?? this.tokens.get(`${who} ${scope === 'read' ? 'deliver' : 'read'}`)?.uid ?? ''
    const nowSeconds = Math.floor(this.now() / 1000)
    const proof = signSuiteProof(
      { email: who, uid: knownUid, suite: 'motion', scope, nonce: randomBytes(9).toString('base64url') },
      this.options.secret,
      nowSeconds,
    )
    const res = await this.call(`${this.options.baseUrl}/suites/token?suite=motion&scope=${scope}`, {
      Authorization: `Suite ${proof}`,
      Accept: 'application/json',
      'User-Agent': 'MotionBot/1.0',
    }, TIMEOUT_MS, { unreachable })
    if (!res.ok) {
      if (scope === 'deliver') this.deliverRefused(res.status, null)
      this.refused(res.status)
    }
    const body = (await res.json()) as { token?: string; expires_in?: number; uid?: string }
    if (!body.token) {
      if (scope === 'deliver') this.deliverRefused(502, null)
      this.refused(502)
    }
    const seconds = Math.max(60, Number(body.expires_in ?? 600))
    const margin = scope === 'deliver' ? 30 : 60
    this.tokens.set(key, { token: body.token, uid: String(body.uid ?? ''), until: this.now() + (seconds - margin) * 1000 })
    return body.token
  }

  /** Street Banker's refusal of a delivery, in plain words. Nothing was filed. */
  private deliverRefused(status: number, said: string | null): never {
    if (status === 401 || status === 403) {
      throw new AppError({ kind: 'forbidden', code: 'vault.signed_out', message: DELIVER_SIGNED_OUT })
    }
    if (status === 413) throw new AppError({ kind: 'validation', code: 'vault.too_big', message: DELIVER_TOO_BIG })
    if (status === 429) throw new AppError({ kind: 'provider_unavailable', code: 'vault.busy', message: 'Your Vault is busy. Nothing was sent. Try again in a minute.' })
    if (status === 503) throw new AppError({ kind: 'provider_unavailable', code: 'vault.off', message: 'Your Vault is not switched on for MOTION yet. Nothing was sent.' })
    if (status >= 400 && status < 500) {
      const reason = said && said.length <= 200 ? ` ${said}` : ''
      throw new AppError({ kind: 'validation', code: 'vault.refused', message: `Your Vault did not take this video.${reason}` })
    }
    throw new AppError({ kind: 'provider_unavailable', code: 'vault.unreachable', message: DELIVER_NO_ANSWER })
  }

  /**
   * Files one finished video in the artist's Vault through Street Banker's
   * delivery door. The bytes are read (and held to the Vault's 200 MB limit)
   * before a deliver token is asked for, so a token is never spent on a file
   * that cannot go. The same bytes twice come back `deduped`, never a second copy.
   */
  async deliver(
    email: string,
    content: DeliverBody,
    filename: string,
    kind: VaultDeliverKind = 'video',
    label: string,
    opts: { releaseId?: string; recordingId?: string } = {},
  ): Promise<VaultDelivery> {
    const extension = (filename.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase()
    const contentType = VIDEO_TYPES[extension]
    if (kind !== 'video' || !contentType) {
      throw new AppError({ kind: 'validation', code: 'vault.not_video', message: 'Your Vault takes MP4 or MOV video from MOTION. This file is neither, so it was not sent.' })
    }
    const name = label.trim()
    if (!name) throw new AppError({ kind: 'validation', code: 'vault.needs_label', message: 'Give the video a name before sending it to your Vault.' })

    const bytes = await readCapped(content, VAULT_VIDEO_MAX_BYTES)
    const token = await this.token(email, 'deliver', DELIVER_NO_ANSWER)

    const form = new FormData()
    // Node's buffers sit on a plain ArrayBuffer; the cast only narrows the DOM typing.
    form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }), filename)
    form.append('kind', kind)
    form.append('label', name.slice(0, 200))
    form.append('source', 'motion')
    if (opts.releaseId) form.append('release_id', opts.releaseId)
    if (opts.recordingId) form.append('recording_id', opts.recordingId)

    const res = await this.call(`${this.options.baseUrl}/api/vault/deliver`, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'MotionBot/1.0',
    }, DELIVER_TIMEOUT_MS, { method: 'POST', body: form, unreachable: DELIVER_NO_ANSWER })
    let body: Record<string, unknown> | null = null
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      body = null
    }
    if (!res.ok) {
      // A deliver token that went stale between the cache and the door is not kept.
      if (res.status === 401 || res.status === 403) this.tokens.delete(`${email.trim().toLowerCase()} deliver`)
      this.deliverRefused(res.status, typeof body?.message === 'string' ? body.message : null)
    }
    const id = body && (typeof body.id === 'string' || typeof body.id === 'number') ? String(body.id) : ''
    if (!id) this.deliverRefused(502, null)
    return {
      id,
      label: typeof body?.label === 'string' && body.label ? body.label : name,
      kind: typeof body?.kind === 'string' ? body.kind : kind,
      deduped: body?.deduped === true,
    }
  }

  /** The artist's Vault audio, newest first, as the Vault labels it. */
  async listAudio(email: string): Promise<VaultAudioFile[]> {
    const token = await this.token(email)
    const res = await this.call(`${this.options.baseUrl}/api/vault/files?kind=audio`, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }, TIMEOUT_MS)
    if (!res.ok) this.refused(res.status)
    const rows = (await res.json()) as Array<Record<string, unknown>>
    if (!Array.isArray(rows)) this.refused(502)
    return rows.map((row) => {
      const extension = String(row.extension ?? '').toLowerCase()
      return {
        id: String(row.id ?? ''),
        label: String(row.label ?? ''),
        extension,
        size: typeof row.size === 'number' ? row.size : null,
        date: String(row.date ?? ''),
        usable: USABLE.has(extension),
      }
    }).filter((row) => row.id)
  }

  /** One Vault file's bytes. Refuses anything over the Vault's own audio limit. */
  async download(email: string, fileId: string): Promise<Buffer> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(fileId)) {
      throw new AppError({ kind: 'validation', code: 'vault.bad_id', message: 'That is not a Vault file.' })
    }
    const token = await this.token(email)
    const res = await this.call(`${this.options.baseUrl}/api/vault/files/${fileId}/content`, {
      Authorization: `Bearer ${token}`,
    }, DOWNLOAD_TIMEOUT_MS)
    if (!res.ok) this.refused(res.status)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > VAULT_AUDIO_MAX_BYTES) {
      throw new AppError({ kind: 'validation', code: 'vault.too_big', message: 'That song is bigger than 200 MB.' })
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > VAULT_AUDIO_MAX_BYTES) {
      throw new AppError({ kind: 'validation', code: 'vault.too_big', message: 'That song is bigger than 200 MB.' })
    }
    return bytes
  }
}

/** The whole body as one buffer, refused (and never sent) the moment it passes `cap`. */
async function readCapped(content: DeliverBody, cap: number): Promise<Uint8Array> {
  const tooBig = () => new AppError({ kind: 'validation', code: 'vault.too_big', message: DELIVER_TOO_BIG })
  if (content instanceof Uint8Array) {
    if (content.byteLength > cap) throw tooBig()
    return content
  }
  const parts: Uint8Array[] = []
  let total = 0
  for await (const part of content) {
    total += part.byteLength
    if (total > cap) throw tooBig()
    parts.push(part)
  }
  return Buffer.concat(parts, total)
}
