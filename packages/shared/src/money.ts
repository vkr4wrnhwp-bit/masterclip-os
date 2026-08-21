/**
 * Money is stored and arithmetic'd as integer **micro-USD** (1 USD = 1_000_000).
 *
 * Video pricing is quoted in fractions of a cent per second ($0.05/s, $0.0008
 * per megapixel-second), and a project runs tens of thousands of these through
 * sums and divisions. Floating-point dollars drift; integers do not. Every
 * ledger row, budget, and quote in the system is micro-USD.
 */
export type MicroUsd = number

export const MICROS_PER_USD = 1_000_000

export function usdToMicros(usd: number): MicroUsd {
  if (!Number.isFinite(usd)) throw new Error(`usdToMicros: non-finite input ${usd}`)
  return Math.round(usd * MICROS_PER_USD)
}

export function microsToUsd(micros: MicroUsd): number {
  return micros / MICROS_PER_USD
}

/** `$1.2345` — 4 decimals, because per-second rates are that small. */
export function formatUsd(micros: MicroUsd, decimals = 4): string {
  const usd = microsToUsd(micros)
  const sign = usd < 0 ? '-' : ''
  return `${sign}$${Math.abs(usd).toFixed(decimals)}`
}

export function sumMicros(values: readonly MicroUsd[]): MicroUsd {
  let total = 0
  for (const v of values) total += v
  return total
}

/**
 * Rate application, kept in integer space: `micros = round(rateMicrosPerUnit * units)`.
 * `units` may be fractional (e.g. 7.5 seconds).
 */
export function applyRate(rateMicrosPerUnit: MicroUsd, units: number): MicroUsd {
  return Math.round(rateMicrosPerUnit * units)
}

/**
 * Safe division for cost-per-approved-second style metrics. Returns `null`
 * rather than Infinity/NaN when the denominator is zero — callers must render
 * "no data yet" instead of a fake number.
 */
export function divideMicros(micros: MicroUsd, divisor: number): MicroUsd | null {
  if (!Number.isFinite(divisor) || divisor === 0) return null
  return Math.round(micros / divisor)
}

export function percent(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole === 0) return null
  return (part / whole) * 100
}
