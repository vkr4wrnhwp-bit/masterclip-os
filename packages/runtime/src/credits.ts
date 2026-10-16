import { createHash, createHmac } from 'node:crypto'
import type { Db } from '@masterclip/database'
import { AppError, type AppConfig, type Clock } from '@masterclip/shared'
import type { ModelTier } from '@masterclip/provider-core'
import type { RenderJob } from '@masterclip/domain'
import { JOB_TYPES, QUEUES, type DurableQueue } from '@masterclip/queue'

export const CREDIT_SALT = 'street-banker-suite-credits-v1'

/** Python itsdangerous URLSafeTimedSerializer's uncompressed wire format. */
export function signCreditCall(payload: Record<string, unknown>, secret: string, nowSeconds: number): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const bytes: number[] = []
  for (let n = nowSeconds; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256)
  const signed = `${body}.${Buffer.from(bytes).toString('base64url')}`
  const key = createHash('sha1').update(`${CREDIT_SALT}signer${secret}`).digest()
  return `${signed}.${createHmac('sha1', key).update(signed).digest('base64url')}`
}

interface CreditSpend {
  ref: string
  job_id: string
  email: string
  action: string
  units: number
  state: string
}

const unavailable = () => new AppError({
  kind: 'provider_unavailable', code: 'credits.unavailable',
  message: "We can't check your credits right now. Your render has not started. Try again later.",
})

export class MotionCredits {
  constructor(private readonly db: Db, private readonly queue: DurableQueue,
    private readonly config: AppConfig, private readonly clock: Clock) {}

  private settings(): { base: string; secret: string } {
    const secret = this.config.SUITE_SSO_SECRET_MOTION.trim() || this.config.SUITE_SSO_SECRET.trim()
    let url: URL
    try { url = new URL(this.config.STREET_BANKER_URL) } catch { throw unavailable() }
    if (!secret || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw unavailable()
    return { base: url.href.replace(/\/$/, ''), secret }
  }

  private async call(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { base, secret } = this.settings()
    let response: Response, body: Record<string, unknown>
    try {
      response = await fetch(`${base}/api/suites/credits`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ token: signCreditCall(payload, secret, Math.floor(this.clock.now() / 1000)) }),
      })
      body = await response.json() as Record<string, unknown>
    } catch { throw unavailable() }
    if (response.status === 402 && payload.op === 'spend') {
      const need = body.need, held = (body.balance as { total?: unknown } | null)?.total
      if (!Number.isSafeInteger(need) || !Number.isSafeInteger(held) || Number(need) < 1 || Number(held) < 0) throw unavailable()
      throw new AppError({ kind: 'budget_exceeded', code: 'credits.short',
        message: `This render needs ${need} ${need === 1 ? 'credit' : 'credits'}. You have ${held} ${held === 1 ? 'credit' : 'credits'}.`,
        details: { creditsNeeded: need, creditsHeld: held, buyUrl: `${base}/billing#credits`, refusedAt: this.clock.isoNow() },
      })
    }
    if (!response.ok || body?.ok !== true) throw unavailable()
    const amount = payload.op === 'refund' ? body.refunded : body.spent
    if (!Number.isSafeInteger(amount) || Number(amount) < (payload.op === 'refund' ? 0 : 1)) throw unavailable()
    return body
  }

  /** A ref is a render plus its paid attempt; retrying a failed generation is new work. */
  async spend(job: RenderJob, tier: ModelTier, seconds: number, orgId: string): Promise<void> {
    if (job.providerId === 'mock' || this.config.isSandbox) return
    // Providers submit whole seconds; never silently truncate a fractional duration.
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 100) {
      throw new AppError({ kind: 'validation', code: 'credits.duration', message: 'Choose a video length from 1 to 100 whole seconds.' })
    }
    this.settings()
    const ref = `${job.id}:${job.attempts + 1}`
    let row = await this.db.get<CreditSpend>('SELECT * FROM render_credit_spends WHERE ref = ?', [ref])
    if (!row) {
      const user = await this.db.get<{ email: string }>(
        `SELECT u.email FROM users u JOIN sessions s ON s.user_id = u.id
         WHERE u.id = ? AND u.org_id = ? AND u.disabled = 0
         AND LOWER(s.street_banker_email) = LOWER(u.email) LIMIT 1`, [job.createdBy, orgId])
      if (!user?.email) throw new AppError({ kind: 'forbidden', code: 'credits.account',
        message: 'Sign in through Street Banker before rendering a video.' })
      await this.db.run(`INSERT INTO render_credit_spends (ref, job_id, email, action, units, state, credits, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?) ON CONFLICT(ref) DO NOTHING`,
      [ref, job.id, user.email.trim().toLowerCase(), `motion.${tier}`, seconds, this.clock.isoNow()])
      row = await this.db.get<CreditSpend>('SELECT * FROM render_credit_spends WHERE ref = ?', [ref])
    }
    if (!row || row.action !== `motion.${tier}` || Number(row.units) !== seconds || ['refunded', 'refund_pending'].includes(row.state)) {
      throw new AppError({ kind: 'conflict', code: 'credits.attempt', message: 'This render attempt has ended. Start a new render.' })
    }
    if (row.state === 'spent') return
    const result = await this.call({ op: 'spend', email: row.email, suite: 'motion', action: row.action, units: Number(row.units), ref })
    await this.db.run("UPDATE render_credit_spends SET state = 'spent', credits = ? WHERE ref = ?", [Number(result.spent), ref])
  }

  /** Persist refund work before marking the render failed. Queue retries use the same ref. */
  async requestRefund(jobId: string, attempt: number): Promise<void> {
    const ref = `${jobId}:${attempt}`
    const row = await this.db.get<CreditSpend>('SELECT * FROM render_credit_spends WHERE ref = ?', [ref])
    if (!row || row.state === 'refunded') return
    await this.db.run("UPDATE render_credit_spends SET state = 'refund_pending' WHERE ref = ? AND state <> 'refunded'", [ref])
    await this.queue.enqueue({ queue: QUEUES.maintenance, type: JOB_TYPES.refundCredits,
      payload: { ref }, dedupeKey: `credits-refund:${ref}`, maxAttempts: 20 })
  }

  async refund(ref: string): Promise<void> {
    const row = await this.db.get<CreditSpend>('SELECT * FROM render_credit_spends WHERE ref = ?', [ref])
    if (!row || row.state !== 'refund_pending') return
    await this.call({ op: 'refund', email: row.email, suite: 'motion', ref })
    await this.db.run("UPDATE render_credit_spends SET state = 'refunded' WHERE ref = ?", [ref])
  }
}
