import { z } from 'zod/v4'

/**
 * The Live Lab vocabulary.
 *
 * These schemas are the contract between the API, the web workspace, the Live
 * Engine, and (later) the desktop application. They deliberately contain no
 * database or React types: a performance package written today must still be
 * loadable by a player that has never seen the server.
 */

export const SCENE_TYPES = [
  'intro',
  'verse',
  'pre_chorus',
  'chorus',
  'break',
  'build',
  'drop',
  'bridge',
  'interlude',
  'outro',
  'custom',
] as const
export const SceneType = z.enum(SCENE_TYPES)
export type SceneType = z.infer<typeof SceneType>

export const SET_ITEM_TYPES = ['song', 'interlude', 'walk_on', 'encore', 'outro', 'generated_scene'] as const
export const SetItemType = z.enum(SET_ITEM_TYPES)
export type SetItemType = z.infer<typeof SetItemType>

export const STEM_TYPES = ['vocal', 'drums', 'bass', 'music', 'fx', 'click', 'custom'] as const
export const StemType = z.enum(STEM_TYPES)
export type StemType = z.infer<typeof StemType>

/** Launch quantization boundaries. A clip triggered early queues until the boundary. */
export const QUANTIZATIONS = ['none', '1/4', '1/2', '1bar', '2bars', '4bars', 'scene_end'] as const
export const Quantization = z.enum(QUANTIZATIONS)
export type Quantization = z.infer<typeof Quantization>

export const FOLLOW_ACTIONS = ['stop', 'loop', 'next_scene', 'target'] as const
export const FollowAction = z.enum(FOLLOW_ACTIONS)
export type FollowAction = z.infer<typeof FollowAction>

export const OUTPUT_TYPES = ['master', 'cue', 'click', 'stem', 'custom'] as const
export const LiveOutputType = z.enum(OUTPUT_TYPES)
export type LiveOutputType = z.infer<typeof LiveOutputType>

/**
 * Audio output abstraction. The web MVP renders master (and, where the device
 * supports it, cue/click) but the shape already carries device and channel so
 * the desktop build can route stems to interface outputs without a migration.
 */
export const LiveOutput = z.object({
  id: z.string(),
  name: z.string(),
  type: LiveOutputType,
  deviceId: z.string().optional(),
  channelIndex: z.number().int().min(0).optional(),
})
export type LiveOutput = z.infer<typeof LiveOutput>

// ------------------------------------------------------------------- pads ----

export const PAD_MODES = [
  'clip',
  'scene',
  'stem_mute',
  'stem_solo',
  'fx',
  'transition',
  'stop',
  'next_song',
  'prev_song',
  'custom',
  'empty',
] as const
export const PadMode = z.enum(PAD_MODES)
export type PadMode = z.infer<typeof PadMode>

export const PadAssignment = z.object({
  index: z.number().int().min(0).max(15),
  mode: PadMode,
  label: z.string(),
  targetId: z.string().nullable(),
  color: z.string(),
})
export type PadAssignment = z.infer<typeof PadAssignment>

export const PAD_STATES = ['empty', 'loaded', 'armed', 'playing', 'queued', 'looping', 'muted', 'error'] as const
export type PadState = (typeof PAD_STATES)[number]

/** A 4x4 grid with STOP on the last pad — the default every new project gets. */
export function defaultPadMap(): PadAssignment[] {
  const pads: PadAssignment[] = []
  for (let index = 0; index < 16; index++) {
    pads.push({ index, mode: index === 15 ? 'stop' : 'empty', label: index === 15 ? 'STOP' : '', targetId: null, color: '' })
  }
  return pads
}

// ---------------------------------------------------------------- records ----

export const LiveProject = z.object({
  id: z.string(),
  organizationId: z.string(),
  artistId: z.string().nullable(),
  name: z.string().min(1),
  description: z.string(),
  status: z.enum(['active', 'archived']),
  masterTempo: z.number().min(20).max(400),
  timeSignature: z.string().regex(/^\d{1,2}\/\d{1,2}$/),
  sourceReleaseIds: z.array(z.string()),
  padMap: z.array(PadAssignment).max(16),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type LiveProject = z.infer<typeof LiveProject>

export const LiveSetItem = z.object({
  id: z.string(),
  organizationId: z.string(),
  liveProjectId: z.string(),
  sortOrder: z.number().int(),
  type: SetItemType,
  title: z.string().min(1),
  sourceReleaseId: z.string().nullable(),
  sourceTrackId: z.string().nullable(),
  bpm: z.number().min(20).max(400).nullable(),
  key: z.string().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  notes: z.string(),
})
export type LiveSetItem = z.infer<typeof LiveSetItem>

export const LiveScene = z.object({
  id: z.string(),
  organizationId: z.string(),
  liveProjectId: z.string(),
  liveSetItemId: z.string(),
  name: z.string().min(1),
  sceneType: SceneType,
  sortOrder: z.number().int(),
  color: z.string(),
  bpm: z.number().min(20).max(400).nullable(),
  key: z.string().nullable(),
  bars: z.number().int().min(1).nullable(),
  quantization: Quantization,
  loopEnabled: z.boolean(),
  followAction: FollowAction,
  followTargetSceneId: z.string().nullable(),
})
export type LiveScene = z.infer<typeof LiveScene>

export const LiveClip = z.object({
  id: z.string(),
  organizationId: z.string(),
  liveProjectId: z.string(),
  liveSceneId: z.string(),
  name: z.string(),
  sourceAssetId: z.string(),
  startMs: z.number().min(0),
  endMs: z.number().min(0).nullable(),
  loopStartMs: z.number().min(0).nullable(),
  loopEndMs: z.number().min(0).nullable(),
  oneShot: z.boolean(),
  gain: z.number().min(0).max(2),
  pan: z.number().min(-1).max(1),
  outputId: z.string().nullable(),
})
export type LiveClip = z.infer<typeof LiveClip>

export const LiveStem = z.object({
  id: z.string(),
  organizationId: z.string(),
  liveProjectId: z.string(),
  liveSetItemId: z.string(),
  stemType: StemType,
  label: z.string(),
  sourceAssetId: z.string(),
  gain: z.number().min(0).max(2),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  solo: z.boolean(),
  outputId: z.string().nullable(),
})
export type LiveStem = z.infer<typeof LiveStem>

export const MIDI_MESSAGE_TYPES = ['note_on', 'note_off', 'cc', 'program_change', 'pitch_bend'] as const
export const MidiMessageType = z.enum(MIDI_MESSAGE_TYPES)
export type MidiMessageType = z.infer<typeof MidiMessageType>

export const MIDI_TARGET_TYPES = [
  'pad',
  'scene',
  'stem_mute',
  'stem_solo',
  'stem_volume',
  'master_volume',
  'next_song',
  'prev_song',
  'stop',
  'click',
  'cue',
  'macro',
] as const
export const MidiTargetType = z.enum(MIDI_TARGET_TYPES)
export type MidiTargetType = z.infer<typeof MidiTargetType>

export const MidiMapping = z.object({
  id: z.string(),
  organizationId: z.string(),
  liveProjectId: z.string(),
  deviceIdentifier: z.string(),
  channel: z.number().int().min(0).max(15),
  messageType: MidiMessageType,
  noteOrController: z.number().int().min(0).max(127),
  targetType: MidiTargetType,
  targetId: z.string().nullable(),
  minimum: z.number(),
  maximum: z.number(),
  inversion: z.boolean(),
})
export type MidiMapping = z.infer<typeof MidiMapping>

// ---------------------------------------------------------------- AI jobs ----

export const AI_JOB_STATUSES = ['queued', 'generating', 'ready', 'accepted', 'rejected', 'failed'] as const
export const AiJobStatus = z.enum(AI_JOB_STATUSES)
export type AiJobStatus = z.infer<typeof AiJobStatus>

export const AiSceneRequest = z.object({
  prompt: z.string().min(1).max(4000),
  bars: z.number().int().min(1).max(128),
  tempoBehavior: z.enum(['keep', 'half', 'double', 'custom']),
  customBpm: z.number().min(20).max(400).nullable().optional(),
  keyBehavior: z.enum(['keep', 'relative', 'custom']),
  customKey: z.string().nullable().optional(),
  energy: z.enum(['sparse', 'low', 'medium', 'high', 'peak']),
  instrumentation: z.array(z.string()).max(16),
  intendedTransition: z.string().max(400),
  /** Explicit, affirmative rights confirmation. Never defaulted to true. */
  rightsConfirmed: z.boolean(),
})
export type AiSceneRequest = z.infer<typeof AiSceneRequest>

/** Every generated scene keeps its full lineage — where it came from and who approved it. */
export const GenerationLineage = z.object({
  sourceAssetId: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
  settings: z.record(z.string(), z.unknown()),
  generatedAt: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  rightsConfirmed: z.boolean(),
})
export type GenerationLineage = z.infer<typeof GenerationLineage>

export const LiveAiJob = z.object({
  id: z.string(),
  organizationId: z.string(),
  liveProjectId: z.string(),
  liveSetItemId: z.string().nullable(),
  sourceAssetId: z.string().nullable(),
  provider: z.string(),
  operation: z.string(),
  prompt: z.string(),
  configuration: AiSceneRequest,
  status: AiJobStatus,
  outputAssetIds: z.array(z.string()),
  error: z.string().nullable(),
  estimatedCostMicros: z.number().int(),
  finalCostMicros: z.number().int().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
})
export type LiveAiJob = z.infer<typeof LiveAiJob>

// --------------------------------------------------- performance packages ----

export const PACKAGE_STATUSES = ['not_ready', 'caching', 'verifying', 'ready', 'error'] as const
export const PackageStatus = z.enum(PACKAGE_STATUSES)
export type PackageStatus = z.infer<typeof PackageStatus>

export const PERFORMANCE_EVENT_TYPES = [
  'set_started',
  'set_ended',
  'song_started',
  'scene_launched',
  'pad_triggered',
  'ai_scene_used',
  'midi_connected',
  'midi_disconnected',
  'audio_device_changed',
  'error',
  'crash_recovered',
] as const
export const PerformanceEventType = z.enum(PERFORMANCE_EVENT_TYPES)
export type PerformanceEventType = z.infer<typeof PerformanceEventType>

export const PerformanceEvent = z.object({
  id: z.string(),
  organizationId: z.string(),
  liveProjectId: z.string(),
  performancePackageId: z.string().nullable(),
  eventType: PerformanceEventType,
  payload: z.record(z.string(), z.unknown()),
  localTimestamp: z.string(),
  synchronizedAt: z.string().nullable(),
})
export type PerformanceEvent = z.infer<typeof PerformanceEvent>
