import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, insertRow, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { SUITE_SSO_SALT } from '@masterclip/auth'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'
import { DELIVER_NO_ANSWER, DELIVER_TOO_BIG, VAULT_VIDEO_MAX_BYTES, VaultDoor } from '../apps/api/src/vault-door.js'

/**
 * "Send to my Vault" (owner, 2026-10-16: "make sure everything saves or
 * uploads to the Vault"). A signed-off master's video goes to the artist's
 * Street Banker Vault through the delivery door: a deliver-scoped token for
 * suite "motion", then one multipart POST /api/vault/deliver, once per master.
 */

interface Call { url: string; auth: string; method: string; fields?: Record<string, string>; file?: { name: string; size: number; type: string }; at: number }

interface FakeState {
  calls: Call[]
  down?: boolean
  status?: number
  deliverStatus?: number
  deliverMessage?: string
  held: Map<string, string>
  seq: number
}

function freshState(): FakeState {
  return { calls: [], held: new Map(), seq: 0 }
}

let clock = 0

/** A fake Street Banker: both token scopes, the read list and the delivery door (dedupes by bytes). */
function fakeStreetBanker(state: FakeState) {
  return async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const auth = init?.headers?.Authorization ?? ''
    const call: Call = { url, auth, method: init?.method ?? 'GET', at: ++clock }
    state.calls.push(call)
    if (state.down) throw new TypeError('fetch failed')
    const reply = (status: number, body: unknown) => ({
      ok: status < 400,
      status,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    if (state.status) return reply(state.status, { ok: false })
    if (url.includes('/suites/token?suite=motion&scope=deliver')) {
      if (!auth.startsWith('Suite ')) return reply(401, { ok: false })
      return reply(200, { token: 'deliver-1', expires_in: 600, uid: '701' })
    }
    if (url.includes('/suites/token?suite=motion&scope=read')) {
      return reply(200, { token: 'read-1', expires_in: 600, uid: '701' })
    }
    if (url.endsWith('/api/vault/deliver') && call.method === 'POST') {
      if (auth !== 'Bearer deliver-1') return reply(403, { ok: false, error: 'wrong_scope', message: 'A read token cannot deliver.' })
      const form = init!.body as FormData
      const file = form.get('file') as File
      const bytes = Buffer.from(await file.arrayBuffer())
      call.fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string') as Array<[string, string]>)
      call.file = { name: file.name, size: bytes.length, type: file.type }
      if (state.deliverStatus) return reply(state.deliverStatus, { ok: false, error: 'refused', message: state.deliverMessage ?? 'No.' })
      const sha = createHash('sha256').update(bytes).digest('hex')
      const known = state.held.get(sha)
      if (known) return reply(200, { ok: true, id: known, label: call.fields.label, kind: 'video', deduped: true })
      const id = `vf${++state.seq}`
      state.held.set(sha, id)
      return reply(201, { ok: true, id, label: call.fields.label, kind: 'video', deduped: false })
    }
    return reply(404, { ok: false })
  }
}

function proofPayload(call: Call): Record<string, unknown> {
  const proof = call.auth.slice('Suite '.length)
  return JSON.parse(Buffer.from(proof.split('.')[0]!, 'base64url').toString('utf8'))
}

const deliverCalls = (state: FakeState) => state.calls.filter((c) => c.url.endsWith('/api/vault/deliver'))
const tokenCalls = (state: FakeState) => state.calls.filter((c) => c.url.includes('/suites/token'))

describe('VaultDoor.deliver', () => {
  it('signs a deliver proof for suite motion and sends one multipart video with source motion', async () => {
    const state = freshState()
    const door = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's3cret', fetch: fakeStreetBanker(state) as never })
    const sent = await door.deliver('Artist@Example.com', Buffer.from('a finished film'), 'Night Drive – Final.mp4', 'video', 'Night Drive – Final')
    expect(sent).toEqual({ id: 'vf1', label: 'Night Drive – Final', kind: 'video', deduped: false })

    const [token] = tokenCalls(state)
    expect(token!.url).toBe('https://sb.test/suites/token?suite=motion&scope=deliver')
    expect(proofPayload(token!)).toMatchObject({ v: 1, email: 'artist@example.com', suite: 'motion', scope: 'deliver' })

    const [delivery] = deliverCalls(state)
    expect(delivery!.method).toBe('POST')
    expect(delivery!.auth).toBe('Bearer deliver-1')
    expect(delivery!.fields).toMatchObject({ kind: 'video', label: 'Night Drive – Final', source: 'motion' })
    expect(delivery!.file).toMatchObject({ name: 'Night Drive – Final.mp4', size: 15, type: 'video/mp4' })

    // The deliver token is reused; it is never the read token, and the read token never delivers.
    await door.deliver('artist@example.com', Buffer.from('a second cut'), 'b.mov', 'video', 'B')
    await door.listAudio('artist@example.com').catch(() => undefined)
    expect(tokenCalls(state).map((c) => c.url.split('scope=')[1])).toEqual(['deliver', 'read'])
    expect(deliverCalls(state).at(-1)!.file!.type).toBe('video/quicktime')
  })

  it('asks for the deliver token only after the whole stream has been read', async () => {
    const state = freshState()
    const door = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker(state) as never })
    let streamDoneAt = 0
    async function* chunks() {
      yield Buffer.from('part one, ')
      yield Buffer.from('part two')
      streamDoneAt = ++clock
    }
    await door.deliver('a@b.co', chunks(), 'clip.mp4', 'video', 'Clip')
    expect(streamDoneAt).toBeGreaterThan(0)
    expect(tokenCalls(state)[0]!.at).toBeGreaterThan(streamDoneAt)
    expect(deliverCalls(state)[0]!.file!.size).toBe('part one, part two'.length)
  })

  it('refuses a video over 200 MB in plain words and sends nothing', async () => {
    const state = freshState()
    const door = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker(state) as never })
    const huge = new Uint8Array(1)
    Object.defineProperty(huge, 'byteLength', { value: VAULT_VIDEO_MAX_BYTES + 1 })
    await expect(door.deliver('a@b.co', huge, 'big.mp4', 'video', 'Big')).rejects.toMatchObject({ code: 'vault.too_big', message: DELIVER_TOO_BIG })

    const mb = Buffer.alloc(1024 * 1024)
    async function* overLimit() { for (let i = 0; i < 201; i++) yield mb }
    await expect(door.deliver('a@b.co', overLimit(), 'big.mp4', 'video', 'Big')).rejects.toMatchObject({ code: 'vault.too_big' })
    expect(state.calls).toHaveLength(0)

    // Street Banker's own 413 reads the same.
    const capped = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker({ ...freshState(), deliverStatus: 413 }) as never })
    await expect(capped.deliver('a@b.co', Buffer.from('x'), 'x.mp4', 'video', 'X')).rejects.toMatchObject({ message: DELIVER_TOO_BIG })
  })

  it('says plainly when Street Banker refuses or does not answer', async () => {
    const down = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker({ ...freshState(), down: true }) as never })
    await expect(down.deliver('a@b.co', Buffer.from('x'), 'x.mp4', 'video', 'X')).rejects.toMatchObject({ code: 'vault.unreachable', message: DELIVER_NO_ANSWER })

    const signedOut = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker({ ...freshState(), status: 403 }) as never })
    await expect(signedOut.deliver('a@b.co', Buffer.from('x'), 'x.mp4', 'video', 'X')).rejects.toMatchObject({
      code: 'vault.signed_out', message: 'Open MOTION from Street Banker again, then send it to your Vault.',
    })

    const refused = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker({ ...freshState(), deliverStatus: 400, deliverMessage: 'That file is not a video.' }) as never })
    await expect(refused.deliver('a@b.co', Buffer.from('x'), 'x.mp4', 'video', 'X')).rejects.toMatchObject({
      code: 'vault.refused', message: 'Your Vault did not take this video. That file is not a video.',
    })

    const wrongType = new VaultDoor({ baseUrl: 'https://sb.test', secret: 's', fetch: fakeStreetBanker(freshState()) as never })
    await expect(wrongType.deliver('a@b.co', Buffer.from('x'), 'x.webm', 'video', 'X')).rejects.toMatchObject({ code: 'vault.not_video' })
  })
})

const SECRET = 'vault-deliver-handoff-secret'

function mint(claims: { uid: string; email: string }): string {
  const b64 = (value: Buffer) => value.toString('base64url')
  const payload = b64(Buffer.from(JSON.stringify({ v: 1, plan: 'label', suite: 'motion', nonce: randomBytes(9).toString('base64url'), name: 'Artist', ...claims })))
  const stamp: number[] = []
  for (let n = Math.floor(Date.now() / 1000); n > 0; n = Math.floor(n / 256)) stamp.unshift(n % 256)
  const signed = `${payload}.${b64(Buffer.from(stamp))}`
  const key = createHash('sha1').update(`${SUITE_SSO_SALT}signer${SECRET}`).digest()
  return `${signed}.${b64(createHmac('sha1', key).update(signed).digest())}`
}

describe('POST /api/masters/:id/vault', () => {
  let db: Db
  let runtime: Runtime
  let app: FastifyInstance
  let storageRoot: string
  let state: FakeState

  async function boot(withDoor: boolean) {
    if (withDoor) process.env.SUITE_SSO_SECRET = SECRET
    else delete process.env.SUITE_SSO_SECRET
    process.env.STREET_BANKER_URL = 'https://sb.test'
    state = freshState()
    vi.stubGlobal('fetch', fakeStreetBanker(state))
    db = await createTestDb()
    // The fixture writes an output and a master straight in, without the render chain behind them.
    await db.exec('PRAGMA foreign_keys = OFF')
    storageRoot = await mkdtemp(join(tmpdir(), 'motion-vault-deliver-'))
    const config = loadConfig(
      { NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: storageRoot, ASSET_SIGNING_SECRET: 'vd-secret', SESSION_SECRET: 'vd-session' },
      true,
    )
    runtime = await createRuntime({ config, db, logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root: storageRoot, signingSecret: 'vd-secret' }) })
    // A Motion password session (used below) is only offered while it is the first account.
    app = await buildServer({ runtime, logger: silentLogger })
    await app.ready()
  }

  beforeEach(async () => { await boot(true) })

  afterEach(async () => {
    vi.unstubAllGlobals()
    delete process.env.SUITE_SSO_SECRET
    delete process.env.STREET_BANKER_URL
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  })

  async function arrive(email: string, uid = '701') {
    const response = await app.inject({ method: 'GET', url: `/auth/street-banker?token=${mint({ uid, email })}` })
    expect(response.statusCode).toBe(302)
    const session = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? ''
    const csrf = response.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? ''
    return { cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }, headers: { [CSRF_HEADER]: csrf } }
  }

  type Who = Awaited<ReturnType<typeof arrive>>

  /** A film with one signed-off master whose video is in Motion's storage. */
  async function filmWithMaster(who: Who, opts: { bytes?: number; signedOff?: boolean; filename?: string } = {}) {
    const project = await app.inject({ method: 'POST', url: '/api/projects', cookies: who.cookies, headers: who.headers, payload: { name: 'Night Drive video' } })
    expect(project.statusCode).toBe(200)
    const projectId = project.json().project.id as string
    const filename = opts.filename ?? 'render.mp4'
    const video = Buffer.from(`approved film for ${projectId}`)
    const key = `projects/${projectId}/generated_video/${filename}`
    const stored = await runtime.storage.putBuffer(key, video, { contentType: 'video/mp4' })
    const asset = await runtime.assets.create({
      projectId, kind: 'generated_video', storageKey: stored.key, filename, mime: filename.endsWith('.mp4') ? 'video/mp4' : 'video/webm',
      bytes: opts.bytes ?? stored.bytes, sha256: stored.sha256, createdBy: 'test',
    })
    const outputId = `out_${projectId}`
    await insertRow(db, 'outputs', {
      id: outputId, job_id: 'job_fixture', attempt_id: null, project_id: projectId, shot_id: 'shot_fixture', asset_id: asset.id,
      proxy_asset_id: null, thumbnail_asset_id: null, contact_sheet_asset_id: null, output_index: 0, provider_id: 'mock', model_id: 'mock-v1',
      duration_seconds: 4, width: 1280, height: 720, fps: 24, has_audio: 0, sha256: stored.sha256, status: 'approved', metadata: '{}',
      created_at: new Date().toISOString(),
    })
    await runtime.renders.addReview({ outputId, projectId, shotId: 'shot_fixture', userId: 'director', decision: 'approve', rankOrder: null, rejectionReasons: [], note: '' })
    const master = await runtime.renders.promoteToMaster({ projectId, shotId: 'shot_fixture', outputId, name: 'Final cut', sourceAssetId: asset.id, approvedBy: 'director' })
    if (opts.signedOff === false) {
      await runtime.renders.addReview({ outputId, projectId, shotId: 'shot_fixture', userId: 'director', decision: 'reset', rankOrder: null, rejectionReasons: [], note: '' })
    }
    return { projectId, masterId: master.id, bytes: video.length }
  }

  const send = (who: Who, masterId: string) =>
    app.inject({ method: 'POST', url: `/api/masters/${masterId}/vault`, cookies: who.cookies, headers: who.headers, payload: {} })
  const code = (res: { json(): Record<string, unknown> }) => (res.json().error as { code?: string } | undefined)?.code

  it('sends a signed-off master once, labelled "<film> – <master>", and remembers it', async () => {
    const who = await arrive('artist@example.com')
    const status = await app.inject({ method: 'GET', url: '/api/vault/status', cookies: who.cookies })
    expect(status.json()).toEqual({ connected: true, note: '' })

    const { masterId, bytes } = await filmWithMaster(who)
    const first = await send(who, masterId)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ ok: true, id: 'vf1', label: 'Night Drive video – Final cut', deduped: false, already: false })
    const [delivery] = deliverCalls(state)
    expect(delivery!.fields).toMatchObject({ kind: 'video', source: 'motion', label: 'Night Drive video – Final cut' })
    expect(delivery!.file!.size).toBe(bytes)
    expect(delivery!.file!.name).toMatch(/\.mp4$/)
    expect(proofPayload(tokenCalls(state)[0]!)).toMatchObject({ email: 'artist@example.com', suite: 'motion', scope: 'deliver' })

    const kept = await runtime.renders.getMaster(masterId)
    expect(kept.vault).toMatchObject({ fileId: 'vf1', label: 'Night Drive video – Final cut' })
    const listed = await app.inject({ method: 'GET', url: `/api/projects/${kept.projectId}/masters`, cookies: who.cookies })
    expect(listed.json().masters[0].vault).toMatchObject({ fileId: 'vf1' })

    // The second press says it is already there and uploads nothing.
    const again = await send(who, masterId)
    expect(again.json()).toEqual({ ok: true, id: 'vf1', label: 'Night Drive video – Final cut', deduped: true, already: true })
    expect(deliverCalls(state)).toHaveLength(1)
  })

  it('says "already" when the Vault held these bytes before Motion sent them', async () => {
    const who = await arrive('artist@example.com')
    const { masterId } = await filmWithMaster(who)
    const master = await runtime.renders.getMaster(masterId)
    const asset = await runtime.assets.get(master.sourceAssetId)
    state.held.set(createHash('sha256').update(Buffer.from(await runtime.storage.getBuffer(asset.storageKey))).digest('hex'), 'vf-by-hand')
    const res = await send(who, masterId)
    expect(res.json()).toMatchObject({ id: 'vf-by-hand', deduped: true, already: true })
    expect((await runtime.renders.getMaster(masterId)).vault?.fileId).toBe('vf-by-hand')
  })

  it('refuses a master that is not signed off, and sends nothing', async () => {
    const who = await arrive('artist@example.com')
    const { masterId } = await filmWithMaster(who, { signedOff: false })
    const res = await send(who, masterId)
    expect(res.statusCode).toBe(400)
    expect(code(res)).toBe('vault.not_signed_off')
    expect(res.json().error.message).toBe('Only a signed-off master goes to your Vault. Approve it first.')

    await db.run("UPDATE masters SET status = 'archived' WHERE id = ?", [masterId])
    expect(code(await send(who, masterId))).toBe('vault.not_signed_off')
    expect(state.calls).toHaveLength(0)
  })

  it("refuses another account's master, and sends nothing", async () => {
    const owner = await arrive('artist@example.com', '701')
    const { masterId } = await filmWithMaster(owner)
    const stranger = await arrive('someone@else.com', '702')
    const res = await send(stranger, masterId)
    expect([403, 404]).toContain(res.statusCode)
    expect(state.calls).toHaveLength(0)
    expect((await runtime.renders.getMaster(masterId)).vault ?? null).toBeNull()
  })

  it('refuses a master over 200 MB before reading it or asking Street Banker', async () => {
    const who = await arrive('artist@example.com')
    const { masterId } = await filmWithMaster(who, { bytes: VAULT_VIDEO_MAX_BYTES + 1 })
    const res = await send(who, masterId)
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toBe(DELIVER_TOO_BIG)
    expect(state.calls).toHaveLength(0)
  })

  it('leaves the master untouched when Street Banker is down, and sends it once it answers', async () => {
    const who = await arrive('artist@example.com')
    const { masterId } = await filmWithMaster(who)
    const before = await runtime.renders.getMaster(masterId)
    state.down = true
    const res = await send(who, masterId)
    expect(res.statusCode).toBe(503)
    expect(res.json().error.message).toBe(DELIVER_NO_ANSWER)
    expect(await runtime.renders.getMaster(masterId)).toEqual(before)

    state.down = false
    const later = await send(who, masterId)
    expect(later.json()).toMatchObject({ ok: true, id: 'vf1', already: false })
  })

  it('refuses a Motion password session, which Street Banker never vouched for', async () => {
    const org = await runtime.projects.createOrg('Elsewhere')
    await runtime.auth.createUser({ orgId: org.id, email: 'artist@example.com', password: 'a-long-test-password', displayName: 'X', orgRole: 'owner' })
    const login = await runtime.auth.login('artist@example.com', 'a-long-test-password')
    const status = await app.inject({ method: 'GET', url: '/api/vault/status', cookies: { [SESSION_COOKIE]: login.token } })
    expect(status.json().connected).toBe(false)
  })

  it('with the door off: status says not connected and the route refuses', async () => {
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
    await boot(false)
    // Without SUITE_SSO_SECRET there is no hand-off either, so this is a password session.
    const org = await runtime.projects.createOrg('Off')
    await runtime.auth.createUser({ orgId: org.id, email: 'off@example.com', password: 'a-long-test-password', displayName: 'Off', orgRole: 'owner' })
    const login = await runtime.auth.login('off@example.com', 'a-long-test-password')
    const status = await app.inject({ method: 'GET', url: '/api/vault/status', headers: { authorization: `Bearer ${login.token}` } })
    expect(status.json()).toEqual({ connected: false, note: 'Your Vault is not connected to MOTION yet.' })

    const project = await runtime.projects.create({ orgId: org.id, name: 'Off film', createdBy: login.user?.id ?? 'x' })
    const asset = await runtime.assets.create({ projectId: project.id, kind: 'generated_video', storageKey: 'k', filename: 'a.mp4', mime: 'video/mp4', bytes: 1, sha256: 'x', createdBy: 'x' })
    await insertRow(db, 'outputs', {
      id: 'out_off', job_id: 'job_fixture', attempt_id: null, project_id: project.id, shot_id: 's', asset_id: asset.id, proxy_asset_id: null,
      thumbnail_asset_id: null, contact_sheet_asset_id: null, output_index: 0, provider_id: 'mock', model_id: 'm', duration_seconds: 1,
      width: 1, height: 1, fps: 24, has_audio: 0, sha256: 'x', status: 'approved', metadata: '{}', created_at: new Date().toISOString(),
    })
    const master = await runtime.renders.promoteToMaster({ projectId: project.id, shotId: 's', outputId: 'out_off', name: 'M', sourceAssetId: asset.id, approvedBy: 'director' })
    const res = await app.inject({ method: 'POST', url: `/api/masters/${master.id}/vault`, headers: { authorization: `Bearer ${login.token}` }, payload: {} })
    expect(code(res)).toBe('vault.off')
    expect(state.calls).toHaveLength(0)
    expect((await runtime.renders.getMaster(master.id)).vault ?? null).toBeNull()
  })
})

describe('Masters page: Send to my Vault', () => {
  const view = readFileSync('apps/web/src/views/Masters.tsx', 'utf8')
  const style = readFileSync('apps/web/src/styles.css', 'utf8')

  it('shows the button only when the Vault is connected and only on a signed-off master', () => {
    expect(view).toContain('api.vaultStatus()')
    expect(view).toContain("if (!vaultOn && state.kind !== 'already') return null")
    expect(view).toContain("if (!signedOff && !kept) return null")
    expect(view).toContain("'Send to my Vault'")
    expect(view).toContain('`Saved to your Vault: ${state.text}`')
    expect(view).toContain("'Already in your Vault'")
    expect(view).toContain("'Sending…'")
  })

  it('uses a 44px target, MOTION tokens and a 12px floor', () => {
    const rules = style.slice(style.indexOf('.mo-vault-send {'))
    expect(rules).toMatch(/\.mo-vault-send button \{[^}]*min-height: 44px;/)
    expect(rules).toMatch(/\.mo-vault-send button \{[^}]*var\(--mo-cyan\)/)
    const sizes = [...rules.slice(0, rules.indexOf('@media')).matchAll(/font-size: (\d+)px/g)].map((m) => Number(m[1]))
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12)
  })
})
