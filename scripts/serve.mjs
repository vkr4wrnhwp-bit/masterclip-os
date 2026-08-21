#!/usr/bin/env node
/**
 * Production entry: one container, both processes.
 *
 * Generation never happens inside an HTTP request — the API queues work and a
 * separate worker performs it — so a deployment that starts only the API
 * accepts renders and never runs them. Locally `pnpm dev` starts both; this is
 * the same arrangement for a single-container host.
 *
 * Three things happen in order, and the order matters:
 *
 *   1. Seed. The first account to reach /api/auth/signup bootstraps the
 *      organization and closes signup behind itself. On a public URL that is a
 *      race with the internet, so the owner is created here, before anything is
 *      listening. Seeding is idempotent, so restarts and redeploys are safe.
 *   2. Worker.
 *   3. API — last, so nothing is reachable until the rest is ready.
 *
 * If either child exits, this exits: a half-running factory that accepts work
 * it will never perform is worse than a container the platform restarts.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath

// Render (and most hosts) assign the port and expect 0.0.0.0.
const env = {
  ...process.env,
  API_PORT: process.env.PORT ?? process.env.API_PORT ?? '4310',
  API_HOST: process.env.API_HOST ?? '0.0.0.0',
  WEB_ROOT: process.env.WEB_ROOT ?? join(root, 'apps/web/dist'),
}

function run(name, script) {
  const child = spawn(node, [join(root, script)], { stdio: 'inherit', env })
  child.on('exit', (code, signal) => {
    console.error(JSON.stringify({ level: 'error', msg: 'serve.child_exited', name, code, signal }))
    shutdown(code ?? 1)
  })
  return child
}

const children = []
let stopping = false

function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  // Give them a moment to close cleanly, then leave regardless.
  setTimeout(() => process.exit(code), 3_000).unref()
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

const seed = spawn(node, [join(root, 'dist/seed.js')], { stdio: 'inherit', env })
seed.on('exit', (code) => {
  if (code !== 0) {
    console.error(JSON.stringify({ level: 'error', msg: 'serve.seed_failed', code }))
    process.exit(code ?? 1)
  }
  children.push(run('worker', 'dist/worker.js'))
  children.push(run('api', 'dist/api.js'))
})
