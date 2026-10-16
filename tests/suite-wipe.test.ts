import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestDb, type Db, type SqlParam } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { SUITE_WIPE_SALT, verifySuiteWipe } from '@masterclip/auth'
import { buildServer } from '../apps/api/src/server.js'
import type { FastifyInstance } from 'fastify'

const secret = 'wipe-test-only'
let db: Db, runtime: Runtime, app: FastifyInstance, root: string
beforeEach(async () => {
  process.env.SUITE_SSO_SECRET_MOTION = secret
  db = await createTestDb()
  root = await mkdtemp(join(tmpdir(), 'motion-wipe-'))
  const config = loadConfig({ NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: root, ASSET_SIGNING_SECRET: secret, SESSION_SECRET: secret }, true)
  runtime = await createRuntime({ config, db, logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root, signingSecret: secret }) })
  app = await buildServer({ runtime, logger: silentLogger })
  await app.ready()
})
afterEach(async () => {
  delete process.env.SUITE_SSO_SECRET_MOTION
  delete process.env.SUITE_SSO_SECRET
  await app.close()
  await rm(root, { recursive: true, force: true })
})

function token(overrides: Record<string, unknown> = {}, age = 0, keySecret = secret) {
  const payload = Buffer.from(JSON.stringify({ v: 1, kind: 'wipe', suite: 'motion', uid: 'a', email: 'a@example.test', nonce: randomUUID(), ...overrides })).toString('base64url')
  const stamp = Buffer.alloc(4)
  stamp.writeUInt32BE(Math.floor(Date.now() / 1000) - age)
  const signed = `${payload}.${stamp.toString('base64url')}`
  const key = createHash('sha1').update(`${SUITE_WIPE_SALT}signer${keySecret}`).digest()
  return `${signed}.${createHmac('sha1', key).update(signed).digest('base64url')}`
}
const wipe = (value: unknown) => app.inject({ method: 'POST', url: '/api/street-banker/wipe', payload: { token: value } })

it('accepts a token stamped 10 seconds ahead of the server clock', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1792118979 * 1000)
  try {
    expect((await wipe(token({}, -10))).statusCode).toBe(200)
  } finally {
    clock.mockRestore()
  }
})

it('refuses a token stamped 31 seconds ahead of the server clock as expired', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1792118979 * 1000)
  try {
    const result = await wipe(token({}, -31))
    expect(result.statusCode).toBe(401)
    expect(result.json()).toEqual({ ok: false, error: 'expired' })
  } finally {
    clock.mockRestore()
  }
})

it('reads the real Python itsdangerous wire format', () => {
  // Minted with URLSafeTimedSerializer, not the JavaScript test helper.
  const signed = '.eJwVi0EOgCAMBP_SM5p45eRXiNbYCC2Rohjj3y23mZ3sCxf4ycFBvIKHmzKCg1JJ0TSJkrANlXoNRpgCxc4ztpByxFGxqAUWXvonP7oLDxs1rSfC9wPh1B_u.atGQww.QLJNqpZEEVWLysoLhI1E7O5TwCI'
  expect(verifySuiteWipe(signed, secret, 1792118979 + 5)).toEqual({ uid: 'a', email: 'a@example.test', nonce: 'python-fixture' })
})

// Fill incidental required fields while explicitly providing all ownership and FK fields.
async function row(table: string, values: Record<string, SqlParam>) {
  const columns = await db.query<{ name: string; type: string; notnull: number; dflt_value: unknown }>(`PRAGMA table_info(${table})`)
  const record = { ...values }
  for (const c of columns) if (!(c.name in record) && c.notnull && c.dflt_value === null) record[c.name] = /INT|REAL/.test(c.type) ? 0 : '{}'
  const names = Object.keys(record)
  await db.run(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, names.map(n => record[n]!))
}

async function seed(id: string) {
  await row('orgs', { id, name: id, street_banker_identity: `uid:${id}` })
  await row('users', { id, org_id: id, email: `${id}@example.test` })
  await row('sessions', { id, user_id: id, token_hash: id })
  await row('projects', { id, org_id: id, slug: id })
  await row('scenes', { id, project_id: id })
  await row('shots', { id, project_id: id, scene_id: id })
  await row('shot_versions', { id, shot_id: id })
  await row('assets', { id, project_id: id, storage_key: `${id}/upload.wav`, created_by: id })
  await row('render_jobs', { id, project_id: id, shot_id: id, shot_version_id: id, idempotency_key: id, status: 'completed', created_by: id })
  await row('outputs', { id, job_id: id, project_id: id, shot_id: id, asset_id: id })
  await row('cost_ledger', { id, org_id: id, project_id: id, created_by: id, credits: 12 })
  await row('project_members', { project_id: id, user_id: id })
  await row('render_attempts', { id, job_id: id })
  await row('render_batches', { id, project_id: id, created_by: id })
  await row('masters', { id, project_id: id, output_id: id, shot_id: id, source_asset_id: id })
  await row('master_deliverables', { id, master_id: id, asset_id: id })
  await row('reviews', { id, output_id: id, project_id: id, shot_id: id, user_id: id })
  await row('output_qc', { id, output_id: id })
  await row('characters', { id, project_id: id })
  await row('character_versions', { id, character_id: id })
  await row('environments', { id, project_id: id })
  await row('environment_versions', { id, environment_id: id })
  await row('provider_asset_cache', { id, asset_id: id, sha256: id })
  await row('asset_lineage', { id, child_asset_id: id, parent_asset_id: id })
  await row('provider_credentials', { id, org_id: id })
  await row('motion_music_timelines', { id, project_id: id, created_by: id })
  await row('motion_timeline_exports', { id, timeline_id: id, asset_id: id, created_by: id })
  await row('motion_music_sections', { project_id: id, audio_asset_id: id })
  for (const scope of ['project', 'scene', 'shot', 'batch', 'org']) {
    await row('budgets', { id: `${id}-${scope}`, scope, scope_id: id })
    await row('budget_events', { id: `${id}-${scope}`, scope, scope_id: id })
  }
  await row('audit_log', { id, org_id: id, project_id: id, actor: id, target_id: id, target_type: 'project', action: 'project.created' })
  for (const table of ['price_quotes', 'model_performance', 'rejection_stats', 'agent_runs']) await row(table, { id, project_id: id })
  for (const table of ['queue_jobs', 'queue_dead']) await row(table, { id, payload: JSON.stringify({ projectId: id }) })
  await row('webhook_events', { id, provider_id: 'test', external_id: id, dedupe_key: id })
  await db.run('UPDATE render_jobs SET external_job_id = ?, provider_id = ? WHERE id = ?', [id, 'test', id])
  await runtime.storage.putBuffer(`${id}/upload.wav`, Buffer.from('upload'))
  await runtime.storage.putBuffer(`${id}/render.mp4`, Buffer.from('render'))
}

it('wipes rows and stored upload/render files for only the signed account; refuses replay', async () => {
  await seed('a'); await seed('b')
  const tables = ['orgs','users','sessions','projects','scenes','shots','shot_versions','assets','render_jobs','outputs','cost_ledger','render_attempts','render_batches','masters','master_deliverables','reviews','output_qc','characters','character_versions','environments','environment_versions','provider_asset_cache','asset_lineage','provider_credentials','motion_music_timelines','motion_timeline_exports','audit_log','price_quotes','model_performance','rejection_stats','agent_runs','queue_jobs','queue_dead','webhook_events']
  const before = await Promise.all(tables.map(t => db.get(`SELECT * FROM ${t} WHERE id = ?`, ['b'])))
  const signed = token()
  const result = await wipe(signed)
  expect(result.json()).toMatchObject({ ok: true, uid: 'a', found: true })
  expect(result.statusCode).toBe(200)
  for (const [index, table] of tables.entries()) {
    expect(await db.get(`SELECT * FROM ${table} WHERE id = ?`, ['a'])).toBeUndefined()
    expect(await db.get(`SELECT * FROM ${table} WHERE id = ?`, ['b'])).toEqual(before[index])
  }
  expect(await runtime.storage.list('a/')).toEqual([])
  for (const table of ['budgets', 'budget_events']) {
    expect(await db.query(`SELECT id FROM ${table} WHERE scope_id = ?`, ['a'])).toEqual([])
    expect(await db.query(`SELECT id FROM ${table} WHERE scope_id = ?`, ['b'])).toHaveLength(5)
  }
  for (const table of ['project_members', 'motion_music_sections']) {
    expect(await db.query(`SELECT * FROM ${table} WHERE project_id = ?`, ['a'])).toEqual([])
    expect(await db.query(`SELECT * FROM ${table} WHERE project_id = ?`, ['b'])).toHaveLength(1)
  }
  expect((await runtime.storage.list('b/')).sort()).toEqual(['b/render.mp4','b/upload.wav'])
  expect((await wipe(signed)).statusCode).toBe(409)
})

it.each(['missing','bad signature','expired','wrong suite','wrong identity'])('refuses %s without touching either account', async reason => {
  await seed('a'); await seed('b')
  const value = reason === 'missing' ? '' : reason === 'bad signature' ? token({}, 0, 'wrong') : reason === 'expired' ? token({}, 61) : reason === 'wrong suite' ? token({ suite: 'tour' }) : token({ uid: 'b' })
  expect((await wipe(value)).statusCode).toBe(reason === 'wrong identity' ? 500 : 401)
  expect(await db.query('SELECT id FROM users ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }])
  expect(await runtime.storage.exists('a/upload.wav')).toBe(true)
  expect(await runtime.storage.exists('b/render.mp4')).toBe(true)
})

it('uses the shared key only when the MOTION key is absent', async () => {
  process.env.SUITE_SSO_SECRET = 'shared'
  expect((await wipe(token({}, 0, 'shared'))).statusCode).toBe(401)
  delete process.env.SUITE_SSO_SECRET_MOTION
  expect((await wipe(token({}, 0, 'shared'))).statusCode).toBe(200)
})

it('returns the same unconfigured and size-limit answers as the other suites', async () => {
  delete process.env.SUITE_SSO_SECRET_MOTION
  const unavailable = await wipe(token())
  expect(unavailable.statusCode).toBe(503)
  expect(unavailable.json()).toEqual({ ok: false, error: 'not_configured' })
  process.env.SUITE_SSO_SECRET_MOTION = secret
  const huge = await wipe('x'.repeat(65536))
  expect(huge.statusCode).toBe(413)
  expect(huge.json()).toEqual({ ok: false, error: 'too_large' })
})

it('consumes a token only once even when two requests arrive together', async () => {
  await seed('a')
  const signed = token()
  const responses = await Promise.all([wipe(signed), wipe(signed)])
  expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409])
})

it('leaves active work intact and releases the nonce for retry', async () => {
  await seed('a')
  await db.run("UPDATE render_jobs SET status = 'running' WHERE id = 'a'")
  const signed = token()
  expect((await wipe(signed)).statusCode).toBe(500)
  expect(await runtime.storage.exists('a/render.mp4')).toBe(true)
  await db.run("UPDATE render_jobs SET status = 'completed' WHERE id = 'a'")
  expect((await wipe(signed)).statusCode).toBe(200)
})

it('keeps rows and releases the nonce if storage refuses deletion', async () => {
  await seed('a')
  const signed = token()
  const remove = vi.spyOn(runtime.storage, 'delete').mockRejectedValueOnce(new Error('storage unavailable'))
  expect((await wipe(signed)).json()).toEqual({ ok: false, error: 'failed' })
  expect(await db.get("SELECT id FROM users WHERE id = 'a'")).toEqual({ id: 'a' })
  remove.mockRestore()
  expect((await wipe(signed)).statusCode).toBe(200)
})
