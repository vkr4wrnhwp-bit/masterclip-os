// Isolated Song Lab browser checks use the production build and a throwaway database.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const scratch = mkdtempSync(join(tmpdir(), 'song-lab-e2e-'))
const child = spawn(process.execPath, ['dist/api.js'], { stdio: 'inherit', env: {
  ...process.env, NODE_ENV: 'test', API_HOST: '127.0.0.1', API_PORT: process.env.E2E_PORT ?? '4399',
  WEB_ROOT: join(process.cwd(), 'apps/web/dist'), SQLITE_PATH: join(scratch, 'suite.sqlite'),
  STORAGE_LOCAL_ROOT: join(scratch, 'storage'), MASTERCLIP_MODE: 'sandbox',
  SESSION_SECRET: 'browser-fixture-session-secret', ASSET_SIGNING_SECRET: 'browser-fixture-asset-secret',
  MUAPI_API_KEY: '', GOOGLE_API_KEY: '', FAL_KEY: '', ANTHROPIC_API_KEY: '', ELEVENLABS_API_KEY: '',
} })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => process.exit(code ?? 0))
