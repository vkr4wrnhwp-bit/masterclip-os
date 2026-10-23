import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Runtime } from '@masterclip/runtime'
import { signSuiteProof } from '@masterclip/auth'
import { AppError, sha256Hex } from '@masterclip/shared'
import { SongVersionRepo } from '@masterclip/song-lab-domain'
import { SongJourneyLinkRepo } from '@masterclip/song-journey-domain'
import { requireAuth, SESSION_COOKIE } from './server.js'
import { requireSongLab } from './routes/song-lab/helpers.js'

const LIMIT = 200 * 1024 * 1024
const fail = (message: string) => new AppError({ kind: 'validation', code: 'song_lab.handoff', message })
type Wire = Record<string, unknown> & { tenant: string; jobId: string; versionId: string; sourceSha256: string; state: string; sequence: number; eventId: string; result: VaultReceipt; error: string }
interface Identity { tenant: string; email: string }
export interface VaultReceipt { fileId: string; versionId: string; sha256: string; bytes: number }

export function signRackMessage(data: Record<string, unknown>, secret: string, audience: string, now = Math.floor(Date.now() / 1000)): string {
  if (!secret) throw fail('The hand-off signing key is not configured.')
  const body = Buffer.from(JSON.stringify({ ...data, v: 1, aud: audience, iat: now, exp: now + 120 })).toString('base64url')
  const signed = `v1.${body}`
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('hex')}`
}
export function verifyRackMessage(token: string, secret: string, audience: string, now = Math.floor(Date.now() / 1000)): Wire {
  if (!secret || typeof token !== 'string' || token.length > 20000) throw fail('Invalid hand-off receipt.')
  const [version, body, mac, extra] = token.split('.')
  if (version !== 'v1' || !body || !mac || extra) throw fail('Invalid hand-off receipt.')
  const expected = createHmac('sha256', secret).update(`v1.${body}`).digest('hex')
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw fail('Invalid hand-off signature.')
  let data: Wire
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString()) as Wire } catch { throw fail('Invalid hand-off receipt.') }
  if (data.v !== 1 || data.aud !== audience || !data.tenant || !Number.isInteger(data.exp) || !Number.isInteger(data.iat)
    || Number(data.exp) <= now || Number(data.iat) > now + 30 || Number(data.exp) - Number(data.iat) > 300) throw fail('Expired or invalid hand-off receipt.')
  return data
}
function origin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw fail('Use the configured HTTPS Street Banker origin.')
  return url.origin
}
async function checked(response: Response): Promise<Response> {
  if (!response.ok) throw fail(`The Street Banker hand-off was refused (${response.status}). Your source is unchanged.`)
  return response
}
async function bounded(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > LIMIT || !response.body) throw fail('Vault file exceeds the hand-off limit.')
  const chunks: Uint8Array[] = []; let size = 0
  const reader = response.body.getReader()
  while (true) { const next = await reader.read(); if (next.done) break; const chunk = next.value; size += chunk.length; if (size > LIMIT) { await reader.cancel(); throw fail('Vault file exceeds the hand-off limit.') }; chunks.push(chunk) }
  return Buffer.concat(chunks)
}

export function approveRackCost(body: { brief?: string; approved?: boolean; costConsent?: boolean; maxCostCents?: number }): string {
  const brief = typeof body?.brief === 'string' ? body.brief.trim() : ''
  if (body?.approved !== true || body.costConsent !== true || body.maxCostCents !== 0 || !brief || brief.length > 4000) throw fail('Approve this version, brief and the $0 manual Rack hand-off. Paid work is not authorized.')
  return brief
}

export class SongLabHandoffs {
  constructor(readonly runtime: Runtime, readonly peer: typeof fetch = fetch) {}
  private get config() { return this.runtime.config }
  async identity(request: FastifyRequest): Promise<Identity> {
    const auth = await requireAuth(this.runtime, request)
    const row = await this.runtime.db.get('SELECT * FROM song_lab_suite_sessions WHERE token_hash = ? AND org_id = ? AND user_id = ? AND expires_at > ?',
      [sha256Hex(request.cookies[SESSION_COOKIE] ?? ''), auth.orgId, auth.userId, this.runtime.clock.isoNow()])
    if (!row) throw fail('Open Song Lab through Street Banker before using these doors.')
    return { tenant: String(row.tenant_uid), email: String(row.email) }
  }
  private async bearer(identity: Identity, scope: 'read' | 'deliver'): Promise<string> {
    const proof = signSuiteProof({ email: identity.email, suite: 'song-lab', scope, nonce: randomBytes(16).toString('hex'), tenantUid: identity.tenant }, this.config.SUITE_SSO_SECRET_SONG_LAB)
    const response = await checked(await this.peer(`${origin(this.config.STREET_BANKER_URL)}/suites/token?suite=song-lab&scope=${scope}`, { headers: { authorization: `Suite ${proof}` }, redirect: 'error', signal: AbortSignal.timeout(15000) }))
    const data = await response.json() as { uid: string; token: string }
    if (data.uid !== identity.tenant || !data.token) throw fail('The Vault account does not match this workspace.')
    return data.token
  }
  async verifyVault(identity: Identity, receipt: VaultReceipt): Promise<Uint8Array> {
    if (!receipt || !receipt.fileId || !receipt.versionId || !/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.bytes <= 0 || receipt.bytes > LIMIT) throw fail('The Vault returned an incomplete receipt.')
    const token = await this.bearer(identity, 'read')
    const path = `/api/vault/files/${encodeURIComponent(receipt.fileId)}/versions/${encodeURIComponent(receipt.versionId)}/content`
    const response = await checked(await this.peer(`${origin(this.config.STREET_BANKER_URL)}${path}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(120000) }))
    const bytes = await bounded(response)
    if (bytes.length !== receipt.bytes || createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw fail('The Vault result checksum does not match its actual bytes.')
    return bytes
  }
  async saveBytes(orgId: string, identity: Identity, bytes: Uint8Array, filename: string, label: string): Promise<VaultReceipt> {
    if (!this.config.SONG_LAB_SUITE_ENABLED || !this.config.SONG_LAB_SUITE_VAULT_HANDOFF_ENABLED) throw fail('Vault hand-off is not enabled.')
    if (!bytes.length || bytes.length > LIMIT) throw fail('Choose an audio file no larger than 200 MB.')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const existing = await this.runtime.db.get('SELECT receipt_json FROM song_lab_vault_receipts WHERE org_id = ? AND sha256 = ?', [orgId, sha256])
    if (existing) { const receipt = JSON.parse(String(existing.receipt_json)) as VaultReceipt; await this.verifyVault(identity, receipt); return receipt }
    const token = await this.bearer(identity, 'deliver')
    const form = new FormData()
    form.set('file', new Blob([Uint8Array.from(bytes).buffer]), filename); form.set('kind', /\.zip$/i.test(filename) ? 'archive' : /\.(json|md)$/i.test(filename) ? 'project' : /\.pdf$/i.test(filename) ? 'document' : /\.(mp4|mov|webm)$/i.test(filename) ? 'video' : /\.(png|jpe?g|webp|gif)$/i.test(filename) ? 'image' : 'audio'); form.set('label', label); form.set('source', 'song-lab')
    const response = await checked(await this.peer(`${origin(this.config.STREET_BANKER_URL)}/api/vault/deliver`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, redirect: 'error', signal: AbortSignal.timeout(120000) }))
    const data = await response.json() as { id: string; version_id: string; sha256: string }
    const receipt = { fileId: data.id, versionId: data.version_id, sha256: data.sha256, bytes: bytes.length }
    if (receipt.sha256 !== sha256) throw fail('The Vault saved a different checksum; no completed save is recorded.')
    await this.verifyVault(identity, receipt)
    await this.runtime.db.run('INSERT INTO song_lab_vault_receipts (org_id, sha256, receipt_json) VALUES (?, ?, ?) ON CONFLICT (org_id,sha256) DO NOTHING', [orgId, sha256, JSON.stringify(receipt)])
    return receipt
  }
  async saveAsset(orgId: string, identity: Identity, assetId: string): Promise<VaultReceipt> {
    const asset = await this.runtime.audio.repos.assets.get(orgId, assetId)
    const bytes = await this.runtime.storage.getBuffer(asset.storageKey)
    if (sha256Hex(Buffer.from(bytes)) !== asset.checksum) throw fail('The source asset checksum changed.')
    return this.saveBytes(orgId, identity, bytes, asset.fileName, asset.fileName)
  }
  async applyReceipt(token: string): Promise<{ seen?: boolean; state: string }> {
    const data = verifyRackMessage(token, this.config.SONG_LAB_SUITE_HANDOFF_SIGNING_KEY, 'song-lab-rack-receipt')
    const row = await this.runtime.db.get('SELECT * FROM song_lab_rack_handoffs WHERE id = ? AND tenant_uid = ?', [data.jobId, data.tenant])
    if (!row || row.version_id !== data.versionId || row.source_sha256 !== data.sourceSha256) throw fail('Receipt does not match this tenant and source version.')
    if (!['pending', 'failed', 'completed'].includes(String(data.state)) || !Number.isInteger(data.sequence) || Number(data.sequence) < 1 || data.eventId !== `${data.jobId}:${data.sequence}`) throw fail('Invalid receipt state.')
    if (Number(data.sequence) <= Number(row.sequence) || row.state === 'completed' || row.state === 'failed') return { seen: true, state: String(row.state) }
    if (data.state === 'completed') await this.verifyVault({ tenant: data.tenant, email: String(row.actor_email) }, data.result as VaultReceipt)
    return this.runtime.db.transaction(async tx => {
      const saved = await tx.run('UPDATE song_lab_rack_handoffs SET state=?, sequence=?, receipt_json=?, error=? WHERE id=? AND tenant_uid=? AND sequence < ? AND state = ?',
        [data.state, data.sequence, JSON.stringify(data), String(data.error ?? '').slice(0, 400), data.jobId, data.tenant, data.sequence, 'pending'])
      if (!saved.changes) { const current = await tx.get('SELECT state FROM song_lab_rack_handoffs WHERE id=? AND tenant_uid=?', [data.jobId, data.tenant]); return { seen: true, state: String(current?.state ?? row.state) } }
      return { state: String(data.state) }
    })
  }
  async dispatch(id: string, orgId: string): Promise<void> {
    const row = await this.runtime.db.get('SELECT * FROM song_lab_rack_handoffs WHERE id=? AND org_id=?', [id, orgId])
    if (!row) throw fail('Hand-off not found.')
    const identity = { tenant: String(row.tenant_uid), email: String(row.actor_email) }
    const bearer = await this.bearer(identity, 'read')
    const signed = signRackMessage(JSON.parse(String(row.request_json)), this.config.SONG_LAB_SUITE_HANDOFF_SIGNING_KEY, 'v1-rack-request')
    const response = await checked(await this.peer(`${origin(this.config.SONG_LAB_SUITE_RACK_URL || this.config.STREET_BANKER_URL)}/api/suites/song-lab/rack`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ token: signed }), redirect: 'error', signal: AbortSignal.timeout(15000) }))
    const receipt = await response.json() as { token: string }
    await this.applyReceipt(receipt.token)
    await this.runtime.db.run("UPDATE song_lab_rack_handoffs SET error = ? WHERE id=? AND org_id=? AND state='pending'", ['', id, orgId])
  }
}

export async function mirrorSongLabUpload(runtime: Runtime, request: FastifyRequest, bytes: Uint8Array, filename: string): Promise<void> {
  if (!runtime.config.SONG_LAB_SUITE_ENABLED || !runtime.config.SONG_LAB_SUITE_VAULT_HANDOFF_ENABLED) return
  const service = new SongLabHandoffs(runtime)
  const actor = await requireAuth(runtime, request)
  await service.saveBytes(actor.orgId, await service.identity(request), bytes, filename, filename)
}

export async function registerSongLabHandoffs(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const service = new SongLabHandoffs(runtime)
  app.get('/api/song-journey/handoffs/config', async request => {
    await requireSongLab(runtime, request, 'song_lab.access')
    return { vault: runtime.config.SONG_LAB_SUITE_ENABLED && runtime.config.SONG_LAB_SUITE_VAULT_HANDOFF_ENABLED,
      rack: runtime.config.SONG_LAB_SUITE_ENABLED && runtime.config.SONG_LAB_SUITE_RACK_HANDOFF_ENABLED }
  })
  app.post('/api/webhooks/song-lab-rack', async request => {
    if (!runtime.config.SONG_LAB_SUITE_ENABLED || !runtime.config.SONG_LAB_SUITE_RACK_HANDOFF_ENABLED) throw fail('Rack hand-off is not enabled.')
    return service.applyReceipt((request.body as { token?: string })?.token ?? '')
  })
  app.get('/api/song-journey/links/:id/handoffs', async request => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    await new SongJourneyLinkRepo(runtime.db, runtime.clock).get(actor.orgId, id)
    const rows = await runtime.db.query('SELECT id,state,version_id,brief,error,receipt_json FROM song_lab_rack_handoffs WHERE org_id=? AND link_id=? ORDER BY created_at DESC', [actor.orgId, id])
    return { handoffs: rows.map(row => ({ id: row.id, state: row.state, versionId: row.version_id, brief: row.brief, error: row.error,
      result: row.receipt_json ? (JSON.parse(String(row.receipt_json)) as { result?: VaultReceipt }).result : null,
      rackUrl: `${origin(runtime.config.SONG_LAB_SUITE_RACK_URL || runtime.config.STREET_BANKER_URL)}/rack?handoff=${encodeURIComponent(String(row.id))}` })) }
  })
  app.post('/api/song-journey/links/:id/vault', async request => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    const { id } = request.params as { id: string }
    const link = await new SongJourneyLinkRepo(runtime.db, runtime.clock).get(actor.orgId, id)
    if (!link.selectedSongVersionId) throw fail('Choose an exact Song Lab version first.')
    if ((request.body as { versionId?: string })?.versionId !== link.selectedSongVersionId) throw fail('Save this exact version selection before sending it.')
    const version = await new SongVersionRepo(runtime.db, runtime.clock).get(actor.orgId, link.selectedSongVersionId)
    if (!version.sourceAssetId) throw fail('The selected version has no audio.')
    return service.saveAsset(actor.orgId, await service.identity(request), version.sourceAssetId)
  })
  app.post('/api/song-journey/links/:id/rack', async request => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    if (!runtime.config.SONG_LAB_SUITE_ENABLED || !runtime.config.SONG_LAB_SUITE_RACK_HANDOFF_ENABLED) throw fail('Send to The Rack: coming next')
    const identity = await service.identity(request)
    const { id } = request.params as { id: string }
    const link = await new SongJourneyLinkRepo(runtime.db, runtime.clock).get(actor.orgId, id)
    const body = request.body as { brief?: string; approved?: boolean; costConsent?: boolean; maxCostCents?: number }
    const brief = approveRackCost(body)
    if (!link.selectedSongVersionId) throw fail('Choose an exact version first.')
    if ((request.body as { versionId?: string })?.versionId !== link.selectedSongVersionId) throw fail('Save this exact version selection before sending it.')
    const version = await new SongVersionRepo(runtime.db, runtime.clock).get(actor.orgId, link.selectedSongVersionId)
    if (version.songLabProjectId !== link.songLabProjectId || !version.sourceAssetId) throw fail('The selected version has no accessible source audio.')
    const vault = await service.saveAsset(actor.orgId, identity, version.sourceAssetId)
    const jobId = `slr_${sha256Hex(JSON.stringify([identity.tenant, version.id, vault.sha256, brief, 0])).slice(0, 40)}`
    const spec = { tenant: identity.tenant, jobId, versionId: version.id, vaultFileId: vault.fileId, vaultVersionId: vault.versionId, sourceSha256: vault.sha256, brief, approved: true, maxCostCents: 0, costConsent: true }
    await runtime.db.run(`INSERT INTO song_lab_rack_handoffs (id,org_id,tenant_uid,actor_email,link_id,version_id,source_sha256,brief,request_json,state,sequence,error,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',0,'',?) ON CONFLICT (id) DO NOTHING`, [jobId, actor.orgId, identity.tenant, identity.email, id, version.id, vault.sha256, brief, JSON.stringify(spec), runtime.clock.isoNow()])
    try { await service.dispatch(jobId, actor.orgId) } catch (error) { await runtime.db.run('UPDATE song_lab_rack_handoffs SET error=? WHERE id=? AND org_id=?', ['The Rack has not acknowledged this request. Retry the same request; no paid job is created.', jobId, actor.orgId]); throw error }
    return { id: jobId }
  })
  app.get('/api/song-journey/handoffs/:id/result', async (request, reply) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const row = await runtime.db.get('SELECT receipt_json,state FROM song_lab_rack_handoffs WHERE id=? AND org_id=?', [(request.params as { id: string }).id, actor.orgId])
    if (!row || row.state !== 'completed') throw fail('No completed result is available.')
    const result = (JSON.parse(String(row.receipt_json)) as { result: VaultReceipt }).result
    const bytes = await service.verifyVault(await service.identity(request), result)
    return reply.header('cache-control', 'private, no-store').type('application/octet-stream').send(Buffer.from(bytes))
  })
  app.post('/api/song-journey/handoffs/:id/refresh', async request => {
    const actor = await requireSongLab(runtime, request, 'song_lab.analysis')
    if (!runtime.config.SONG_LAB_SUITE_RACK_HANDOFF_ENABLED) throw fail('Rack hand-off is not enabled.')
    await service.dispatch((request.params as { id: string }).id, actor.orgId)
    return { ok: true }
  })
}
