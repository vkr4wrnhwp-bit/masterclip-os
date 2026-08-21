import { z } from 'zod/v4'
import { CanonicalShot, SHOT_SCHEMA_VERSION, type CanonicalShot as Shot } from './shot.js'
import { validateShot, type ValidationIssue } from './validate.js'

/**
 * Import/export for shot lists.
 *
 * JSON is the lossless format; CSV exists because shot lists are still written
 * in spreadsheets. The CSV reader accepts dotted paths (`lighting.dominant_source`)
 * and pipe-separated lists so a flat sheet can express the nested spec without
 * anyone hand-writing JSON in a cell.
 */

export const ShotBundle = z.object({
  schema_version: z.string().default(SHOT_SCHEMA_VERSION),
  exported_at: z.string().default(''),
  project_id: z.string().default(''),
  shots: z.array(CanonicalShot),
})
export type ShotBundle = z.infer<typeof ShotBundle>

export interface ImportResult {
  shots: Shot[]
  errors: Array<{ row: number; shotId: string; issues: ValidationIssue[] }>
  warnings: Array<{ row: number; shotId: string; issues: ValidationIssue[] }>
}

export function exportBundle(shots: Shot[], projectId: string, exportedAt: string): ShotBundle {
  return { schema_version: SHOT_SCHEMA_VERSION, exported_at: exportedAt, project_id: projectId, shots }
}

export function importJson(text: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    return {
      shots: [],
      errors: [
        {
          row: 0,
          shotId: '',
          issues: [{ path: '(file)', code: 'import.invalid_json', message: (err as Error).message, severity: 'error' }],
        },
      ],
      warnings: [],
    }
  }
  const rows: unknown[] = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && Array.isArray((data as { shots?: unknown }).shots)
      ? ((data as { shots: unknown[] }).shots)
      : [data]
  return collect(rows)
}

/** RFC 4180 parsing: quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const source = text.replace(/^﻿/, '')

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0))
}

const LIST_FIELDS = new Set([
  'subjects',
  'identity_locks',
  'wardrobe_locks',
  'prop_locks',
  'source_assets',
  'reference_video_assets',
  'material_requirements',
  'environmental_motion',
  'physical_motion_rules',
  'negative_constraints',
  'preferred_models',
  'excluded_models',
  'approval_requirements',
  'lighting.practicals',
])

const NUMBER_FIELDS = new Set([
  'version',
  'duration_seconds',
  'fps',
  'lens_mm',
  'aperture',
  'candidate_count',
  'max_cost_usd',
])

const NULLABLE_FIELDS = new Set([
  'first_frame_asset',
  'last_frame_asset',
  'continuity_from_shot',
  'continuity_to_shot',
  'environment_lock',
])

export function importCsv(text: string): ImportResult {
  const rows = parseCsv(text)
  if (rows.length < 2) {
    return {
      shots: [],
      errors: [
        {
          row: 0,
          shotId: '',
          issues: [{ path: '(file)', code: 'import.empty_csv', message: 'CSV needs a header row and at least one data row', severity: 'error' }],
        },
      ],
      warnings: [],
    }
  }
  const header = (rows[0] ?? []).map((h) => h.trim())
  const objects = rows.slice(1).map((cells) => {
    const record: Record<string, unknown> = {}
    header.forEach((column, index) => {
      const raw = (cells[index] ?? '').trim()
      if (column.length === 0) return
      if (raw.length === 0) return
      setPath(record, column, coerceCell(column, raw))
    })
    return record
  })
  return collect(objects)
}

function coerceCell(column: string, raw: string): unknown {
  // List columns are resolved first: a single-element list serialized as one
  // JSON object would otherwise parse to an object, not an array of one.
  if (LIST_FIELDS.has(column)) {
    if (raw.startsWith('[')) {
      try {
        return JSON.parse(raw)
      } catch {
        /* fall through to the pipe-separated interpretation */
      }
    }
    // Pipe-separated for hand-written sheets; each element may itself be JSON,
    // which is what `exportCsv` emits for object lists so a round trip is lossless.
    return raw
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((element) => {
        if (!element.startsWith('{') && !element.startsWith('[')) return element
        try {
          return JSON.parse(element)
        } catch {
          return element
        }
      })
  }
  // Non-list columns may still carry structured JSON (e.g. environment_lock).
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw)
    } catch {
      /* fall through to the plain-text interpretations below */
    }
  }
  if (NUMBER_FIELDS.has(column)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  if (NULLABLE_FIELDS.has(column) && (raw === '-' || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'none')) {
    return null
  }
  return raw
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cursor: Record<string, unknown> = target
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string
    // Reject prototype-polluting keys: import files are untrusted input.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  const last = parts[parts.length - 1] as string
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return
  cursor[last] = value
}

function collect(rows: unknown[]): ImportResult {
  const result: ImportResult = { shots: [], errors: [], warnings: [] }
  rows.forEach((row, index) => {
    const validation = validateShot(row)
    const shotId = typeof (row as { shot_id?: string })?.shot_id === 'string' ? (row as { shot_id: string }).shot_id : ''
    const errors = validation.issues.filter((i) => i.severity === 'error')
    const warnings = validation.issues.filter((i) => i.severity === 'warning')
    if (warnings.length > 0) result.warnings.push({ row: index + 1, shotId, issues: warnings })
    if (validation.ok && validation.shot) result.shots.push(validation.shot)
    else result.errors.push({ row: index + 1, shotId, issues: errors })
  })
  return result
}

const CSV_COLUMNS = [
  'shot_id',
  'scene_id',
  'title',
  'shot_category',
  'narrative_purpose',
  'generation_mode',
  'duration_seconds',
  'aspect_ratio',
  'target_resolution',
  'fps',
  'action',
  'performance_direction',
  'blocking',
  'camera_position',
  'camera_movement',
  'lens_mm',
  'aperture',
  'focus_behavior',
  'lighting.dominant_source',
  'lighting.source_position',
  'lighting.color_temperature',
  'lighting.falloff',
  'lighting.shadow_behavior',
  'screen_direction',
  'audio_mode',
  'dialogue',
  'ambient_audio',
  'first_frame_asset',
  'last_frame_asset',
  'source_assets',
  'identity_locks',
  'wardrobe_locks',
  'prop_locks',
  'negative_constraints',
  'routing_profile',
  'candidate_count',
  'max_cost_usd',
] as const

export function exportCsv(shots: Shot[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const shot of shots) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(getPath(shot, column))).join(','))
  }
  return lines.join('\n') + '\n'
}

function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source)
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    const flat = value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
    return csvCell(flat.join('|'))
  }
  if (typeof value === 'object') return csvCell(JSON.stringify(value))
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Header-only template for teams starting a shot list in a spreadsheet. */
export function csvTemplate(): string {
  return CSV_COLUMNS.join(',') + '\n'
}
