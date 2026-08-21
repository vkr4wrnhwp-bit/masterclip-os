/**
 * Secret redaction for logs and API error surfaces.
 *
 * Two independent defences, because either alone leaks:
 *  1. key-name matching — anything that *looks* like a credential field;
 *  2. value matching — known live secret values registered at boot, so a key
 *     copied into an unexpected field (a provider echoing the request back,
 *     an error message with the URL in it) is still scrubbed.
 */
const SENSITIVE_KEY = /(authorization|api[-_]?key|secret|token|password|passwd|credential|cookie|signature|bearer|private[-_]?key)/i

const registeredSecrets = new Set<string>()

/** Register a live secret value so it is scrubbed wherever it appears. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 8) registeredSecrets.add(value)
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear()
}

export function redactString(input: string): string {
  let out = input
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]')
  }
  return out
}

/** Show enough to identify which key is configured, never enough to use it. */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '(unset)'
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return '[depth-limit]' as unknown as T
  if (typeof value === 'string') return redactString(value) as unknown as T
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T
  if (value instanceof Error) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1)
  }
  return out as unknown as T
}

/** Redacted view of outbound HTTP headers, for request tracing. */
export function redactHeaders(headers: Record<string, string | undefined> | Headers): Record<string, string> {
  const entries: Array<[string, string]> =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers).filter((e): e is [string, string] => typeof e[1] === 'string')
  const out: Record<string, string> = {}
  for (const [k, v] of entries) out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactString(v)
  return out
}
