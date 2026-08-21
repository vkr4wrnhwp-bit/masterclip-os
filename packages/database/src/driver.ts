export type Row = Record<string, unknown>
export type SqlParam = string | number | boolean | null | undefined | Date | Uint8Array | object

export type Dialect = 'sqlite' | 'postgres'

export interface Db {
  readonly dialect: Dialect
  /** Rows for a SELECT. SQL is written with `?` placeholders in every dialect. */
  query<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>
  get<T = Row>(sql: string, params?: SqlParam[]): Promise<T | undefined>
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>
  /** Multi-statement DDL. No parameters. */
  exec(sql: string): Promise<void>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/**
 * Normalizes JS values into the narrow set both drivers accept.
 *
 * `node:sqlite` only binds null/number/bigint/string/Uint8Array, so booleans,
 * Dates, and JSON columns have to be flattened here rather than at every call
 * site. Doing it in one place is also what keeps the same SQL string valid
 * against both dialects.
 */
export function normalizeParam(value: SqlParam): string | number | null | Uint8Array {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return value
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot bind non-finite number: ${value}`)
    return value
  }
  return value
}

export function normalizeParams(params: SqlParam[] = []): Array<string | number | null | Uint8Array> {
  return params.map(normalizeParam)
}

/**
 * Rewrites `?` placeholders to `$1..$n` for PostgreSQL, ignoring `?` inside
 * string literals so a prompt containing a question mark cannot shift the
 * parameter numbering.
 */
export function toPositional(sql: string): string {
  let out = ''
  let index = 0
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    if (ch === '?' && !inSingle && !inDouble) {
      index++
      out += `$${index}`
      continue
    }
    out += ch
  }
  return out
}

/** JSON column helper: columns are TEXT in both dialects, always parsed here. */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value as T
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** SQLite has no boolean type; both dialects store 0/1 INTEGER. */
export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1' || value === 't' || value === 'true'
}

export function toNum(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function toNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function toStr(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value)
}

export function toStrOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}
