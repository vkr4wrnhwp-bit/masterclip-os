/**
 * Injectable clock. Every timestamp in the system goes through one of these so
 * queue leases, quote expiry, and backoff can be tested without sleeping.
 */
export interface Clock {
  now(): number
  isoNow(): string
}

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
}

export function fixedClock(startMs: number): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startMs
  return {
    now: () => current,
    isoNow: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms
    },
    set: (ms: number) => {
      current = ms
    },
  }
}

export function isoAt(ms: number): string {
  return new Date(ms).toISOString()
}

export function parseIso(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`invalid ISO timestamp: ${iso}`)
  return ms
}
