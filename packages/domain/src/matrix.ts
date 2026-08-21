import type { AspectRatio, CanonicalShot, TargetResolution } from '@masterclip/shot-schema'
import type { MicroUsd } from '@masterclip/shared'
import { variationsFor, type STANDARD_VARIATIONS } from '@masterclip/prompt-compiler'

export interface MatrixAxis {
  /** `provider/model` pairs to render with. */
  models: Array<{ providerId: string; modelId: string }>
  seeds: Array<string | null>
  /** Prompt variations. Defaults to the standard ladder when omitted. */
  variations?: Array<{ index: number; label: string; instruction: string }>
  aspectRatios?: AspectRatio[]
  resolutions?: TargetResolution[]
  durations?: number[]
}

export interface MatrixCell {
  index: number
  providerId: string
  modelId: string
  seed: string | null
  variationLabel: string
  variationInstruction: string
  aspectRatio: AspectRatio
  resolution: TargetResolution
  durationSeconds: number
  /** Filled in by the caller from real quotes; null until quoted. */
  estimatedMicros: MicroUsd | null
}

export interface MatrixPlan {
  cells: MatrixCell[]
  candidateCount: number
  estimatedTotalMicros: MicroUsd | null
  /** Cells whose price could not be established without a live quote. */
  unpricedCount: number
  byProvider: Array<{ providerId: string; count: number; estimatedMicros: MicroUsd | null }>
  warnings: string[]
}

export const MAX_MATRIX_CELLS = 512

/**
 * Cartesian product of the requested axes.
 *
 * The point of building this explicitly — rather than looping submissions — is
 * that the operator sees the full candidate count and the total cost *before*
 * anything is sent, and can prune expensive branches. A batch that surprises
 * you with its size is the most expensive bug this system can have.
 */
export function buildMatrix(shot: CanonicalShot, axis: MatrixAxis): MatrixPlan {
  const warnings: string[] = []
  const variations = axis.variations ?? variationsFor(Math.max(1, shot.candidate_count))
  const aspectRatios = axis.aspectRatios?.length ? axis.aspectRatios : [shot.aspect_ratio]
  const resolutions = axis.resolutions?.length ? axis.resolutions : [shot.target_resolution]
  const durations = axis.durations?.length ? axis.durations : [shot.duration_seconds]
  const seeds = axis.seeds.length > 0 ? axis.seeds : [null]

  const cells: MatrixCell[] = []
  let index = 0
  outer: for (const model of axis.models) {
    for (const variation of variations) {
      for (const seed of seeds) {
        for (const aspectRatio of aspectRatios) {
          for (const resolution of resolutions) {
            for (const durationSeconds of durations) {
              if (cells.length >= MAX_MATRIX_CELLS) {
                warnings.push(`matrix truncated at ${MAX_MATRIX_CELLS} cells — narrow the axes rather than submitting a partial batch`)
                break outer
              }
              cells.push({
                index: index++,
                providerId: model.providerId,
                modelId: model.modelId,
                seed,
                variationLabel: variation.label,
                variationInstruction: variation.instruction,
                aspectRatio,
                resolution,
                durationSeconds,
                estimatedMicros: null,
              })
            }
          }
        }
      }
    }
  }

  if (cells.length === 0) warnings.push('matrix is empty — no models were selected')
  if (aspectRatios.length > 1) {
    warnings.push(
      'rendering multiple aspect ratios generates separate clips; for approved footage prefer reframing a single master unless the framing genuinely differs',
    )
  }

  return summarize(cells, warnings)
}

/** Recomputes totals after quotes are attached or cells are pruned. */
export function summarize(cells: MatrixCell[], warnings: string[] = []): MatrixPlan {
  const priced = cells.filter((c) => c.estimatedMicros !== null)
  const estimatedTotalMicros = priced.length > 0 ? priced.reduce((acc, c) => acc + (c.estimatedMicros ?? 0), 0) : null

  const byProviderMap = new Map<string, { count: number; micros: MicroUsd | null }>()
  for (const cell of cells) {
    const entry = byProviderMap.get(cell.providerId) ?? { count: 0, micros: 0 }
    entry.count++
    if (cell.estimatedMicros === null) entry.micros = null
    else if (entry.micros !== null) entry.micros += cell.estimatedMicros
    byProviderMap.set(cell.providerId, entry)
  }

  return {
    cells,
    candidateCount: cells.length,
    estimatedTotalMicros,
    unpricedCount: cells.length - priced.length,
    byProvider: [...byProviderMap.entries()].map(([providerId, entry]) => ({
      providerId,
      count: entry.count,
      estimatedMicros: entry.micros,
    })),
    warnings,
  }
}

export function pruneMatrix(plan: MatrixPlan, predicate: (cell: MatrixCell) => boolean): MatrixPlan {
  return summarize(plan.cells.filter(predicate), plan.warnings)
}

/**
 * Stop-loss: the batch halts once actual spend passes this, so a systematic
 * failure (every candidate rejected) cannot burn the whole budget.
 */
export function defaultStopLoss(plan: MatrixPlan): MicroUsd | null {
  if (plan.estimatedTotalMicros === null) return null
  return Math.round(plan.estimatedTotalMicros * 1.25)
}

export type StandardVariation = (typeof STANDARD_VARIATIONS)[number]
