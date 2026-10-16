import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { WipeRejected, verifySuiteWipe } from '@masterclip/auth'
import type { Runtime } from '@masterclip/runtime'
import type { Db, SqlParam } from '@masterclip/database'
import { motionSuiteSecret } from '../vault-door.js'

/** Account-independent receipts survive deletion and prevent replay after a restart. */
export async function registerAccountWipe(app: FastifyInstance, runtime: Runtime): Promise<void> {
  // SQLite's nested transaction helper joins an open transaction. Two wipe
  // requests must not accidentally join each other while storage is awaited.
  let tail: Promise<unknown> = Promise.resolve()
  app.post('/api/street-banker/wipe', {
    bodyLimit: 64 * 1024,
    errorHandler(error, _request, reply) {
      return reply.code(error.statusCode === 413 ? 413 : 400).send({ ok: false, error: error.statusCode === 413 ? 'too_large' : 'malformed' })
    },
  }, async (request, reply) => {
    const secret = motionSuiteSecret()
    if (!secret) return reply.code(503).send({ ok: false, error: 'not_configured' })
    let who
    try { who = verifySuiteWipe((request.body as { token?: unknown } | null)?.token, secret) }
    catch (e) { return reply.code(401).send({ ok: false, error: e instanceof WipeRejected ? e.reason : 'bad signature' }) }
    const nonce = createHash('sha256').update(who.nonce).digest('hex')
    try {
      const pending = tail.then(() => runtime.db.transaction(async tx => {
        const receipt = await tx.run('INSERT INTO suite_wipe_receipts (nonce_hash, used_at) VALUES (?, ?) ON CONFLICT (nonce_hash) DO NOTHING', [nonce, new Date().toISOString()])
        if (!receipt.changes) return null
        return wipeAccount(tx, runtime, who.uid, who.email)
      }))
      tail = pending.catch(() => undefined)
      const result = await pending
      if (!result) return reply.code(409).send({ ok: false, error: 'used' })
      return { ok: true, uid: who.uid, ...result, total: Object.values(result.counts).reduce((a, b) => a + b, 0) }
    } catch {
      // Rollback also releases the nonce, as in V2. Retained rows allow the sender to retry.
      runtime.logger.error('account.wipe.failed', {})
      return reply.code(500).send({ ok: false, error: 'failed' })
    }
  })
}

async function wipeAccount(db: Db, runtime: Runtime, uid: string, email: string) {
  const account = await db.get('SELECT u.*, o.street_banker_identity FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.email = ?', [email])
  const counts: Record<string, number> = {}
  if (!account) return { found: false, counts }
  const userId = String(account.id), orgId = String(account.org_id), identity = account.street_banker_identity
  if (identity && identity !== `uid:${uid}` && identity !== `email:${email}`) throw Error('Identity mismatch')
  const others = await db.get('SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND id <> ?', [orgId, userId])
  const ownOrg = Boolean(identity) && Number(others?.n) === 0
  const projects = await db.query<{ id: string }>(ownOrg ? 'SELECT id FROM projects WHERE org_id = ?' :
    "SELECT p.id FROM projects p WHERE p.org_id = ? AND EXISTS (SELECT 1 FROM audit_log a WHERE a.target_type = 'project' AND a.target_id = p.id AND a.action = 'project.created' AND a.actor = ?)", ownOrg ? [orgId] : [orgId, userId])
  const ids = projects.map(p => p.id)
  const remove = async (table: string, where: string, params: SqlParam[]) => {
    counts[table] = (counts[table] ?? 0) + (await db.run(`DELETE FROM ${table} WHERE ${where}`, params)).changes
  }
  for (const id of ids) {
    // Never erase underneath a renderer/finisher. The sender receives a failure and can retry.
    const busy = await db.get("SELECT id FROM render_jobs WHERE project_id = ? AND status NOT IN ('completed','failed','cancelled','queued','pending','blocked')", [id])
    const finish = await db.get('SELECT l.master_id FROM media_finish_leases l JOIN masters m ON m.id = l.master_id WHERE m.project_id = ? AND l.expires_at > ?', [id, new Date().toISOString()])
    if (busy || finish) throw Error('Work is active')
    const jobs = await db.query<{ id: string; external_job_id: string | null; provider_id: string }>('SELECT id, external_job_id, provider_id FROM render_jobs WHERE project_id = ?', [id])
    const masters = await db.query<{ id: string }>('SELECT id FROM masters WHERE project_id = ?', [id])
    const outputs = await db.query<{ id: string }>('SELECT id FROM outputs WHERE project_id = ?', [id])
    const targets = new Set([id, ...jobs.map(j => j.id), ...masters.map(m => m.id), ...outputs.map(o => o.id)])
    for (const table of ['queue_jobs', 'queue_dead']) {
      for (const row of await db.query(`SELECT * FROM ${table}`)) {
        const payload = JSON.parse(String(row.payload)) as Record<string, unknown>
        if (!payload || !['projectId','jobId','masterId','outputId'].some(k => typeof payload[k] === 'string' && targets.has(payload[k] as string))) continue
        if (table === 'queue_jobs') {
          const locked = await db.get('SELECT status FROM queue_jobs WHERE id = ?' + (db.dialect === 'postgres' ? ' FOR UPDATE' : ''), [String(row.id)])
          if (locked?.status === 'active') throw Error('Queue work is active')
        }
        await remove(table, 'id = ?', [String(row.id)])
      }
    }
    for (const job of jobs) if (job.external_job_id) await remove('webhook_events', 'provider_id = ? AND external_id = ?', [job.provider_id, job.external_job_id])
    // Include orphaned upload/render objects under this exact project prefix, not other projects.
    const prefix = `${id}/`
    const keys = new Set(await runtime.storage.list(prefix))
    for (const asset of await db.query<{ storage_key: string }>('SELECT storage_key FROM assets WHERE project_id = ?', [id])) keys.add(asset.storage_key)
    const linked = await db.get('SELECT l.child_asset_id FROM asset_lineage l JOIN assets c ON c.id = l.child_asset_id JOIN assets p ON p.id = l.parent_asset_id WHERE (c.project_id = ? AND p.project_id <> ?) OR (p.project_id = ? AND c.project_id <> ?)', [id,id,id,id])
    if (linked) throw Error('Cross-project asset requires review')
    for (const key of keys) {
      if (!key.startsWith(prefix)) throw Error('Object outside project')
      const shared = await db.get('SELECT id FROM assets WHERE storage_key = ? AND project_id <> ?', [key, id])
      if (shared) throw Error('Shared object requires review')
      await runtime.storage.delete(key); counts.files = (counts.files ?? 0) + 1
    }
    const output = 'output_id IN (SELECT o.id FROM outputs o JOIN render_jobs j ON j.id = o.job_id WHERE j.project_id = ?)'
    for (const t of ['reviews','output_qc']) await remove(t, output, [id])
    await remove('media_finish_leases', 'master_id IN (SELECT id FROM masters WHERE project_id = ?)', [id])
    await remove('master_deliverables', 'master_id IN (SELECT id FROM masters WHERE project_id = ?)', [id])
    await remove('masters', 'project_id = ?', [id])
    await remove('outputs', 'job_id IN (SELECT id FROM render_jobs WHERE project_id = ?)', [id])
    await remove('render_attempts', 'job_id IN (SELECT id FROM render_jobs WHERE project_id = ?)', [id])
    await remove('render_jobs', 'project_id = ?', [id])
    for (const t of ['budgets','budget_events']) await remove(t, "scope = 'batch' AND scope_id IN (SELECT id FROM render_batches WHERE project_id = ?)", [id])
    await remove('render_batches', 'project_id = ?', [id])
    await remove('motion_timeline_exports', 'timeline_id IN (SELECT id FROM motion_music_timelines WHERE project_id = ?)', [id])
    for (const t of ['motion_music_timelines','motion_music_sections']) await remove(t, 'project_id = ?', [id])
    await remove('provider_asset_cache', 'asset_id IN (SELECT id FROM assets WHERE project_id = ?)', [id])
    await remove('asset_lineage', 'child_asset_id IN (SELECT id FROM assets WHERE project_id = ?) OR parent_asset_id IN (SELECT id FROM assets WHERE project_id = ?)', [id,id])
    await remove('assets', 'project_id = ?', [id])
    for (const [version, parent, column] of [['shot_versions','shots','shot_id'],['character_versions','characters','character_id'],['environment_versions','environments','environment_id']]) await remove(version!, `${column} IN (SELECT id FROM ${parent} WHERE project_id = ?)`, [id])
    for (const t of ['budgets','budget_events']) await remove(t, "(scope = 'project' AND scope_id = ?) OR (scope = 'shot' AND scope_id IN (SELECT id FROM shots WHERE project_id = ?)) OR (scope = 'scene' AND scope_id IN (SELECT id FROM scenes WHERE project_id = ?))", [id,id,id])
    for (const t of ['price_quotes','cost_ledger','agent_runs','model_performance','rejection_stats','audit_log','project_members','shots','scenes','characters','environments']) await remove(t, 'project_id = ?', [id])
    await remove('projects', 'id = ?', [id])
  }
  for (const t of ['sessions','project_members']) await remove(t, 'user_id = ?', [userId])
  for (const t of ['cost_ledger','agent_runs']) await remove(t, 'created_by = ?', [userId])
  await remove('audit_log', 'actor = ?', [userId])
  await remove('users', 'id = ?', [userId])
  if (ownOrg) {
    for (const t of ['provider_credentials','cost_ledger','audit_log']) await remove(t, 'org_id = ?', [orgId])
    for (const t of ['budgets','budget_events']) await remove(t, "scope = 'org' AND scope_id = ?", [orgId])
    await remove('orgs', 'id = ?', [orgId])
  }
  return { found: true, counts }
}
