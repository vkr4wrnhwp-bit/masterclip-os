import {
  assertGenerationAllowed,
  type AudioIntelligenceProvider,
  type GeneratedOption,
  type SceneGenerationInput,
  type SceneGenerationResult,
} from './provider.js'
import { durationMsOf, synthesizeWav } from './wav.js'

/**
 * The mock audio provider.
 *
 * Renders three genuinely different, tempo-locked options for every request
 * using the local synthesizer. Free, offline, and deterministic per seed —
 * which is exactly what tests, the demo set, and credential-less deployments
 * need. Real providers replace the synthesis, not the contract.
 */

const ENERGY_LEVELS: Record<string, number> = {
  sparse: 0.15,
  low: 0.35,
  medium: 0.6,
  high: 0.8,
  peak: 1,
}

export class MockAudioProvider implements AudioIntelligenceProvider {
  readonly id = 'mock-audio'
  readonly displayName = 'Local synthesis (mock)'

  available(): boolean {
    return true
  }

  async generateScene(input: SceneGenerationInput): Promise<SceneGenerationResult> {
    assertGenerationAllowed(input.request)
    const energy = ENERGY_LEVELS[input.request.energy] ?? 0.6
    const wantsDrums =
      input.request.instrumentation.length === 0 ||
      input.request.instrumentation.some((i) => /drum|perc|beat|kick|hat/i.test(i))
    const wantsBass = input.request.instrumentation.length === 0 || input.request.instrumentation.some((i) => /bass|808|sub/i.test(i))
    const wantsPad =
      input.request.instrumentation.length === 0 || input.request.instrumentation.some((i) => /pad|synth|key|chord|music|ambient/i.test(i))
    const wantsRiser = /riser|build|transition|drop/i.test(`${input.request.prompt} ${input.request.intendedTransition}`)

    const options: GeneratedOption[] = []
    const shapes = [
      { label: 'OPTION A', description: 'as described', energyScale: 1, extraRiser: false },
      { label: 'OPTION B', description: 'sparser take, later drum entry', energyScale: 0.6, extraRiser: false },
      { label: 'OPTION C', description: 'higher-energy take with riser into the transition', energyScale: 1.2, extraRiser: true },
    ]

    for (const [index, shape] of shapes.entries()) {
      const shapedEnergy = Math.max(0.1, Math.min(1, energy * shape.energyScale))
      const wavBytes = synthesizeWav({
        bpm: input.bpm,
        bars: input.request.bars,
        beatsPerBar: input.beatsPerBar,
        energy: shapedEnergy,
        layers: {
          kick: wantsDrums,
          hat: wantsDrums && shapedEnergy > 0.25,
          bass: wantsBass,
          pad: wantsPad,
          riser: wantsRiser || shape.extraRiser,
        },
        seed: input.seed + index * 7919,
      })
      options.push({
        label: shape.label,
        wavBytes,
        durationMs: durationMsOf({ bpm: input.bpm, bars: input.request.bars, beatsPerBar: input.beatsPerBar }),
        description: shape.description,
      })
    }

    return { options, model: 'mock-synth-1', costMicros: 0 }
  }
}
