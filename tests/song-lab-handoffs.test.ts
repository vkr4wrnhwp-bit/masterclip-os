import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '@masterclip/database'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, sha256Hex, silentLogger } from '@masterclip/shared'
import { buildServer } from '../apps/api/src/server.js'
import { approveRackCost, signRackMessage, verifyRackMessage, SongLabHandoffs } from '../apps/api/src/song-lab-handoffs.js'

const SECRET = 'fixture-handoff-signing-key'
const identity = { tenant: 'parent-artist', email: 'artist@example.test' }
const bytes = new Uint8Array([82,73,70,70,1,2,3,4,87,65,86,69])
const receipt = { fileId: 'vf_source', versionId: 'vv_source', sha256: sha256Hex(bytes), bytes: bytes.length }
const spec = { tenant: identity.tenant, jobId: 'slr_' + '1'.repeat(40), versionId: 'song-version-1', sourceSha256: receipt.sha256,
  vaultFileId: receipt.fileId, vaultVersionId: receipt.versionId, brief: 'Preserve the vocal.', approved: true, costConsent: true, maxCostCents: 0 }
const event = (state = 'completed', sequence = 2, changes = {}) => ({ ...spec, state, sequence, eventId: `${spec.jobId}:${sequence}`, result: receipt, ...changes })
let runtime: Runtime, root: string, service: SongLabHandoffs, calls: string[], wrongBytes = false, failPeer = false
const jobs = new Map<string, string>()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'songlab-handoffs-'))
  const config = loadConfig({ NODE_ENV: 'test', SONG_LAB_SUITE_ENABLED: '1', SONG_LAB_SUITE_VAULT_HANDOFF_ENABLED: '1', SONG_LAB_SUITE_RACK_HANDOFF_ENABLED: '1', SONG_LAB_SUITE_HANDOFF_SIGNING_KEY: SECRET, SUITE_SSO_SECRET_SONG_LAB: 'fixture-suite-key', STREET_BANKER_URL: 'https://parent.example.test', ASSET_SIGNING_SECRET: 'fixture-storage', SESSION_SECRET: 'fixture-session' }, true)
  runtime = await createRuntime({ config, db: await createTestDb(), logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root, signingSecret: 'fixture-storage' }) })
  await runtime.db.run('INSERT INTO orgs (id,name,created_at) VALUES (?,?,?)', ['org-handoff', 'Test', runtime.clock.isoNow()])
  await runtime.db.run(`INSERT INTO song_lab_rack_handoffs (id,org_id,tenant_uid,actor_email,link_id,version_id,source_sha256,brief,request_json,state,sequence,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',0,'',?)`, [spec.jobId, 'org-handoff', identity.tenant, identity.email, 'link-test', spec.versionId, receipt.sha256, spec.brief, JSON.stringify(spec), runtime.clock.isoNow()])
  calls = []; jobs.clear(); wrongBytes = false; failPeer = false
  const peer: typeof fetch = async (input, options) => {
    const url = String(input); calls.push(url)
    if (failPeer) return new Response('{}', { status: 503 })
    if (url.includes('/suites/token')) return Response.json({ uid: identity.tenant, token: 'fixture-bearer' })
    if (url.endsWith('/api/vault/deliver')) return Response.json({ id: receipt.fileId, version_id: receipt.versionId, sha256: receipt.sha256 })
    if (url.endsWith('/content')) return new Response(wrongBytes ? new Uint8Array([1]) : bytes)
    if (url.endsWith('/api/suites/song-lab/rack')) {
      const data = verifyRackMessage((JSON.parse(String(options?.body)) as { token: string }).token, SECRET, 'v1-rack-request')
      const encoded = JSON.stringify([data.tenant, data.versionId, data.sourceSha256, data.brief])
      if (jobs.has(data.jobId) && jobs.get(data.jobId) !== encoded) return new Response('{}', { status: 409 })
      jobs.set(data.jobId, encoded)
      return Response.json({ token: signRackMessage(event('pending', 1, { result: null }), SECRET, 'song-lab-rack-receipt') })
    }
    throw new Error('Unexpected fake peer route: ' + url)
  }
  service = new SongLabHandoffs(runtime, peer)
})
afterEach(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })

describe('expiring tenant-bound Rack protocol', () => {
  it('rejects a forged signature, wrong direction and expiry', () => {
    const token = signRackMessage(event(), SECRET, 'song-lab-rack-receipt', 1000)
    expect(() => verifyRackMessage(token, SECRET, 'song-lab-rack-receipt', 1121)).toThrow()
    expect(() => verifyRackMessage(token, SECRET, 'v1-rack-request', 1001)).toThrow()
    expect(() => verifyRackMessage(token + 'f', SECRET, 'song-lab-rack-receipt', 1001)).toThrow()
    expect(() => verifyRackMessage(token, 'wrong', 'song-lab-rack-receipt', 1001)).toThrow()
  })
  it('defaults both doors off', () => {
    const config = loadConfig({}, true)
    expect(config.SONG_LAB_SUITE_RACK_HANDOFF_ENABLED).toBe(false)
    expect(config.SONG_LAB_SUITE_VAULT_HANDOFF_ENABLED).toBe(false)
  })
  it.each([{}, { approved: true }, { approved: true, costConsent: true, maxCostCents: 1 }, { approved: true, costConsent: false, maxCostCents: 0 }])('requires explicit brief/cost consent: %j', body => {
    expect(() => approveRackCost({ brief: 'Work', ...body })).toThrow()
  })
  it('accepts the approved zero-cost manual path only', () => expect(approveRackCost({ brief: ' Work ', approved: true, costConsent: true, maxCostCents: 0 })).toBe('Work'))
  it('saves through signed Vault doors and verifies actual pinned bytes', async () => {
    expect(await service.saveBytes('org-handoff', identity, bytes, 'song.wav', 'Song')).toEqual(receipt)
    await service.saveBytes('org-handoff', identity, bytes, 'song.wav', 'Song')
    expect(calls.filter(url => url.endsWith('/api/vault/deliver'))).toHaveLength(1)
    expect(calls.some(url => url.includes('/versions/vv_source/content'))).toBe(true)
  })
  it('never records a completed Vault save for mismatched bytes', async () => {
    wrongBytes = true
    await expect(service.saveBytes('org-handoff', identity, bytes, 'song.wav', 'Song')).rejects.toThrow('checksum')
    expect(await runtime.db.get('SELECT * FROM song_lab_vault_receipts')).toBeUndefined()
  })
  it('retry/duplicate dispatch creates one peer job and never spends', async () => {
    await service.dispatch(spec.jobId, 'org-handoff'); await service.dispatch(spec.jobId, 'org-handoff')
    expect(jobs.size).toBe(1)
    expect((await runtime.db.get('SELECT state FROM song_lab_rack_handoffs'))?.state).toBe('pending')
  })
  it('rejects a wrong tenant, source version, source checksum and event identity', async () => {
    for (const changes of [{ tenant: 'someone-else' }, { versionId: 'other' }, { sourceSha256: '0'.repeat(64) }, { eventId: 'reused-nonce' }]) {
      await expect(service.applyReceipt(signRackMessage(event('completed', 2, changes), SECRET, 'song-lab-rack-receipt'))).rejects.toThrow()
    }
  })
  it('verifies completion once and ignores a replay or out-of-order pending receipt', async () => {
    const token = signRackMessage(event(), SECRET, 'song-lab-rack-receipt')
    expect(await service.applyReceipt(token)).toEqual({ state: 'completed' })
    const count = calls.length
    expect((await service.applyReceipt(token)).seen).toBe(true)
    expect((await service.applyReceipt(signRackMessage(event('pending', 1), SECRET, 'song-lab-rack-receipt'))).state).toBe('completed')
    expect(calls).toHaveLength(count)
  })
  it('keeps failures distinct and never revives a terminal failed job', async () => {
    await service.applyReceipt(signRackMessage(event('failed', 2, { result: null, error: 'Artist stopped' }), SECRET, 'song-lab-rack-receipt'))
    expect((await service.applyReceipt(signRackMessage(event('completed', 3), SECRET, 'song-lab-rack-receipt'))).state).toBe('failed')
    await service.dispatch(spec.jobId, 'org-handoff')
    expect((await runtime.db.get('SELECT error FROM song_lab_rack_handoffs'))?.error).toBe('Artist stopped')
  })
  it('keeps a peer outage pending and permits a later verified retry', async () => {
    failPeer = true
    await expect(service.dispatch(spec.jobId, 'org-handoff')).rejects.toThrow()
    expect((await runtime.db.get('SELECT state FROM song_lab_rack_handoffs'))?.state).toBe('pending')
    failPeer = false
    await service.dispatch(spec.jobId, 'org-handoff')
    expect(jobs.size).toBe(1)
  })
  it('does not complete on a bad result checksum', async () => {
    wrongBytes = true
    await expect(service.applyReceipt(signRackMessage(event(), SECRET, 'song-lab-rack-receipt'))).rejects.toThrow('checksum')
    expect((await runtime.db.get('SELECT state FROM song_lab_rack_handoffs'))?.state).toBe('pending')
  })
})


it('the callback HTTP door rejects browser claims and accepts only the signed peer event', async () => {
  const app = await buildServer({ runtime })
  try {
    const forged = await app.inject({ method: 'POST', url: '/api/webhooks/song-lab-rack', payload: { token: 'browser-says-completed', state: 'completed' } })
    expect(forged.statusCode).toBe(400)
    expect((await runtime.db.get('SELECT state FROM song_lab_rack_handoffs'))?.state).toBe('pending')
    const signed = signRackMessage(event('pending', 1, { result: null }), SECRET, 'song-lab-rack-receipt')
    const accepted = await app.inject({ method: 'POST', url: '/api/webhooks/song-lab-rack', payload: { token: signed } })
    expect(accepted.statusCode).toBe(200)
  } finally { await app.close() }
})
