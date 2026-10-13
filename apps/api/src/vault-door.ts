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
 * Only a session Street Banker's hand-off opened carries an email Street Banker
 * vouched for; callers pass that email and nothing else.
 */

export interface VaultAudioFile {
  id: string
  label: string
  extension: string
  size: number | null
  date: string
  /** Motion takes WAV and MP3; other audio in the Vault is listed but cannot be used yet. */
  usable: boolean
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}>

const USABLE = new Set(['wav', 'wave', 'mp3'])
/** The Vault's own limit for audio (vault_doors_api), so nothing bigger is ever asked for. */
export const VAULT_AUDIO_MAX_BYTES = 200 * 1024 * 1024
const TIMEOUT_MS = 6000
const DOWNLOAD_TIMEOUT_MS = 120_000

export class VaultDoor {
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

  private async call(url: string, headers: Record<string, string>, timeoutMs: number) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this.fetchImpl(url, { headers, signal: controller.signal } as never)
    } catch {
      throw new AppError({ kind: 'provider_unavailable', code: 'vault.unreachable', message: 'Your Vault did not answer. Try again in a minute.' })
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

  /** A ten-minute read token for this artist, reused until a minute before it runs out. */
  async token(email: string): Promise<string> {
    const key = email.trim().toLowerCase()
    const held = this.tokens.get(key)
    if (held && held.until > this.now()) return held.token
    const nowSeconds = Math.floor(this.now() / 1000)
    const proof = signSuiteProof(
      { email: key, uid: held?.uid ?? '', suite: 'motion', scope: 'read', nonce: randomBytes(9).toString('base64url') },
      this.options.secret,
      nowSeconds,
    )
    const res = await this.call(`${this.options.baseUrl}/suites/token?suite=motion&scope=read`, {
      Authorization: `Suite ${proof}`,
      Accept: 'application/json',
      'User-Agent': 'MotionBot/1.0',
    }, TIMEOUT_MS)
    if (!res.ok) this.refused(res.status)
    const body = (await res.json()) as { token?: string; expires_in?: number; uid?: string }
    if (!body.token) this.refused(502)
    const seconds = Math.max(60, Number(body.expires_in ?? 600))
    this.tokens.set(key, { token: body.token, uid: String(body.uid ?? ''), until: this.now() + (seconds - 60) * 1000 })
    return body.token
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
