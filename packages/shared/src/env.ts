import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { registerSecret } from './redact.js'
import { usdToMicros, type MicroUsd } from './money.js'

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v)))

const num = (dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().finite())

/**
 * A number the environment may or may not have set, with no fallback folded in.
 *
 * `num` above applies its default inside the schema, which is right for a port
 * or a poll interval and wrong for a value whose absence is itself worth
 * reporting: once the default is applied here, nothing downstream can tell a
 * deployment that chose the default from one that never configured anything.
 * The caller applies the fallback instead, and records that it did.
 */
const optionalNum = () =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
    .pipe(z.number().finite().optional())

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- runtime posture -----------------------------------------------------
  /**
   * `sandbox` is the default and the safe state: adapters must use provider
   * sandbox/test modes and no request may be billed. `live` is opt-in and still
   * capped by LIVE_SPEND_CAP_USD.
   */
  MASTERCLIP_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  /**
   * The global live-spend ceiling, in dollars.
   *
   * No schema default on purpose. It used to be `num(2)`, which meant a
   * deployment that never configured a cap was indistinguishable from one that
   * deliberately chose two dollars, and every screen reported the second. The
   * fallback now lives in `loadConfig`, which records whether it had to use it
   * as `liveSpendCapConfigured`. `AppConfig.LIVE_SPEND_CAP_USD` is still always
   * a number, so nothing that enforces the cap changes.
   */
  LIVE_SPEND_CAP_USD: optionalNum(),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: num(4310),
  /**
   * Whether to believe `X-Forwarded-For`/`X-Forwarded-Proto`.
   *
   * Defaults to **false** because these headers are client-supplied: trusting
   * them on a directly-exposed port lets anyone forge their own source address,
   * which both poisons the audit log and makes IP-keyed rate limiting useless.
   * Set it only when the API genuinely sits behind a proxy that overwrites them.
   */
  TRUST_PROXY: bool(false),
  /** Escape hatch for load testing against a throwaway deployment. */
  RATE_LIMIT_ENABLED: bool(true),
  /** Multiplies every rate-limit budget. Raise it for a busy shared deployment. */
  RATE_LIMIT_SCALE: num(1),
  WEB_PORT: num(4311),
  /** Externally reachable origin, used to build provider webhook callback URLs. */
  PUBLIC_BASE_URL: z.string().default(''),

  // --- persistence ---------------------------------------------------------
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().default(''),
  SQLITE_PATH: z.string().default('var/masterclip.sqlite'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('var/storage'),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool(true),

  // --- secrets -------------------------------------------------------------
  SESSION_SECRET: z.string().default(''),
  ASSET_SIGNING_SECRET: z.string().default(''),
  /** Shared secret for our own outbound->inbound webhook URL signing. */
  WEBHOOK_SECRET: z.string().default(''),
  SECRETS_ENCRYPTION_KEY: z.string().default(''),

  // --- providers -----------------------------------------------------------
  MUAPI_API_KEY: z.string().default(''),
  MUAPI_BASE_URL: z.string().default('https://api.muapi.ai'),
  MUAPI_SANDBOX: bool(true),

  GOOGLE_API_KEY: z.string().default(''),
  GOOGLE_BASE_URL: z.string().default('https://generativelanguage.googleapis.com'),

  FAL_KEY: z.string().default(''),
  FAL_BASE_URL: z.string().default('https://queue.fal.run'),

  RUNWAY_API_KEY: z.string().default(''),
  RUNWAY_BASE_URL: z.string().default('https://api.dev.runwayml.com'),
  RUNWAY_API_VERSION: z.string().default('2024-11-06'),

  LUMA_API_KEY: z.string().default(''),
  LUMA_BASE_URL: z.string().default('https://api.lumalabs.ai'),

  REPLICATE_API_TOKEN: z.string().default(''),
  REPLICATE_BASE_URL: z.string().default('https://api.replicate.com'),

  /** Self-hosted ComfyUI (or compatible) HTTP endpoint. */
  COMFYUI_BASE_URL: z.string().default(''),
  COMFYUI_API_KEY: z.string().default(''),

  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),
  /** Model used for reasoning-heavy producer agents. */
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  /** Cheaper model used for first-pass visual QC over extracted frames. */
  ANTHROPIC_QC_MODEL: z.string().default('claude-haiku-4-5'),

  // --- media ---------------------------------------------------------------
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  // --- worker --------------------------------------------------------------
  WORKER_CONCURRENCY: num(4),
  WORKER_POLL_INTERVAL_MS: num(1000),
  JOB_LEASE_SECONDS: num(120),
  PROVIDER_POLL_INTERVAL_MS: num(5000),
  PROVIDER_JOB_TIMEOUT_MS: num(20 * 60_000),
})

export type RawEnv = z.infer<typeof EnvSchema>

/**
 * Signing secrets published in this repository.
 *
 * They exist so a clean checkout runs without generating keys by hand. They are
 * defined here, once, because the production guard below refuses exactly these
 * values — two copies of the string would eventually drift and the guard would
 * quietly stop refusing the one still in use.
 */
export const DEV_SESSION_SECRET = 'masterclip-development-session-secret'
export const DEV_ASSET_SIGNING_SECRET = 'masterclip-development-only-asset-signing-secret'

const PUBLISHED_DEV_SECRETS = new Set<string>([DEV_SESSION_SECRET, DEV_ASSET_SIGNING_SECRET])

/** Shortest secret worth signing with. Render's generateValue is far longer. */
const MIN_SECRET_LENGTH = 16

const PRODUCTION_REQUIRED = ['SESSION_SECRET', 'ASSET_SIGNING_SECRET'] as const

/**
 * Refuses to start a production deployment whose signing secrets are absent,
 * published in this repository, or too short to be worth signing with.
 *
 * `createStorage()` already refused an empty ASSET_SIGNING_SECRET, but only on
 * the local-driver path, and nothing refused an empty SESSION_SECRET at all —
 * so a production deployment could boot signing CSRF tokens with a value
 * anybody can read in this file. Checking at config load covers the API, the
 * worker and the CLI in one place instead of at each point of use, and fails at
 * boot rather than at the first request that happens to need a signature.
 */
function assertProductionSecrets(env: RawEnv): void {
  if (env.NODE_ENV !== 'production') return
  const problems: string[] = []
  for (const key of PRODUCTION_REQUIRED) {
    const value = env[key]
    if (!value) problems.push(`${key} is not set`)
    else if (PUBLISHED_DEV_SECRETS.has(value)) problems.push(`${key} is the development value published in this repository`)
    else if (value.length < MIN_SECRET_LENGTH) problems.push(`${key} is ${value.length} characters; use at least ${MIN_SECRET_LENGTH}`)
  }
  if (problems.length > 0) {
    throw new Error(`refusing to start in production: ${problems.join('; ')}`)
  }
}

/**
 * The live-spend ceiling a deployment gets when it never set one.
 *
 * It is a real, enforced limit rather than a placeholder: the cost controller
 * refuses any live submission that would carry spend past it, configured or
 * not. What is new is that the runtime remembers the figure was ours, so a
 * screen can say the cap is not set and still name the limit that applies.
 */
export const DEFAULT_LIVE_SPEND_CAP_USD = 2

export interface AppConfig extends RawEnv {
  /**
   * Always a usable number: the configured cap, or DEFAULT_LIVE_SPEND_CAP_USD.
   * Narrowed from the schema's `number | undefined` deliberately, so every
   * existing reader of `config.LIVE_SPEND_CAP_USD` keeps the number it had.
   */
  LIVE_SPEND_CAP_USD: number
  /**
   * True only when LIVE_SPEND_CAP_USD came from the environment. Reporting
   * only, and the only thing that separates "we chose two dollars" from "we
   * chose nothing and two dollars is what protects you".
   */
  liveSpendCapConfigured: boolean
  liveSpendCapMicros: MicroUsd
  isSandbox: boolean
  isTest: boolean
}

let cached: AppConfig | null = null

export function loadConfig(source: NodeJS.ProcessEnv = process.env, force = false): AppConfig {
  if (cached && !force) return cached
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`invalid environment configuration: ${issues}`)
  }
  const env = parsed.data
  assertProductionSecrets(env)
  for (const key of [
    'MUAPI_API_KEY',
    'GOOGLE_API_KEY',
    'FAL_KEY',
    'RUNWAY_API_KEY',
    'LUMA_API_KEY',
    'REPLICATE_API_TOKEN',
    'ANTHROPIC_API_KEY',
    'S3_SECRET_ACCESS_KEY',
    'SESSION_SECRET',
    'ASSET_SIGNING_SECRET',
    'WEBHOOK_SECRET',
    'SECRETS_ENCRYPTION_KEY',
    'COMFYUI_API_KEY',
  ] as const) {
    registerSecret(env[key])
  }
  // The cap is the one value whose absence is reported rather than papered
  // over, so the fallback is applied here and the fact kept alongside it. Every
  // consumer below this line still sees a plain number.
  const liveSpendCapConfigured = env.LIVE_SPEND_CAP_USD !== undefined
  const liveSpendCapUsd = env.LIVE_SPEND_CAP_USD ?? DEFAULT_LIVE_SPEND_CAP_USD
  cached = {
    ...env,
    LIVE_SPEND_CAP_USD: liveSpendCapUsd,
    liveSpendCapConfigured,
    liveSpendCapMicros: usdToMicros(liveSpendCapUsd),
    isSandbox: env.MASTERCLIP_MODE === 'sandbox',
    isTest: env.NODE_ENV === 'test',
  }
  return cached
}

export function resetConfigCache(): void {
  cached = null
}

/**
 * Applies a `.env` file to `target` (normally `process.env`), skipping every
 * variable that is already set — the same precedence as `node --env-file`, so
 * a properly configured environment can never be overridden by a checkout's
 * local file.
 *
 * Nothing loads `.env` on its own: Node only reads one under an explicit
 * `--env-file` flag, which NODE_OPTIONS refuses to carry through pnpm and tsx.
 * Until the entry points called this, the file `masterclip init` creates and
 * `.env.example` documents was silently ignored — `providers health` reported
 * a key "not set" while the operator could see it sitting in `.env`.
 * Deployments are unaffected: `.dockerignore` keeps `.env` out of every image,
 * and real environment variables win regardless.
 *
 * Returns the names of the variables applied, never their values, so callers
 * can report what happened without a secret reaching a log.
 */
export function applyEnvFile(path = '.env', target: NodeJS.ProcessEnv = process.env): string[] {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const applied: string[] = []
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (target[key] !== undefined) continue
    target[key] = value
    applied.push(key)
  }
  return applied
}
