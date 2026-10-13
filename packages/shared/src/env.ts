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
 * A dollar amount the environment may or may not set, with no fallback folded in.
 *
 * `num` above applies its default inside the schema, which is right for a port
 * or a poll interval and wrong for a value whose absence is itself worth
 * reporting: once the default is applied here, nothing downstream can tell a
 * deployment that chose the default from one that never configured anything.
 * The caller applies the fallback instead, and records that it did.
 *
 * It is for limits, so it is strict: only plain decimal dollars ("10", "7.5",
 * "7.50") are accepted. Junk ("ten", "$10"), "0x10", "1e3", Infinity and
 * negative figures stop startup with a sentence saying what is wanted, instead
 * of becoming a number nobody meant. Unset and blank both mean "not set", and a
 * blank must not quietly become zero dollars, which would shut everyone out, so
 * whitespace is trimmed before the blank check. Zero is allowed and means none.
 */
const PLAIN_DOLLARS = 'must be a plain number of dollars, like 10'
const PLAIN_DECIMAL = /^\d+(\.\d{1,2})?$/
const optionalDollars = () =>
  z
    .string()
    .optional()
    .transform((v, ctx): number | undefined => {
      const text = (v ?? '').trim()
      if (text === '') return undefined
      if (PLAIN_DECIMAL.test(text)) return Number(text)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: /^-\d/.test(text) ? 'must not be negative' : PLAIN_DOLLARS })
      return z.NEVER
    })

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
   * An optional emergency brake for the whole service, in dollars: the most real
   * money every customer together may cost per calendar month (UTC). It starts
   * over on the 1st. The owner manages CUSTOMER_SPEND_CAP_USD; leave this unset
   * unless a combined monthly total is wanted.
   *
   * Unset (absent or blank) with CUSTOMER_SPEND_CAP_USD set means no
   * whole-service ceiling at all. Unset with neither set keeps the built-in
   * DEFAULT_LIVE_SPEND_CAP_USD ceiling, so a service never runs with no limit of
   * any kind by accident. Zero means no live renders at all.
   *
   * No schema default on purpose: the fallback lives in `loadConfig`, which
   * records where the ceiling came from as `liveSpendCapSource`.
   */
  LIVE_SPEND_CAP_USD: optionalDollars(),
  /**
   * The most one customer (one organization) may spend on live renders in one
   * calendar month (UTC), in dollars. When it is set it is that organization's
   * monthly cap; where an organization also has a stored monthly budget, the
   * smaller of the two applies. When it is unset, nothing changes: the stored
   * organization budget (500 dollars by default) is the only monthly cap.
   *
   * Every account in the house organization, where OWNER_EMAILS accounts live,
   * is exempt; it is bound only by its stored organization budget and by
   * LIVE_SPEND_CAP_USD when that is set. This is the one setting that decides
   * what a customer may spend.
   *
   * A value that is not a plain non-negative number stops the service at
   * startup. Zero is allowed and means no customer may run a live render.
   */
  CUSTOMER_SPEND_CAP_USD: optionalDollars(),

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
 * The whole-service monthly live-spend ceiling a deployment gets when it set
 * neither LIVE_SPEND_CAP_USD nor CUSTOMER_SPEND_CAP_USD.
 *
 * It is a real, enforced limit rather than a placeholder: the cost controller
 * refuses any live submission that would carry spend past it. It exists so a
 * service never runs with no limit of any kind by accident. Setting
 * CUSTOMER_SPEND_CAP_USD is what removes it.
 */
export const DEFAULT_LIVE_SPEND_CAP_USD = 2

/** Where the whole-service ceiling came from: the environment, the built-in default, or nowhere (none). */
export type LiveSpendCapSource = 'env' | 'default' | 'none'

export interface AppConfig extends Omit<RawEnv, 'LIVE_SPEND_CAP_USD'> {
  /**
   * The whole-service monthly ceiling in dollars, or null when there is none
   * (LIVE_SPEND_CAP_USD unset while CUSTOMER_SPEND_CAP_USD is set).
   */
  LIVE_SPEND_CAP_USD: number | null
  /**
   * True only when LIVE_SPEND_CAP_USD came from the environment. Reporting
   * only, and the only thing that separates "we chose two dollars" from "we
   * chose nothing and two dollars is what protects you".
   */
  liveSpendCapConfigured: boolean
  /** `env`: set by the operator. `default`: neither cap set, built-in ceiling. `none`: no ceiling. */
  liveSpendCapSource: LiveSpendCapSource
  /** The ceiling in micro-dollars, or null when there is no whole-service ceiling. */
  liveSpendCapMicros: MicroUsd | null
  /** True only when CUSTOMER_SPEND_CAP_USD came from the environment. */
  customerSpendCapConfigured: boolean
  /** The per-customer monthly cap in micro-dollars, or null when none is set. */
  customerSpendCapMicros: MicroUsd | null
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
  // The ceiling's absence is reported rather than papered over, so the
  // fallback is applied here and where the ceiling came from is kept alongside
  // it. Set: the operator's figure. Unset while the per-customer cap is set: no
  // ceiling. Unset with neither set: the built-in default, so a service never
  // runs with no limit of any kind by accident.
  const liveSpendCapConfigured = env.LIVE_SPEND_CAP_USD !== undefined
  const liveSpendCapSource: LiveSpendCapSource = liveSpendCapConfigured
    ? 'env'
    : env.CUSTOMER_SPEND_CAP_USD !== undefined
      ? 'none'
      : 'default'
  const liveSpendCapUsd =
    liveSpendCapSource === 'env' ? (env.LIVE_SPEND_CAP_USD as number) : liveSpendCapSource === 'default' ? DEFAULT_LIVE_SPEND_CAP_USD : null
  cached = {
    ...env,
    LIVE_SPEND_CAP_USD: liveSpendCapUsd,
    liveSpendCapConfigured,
    liveSpendCapSource,
    liveSpendCapMicros: liveSpendCapUsd === null ? null : usdToMicros(liveSpendCapUsd),
    customerSpendCapConfigured: env.CUSTOMER_SPEND_CAP_USD !== undefined,
    customerSpendCapMicros: env.CUSTOMER_SPEND_CAP_USD === undefined ? null : usdToMicros(env.CUSTOMER_SPEND_CAP_USD),
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
