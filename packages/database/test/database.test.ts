import { describe, expect, it } from 'vitest'
import { SqliteDb, createTestDb, inClause, insertRow, migrationStatus, parseJsonColumn, runMigrations, toBool, toPositional, updateRow, upsertRow } from '../src/index.js'

describe('placeholder rewriting', () => {
  it('numbers placeholders for PostgreSQL', () => {
    expect(toPositional('SELECT * FROM t WHERE a = ? AND b = ?')).toBe('SELECT * FROM t WHERE a = $1 AND b = $2')
  })

  it('ignores question marks inside string literals', () => {
    // A compiled prompt routinely contains "?" — if it shifted the parameter
    // numbering, every query carrying prose would silently bind wrong.
    const sql = "SELECT * FROM t WHERE note = 'what? really' AND id = ?"
    expect(toPositional(sql)).toBe("SELECT * FROM t WHERE note = 'what? really' AND id = $1")
  })
})

describe('migrations', () => {
  it('applies every migration and is idempotent', async () => {
    const db = new SqliteDb(':memory:')
    const first = await runMigrations(db)
    expect(first.applied.length).toBeGreaterThan(0)
    expect(first.skipped).toHaveLength(0)

    const second = await runMigrations(db)
    expect(second.applied).toHaveLength(0)
    expect(second.skipped.length).toBe(first.applied.length)

    const status = await migrationStatus(db)
    expect(status.every((m) => m.applied)).toBe(true)
    await db.close()
  })

  it('creates every table the pipeline writes to', async () => {
    const db = await createTestDb()
    const rows = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    const tables = new Set(rows.map((r) => r.name))
    for (const required of [
      'orgs',
      'users',
      'projects',
      'shots',
      'shot_versions',
      'characters',
      'environments',
      'assets',
      'asset_lineage',
      'render_jobs',
      'render_attempts',
      'outputs',
      'output_qc',
      'reviews',
      'masters',
      'master_deliverables',
      'cost_ledger',
      'budgets',
      'price_quotes',
      'queue_jobs',
      'queue_dead',
      'webhook_events',
      'audit_log',
      'model_performance',
      'agent_runs',
    ]) {
      expect(tables.has(required), `missing table ${required}`).toBe(true)
    }
    await db.close()
  })
})

describe('parameter normalization', () => {
  it('binds booleans, dates and objects that SQLite would otherwise reject', async () => {
    const db = await createTestDb()
    await insertRow(db, 'orgs', { id: 'org_1', name: 'Test', created_at: new Date('2026-01-01T00:00:00Z') })
    await insertRow(db, 'projects', {
      id: 'proj_1',
      org_id: 'org_1',
      name: 'P',
      slug: 'p',
      brief: '',
      style_bible: { enforce: true, list: [1, 2] },
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
    })

    const row = await db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', ['proj_1'])
    expect(row?.created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(parseJsonColumn(row?.style_bible, {})).toEqual({ enforce: true, list: [1, 2] })

    await insertRow(db, 'scenes', { id: 's1', project_id: 'proj_1', name: 'Scene', ordinal: 1, synopsis: '', created_at: 'now' })
    const org = await db.get<Record<string, unknown>>('SELECT * FROM orgs WHERE id = ?', ['org_1'])
    expect(org?.created_at).toBe('2026-01-01T00:00:00.000Z')
    await db.close()
  })

  it('round-trips 0/1 booleans', () => {
    expect(toBool(1)).toBe(true)
    expect(toBool(0)).toBe(false)
    expect(toBool('t')).toBe(true)
    expect(toBool(null)).toBe(false)
  })
})

describe('statement helpers', () => {
  it('upserts on conflict', async () => {
    const db = await createTestDb()
    const row = {
      id: 'model_1',
      provider_id: 'mock',
      model_id: 'mock-draft',
      display_name: 'A',
      family: 'mock',
      modes: '[]',
      capabilities: '{}',
      pricing: '{}',
      raw: '{}',
      enabled: 1,
      source: 'static',
      fetched_at: 'now',
    }
    await upsertRow(db, 'provider_models', row, ['provider_id', 'model_id'])
    await upsertRow(db, 'provider_models', { ...row, id: 'model_2', display_name: 'B' }, ['provider_id', 'model_id'])
    const all = await db.query('SELECT display_name FROM provider_models')
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ display_name: 'B' })
    await db.close()
  })

  it('rejects an unsafe identifier rather than interpolating it', async () => {
    const db = await createTestDb()
    await expect(insertRow(db, 'orgs; DROP TABLE orgs', { id: 'x' })).rejects.toThrow(/unsafe SQL identifier/)
    await expect(updateRow(db, 'orgs', 'x', { 'name; --': 'y' })).rejects.toThrow(/unsafe SQL identifier/)
    await db.close()
  })

  it('builds a never-matching IN clause for an empty list', () => {
    expect(inClause('id', []).sql).toBe('1 = 0')
    expect(inClause('id', ['a', 'b'])).toEqual({ sql: 'id IN (?, ?)', params: ['a', 'b'] })
  })
})

describe('transactions', () => {
  it('rolls back every write when the body throws', async () => {
    const db = await createTestDb()
    await insertRow(db, 'orgs', { id: 'org_1', name: 'Test', created_at: 'now' })
    await expect(
      db.transaction(async (tx) => {
        await insertRow(tx, 'orgs', { id: 'org_2', name: 'Rolled back', created_at: 'now' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const rows = await db.query('SELECT id FROM orgs')
    expect(rows).toHaveLength(1)
    await db.close()
  })
})
