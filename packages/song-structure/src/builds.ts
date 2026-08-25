import { mean, type AnalysisFrames, type DetectedSection, type SectionFeatures, type SectionType } from '@masterclip/song-analysis'
import type { SectionContrast } from './metrics.js'

/**
 * Build intelligence.
 *
 * Looks at the transition *into* the sections that are meant to land — chorus,
 * drop, final chorus, bridge, breakdown, outro — and measures how much
 * arrangement change the listener is actually given at that moment.
 *
 * It measures the transition. It does not decide whether the transition is
 * good: a deliberately flat entry into a chorus is a valid choice, and the
 * output is phrased so the artist can tell the difference between "we found
 * nothing" and "we found something you may have meant".
 */

/** Sections whose entrances are worth analysing. */
export const BUILD_TARGETS: SectionType[] = ['chorus', 'final_chorus', 'drop', 'bridge', 'breakdown', 'outro', 'post_chorus']

export interface BuildAnalysis {
  targetOrderIndex: number
  targetLabel: string
  targetType: SectionType
  approachLabel: string
  startMs: number
  /** 0–1 composite of how much changes across the transition. */
  transitionStrength: number
  band: 'strong' | 'moderate' | 'minimal'
  signals: {
    energyDelta: number
    transientDelta: number
    lowFrequencyDelta: number
    spectralDelta: number
    vocalDelta: number | null
    stereoWidthDelta: number | null
    /** Seconds of near-silence immediately before the target section. */
    preGapSeconds: number
  }
  /** Neutral, evidence-anchored description. Never a verdict. */
  observation: string
  /** Ideas the artist can try. Presented as options, never applied. */
  experimentIdeas: string[]
  /** Which of the ideas this deployment can actually render as audio. */
  renderableWithStems: boolean
}

export interface BuildInput {
  sections: DetectedSection[]
  features: SectionFeatures[]
  contrasts: SectionContrast[]
  frames?: AnalysisFrames | null
  /** True when separated stems exist, which unlocks mute-based experiments. */
  hasStems?: boolean
}

export function analyzeBuilds(input: BuildInput): BuildAnalysis[] {
  const out: BuildAnalysis[] = []
  for (const section of input.sections) {
    if (!BUILD_TARGETS.includes(section.sectionType)) continue
    const previous = input.sections.find((candidate) => candidate.orderIndex === section.orderIndex - 1)
    if (!previous) continue
    const contrast = input.contrasts.find((entry) => entry.toOrderIndex === section.orderIndex)
    if (!contrast) continue

    const preGapSeconds = silenceBefore(section.startMs, input.frames ?? null)
    // Weighted so the things a listener actually notices at a transition —
    // level, drum activity, low end — count for most of the score.
    const strength = clamp(
      Math.abs(contrast.energyDelta) * 1.6 +
        Math.abs(contrast.transientDelta) * 1.2 +
        Math.abs(contrast.lowFrequencyDelta) * 1.0 +
        Math.abs(contrast.spectralDelta) * 0.6 +
        Math.abs(contrast.vocalDelta ?? 0) * 0.8 +
        Math.abs(contrast.stereoWidthDelta ?? 0) * 0.6 +
        Math.min(0.3, preGapSeconds * 2),
    )
    const band: BuildAnalysis['band'] = strength >= 0.55 ? 'strong' : strength >= 0.28 ? 'moderate' : 'minimal'

    out.push({
      targetOrderIndex: section.orderIndex,
      targetLabel: section.label,
      targetType: section.sectionType,
      approachLabel: previous.label,
      startMs: section.startMs,
      transitionStrength: round(strength),
      band,
      signals: {
        energyDelta: contrast.energyDelta,
        transientDelta: contrast.transientDelta,
        lowFrequencyDelta: contrast.lowFrequencyDelta,
        spectralDelta: contrast.spectralDelta,
        vocalDelta: contrast.vocalDelta,
        stereoWidthDelta: contrast.stereoWidthDelta,
        preGapSeconds: round(preGapSeconds),
      },
      observation: describe(band, previous.label, section.label),
      experimentIdeas: ideasFor(band, section.sectionType),
      renderableWithStems: Boolean(input.hasStems),
    })
  }
  return out
}

function describe(band: BuildAnalysis['band'], approach: string, target: string): string {
  switch (band) {
    case 'strong':
      return `${approach} produces a large measured change in arrangement and level going into ${target}.`
    case 'moderate':
      return `${approach} produces a moderate measured change going into ${target}.`
    default:
      return `${approach} produces relatively little measured arrangement contrast before ${target}.`
  }
}

function ideasFor(band: BuildAnalysis['band'], type: SectionType): string[] {
  if (band === 'strong') {
    return [
      'The transition already carries a large change — worth checking it is not so large that it reads as a different song.',
      'Try holding one element back until the second half of the section, so there is somewhere left to go.',
    ]
  }
  const shared = [
    'Remove the kick for the first four bars of the approach.',
    'Increase rhythmic subdivision across the final two bars.',
    'Drop the bass on the last beat before the change.',
    'Insert a brief pause immediately before the section starts.',
    'Delay full stereo width until the section lands.',
  ]
  if (type === 'final_chorus') {
    return [
      'Introduce one element here that has not appeared before in the song.',
      'Reintroduce an existing backing-vocal layer only in this section.',
      ...shared.slice(0, 3),
    ]
  }
  if (type === 'outro') {
    return ['Try ending on the hook rather than an instrumental tail.', 'Try a shorter tail and hear whether the ending lands harder.']
  }
  return shared
}

/** Longest run of very low energy in the two seconds before a section starts. */
function silenceBefore(startMs: number, frames: AnalysisFrames | null): number {
  if (!frames || frames.count === 0) return 0
  const startFrame = Math.floor(startMs / 1000 / frames.frameSeconds)
  const from = Math.max(0, startFrame - Math.ceil(2 / frames.frameSeconds))
  let run = 0
  let best = 0
  const reference = mean(frames.energy)
  for (let i = from; i < Math.min(frames.count, startFrame); i++) {
    if (frames.energy[i]! < reference * 0.15) {
      run++
      if (run > best) best = run
    } else run = 0
  }
  return best * frames.frameSeconds
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
