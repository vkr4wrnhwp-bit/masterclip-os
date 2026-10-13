import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { AppError, loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { SUITE_SSO_SALT, signSuiteProof } from '@masterclip/auth'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'
import { VaultDoor } from '../apps/api/src/vault-door.js'

/**
 * "From your Vault" (owner, 2026-10-12: "what we need to create is the pull
 * from vault"). Motion trades a signed proof for a read token at Street
 * Banker's /suites/token, lists the artist's Vault audio and brings one song
 * into a project through the same store step and rights as an upload.
 */

describe('signSuiteProof', () => {
  it('signs the proof exactly as Street Banker reads it', () => {
    // Checked with the main app's own library: URLSafeTimedSerializer('test-secret-123',
    // salt='street-banker-suite-proof-v1').loads(<this>) returns the payload below.
    const proof = signSuiteProof({ email: 'Artist@Example.com', suite: 'motion', scope: 'read', nonce: 'abc123' }, 'test-secret-123', 1760000000)
    expect(proof).toBe(
      'eyJ2IjoxLCJ1aWQiOiIiLCJlbWFpbCI6ImFydGlzdEBleGFtcGxlLmNvbSIsInN1aXRlIjoibW90aW9uIiwic2NvcGUiOiJyZWFkIiwibm9uY2UiOiJhYmMxMjMiLCJpYXQiOjE3NjAwMDAwMDB9.aOd4AA.YTOaGteX9DwR9mLwnH8nxqk9gZs',
    )
  })
})

/** A WAV Motion's sniffer accepts: RIFF/WAVE header and a little silence. */
function wav(): Buffer {
  const data = Buffer.alloc(800)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(8000, 24); head.writeUInt32LE(16000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

const VAULT = [
  { id: 'v1', label: 'Night Drive', kind: 'audio', extension: 'wav', size: 844, date: '2026-10-01' },
  { id: 'v2', label: 'Gold Teeth demo', kind: 'audio', extension: 'm4a', size: 1200, date: '2026-09-20' },
]

/** A fake Street Banker: the token door, the files list and one file's bytes. */
function fakeStreetBanker(state: { calls: Array<{ url: string; auth: string }>; status?: number; down?: boolean }) {
  return async (url: string, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization ?? ''
    state.calls.push({ url, auth })
    if (state.down) throw new TypeError('fetch failed')
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
      ok: status < 400,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
      arrayBuffer: async () => {
        const bytes = body as Buffer
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      },
    })
    if (state.status) return reply(state.status, { ok: false })
    if (url.includes('/suites/token?suite=motion&scope=read')) {
      if (!auth.startsWith('Suite ')) return reply(401, { ok: false })
      return reply(200, { token: 'bearer-1', expires_in: 600, uid: '701' })
    }
    if (auth !== 'Bearer bearer-1') return reply(401, { ok: false })
    if (url.endsWith('/api/vault/files?kind=audio')) return reply(200, VAULT)
    if (url.endsWith('/api/vault/files/v1/content')) {
      const bytes = wav()
      return reply(200, bytes, { 'content-length': String(bytes.length) })
    }
    return reply(404, { ok: false })
  }
}

describe('VaultDoor', () => {
  it('trades a signed proof for a read token, reuses it, and lists the Vault audio', async () => {
    const state = { calls: [] as Array<{ url: string; auth: string }> }
    const door = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's3cret', fetch: fakeStreetBanker(state) as never })
    const files = await door.listAudio('artist@example.com')
    expect(files.map((f) => [f.id, f.usable])).toEqual([['v1', true], ['v2', false]])
    await door.listAudio('artist@example.com')
    const tokenCalls = state.calls.filter((c) => c.url.includes('/suites/token'))
    expect(tokenCalls).toHaveLength(1)
    expect(tokenCalls[0]!.url).toBe('https://sb.test/suites/token?suite=motion&scope=read')
    expect(tokenCalls[0]!.auth).toMatch(/^Suite [\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it('says plainly when Street Banker refuses or does not answer', async () => {
    const refused = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker({ calls: [], status: 403 }) as never })
    await expect(refused.listAudio('a@b.co')).rejects.toMatchObject({ code: 'vault.signed_out', message: 'Open Motion from Street Banker again to reach your Vault.' })
    const down = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker({ calls: [], down: true }) as never })
    await expect(down.listAudio('a@b.co')).rejects.toMatchObject({ code: 'vault.unreachable' })
    await expect(down.download('a@b.co', '../etc')).rejects.toBeInstanceOf(AppError)
  })
})

const SECRET = 'vault-test-handoff-secret'

function mint(claims: { uid: string; email: string }): string {
  const b64 = (value: Buffer) => value.toString('base64url')
  const payload = b64(Buffer.from(JSON.stringify({ v: 1, plan: 'label', suite: 'motion', nonce: 'n', name: 'Artist', ...claims })))
  const stamp: number[] = []
  for (let n = Math.floor(Date.now() / 1000); n > 0; n = Math.floor(n / 256)) stamp.unshift(n % 256)
  const signed = `${payload}.${b64(Buffer.from(stamp))}`
  const key = createHash('sha1').update(`${SUITE_SSO_SALT}signer${SECRET}`).digest()
  return `${signed}.${b64(createHmac('sha1', key).update(signed).digest())}`
}

describe('From your Vault routes', () => {
  let db: Db
  let runtime: Runtime
  let app: FastifyInstance
  let storageRoot: string
  const state = { calls: [] as Array<{ url: string; auth: string }> }

  beforeEach(async () => {
    process.env.SUITE_SSO_SECRET = SECRET
    process.env.STREET_BANKER_URL = 'https://sb.test'
    state.calls = []
    vi.stubGlobal('fetch', fakeStreetBanker(state))
    db = await createTestDb()
    storageRoot = await mkdtemp(join(tmpdir(), 'motion-vault-test-'))
    const config = loadConfig(
      { NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: storageRoot, ASSET_SIGNING_SECRET: 'vault-test-secret', SESSION_SECRET: 'vault-test-session' },
      true,
    )
    runtime = await createRuntime({ config, db, logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root: storageRoot, signingSecret: 'vault-test-secret' }) })
    app = await buildServer({ runtime, logger: silentLogger })
    await app.ready()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    delete process.env.SUITE_SSO_SECRET
    delete process.env.STREET_BANKER_URL
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  })

  async function arrive(email: string) {
    const response = await app.inject({ method: 'GET', url: `/auth/street-banker?token=${mint({ uid: '701', email })}` })
    expect(response.statusCode).toBe(302)
    const session = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? ''
    const csrf = response.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? ''
    return { cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }, headers: { [CSRF_HEADER]: csrf } }
  }

  it('lists the Vault songs for an artist who came from Street Banker', async () => {
    const who = await arrive('artist@example.com')
    const res = await app.inject({ method: 'GET', url: '/api/vault/audio', cookies: who.cookies })
    expect(res.statusCode).toBe(200)
    expect(res.json().files.map((f: { label: string; usable: boolean }) => [f.label, f.usable])).toEqual([['Night Drive', true], ['Gold Teeth demo', false]])
    const proof = state.calls.find((c) => c.url.includes('/suites/token'))!.auth.slice('Suite '.length)
    const payload = JSON.parse(Buffer.from(proof.split('.')[0]!, 'base64url').toString('utf8'))
    expect(payload).toMatchObject({ v: 1, email: 'artist@example.com', suite: 'motion', scope: 'read' })
  })

  it('refuses a Motion password session, whatever email it has', async () => {
    const org = await runtime.projects.createOrg('Elsewhere')
    await runtime.auth.createUser({ orgId: org.id, email: 'artist@example.com', password: 'a-long-test-password', displayName: 'X', orgRole: 'owner' })
    const login = await runtime.auth.login('artist@example.com', 'a-long-test-password')
    const res = await app.inject({ method: 'GET', url: '/api/vault/audio', cookies: { [SESSION_COOKIE]: login.token } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error?.code ?? res.json().code).toBe('vault.not_from_street_banker')
    expect(state.calls).toHaveLength(0)
  })

  it('brings a Vault song into a project with the rights the artist confirms, once', async () => {
    const who = await arrive('artist@example.com')
    const project = await app.inject({ method: 'POST', url: '/api/projects', cookies: who.cookies, headers: who.headers, payload: { name: 'Night Drive video' } })
    const projectId = project.json().project.id as string
    const body = { fileId: 'v1', rights: { owner: 'Lucas Joyner', authorized: true, consent: 'authorized' } }
    const first = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/vault-import`, cookies: who.cookies, headers: who.headers, payload: body })
    expect(first.statusCode).toBe(200)
    const asset = first.json().asset
    expect(asset).toMatchObject({ kind: 'audio', filename: 'Night_Drive.wav', mime: 'audio/wav' })
    expect(asset.rights).toMatchObject({ owner: 'Lucas Joyner', authorized: true, consent: 'authorized', source: 'Street Banker Vault: Night Drive' })
    expect(asset.metadata.fromVault).toEqual({ fileId: 'v1', label: 'Night Drive' })
    const again = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/vault-import`, cookies: who.cookies, headers: who.headers, payload: body })
    expect(again.json().deduplicated).toBe(true)
    expect(again.json().asset.id).toBe(asset.id)
  })

  it('says Motion takes WAV or MP3 for other audio, and copies nothing', async () => {
    const who = await arrive('artist@example.com')
    const project = await app.inject({ method: 'POST', url: '/api/projects', cookies: who.cookies, headers: who.headers, payload: { name: 'Demo' } })
    const projectId = project.json().project.id as string
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/vault-import`, cookies: who.cookies, headers: who.headers, payload: { fileId: 'v2' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.stringify(res.json())).toContain('Motion takes WAV or MP3')
    expect(state.calls.some((c) => c.url.includes('/content'))).toBe(false)
  })
})
