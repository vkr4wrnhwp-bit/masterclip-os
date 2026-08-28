/**
 * JSON column helpers.
 *
 * Every JSON column in the Studio schema goes through these. `parseJson`
 * returning the fallback rather than throwing is deliberate: a row written by
 * an older build, or hand-edited during an incident, should degrade to an empty
 * list on one screen rather than take down every request that touches the
 * project.
 */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    const parsed = JSON.parse(raw) as T
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}
