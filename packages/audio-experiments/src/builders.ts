import type { DetectedSection } from '@masterclip/song-analysis'
import type { ExperimentDefinition, ExperimentEdit } from './edl.js'

/**
 * Experiment builders.
 *
 * Turns "bring the chorus forward" into a concrete, bar-aware edit list. Cuts
 * are snapped to bar lines wherever tempo and meter are known well enough,
 * because an edit that lands off the bar is not a musical experiment — it is a
 * glitch the artist will (rightly) dismiss without hearing the idea.
 */

export interface BuilderContext {
  sections: DetectedSection[]
  durationMs: number
  bpm: number | null
  beatsPerBar: number | null
}

/** Bar length in ms, or null when tempo/meter are not solid enough to use. */
export function barMs(context: BuilderContext): number | null {
  if (!context.bpm || context.bpm <= 0) return null
  const beats = context.beatsPerBar ?? 4
  return (60_000 / context.bpm) * beats
}

/** Rounds a duration to a whole number of bars, never below one bar. */
export function snapToBars(durationMs: number, context: BuilderContext): number {
  const bar = barMs(context)
  if (!bar) return Math.round(durationMs)
  const bars = Math.max(1, Math.round(durationMs / bar))
  return Math.round(bars * bar)
}

function findSection(context: BuilderContext, predicate: (section: DetectedSection) => boolean): DetectedSection | null {
  return [...context.sections].sort((a, b) => a.startMs - b.startMs).find(predicate) ?? null
}

/**
 * Earlier chorus.
 *
 * Removes time from the *end* of the section immediately before the first
 * chorus — the last bars of a verse or pre-chorus — rather than from its start.
 * Cutting the start would remove the section's own entrance; cutting the tail
 * shortens the approach, which is what "get there sooner" actually means.
 */
export function buildEarlierChorus(context: BuilderContext, targetSecondsEarlier: number): ExperimentDefinition | null {
  const chorus = findSection(context, (section) => section.sectionType === 'chorus' || section.sectionType === 'hook' || section.sectionType === 'drop')
  if (!chorus) return null
  const approach = [...context.sections].sort((a, b) => a.startMs - b.startMs).filter((section) => section.endMs <= chorus.startMs).pop()
  if (!approach) return null

  const requested = Math.max(1000, targetSecondsEarlier * 1000)
  const available = approach.endMs - approach.startMs
  // Never take more than two-thirds of the approach: past that the section
  // stops being itself and the experiment answers a different question.
  const trim = snapToBars(Math.min(requested, available * 0.66), context)
  if (trim < 500) return null

  const edits: ExperimentEdit[] = [
    {
      type: 'remove_range',
      sourceStartMs: Math.round(approach.endMs - trim),
      sourceEndMs: approach.endMs,
      note: `removes ${describeTrim(trim, context)} from the end of ${approach.label}`,
    },
  ]
  return {
    name: 'Earlier chorus',
    experimentType: 'earlier_chorus',
    editDecisionList: edits,
    bpmOverride: null,
    intent: `Chorus approximately ${Math.round(trim / 1000)} seconds earlier.`,
  }
}

/** Shorter intro. Trims from the front, keeping the final bars so the handover
 *  into the first section still resolves. */
export function buildShorterIntro(context: BuilderContext, targetSeconds: number): ExperimentDefinition | null {
  const intro = findSection(context, (section) => section.sectionType === 'intro')
  if (!intro) return null
  const current = intro.endMs - intro.startMs
  const target = Math.max(0, targetSeconds * 1000)
  if (current - target < 500) return null
  const trim = snapToBars(current - target, context)
  if (trim >= current) return null

  return {
    name: 'Shorter intro',
    experimentType: 'shorter_intro',
    editDecisionList: [
      {
        type: 'remove_range',
        sourceStartMs: intro.startMs,
        sourceEndMs: Math.round(intro.startMs + trim),
        note: `intro reduced from ${Math.round(current / 1000)}s to about ${Math.round((current - trim) / 1000)}s`,
      },
    ],
    bpmOverride: null,
    intent: `Intro shortened by about ${Math.round(trim / 1000)} seconds, so the vocal appears sooner.`,
  }
}

/** Removes a named section's tail — the generic "this part is long" experiment. */
export function buildSectionCut(context: BuilderContext, sectionOrderIndex: number, secondsToRemove: number): ExperimentDefinition | null {
  const section = context.sections.find((candidate) => candidate.orderIndex === sectionOrderIndex)
  if (!section) return null
  const available = section.endMs - section.startMs
  const trim = snapToBars(Math.min(secondsToRemove * 1000, available * 0.66), context)
  if (trim < 500) return null

  return {
    name: `Shorter ${section.label.toLowerCase()}`,
    experimentType: 'section_cut',
    editDecisionList: [
      {
        type: 'remove_range',
        sourceStartMs: Math.round(section.endMs - trim),
        sourceEndMs: section.endMs,
        note: `removes ${describeTrim(trim, context)} from ${section.label}`,
      },
    ],
    bpmOverride: null,
    intent: `${section.label} shortened by about ${Math.round(trim / 1000)} seconds.`,
  }
}

/** Repeats a section immediately after itself — usually the final hook. */
export function buildSectionDuplicate(context: BuilderContext, sectionOrderIndex: number): ExperimentDefinition | null {
  const section = context.sections.find((candidate) => candidate.orderIndex === sectionOrderIndex)
  if (!section) return null
  return {
    name: `Repeat ${section.label.toLowerCase()}`,
    experimentType: 'section_duplicate',
    editDecisionList: [
      {
        type: 'duplicate_range',
        sourceStartMs: section.startMs,
        sourceEndMs: section.endMs,
        destinationMs: section.endMs,
        note: `repeats ${section.label} once`,
      },
    ],
    bpmOverride: null,
    intent: `${section.label} repeated once.`,
  }
}

/**
 * Tempo change with pitch preserved.
 *
 * The stretch ratio is target ÷ current, so the *output* plays at the target
 * BPM. Runtime falls out of that automatically and is shown before rendering.
 */
export function buildTempoExperiment(context: BuilderContext, targetBpm: number): ExperimentDefinition | null {
  if (!context.bpm || context.bpm <= 0 || targetBpm <= 0) return null
  const ratio = targetBpm / context.bpm
  if (Math.abs(ratio - 1) < 0.005) return null
  return {
    name: `${targetBpm > context.bpm ? '+' : ''}${Math.round((targetBpm - context.bpm) * 10) / 10} BPM`,
    experimentType: 'tempo',
    editDecisionList: [
      {
        type: 'time_stretch',
        value: Math.round(ratio * 10000) / 10000,
        note: `${Math.round(context.bpm)} → ${Math.round(targetBpm)} BPM, pitch preserved`,
      },
    ],
    bpmOverride: targetBpm,
    intent: `Tempo moved from ${Math.round(context.bpm)} to ${Math.round(targetBpm)} BPM with pitch preserved.`,
  }
}

/**
 * Alternate outro: drop the tail, optionally repeating the final hook to hold a
 * comparable runtime.
 */
export function buildAlternateOutro(context: BuilderContext, opts: { repeatFinalHook?: boolean } = {}): ExperimentDefinition | null {
  const ordered = [...context.sections].sort((a, b) => a.startMs - b.startMs)
  const outro = ordered[ordered.length - 1]
  if (!outro || outro.sectionType !== 'outro') return null
  const hook = [...ordered].reverse().find((section) => section.sectionType === 'final_chorus' || section.sectionType === 'chorus' || section.sectionType === 'hook')

  const edits: ExperimentEdit[] = [
    { type: 'remove_range', sourceStartMs: outro.startMs, sourceEndMs: outro.endMs, note: 'removes the instrumental outro' },
  ]
  if (opts.repeatFinalHook && hook) {
    edits.push({
      type: 'duplicate_range',
      sourceStartMs: hook.startMs,
      sourceEndMs: hook.endMs,
      destinationMs: outro.startMs,
      note: `repeats ${hook.label} in place of the outro`,
    })
  }

  return {
    name: opts.repeatFinalHook ? 'Alternate outro — repeat the hook' : 'Alternate outro — hard ending',
    experimentType: 'alternate_outro',
    editDecisionList: edits,
    bpmOverride: null,
    intent: opts.repeatFinalHook
      ? 'Ends on a repeat of the final hook instead of the instrumental tail.'
      : 'Ends where the final hook ends, with no instrumental tail.',
  }
}

function describeTrim(trimMs: number, context: BuilderContext): string {
  const bar = barMs(context)
  if (!bar) return `${Math.round(trimMs / 1000)} seconds`
  const bars = Math.round(trimMs / bar)
  return `${bars} bar${bars === 1 ? '' : 's'} (about ${Math.round(trimMs / 1000)} seconds)`
}
