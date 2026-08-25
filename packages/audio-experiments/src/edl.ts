import { AppError } from '@masterclip/shared'

/**
 * The edit decision list.
 *
 * An experiment is a *description* of an edit, never a rewritten file. That is
 * the entire safety model of this feature: the source asset is opened read-only,
 * a preview is rendered to a new asset, and the EDL is what gets stored, so any
 * experiment can be re-rendered, inspected, reversed, or compared long after the
 * preview bytes have expired.
 *
 * Times are milliseconds against the *source* timeline throughout. An edit never
 * refers to a position in its own output, because that would make the list
 * order-dependent and unreadable.
 */

export const EXPERIMENT_EDIT_TYPES = [
  'remove_range',
  'duplicate_range',
  'move_range',
  'time_stretch',
  'insert_silence',
  'gain_change',
  'stem_mute',
] as const

export type ExperimentEditType = (typeof EXPERIMENT_EDIT_TYPES)[number]

export interface ExperimentEdit {
  type: ExperimentEditType
  /** Source-timeline start of the affected range. */
  sourceStartMs?: number
  /** Source-timeline end of the affected range. */
  sourceEndMs?: number
  /** Source-timeline insertion point, for duplicate/move/insert_silence. */
  destinationMs?: number
  /**
   * Meaning depends on `type`: playback-rate multiplier for `time_stretch`,
   * gain in dB for `gain_change`, duration in ms for `insert_silence`.
   */
  value?: number
  /** Which stem to mute, for `stem_mute`. */
  stem?: string
  /** Free-text note carried into the version history. */
  note?: string
}

export type ExperimentType =
  | 'earlier_chorus'
  | 'shorter_intro'
  | 'section_cut'
  | 'section_duplicate'
  | 'tempo'
  | 'alternate_outro'
  | 'arrangement'
  | 'custom'

export interface ExperimentDefinition {
  name: string
  experimentType: ExperimentType
  editDecisionList: ExperimentEdit[]
  /** Target BPM for a tempo experiment. Null for edit-only experiments. */
  bpmOverride: number | null
  /** What the user asked for, in their own words or the generated summary. */
  intent: string
}

/** The most a single experiment may stretch, in either direction. */
const MAX_STRETCH_RATIO = 1.35
const MIN_STRETCH_RATIO = 0.7

export interface EdlValidationContext {
  sourceDurationMs: number
  /** Stems available for muting. Empty when the project has none. */
  availableStems?: string[]
}

/**
 * Rejects an EDL that could not be rendered, or that would produce something
 * misleading. Called before an experiment is persisted, so a stored EDL is
 * always renderable.
 */
export function validateEdl(edits: ExperimentEdit[], context: EdlValidationContext): void {
  if (edits.length === 0) {
    throw new AppError({ kind: 'validation', code: 'song_lab.empty_edl', message: 'an experiment needs at least one edit' })
  }
  if (edits.length > 64) {
    throw new AppError({ kind: 'validation', code: 'song_lab.edl_too_long', message: 'an experiment is limited to 64 edits' })
  }

  for (const [index, edit] of edits.entries()) {
    const at = `edit ${index + 1}`
    const needsRange = edit.type === 'remove_range' || edit.type === 'duplicate_range' || edit.type === 'move_range' || edit.type === 'gain_change'
    if (needsRange) {
      requireRange(edit, at, context.sourceDurationMs)
    }
    if (edit.type === 'duplicate_range' || edit.type === 'move_range' || edit.type === 'insert_silence') {
      if (edit.destinationMs === undefined || edit.destinationMs < 0 || edit.destinationMs > context.sourceDurationMs) {
        throw invalid(`${at}: destinationMs must fall inside the source`)
      }
    }
    if (edit.type === 'time_stretch') {
      const ratio = edit.value ?? 1
      if (!Number.isFinite(ratio) || ratio < MIN_STRETCH_RATIO || ratio > MAX_STRETCH_RATIO) {
        throw invalid(`${at}: time stretch must stay between ${MIN_STRETCH_RATIO}× and ${MAX_STRETCH_RATIO}×`)
      }
    }
    if (edit.type === 'insert_silence') {
      const duration = edit.value ?? 0
      if (!Number.isFinite(duration) || duration <= 0 || duration > 30_000) {
        throw invalid(`${at}: inserted silence must be between 1 ms and 30 s`)
      }
    }
    if (edit.type === 'gain_change') {
      const gain = edit.value ?? 0
      if (!Number.isFinite(gain) || gain < -60 || gain > 12) throw invalid(`${at}: gain must be between −60 dB and +12 dB`)
    }
    if (edit.type === 'stem_mute') {
      // Offering a stem mute where no stems exist would promise audio the
      // system cannot produce. The suggestion is still shown in Build
      // Intelligence — as a suggestion, not as a renderable experiment.
      if (!edit.stem) throw invalid(`${at}: a stem mute must name a stem`)
      if (!context.availableStems?.includes(edit.stem)) {
        throw invalid(`${at}: this project has no separated "${edit.stem}" stem, so it cannot be muted`)
      }
    }
  }

  const removed = edits
    .filter((edit) => edit.type === 'remove_range')
    .reduce((total, edit) => total + ((edit.sourceEndMs ?? 0) - (edit.sourceStartMs ?? 0)), 0)
  if (removed >= context.sourceDurationMs) {
    throw invalid('these edits would remove the entire recording')
  }
}

function requireRange(edit: ExperimentEdit, at: string, durationMs: number): void {
  const start = edit.sourceStartMs
  const end = edit.sourceEndMs
  if (start === undefined || end === undefined) throw invalid(`${at}: needs sourceStartMs and sourceEndMs`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw invalid(`${at}: range values must be numbers`)
  if (start < 0 || end > durationMs) throw invalid(`${at}: range falls outside the recording`)
  if (end - start < 50) throw invalid(`${at}: range must be at least 50 ms`)
}

function invalid(message: string): AppError {
  return new AppError({ kind: 'validation', code: 'song_lab.invalid_edl', message })
}

export interface EdlOutcome {
  /** Predicted runtime of the rendered preview, in ms. */
  durationMs: number
  /** Source→output time mapping, so section markers can be carried across. */
  segments: Array<{ sourceStartMs: number; sourceEndMs: number; outputStartMs: number; stretch: number }>
  removedMs: number
  addedMs: number
  stretchRatio: number
}

/**
 * Applies an EDL on paper.
 *
 * Used to show the artist the new runtime and where each section will land
 * *before* anything is rendered, and by the renderer to build its filter graph.
 * One implementation, so the preview and the prediction cannot disagree.
 */
export function projectEdl(edits: ExperimentEdit[], sourceDurationMs: number): EdlOutcome {
  // Build the output as an ordered list of source spans.
  let spans: Array<{ sourceStartMs: number; sourceEndMs: number; silent?: boolean }> = [
    { sourceStartMs: 0, sourceEndMs: sourceDurationMs },
  ]

  const ordered = [...edits].sort((a, b) => editRank(a) - editRank(b))
  for (const edit of ordered) {
    switch (edit.type) {
      case 'remove_range':
        spans = cut(spans, edit.sourceStartMs!, edit.sourceEndMs!)
        break
      case 'duplicate_range':
        spans = insertAt(spans, edit.destinationMs!, { sourceStartMs: edit.sourceStartMs!, sourceEndMs: edit.sourceEndMs! })
        break
      case 'move_range': {
        const moved = { sourceStartMs: edit.sourceStartMs!, sourceEndMs: edit.sourceEndMs! }
        spans = insertAt(cut(spans, moved.sourceStartMs, moved.sourceEndMs), edit.destinationMs!, moved)
        break
      }
      case 'insert_silence':
        spans = insertAt(spans, edit.destinationMs!, {
          sourceStartMs: edit.destinationMs!,
          sourceEndMs: edit.destinationMs! + (edit.value ?? 0),
          silent: true,
        })
        break
      default:
        // gain_change, stem_mute and time_stretch do not alter the span layout.
        break
    }
  }

  const stretch = edits.find((edit) => edit.type === 'time_stretch')?.value ?? 1
  const segments: EdlOutcome['segments'] = []
  let outputMs = 0
  for (const span of spans) {
    const length = (span.sourceEndMs - span.sourceStartMs) / stretch
    segments.push({
      sourceStartMs: Math.round(span.sourceStartMs),
      sourceEndMs: Math.round(span.sourceEndMs),
      outputStartMs: Math.round(outputMs),
      stretch,
    })
    outputMs += length
  }

  const kept = spans.reduce((total, span) => total + (span.sourceEndMs - span.sourceStartMs), 0)
  const duplicated = spans.filter((span) => span.silent).reduce((total, span) => total + (span.sourceEndMs - span.sourceStartMs), 0)

  return {
    durationMs: Math.round(outputMs),
    segments,
    removedMs: Math.max(0, Math.round(sourceDurationMs - kept + duplicated)),
    addedMs: Math.max(0, Math.round(kept - sourceDurationMs + duplicated)),
    stretchRatio: stretch,
  }
}

/** Removals run first so later insert positions refer to a stable timeline. */
function editRank(edit: ExperimentEdit): number {
  switch (edit.type) {
    case 'remove_range':
      return 0
    case 'move_range':
      return 1
    case 'duplicate_range':
      return 2
    case 'insert_silence':
      return 3
    default:
      return 4
  }
}

function cut(
  spans: Array<{ sourceStartMs: number; sourceEndMs: number; silent?: boolean }>,
  fromMs: number,
  toMs: number,
): Array<{ sourceStartMs: number; sourceEndMs: number; silent?: boolean }> {
  const out: typeof spans = []
  for (const span of spans) {
    if (span.sourceEndMs <= fromMs || span.sourceStartMs >= toMs) {
      out.push(span)
      continue
    }
    if (span.sourceStartMs < fromMs) out.push({ ...span, sourceEndMs: fromMs })
    if (span.sourceEndMs > toMs) out.push({ ...span, sourceStartMs: toMs })
  }
  return out
}

function insertAt(
  spans: Array<{ sourceStartMs: number; sourceEndMs: number; silent?: boolean }>,
  atMs: number,
  inserted: { sourceStartMs: number; sourceEndMs: number; silent?: boolean },
): Array<{ sourceStartMs: number; sourceEndMs: number; silent?: boolean }> {
  const out: typeof spans = []
  let cursor = 0
  let placed = false
  for (const span of spans) {
    const length = span.sourceEndMs - span.sourceStartMs
    if (!placed && atMs <= cursor + length) {
      const offset = atMs - cursor
      if (offset > 0) out.push({ ...span, sourceEndMs: span.sourceStartMs + offset })
      out.push(inserted)
      if (offset < length) out.push({ ...span, sourceStartMs: span.sourceStartMs + offset })
      placed = true
    } else {
      out.push(span)
    }
    cursor += length
  }
  if (!placed) out.push(inserted)
  return out
}

/** Maps a source-timeline position onto the rendered output. */
export function mapSourceToOutput(outcome: EdlOutcome, sourceMs: number): number | null {
  for (const segment of outcome.segments) {
    if (sourceMs >= segment.sourceStartMs && sourceMs <= segment.sourceEndMs) {
      return Math.round(segment.outputStartMs + (sourceMs - segment.sourceStartMs) / segment.stretch)
    }
  }
  // The position was cut. Null, not zero — "this moment is gone" is the answer.
  return null
}
