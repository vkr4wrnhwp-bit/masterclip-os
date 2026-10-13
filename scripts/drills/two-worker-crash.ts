/**
 * Two-worker crash drill (MOTION release gate).
 *
 * Two real worker processes, built the way production builds them, share one
 * SQLite database and one storage folder. Six sandbox renders are queued. The
 * moment worker A is in the middle of heavy media work it is killed outright
 * (no shutdown handler runs). Worker B must then finish every render, with no
 * render stuck part-way, no duplicate outputs and no duplicate charges.
 *
 *   node --import tsx scripts/drills/two-worker-crash.ts
 *
 * Nothing here can spend: MASTERCLIP_MODE=sandbox and only the mock provider is
 * used. Everything lives in a temp folder that is removed afterwards unless
 * DRILL_KEEP=1.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { build } from 'esbuild'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { toNum } from '@masterclip/database'
import { emptyShot } from '@masterclip/shot-schema'
import { createRuntime, RenderService } from '@masterclip/runtime'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RENDERS = Number(process.env.DRILL_RENDERS ?? 6)
const LEASE_SECONDS = Number(process.env.DRILL_LEASE_SECONDS ?? 15)
const HEAVY = new Set(['render.poll', 'render.ingest', 'qc.technical', 'media.proxies'])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const say = (msg: string) => console.log(`${stamp()}  ${msg}`)

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'motion-crash-drill-'))
  const env: Record<string, string> = {
    NODE_ENV: 'development',
    LOG_LEVEL: 'debug',
    MASTERCLIP_MODE: 'sandbox',
    LIVE_SPEND_CAP_USD: '0',
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: join(dir, 'motion.sqlite'),
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_ROOT: join(dir, 'storage'),
    SESSION_SECRET: randomBytes(24).toString('hex'),
    ASSET_SIGNING_SECRET: randomBytes(24).toString('hex'),
    JOB_LEASE_SECONDS: String(LEASE_SECONDS),
    WORKER_CONCURRENCY: '2',
    WORKER_POLL_INTERVAL_MS: '250',
    PROVIDER_POLL_INTERVAL_MS: '1000',
    MIGRATION_BACKUP: 'off',
  }
  say(`drill folder ${dir}`)

  // --- the worker, bundled exactly as scripts/build.mjs bundles it ----------
  // Inside the repo's dist/ (ignored) so its external packages resolve as they
  // do in production.
  const workerJs = join(root, 'dist', 'drill-worker.js')
  await build({
    entryPoints: [join(root, 'apps/worker/src/main.ts')],
    outfile: workerJs,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['pg', 'pg-native', 'node:sqlite', 'fsevents'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  })

  // --- a project with one shot and six queued sandbox renders -----------------
  const config = loadConfig(env, true)
  const runtime = await createRuntime({ config, logger: silentLogger, mockOnly: true, workerId: 'drill-director' })
  const org = await runtime.projects.createOrg('Crash Drill')
  const project = await runtime.projects.create({ orgId: org.id, name: 'Crash Drill', createdBy: 'drill' })
  await runtime.cost.budgetStore.ensureDefaults('project', project.id)
  const created = await runtime.projects.createShot({
    projectId: project.id,
    createdBy: 'drill',
    spec: emptyShot({
      shot_id: 'S01',
      title: 'Crash drill',
      generation_mode: 'text_to_video',
      action: 'the camera drifts past a neon sign',
      camera_position: 'wide, eye level',
      camera_movement: 'slow push in',
      duration_seconds: 8,
      target_resolution: '720p',
      aspect_ratio: '16:9',
      max_cost_usd: 50,
    }),
  })
  const plan = await new RenderService(runtime).planBatch({
    projectId: project.id,
    shotId: created.shot.id,
    batchName: 'crash drill',
    createdBy: 'drill',
    orgId: org.id,
    candidates: Array.from({ length: RENDERS }, (_, i) => ({
      providerId: 'mock', modelId: 'mock-standard', seed: null,
      variationLabel: `v${i}`, variationInstruction: i === 0 ? '' : `variation ${i}`,
      resolution: '720p', aspectRatio: '16:9', durationSeconds: 8,
    })),
  })
  say(`queued ${plan.jobIds.length} renders`)
  const db = runtime.db

  // --- two workers ------------------------------------------------------------
  const start = (name: string): ChildProcess => {
    const log = createWriteStream(join(dir, `${name}.log`))
    const child = spawn(process.execPath, [workerJs], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.pipe(log)
    child.stderr!.pipe(log)
    say(`worker ${name} started, pid ${child.pid}`)
    return child
  }
  const a = start('A')
  const b = start('B')
  const workerA = `worker-${a.pid}`
  let exited: string | null = null
  let killedA = false
  a.once('exit', (code) => { if (!killedA) exited = `worker A exited on its own (code ${code}); see ${dir}\\A.log` })
  b.once('exit', (code) => { exited = `worker B exited (code ${code}); see ${dir}\\B.log` })
  process.once('exit', () => { a.kill('SIGKILL'); b.kill('SIGKILL') })

  // --- kill A in the middle of heavy work ---------------------------------------
  let heldAtKill: Array<{ id: string; job_type: string; payload: string; attempts: number }> = []
  const killDeadline = Date.now() + 120_000
  while (Date.now() < killDeadline) {
    if (exited) throw new Error(exited)
    heldAtKill = await db.query(
      `SELECT id, job_type, payload, attempts FROM queue_jobs WHERE status = 'active' AND locked_by = ?`,
      [workerA],
    )
    if (heldAtKill.some((j) => HEAVY.has(j.job_type))) break
    await sleep(100)
  }
  if (!heldAtKill.some((j) => HEAVY.has(j.job_type))) throw new Error('worker A never took heavy work; nothing to kill mid-job')
  killedA = true
  a.kill('SIGKILL')
  say(`killed worker A while it held: ${heldAtKill.map((j) => `${j.job_type} (attempt ${j.attempts})`).join(', ')}`)

  // --- wait for B to finish everything -------------------------------------------
  const waitDeadline = Date.now() + 6 * 60_000
  let settled = false
  while (Date.now() < waitDeadline) {
    if (exited) throw new Error(exited)
    const open = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM queue_jobs WHERE status IN ('pending','active') AND queue_name <> 'maintenance'`,
    )
    const unfinished = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM render_jobs WHERE status NOT IN ('completed','failed','cancelled','blocked')`,
    )
    if (toNum(open?.n, 0) === 0 && toNum(unfinished?.n, 0) === 0) { settled = true; break }
    await sleep(1000)
  }
  b.kill('SIGTERM')
  await sleep(1500)
  if (!b.killed) b.kill('SIGKILL')
  say(settled ? 'worker B finished the queue' : 'TIMED OUT waiting for worker B')

  // --- what happened -------------------------------------------------------------
  const problems: string[] = []
  const jobs = await db.query<{ id: string; status: string; attempts: number }>('SELECT id, status, attempts FROM render_jobs')
  const statusCounts = jobs.reduce<Record<string, number>>((acc, j) => ((acc[j.status] = (acc[j.status] ?? 0) + 1), acc), {})
  for (const job of jobs) {
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) problems.push(`render ${job.id} left at "${job.status}"`)
  }
  const outputsPerJob = await db.query<{ job_id: string; n: number }>('SELECT job_id, COUNT(*) AS n FROM outputs GROUP BY job_id')
  for (const row of outputsPerJob) if (toNum(row.n) > 1) problems.push(`render ${row.job_id} has ${row.n} outputs (duplicate ingest)`)
  for (const job of jobs.filter((j) => j.status === 'completed')) {
    if (!outputsPerJob.some((r) => r.job_id === job.id)) problems.push(`render ${job.id} completed with no output`)
  }
  const charges = await db.query<{ job_id: string; n: number }>(
    `SELECT job_id, COUNT(*) AS n FROM cost_ledger WHERE entry_type = 'charge' GROUP BY job_id`,
  )
  for (const row of charges) if (toNum(row.n) > 1) problems.push(`render ${row.job_id} charged ${row.n} times`)
  const estimates = await db.query<{ job_id: string; n: number }>(
    `SELECT job_id, COUNT(*) AS n FROM cost_ledger WHERE entry_type = 'estimate' GROUP BY job_id`,
  )
  const submittedAttempts = await db.query<{ job_id: string; n: number }>(
    `SELECT job_id, COUNT(*) AS n FROM render_attempts WHERE external_job_id IS NOT NULL OR status <> 'failed' GROUP BY job_id`,
  )
  const strandedAttempts = await db.query<{ job_id: string; attempt: number }>(
    `SELECT job_id, attempt FROM render_attempts WHERE status = 'submitting'`,
  )
  for (const row of strandedAttempts) problems.push(`render ${row.job_id} attempt ${row.attempt} still "submitting"`)
  const missingDerivatives = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM outputs WHERE proxy_asset_id IS NULL AND status <> 'qc_failed'`,
  )
  for (const row of missingDerivatives) problems.push(`output ${row.id} has no proxy`)
  const unqc = await db.query<{ id: string }>(
    `SELECT o.id FROM outputs o WHERE NOT EXISTS (SELECT 1 FROM output_qc q WHERE q.output_id = o.id AND q.layer = 'combined')`,
  )
  for (const row of unqc) problems.push(`output ${row.id} never got a QC verdict`)
  const qcRuns = await db.query<{ output_id: string; n: number }>(
    `SELECT output_id, COUNT(*) AS n FROM output_qc WHERE layer = 'technical' GROUP BY output_id`,
  )
  const leftovers = await db.query<{ job_type: string; status: string; n: number }>(
    `SELECT job_type, status, COUNT(*) AS n FROM queue_jobs WHERE status IN ('pending','active') GROUP BY job_type, status`,
  )
  const dead = await db.query<{ job_type: string; last_error: string }>('SELECT job_type, last_error FROM queue_dead')
  const orphanVideos = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assets a WHERE a.kind = 'generated_video' AND NOT EXISTS (SELECT 1 FROM outputs o WHERE o.asset_id = a.id)`,
  )
  const orphanProxies = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM assets a WHERE a.kind = 'proxy' AND NOT EXISTS (SELECT 1 FROM outputs o WHERE o.proxy_asset_id = a.id)`,
  )
  const recovered = await Promise.all(heldAtKill.map(async (h) => {
    const row = await db.get<{ status: string; attempts: number; locked_by: string | null }>(
      'SELECT status, attempts, locked_by FROM queue_jobs WHERE id = ?', [h.id],
    )
    return { type: h.job_type, payload: JSON.parse(h.payload), attemptAtKill: h.attempts, now: row }
  }))
  for (const r of recovered) if (r.now?.status !== 'completed') problems.push(`${r.type} held by A ended "${r.now?.status}"`)

  const report = {
    settled,
    renders: jobs.length,
    renderStatus: statusCounts,
    heldByAAtKill: recovered,
    outputs: outputsPerJob.reduce((s, r) => s + toNum(r.n), 0),
    charges: charges.reduce((s, r) => s + toNum(r.n), 0),
    estimates: estimates.reduce((s, r) => s + toNum(r.n), 0),
    attemptsSent: submittedAttempts.reduce((s, r) => s + toNum(r.n), 0),
    technicalQcRunsPerOutput: qcRuns.map((r) => toNum(r.n)),
    orphanGeneratedVideos: toNum(orphanVideos?.n, 0),
    orphanProxies: toNum(orphanProxies?.n, 0),
    queueLeftovers: leftovers,
    deadLetters: dead,
    problems,
  }
  console.log(JSON.stringify(report, null, 2))
  await runtime.close()
  if (process.env.DRILL_KEEP !== '1') await rm(dir, { recursive: true, force: true })
  else say(`kept ${dir}`)
  process.exitCode = problems.length === 0 && settled ? 0 : 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
