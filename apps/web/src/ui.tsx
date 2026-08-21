import React from 'react'

export function Card({ title, children, action }: { title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="card">
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3>{title}</h3>
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

export function Stat({ value, label, tone }: { value: string | number | null; label: string; tone?: 'ok' | 'warn' | 'danger' }) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div>
      <div className={`stat${empty ? ' muted' : ''}`} style={tone ? { color: `var(--${tone})` } : undefined}>
        {/* "no data yet" beats a fabricated zero — the difference matters for
            every cost-per-approved-second figure in this app. */}
        {empty ? 'no data yet' : value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

export function Badge({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'info' | 'accent' }) {
  return <span className={`badge${tone ? ` ${tone}` : ''}`}>{children}</span>
}

export function Callout({ tone, title, children }: { tone: 'warn' | 'danger' | 'info' | 'ok'; title?: string; children: React.ReactNode }) {
  return (
    <div className={`callout ${tone}`}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>
}

/**
 * The control is rendered *inside* the `<label>`, which associates the two
 * implicitly — no id plumbing, and screen readers (and Playwright's
 * `getByLabel`) resolve the control from its label the way they should.
 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span className="faint"> — {hint}</span>}
      </span>
      {children}
    </label>
  )
}

export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** Consecutive failures. Pollers use this to back off instead of hammering. */
  failures: number
  reload: () => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList): AsyncState<T> {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failures, setFailures] = React.useState(0)
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    fn()
      .then((value) => {
        if (cancelled) return
        setData(value)
        // Clear the error only once a request has actually succeeded. Clearing
        // it up front made a failing poll flicker the banner off and on.
        setError(null)
        setFailures(0)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(err.message)
        setFailures((n) => n + 1)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  return { data, error, loading, failures, reload: () => setNonce((n) => n + 1) }
}

/**
 * Renders async state.
 *
 * An error only takes over the screen when there is nothing else to show. If
 * data has already loaded, the error rides above it as a banner and the data
 * stays put — one failed poll used to blank the entire queue table, the stat
 * cards and the cost-controller callout, replacing a working screen with a
 * single line of red text. Losing what you were reading because one request out
 * of many timed out is worse than looking at figures a few seconds stale, and
 * the banner says which it is.
 */
export function AsyncBlock<T>({
  state,
  children,
}: {
  state: { data: T | null; error: string | null; loading: boolean }
  children: (data: T) => React.ReactNode
}) {
  if (state.loading && !state.data) return <div className="spinner">loading…</div>
  if (state.error && !state.data) {
    return (
      <Callout tone="danger" title="Request failed">
        {state.error}
      </Callout>
    )
  }
  if (!state.data) return <Empty>nothing here yet</Empty>
  return (
    <>
      {state.error ? (
        <Callout tone="warn" title="Showing the last good data">
          {state.error}
        </Callout>
      ) : null}
      {children(state.data)}
    </>
  )
}

export function qcTone(action: string | undefined): 'ok' | 'warn' | 'danger' | 'info' {
  if (action === 'AUTO_REJECT') return 'danger'
  if (action === 'APPROVE_FOR_DRAFT' || action === 'PROMOTE_TO_FINAL') return 'ok'
  if (action === 'REGENERATE_WITH_CORRECTION' || action === 'SEND_TO_DIFFERENT_MODEL') return 'warn'
  return 'info'
}

export function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'info' | undefined {
  if (status === 'completed' || status === 'approved' || status === 'qc_passed' || status === 'promoted' || status === 'healthy') return 'ok'
  if (status === 'failed' || status === 'blocked' || status === 'qc_failed' || status === 'rejected' || status === 'unavailable') return 'danger'
  if (status === 'processing' || status === 'submitted' || status === 'downloading' || status === 'degraded') return 'info'
  if (status === 'queued' || status === 'authorizing' || status === 'unconfigured') return 'warn'
  return undefined
}
