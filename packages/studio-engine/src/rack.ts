import { AppError } from '@masterclip/shared'
import {
  RACK_STAGES,
  type RackChainRecord,
  type RackModuleRecord,
  type RackModuleSnapshot,
  type RackPresetRecord,
  type RackStage,
  type RackType,
} from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'
import { artistKeyOf } from './room.js'

/**
 * RACK — modular signal-chain processing.
 *
 * Street Banker's own visual and conceptual language: five named stages in a
 * fixed signal order, and modules described by what they do rather than by
 * imitating anybody's plug-in. The module catalogue below is deliberately
 * generic — `de_esser`, `tape_saturation`, `plate_reverb` — with no branding,
 * no faceplate metaphor, and no vendor's parameter naming.
 *
 * A rack is a *stored intent*, not a live DSP graph. It records the chain the
 * artist wants applied, ready to travel with the project to whoever renders it
 * — an engineer, an export, or a future in-platform renderer. Nothing here
 * claims to process audio, which is why the module catalogue can be honest
 * about what each entry is for.
 */
export class StudioRackService {
  constructor(private readonly deps: StudioDeps) {}

  async create(input: { actor: Actor; projectId: string; versionId?: string | null; rackType: RackType; name?: string; fromPresetId?: string }): Promise<{
    chain: RackChainRecord
    modules: RackModuleRecord[]
  }> {
    await this.deps.repos.projects.get(input.actor.orgId, input.projectId)
    const chain = await this.deps.repos.racks.createChain({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      studioVersionId: input.versionId ?? null,
      rackType: input.rackType,
      name: input.name ?? defaultRackName(input.rackType),
      createdBy: input.actor.userId,
    })

    // A new rack starts from a preset if one was named, otherwise from the
    // starting chain for its type. An empty rack is a worse first experience
    // than one a user immediately edits.
    const modules = input.fromPresetId
      ? (await this.deps.repos.racks.getPreset(input.actor.orgId, input.fromPresetId)).modules
      : startingChain(input.rackType)

    const written = await this.deps.repos.racks.replaceModules({
      orgId: input.actor.orgId,
      chainId: chain.id,
      modules,
      action: input.fromPresetId ? 'created from preset' : 'created',
      actorUserId: input.actor.userId,
    })

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'rack.created',
      subjectType: 'rack',
      subjectId: chain.id,
      detail: chain.name,
    })

    return { chain: await this.deps.repos.racks.getChain(input.actor.orgId, chain.id), modules: written }
  }

  async list(actor: Actor, projectId: string) {
    const chains = await this.deps.repos.racks.listChains(actor.orgId, projectId)
    const withModules = []
    for (const chain of chains) {
      withModules.push({ chain, modules: await this.deps.repos.racks.listModules(actor.orgId, chain.id) })
    }
    return withModules
  }

  async get(actor: Actor, chainId: string) {
    const chain = await this.deps.repos.racks.getChain(actor.orgId, chainId)
    return {
      chain,
      modules: await this.deps.repos.racks.listModules(actor.orgId, chainId),
      history: await this.deps.repos.racks.history(actor.orgId, chainId),
    }
  }

  /**
   * Applies a new module list.
   *
   * Every edit — add, remove, bypass, reorder — arrives here as the chain's new
   * state, and every unknown module type is refused rather than silently
   * stored. A rack full of typos that renders as nothing is worse than an
   * error at the point of the mistake.
   */
  async setModules(input: { actor: Actor; chainId: string; modules: RackModuleSnapshot[]; action?: string }): Promise<RackModuleRecord[]> {
    const chain = await this.deps.repos.racks.getChain(input.actor.orgId, input.chainId)
    for (const module of input.modules) {
      const definition = rackModuleDefinition(module.moduleType)
      if (!definition) {
        throw new AppError({ kind: 'validation', code: 'studio.unknown_module', message: `"${module.moduleType}" is not a Street Banker rack module` })
      }
      if (definition.stage !== module.stage) {
        throw new AppError({
          kind: 'validation',
          code: 'studio.module_wrong_stage',
          message: `${definition.label} belongs in the ${definition.stage} stage, not ${module.stage}`,
        })
      }
    }

    const modules = await this.deps.repos.racks.replaceModules({
      orgId: input.actor.orgId,
      chainId: input.chainId,
      modules: input.modules,
      action: input.action ?? 'edited',
      actorUserId: input.actor.userId,
    })

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: chain.studioProjectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'rack.edited',
      subjectType: 'rack',
      subjectId: chain.id,
      detail: input.action ?? `${modules.length} module(s)`,
    })
    return modules
  }

  /** Steps the chain back or forward through its own history. */
  async step(actor: Actor, chainId: string, direction: 'undo' | 'redo'): Promise<{ chain: RackChainRecord; modules: RackModuleRecord[] }> {
    const chain = await this.deps.repos.racks.getChain(actor.orgId, chainId)
    const target = direction === 'undo' ? chain.stateVersion - 1 : chain.stateVersion + 1
    if (target < 1) {
      throw new AppError({ kind: 'validation', code: 'studio.rack_no_history', message: 'this rack is already at its earliest state' })
    }
    const modules = await this.deps.repos.racks.restore(actor.orgId, chainId, target)
    return { chain: await this.deps.repos.racks.getChain(actor.orgId, chainId), modules }
  }

  /**
   * Creates the B chain of an A/B pair by copying A.
   *
   * Both sides are real, editable racks — an A/B where one side is frozen stops
   * being useful the first time somebody wants to try a variation on it.
   */
  async createAlternative(actor: Actor, chainId: string): Promise<{ chain: RackChainRecord; modules: RackModuleRecord[] }> {
    const source = await this.deps.repos.racks.getChain(actor.orgId, chainId)
    const modules = await this.deps.repos.racks.listModules(actor.orgId, chainId)
    const chain = await this.deps.repos.racks.createChain({
      orgId: actor.orgId,
      studioProjectId: source.studioProjectId,
      studioVersionId: source.studioVersionId,
      rackType: source.rackType,
      name: `${source.name} (B)`,
      abSlot: source.abSlot === 'a' ? 'b' : 'a',
      createdBy: actor.userId,
    })
    const written = await this.deps.repos.racks.replaceModules({
      orgId: actor.orgId,
      chainId: chain.id,
      modules: modules.map(({ stage, moduleType, orderIndex, bypassed, params }) => ({ stage, moduleType, orderIndex, bypassed, params })),
      action: `copied from ${source.name}`,
      actorUserId: actor.userId,
    })
    return { chain, modules: written }
  }

  async savePreset(input: { actor: Actor; chainId: string; name: string; scope: 'project' | 'artist' | 'org' }): Promise<RackPresetRecord> {
    const chain = await this.deps.repos.racks.getChain(input.actor.orgId, input.chainId)
    const modules = await this.deps.repos.racks.listModules(input.actor.orgId, input.chainId)
    const project = await this.deps.repos.projects.get(input.actor.orgId, chain.studioProjectId)

    return this.deps.repos.racks.createPreset({
      orgId: input.actor.orgId,
      scope: input.scope,
      studioProjectId: input.scope === 'project' ? project.id : null,
      artistKey: input.scope === 'artist' ? artistKeyOf(project) : null,
      rackType: chain.rackType,
      name: input.name,
      modules: modules.map(({ stage, moduleType, orderIndex, bypassed, params }) => ({ stage, moduleType, orderIndex, bypassed, params })),
      createdBy: input.actor.userId,
    })
  }

  async presets(actor: Actor, projectId: string, rackType?: RackType): Promise<RackPresetRecord[]> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    return this.deps.repos.racks.listPresets(actor.orgId, {
      ...(rackType ? { rackType } : {}),
      projectId: project.id,
      artistKey: artistKeyOf(project),
    })
  }

  async delete(actor: Actor, chainId: string): Promise<void> {
    await this.deps.repos.racks.deleteChain(actor.orgId, chainId)
  }
}

// ---------------------------------------------------------------------------
// the module catalogue
// ---------------------------------------------------------------------------

export interface RackModuleDefinition {
  key: string
  label: string
  stage: RackStage
  /** What it is for, in one sentence a musician reads. */
  description: string
  /** Parameter name → sensible starting value. */
  defaults: Record<string, number | string | boolean>
}

/**
 * Street Banker's own module vocabulary.
 *
 * Named for the job, not for anybody's product. No entry here references a
 * manufacturer, a model number, a famous console or a plug-in's parameter
 * naming, and none of them is skeuomorphic.
 */
export const RACK_MODULES: RackModuleDefinition[] = [
  // CLEAN
  { key: 'noise_reduction', label: 'Noise Reduction', stage: 'clean', description: 'Reduces steady background noise between phrases.', defaults: { amountDb: 6 } },
  { key: 'breath_control', label: 'Breath Control', stage: 'clean', description: 'Softens breaths without removing them.', defaults: { reductionDb: 8 } },
  { key: 'mouth_noise', label: 'Mouth Noise', stage: 'clean', description: 'Reduces clicks and mouth noise between words.', defaults: { sensitivity: 0.5 } },
  { key: 'de_esser', label: 'De-esser', stage: 'clean', description: 'Controls sibilant consonants.', defaults: { thresholdDb: -18, frequencyHz: 7000 } },
  { key: 'high_pass', label: 'High Pass', stage: 'clean', description: 'Removes rumble below the useful range.', defaults: { frequencyHz: 80 } },

  // TUNE
  { key: 'pitch_correction', label: 'Pitch Correction', stage: 'tune', description: 'Corrects intonation, from transparent to hard.', defaults: { strength: 0.4, retuneMs: 30 } },
  { key: 'timing_alignment', label: 'Timing Alignment', stage: 'tune', description: 'Tightens performance timing against the grid.', defaults: { strength: 0.3 } },
  { key: 'stack_alignment', label: 'Stack Alignment', stage: 'tune', description: 'Aligns doubles and stacks to the lead.', defaults: { strength: 0.6 } },

  // SHAPE
  { key: 'subtractive_eq', label: 'Subtractive EQ', stage: 'shape', description: 'Removes what is in the way.', defaults: { bands: 3 } },
  { key: 'tone_eq', label: 'Tone EQ', stage: 'shape', description: 'Broad tonal shaping.', defaults: { lowDb: 0, midDb: 0, highDb: 0 } },
  { key: 'levelling_compressor', label: 'Levelling Compressor', stage: 'shape', description: 'Evens out a performance without changing its character.', defaults: { thresholdDb: -20, ratio: 3 } },
  { key: 'peak_compressor', label: 'Peak Compressor', stage: 'shape', description: 'Catches the loudest moments only.', defaults: { thresholdDb: -8, ratio: 6 } },
  { key: 'dynamic_eq', label: 'Dynamic EQ', stage: 'shape', description: 'Acts on a frequency band only when it gets loud.', defaults: { frequencyHz: 250, thresholdDb: -18 } },
  { key: 'gate', label: 'Gate', stage: 'shape', description: 'Silences the signal below a threshold.', defaults: { thresholdDb: -45 } },

  // COLOR
  { key: 'tape_saturation', label: 'Tape Saturation', stage: 'color', description: 'Soft harmonic thickening with gentle transient rounding.', defaults: { drive: 0.3 } },
  { key: 'tube_drive', label: 'Tube Drive', stage: 'color', description: 'Even-order harmonics for warmth and weight.', defaults: { drive: 0.25 } },
  { key: 'transistor_edge', label: 'Transistor Edge', stage: 'color', description: 'Odd-order harmonics for bite and forwardness.', defaults: { drive: 0.2 } },
  { key: 'exciter', label: 'Exciter', stage: 'color', description: 'Generates high-frequency content for air and presence.', defaults: { amount: 0.2, frequencyHz: 8000 } },

  // SPACE
  { key: 'plate_reverb', label: 'Plate Reverb', stage: 'space', description: 'Dense, bright reverb that sits behind a vocal.', defaults: { decaySeconds: 1.6, mix: 0.15 } },
  { key: 'room_reverb', label: 'Room Reverb', stage: 'space', description: 'Short reflections that place a source in a space.', defaults: { decaySeconds: 0.6, mix: 0.12 } },
  { key: 'hall_reverb', label: 'Hall Reverb', stage: 'space', description: 'Long, diffuse reverb for size.', defaults: { decaySeconds: 2.8, mix: 0.1 } },
  { key: 'slap_delay', label: 'Slap Delay', stage: 'space', description: 'A single short repeat for thickness.', defaults: { timeMs: 90, mix: 0.12 } },
  { key: 'tempo_delay', label: 'Tempo Delay', stage: 'space', description: 'Repeats locked to the tempo.', defaults: { division: '1/8', feedback: 0.25, mix: 0.15 } },
  { key: 'stereo_spread', label: 'Stereo Spread', stage: 'space', description: 'Widens the image above a chosen frequency, leaving the bottom centred.', defaults: { amount: 0.2, aboveHz: 300 } },
]

const MODULE_INDEX = new Map(RACK_MODULES.map((module) => [module.key, module]))

export function rackModuleDefinition(key: string): RackModuleDefinition | undefined {
  return MODULE_INDEX.get(key)
}

export function modulesForStage(stage: RackStage): RackModuleDefinition[] {
  return RACK_MODULES.filter((module) => module.stage === stage)
}

/** A sensible opening chain for each rack type. */
export function startingChain(rackType: RackType): RackModuleSnapshot[] {
  const build = (keys: string[]): RackModuleSnapshot[] =>
    keys
      .map((key) => rackModuleDefinition(key))
      .filter((definition): definition is RackModuleDefinition => definition !== undefined)
      .map((definition, index) => ({ stage: definition.stage, moduleType: definition.key, orderIndex: index, bypassed: false, params: { ...definition.defaults } }))

  switch (rackType) {
    case 'vocal':
      return build(['high_pass', 'de_esser', 'pitch_correction', 'subtractive_eq', 'levelling_compressor', 'tape_saturation', 'plate_reverb'])
    case 'instrument':
      return build(['high_pass', 'tone_eq', 'levelling_compressor', 'room_reverb'])
    case 'mix_bus':
      return build(['tone_eq', 'levelling_compressor', 'tape_saturation'])
    case 'master':
      return build(['tone_eq', 'dynamic_eq', 'tube_drive'])
    default:
      return []
  }
}

function defaultRackName(rackType: RackType): string {
  switch (rackType) {
    case 'vocal':
      return 'Vocal Rack'
    case 'instrument':
      return 'Instrument Rack'
    case 'mix_bus':
      return 'Mix Bus Rack'
    case 'master':
      return 'Master Rack'
    default:
      return 'Custom Rack'
  }
}

export { RACK_STAGES }
