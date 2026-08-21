import type { Db, SqlParam } from './driver.js'

/**
 * Minimal statement builders. Deliberately not an ORM: every query in this
 * codebase is parameterized and readable as SQL, and these helpers only remove
 * the placeholder-counting boilerplate around INSERT/UPDATE.
 *
 * Identifiers are never interpolated from user input — callers pass literal
 * table and column names — and values always travel as bound parameters.
 */
const IDENT = /^[a-z_][a-z0-9_]*$/i

function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${name}`)
  return name
}

export async function insertRow(db: Db, table: string, values: Record<string, SqlParam>): Promise<void> {
  const cols = Object.keys(values).map(assertIdent)
  const placeholders = cols.map(() => '?').join(', ')
  await db.run(
    `INSERT INTO ${assertIdent(table)} (${cols.join(', ')}) VALUES (${placeholders})`,
    cols.map((c) => values[c]),
  )
}

/** INSERT ... ON CONFLICT (keys) DO UPDATE — supported identically by both dialects. */
export async function upsertRow(
  db: Db,
  table: string,
  values: Record<string, SqlParam>,
  conflictColumns: string[],
  updateColumns?: string[],
): Promise<void> {
  const cols = Object.keys(values).map(assertIdent)
  const conflict = conflictColumns.map(assertIdent)
  const updates = (updateColumns ?? cols.filter((c) => !conflict.includes(c))).map(assertIdent)
  const setClause = updates.map((c) => `${c} = excluded.${c}`).join(', ')
  const sql =
    `INSERT INTO ${assertIdent(table)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (${conflict.join(', ')}) DO ` +
    (updates.length > 0 ? `UPDATE SET ${setClause}` : 'NOTHING')
  await db.run(
    sql,
    cols.map((c) => values[c]),
  )
}

export async function updateRow(
  db: Db,
  table: string,
  id: string,
  values: Record<string, SqlParam>,
  idColumn = 'id',
): Promise<number> {
  const cols = Object.keys(values).map(assertIdent)
  if (cols.length === 0) return 0
  const setClause = cols.map((c) => `${c} = ?`).join(', ')
  const result = await db.run(
    `UPDATE ${assertIdent(table)} SET ${setClause} WHERE ${assertIdent(idColumn)} = ?`,
    [...cols.map((c) => values[c]), id],
  )
  return result.changes
}

/** `WHERE x IN (?, ?, ?)` fragment plus its params, or a never-matching clause. */
export function inClause(column: string, values: readonly string[]): { sql: string; params: string[] } {
  assertIdent(column)
  if (values.length === 0) return { sql: '1 = 0', params: [] }
  return { sql: `${column} IN (${values.map(() => '?').join(', ')})`, params: [...values] }
}
