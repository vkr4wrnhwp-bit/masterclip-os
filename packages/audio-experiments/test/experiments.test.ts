import { describe, expect, it } from 'vitest'
import {
  atempoStages,
  buildAlternateOutro,
  buildEarlierChorus,
  buildSectionCut,
  buildSectionDuplicate,
  buildShorterIntro,
  buildTempoExperiment,
  mapSourceToOutput,
  projectEdl,
  validateEdl,
  type BuilderContext,
} from '../src/index.js'
import type { DetectedSection } from '@masterclip/song-analysis'

/**
 * The experiment engine.
 *
 * The properties pinned here are the ones the product's safety story rests on:
 * an edit list describes a change without performing it, the predicted runtime
 * matches what the renderer will produce, and an edit that cannot be rendered
 * is refused before it is stored.
 */

function section(type: string, label: string, startMs: number, endMs: number, orderIndex: number): DetectedSection {
  return { sectionType: type as DetectedSection['sectionType'], label, startMs, endMs, confidence: 0.7, orderIndex }
}

const CONTEXT: BuilderContext = {
  sections: [
    section('intro', 'Intro', 0, 13_000, 0),
    section('verse', 'Verse 1', 13_000, 42_000, 1),
    section('pre_chorus', 'Pre-Chorus 1', 42_000, 56_000, 2),
    section('chorus', 'Chorus 1', 56_000, 83_000, 3),
    section('verse', 'Verse 2', 83_000, 112_000, 4),
    section('chorus', 'Chorus 2', 112_000, 140_000, 5),
    section('final_chorus', 'Final Chorus', 140_000, 175_000, 6),
    section('outro', 'Outro', 175_000, 200_000, 7),
  ],
  durationMs: 200_000,
  bpm: 92,
  beatsPerBar: 4,
}

describe('EDL projection', () => {
  it('predicts the runtime of a removal', () => {
    const outcome = projectEdl([{ type: 'remove_range', sourceStartMs: 10_000, sourceEndMs: 20_000 }], 200_000)
    expect(outcome.durationMs).toBe(190_000)
    expect(outcome.removedMs).toBe(10_000)
  })

  it('predicts the runtime of a duplication', () => {
    const outcome = projectEdl([{ type: 'duplicate_range', sourceStartMs: 0, sourceEndMs: 5_000, destinationMs: 5_000 }], 200_000)
    expect(outcome.durationMs).toBe(205_000)
  })

  it('predicts the runtime of a tempo change', () => {
    // 1.043× faster ≈ 92 → 96 BPM.
    const outcome = projectEdl([{ type: 'time_stretch', value: 96 / 92 }], 200_000)
    expect(outcome.durationMs).toBeLessThan(200_000)
    expect(outcome.durationMs).toBeCloseTo(200_000 * (92 / 96), -2)
  })

  it('maps a surviving source position onto the output', () => {
    const outcome = projectEdl([{ type: 'remove_range', sourceStartMs: 10_000, sourceEndMs: 20_000 }], 200_000)
    // A moment after the cut moves earlier by exactly the cut length.
    expect(mapSourceToOutput(outcome, 30_000)).toBe(20_000)
    // A moment before the cut does not move.
    expect(mapSourceToOutput(outcome, 5_000)).toBe(5_000)
  })

  it('reports a removed position as gone rather than as zero', () => {
    const outcome = projectEdl([{ type: 'remove_range', sourceStartMs: 10_000, sourceEndMs: 20_000 }], 200_000)
    expect(mapSourceToOutput(outcome, 15_000)).toBeNull()
  })
})

describe('EDL validation', () => {
  it('refuses an empty edit list', () => {
    expect(() => validateEdl([], { sourceDurationMs: 200_000 })).toThrow(/at least one edit/)
  })

  it('refuses a range outside the recording', () => {
    expect(() => validateEdl([{ type: 'remove_range', sourceStartMs: 0, sourceEndMs: 500_000 }], { sourceDurationMs: 200_000 })).toThrow(
      /outside the recording/,
    )
  })

  it('refuses an edit list that would remove the whole song', () => {
    expect(() => validateEdl([{ type: 'remove_range', sourceStartMs: 0, sourceEndMs: 200_000 }], { sourceDurationMs: 200_000 })).toThrow(
      /entire recording/,
    )
  })

  it('refuses an extreme time stretch', () => {
    expect(() => validateEdl([{ type: 'time_stretch', value: 4 }], { sourceDurationMs: 200_000 })).toThrow(/time stretch/)
  })

  it('refuses a stem mute when the project has no stems', () => {
    expect(() => validateEdl([{ type: 'stem_mute', stem: 'drums' }], { sourceDurationMs: 200_000, availableStems: [] })).toThrow(
      /no separated "drums" stem/,
    )
  })

  it('accepts a stem mute when the stem exists', () => {
    expect(() => validateEdl([{ type: 'stem_mute', stem: 'drums' }], { sourceDurationMs: 200_000, availableStems: ['drums'] })).not.toThrow()
  })
})

describe('experiment builders', () => {
  it('builds an earlier chorus by trimming the approach, not the chorus', () => {
    const experiment = buildEarlierChorus(CONTEXT, 8)
    expect(experiment).not.toBeNull()
    const edit = experiment!.editDecisionList[0]!
    expect(edit.type).toBe('remove_range')
    // The cut lands at the end of the pre-chorus, immediately before the chorus.
    expect(edit.sourceEndMs).toBe(56_000)
    expect(edit.sourceStartMs!).toBeLessThan(56_000)
    expect(edit.sourceStartMs!).toBeGreaterThanOrEqual(42_000)
  })

  it('snaps a cut to whole bars when tempo and meter are known', () => {
    const experiment = buildEarlierChorus(CONTEXT, 8)!
    const edit = experiment.editDecisionList[0]!
    const barMs = (60_000 / 92) * 4
    const trim = edit.sourceEndMs! - edit.sourceStartMs!
    expect(Math.abs(trim / barMs - Math.round(trim / barMs))).toBeLessThan(0.02)
  })

  it('builds a tempo experiment whose stretch ratio produces the target BPM', () => {
    const experiment = buildTempoExperiment(CONTEXT, 96)!
    expect(experiment.bpmOverride).toBe(96)
    expect(experiment.editDecisionList[0]!.value).toBeCloseTo(96 / 92, 4)
  })

  it('refuses a tempo experiment that changes nothing', () => {
    expect(buildTempoExperiment(CONTEXT, 92)).toBeNull()
  })

  it('shortens the intro from the front', () => {
    const experiment = buildShorterIntro(CONTEXT, 8)!
    const edit = experiment.editDecisionList[0]!
    expect(edit.sourceStartMs).toBe(0)
    expect(edit.sourceEndMs!).toBeLessThan(13_000)
  })

  it('never takes more than two-thirds of a section in a cut', () => {
    const experiment = buildSectionCut(CONTEXT, 1, 60)!
    const edit = experiment.editDecisionList[0]!
    const trim = edit.sourceEndMs! - edit.sourceStartMs!
    expect(trim).toBeLessThanOrEqual((42_000 - 13_000) * 0.67)
  })

  it('duplicates a section immediately after itself', () => {
    const experiment = buildSectionDuplicate(CONTEXT, 6)!
    const edit = experiment.editDecisionList[0]!
    expect(edit.type).toBe('duplicate_range')
    expect(edit.destinationMs).toBe(175_000)
  })

  it('builds an alternate outro that can repeat the final hook', () => {
    const experiment = buildAlternateOutro(CONTEXT, { repeatFinalHook: true })!
    expect(experiment.editDecisionList.some((edit) => edit.type === 'remove_range')).toBe(true)
    expect(experiment.editDecisionList.some((edit) => edit.type === 'duplicate_range')).toBe(true)
  })

  it('returns null when the structure does not contain the needed section', () => {
    const noChorus: BuilderContext = { ...CONTEXT, sections: [section('verse', 'Verse 1', 0, 40_000, 0)] }
    expect(buildEarlierChorus(noChorus, 8)).toBeNull()
    expect(buildShorterIntro(noChorus, 8)).toBeNull()
  })
})

describe('the resilient renderer', () => {
  it('falls back to the placeholder when no real renderer is available', async () => {
    const { ResilientExperimentRenderer } = await import('../src/renderer.js')
    // A renderer that reports itself unavailable stands in for a missing ffmpeg.
    const unavailable = {
      rendererId: 'never',
      version: '0',
      isAvailable: async () => false,
      renderExperiment: async () => {
        throw new Error('should never be called')
      },
    }
    const renderer = new ResilientExperimentRenderer([unavailable])
    const result = await renderer.renderExperiment({
      experimentId: 'sexp_1',
      sourceBytes: new Uint8Array(0),
      sourceMimeType: 'audio/wav',
      sourceDurationMs: 200_000,
      editDecisionList: [{ type: 'remove_range', sourceStartMs: 0, sourceEndMs: 5_000 }],
    })
    // The experiment still completes, and says plainly that the audio is not real.
    expect(result.placeholder).toBe(true)
    expect(result.renderer).toBe('placeholder')
    expect(result.note).toContain('unavailable')
    // The predicted timings are real even though the audio is not.
    expect(result.durationMs).toBe(195_000)
  })

  it('uses a real renderer when one is available', async () => {
    const { ResilientExperimentRenderer } = await import('../src/renderer.js')
    const available = {
      rendererId: 'fake-real',
      version: '1',
      isAvailable: async () => true,
      renderExperiment: async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'audio/wav',
        durationMs: 195_000,
        outcome: projectEdl([{ type: 'remove_range', sourceStartMs: 0, sourceEndMs: 5_000 }], 200_000),
        renderer: 'fake-real',
        rendererVersion: '1',
        placeholder: false,
        note: 'rendered',
      }),
    }
    const result = await new ResilientExperimentRenderer([available]).renderExperiment({
      experimentId: 'sexp_2',
      sourceBytes: new Uint8Array(0),
      sourceMimeType: 'audio/wav',
      sourceDurationMs: 200_000,
      editDecisionList: [{ type: 'remove_range', sourceStartMs: 0, sourceEndMs: 5_000 }],
    })
    expect(result.placeholder).toBe(false)
    expect(result.renderer).toBe('fake-real')
  })
})

describe('atempo staging', () => {
  it("chains stages so each stays inside ffmpeg's 0.5-2.0 range", () => {
    for (const ratio of [0.7, 1.04, 1.5, 2.5, 0.4]) {
      const stages = atempoStages(ratio)
      expect(stages.every((stage) => stage >= 0.5 && stage <= 2)).toBe(true)
      expect(stages.reduce((product, stage) => product * stage, 1)).toBeCloseTo(ratio, 6)
    }
  })
})
