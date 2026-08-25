import { z } from 'zod/v4'
import { LiveOutput, type LiveProject, type LiveScene, type LiveSetItem, type LiveStem } from './types.js'

/**
 * Stage Control handoff interfaces.
 *
 * Live Lab describes the show; Stage Control runs the room. The boundary is
 * deliberate: Live Lab never controls IEM or monitor levels — anything
 * safety-critical for a performer's ears stays on the Stage Control side, and
 * this document is a description, not a control channel.
 */

export const StageControlSceneTransition = z.object({
  fromSceneId: z.string().nullable(),
  toSceneId: z.string(),
  setItemId: z.string(),
  quantization: z.string(),
})
export type StageControlSceneTransition = z.infer<typeof StageControlSceneTransition>

export const StageControlSong = z.object({
  setItemId: z.string(),
  order: z.number().int(),
  title: z.string(),
  type: z.string(),
  bpm: z.number().nullable(),
  key: z.string().nullable(),
  durationMs: z.number().nullable(),
  clickRequired: z.boolean(),
  stemOutputs: z.array(z.object({ stemType: z.string(), label: z.string(), outputId: z.string().nullable() })),
  notes: z.string(),
})
export type StageControlSong = z.infer<typeof StageControlSong>

/** What Live Lab sends to Stage Control. */
export const StageControlHandoff = z.object({
  kind: z.literal('live_lab.stage_control.handoff'),
  version: z.literal(1),
  projectId: z.string(),
  setName: z.string(),
  artist: z.string(),
  masterTempo: z.number(),
  timeSignature: z.string(),
  expectedDurationMs: z.number(),
  setlist: z.array(StageControlSong),
  sceneTransitions: z.array(StageControlSceneTransition),
  outputs: z.array(LiveOutput),
  playbackRig: z.object({
    engine: z.string(),
    platform: z.string(),
    offlineCapable: z.boolean(),
  }),
  stageNotes: z.string(),
  generatedAt: z.string(),
})
export type StageControlHandoff = z.infer<typeof StageControlHandoff>

/** What Stage Control sends back to Live Lab. */
export const StageControlSession = z.object({
  kind: z.literal('stage_control.live_lab.session'),
  version: z.literal(1),
  showSessionId: z.string(),
  venue: z.string(),
  soundcheckTime: z.string().nullable(),
  monitorAssignments: z.array(z.object({ performer: z.string(), mix: z.string() })),
  technicalNotes: z.string(),
})
export type StageControlSession = z.infer<typeof StageControlSession>

export function buildStageControlHandoff(input: {
  project: LiveProject
  artistName: string
  items: LiveSetItem[]
  scenes: LiveScene[]
  stems: LiveStem[]
  outputs: LiveOutput[]
  generatedAt: string
}): StageControlHandoff {
  const ordered = [...input.items].sort((a, b) => a.sortOrder - b.sortOrder)
  const stemsByItem = new Map<string, LiveStem[]>()
  for (const stem of input.stems) {
    const list = stemsByItem.get(stem.liveSetItemId) ?? []
    list.push(stem)
    stemsByItem.set(stem.liveSetItemId, list)
  }

  const transitions: StageControlSceneTransition[] = []
  for (const item of ordered) {
    const itemScenes = input.scenes.filter((s) => s.liveSetItemId === item.id).sort((a, b) => a.sortOrder - b.sortOrder)
    let previous: LiveScene | null = null
    for (const scene of itemScenes) {
      transitions.push({
        fromSceneId: previous?.id ?? null,
        toSceneId: scene.id,
        setItemId: item.id,
        quantization: scene.quantization,
      })
      previous = scene
    }
  }

  return StageControlHandoff.parse({
    kind: 'live_lab.stage_control.handoff',
    version: 1,
    projectId: input.project.id,
    setName: input.project.name,
    artist: input.artistName,
    masterTempo: input.project.masterTempo,
    timeSignature: input.project.timeSignature,
    expectedDurationMs: ordered.reduce((total, item) => total + (item.durationMs ?? 0), 0),
    setlist: ordered.map((item, index) => ({
      setItemId: item.id,
      order: index + 1,
      title: item.title,
      type: item.type,
      bpm: item.bpm,
      key: item.key,
      durationMs: item.durationMs,
      clickRequired: (stemsByItem.get(item.id) ?? []).some((stem) => stem.stemType === 'click'),
      stemOutputs: (stemsByItem.get(item.id) ?? []).map((stem) => ({
        stemType: stem.stemType,
        label: stem.label,
        outputId: stem.outputId,
      })),
      notes: item.notes,
    })),
    sceneTransitions: transitions,
    outputs: input.outputs,
    playbackRig: {
      engine: 'live-engine/web-audio',
      platform: 'web',
      offlineCapable: true,
    },
    stageNotes: input.project.description,
    generatedAt: input.generatedAt,
  })
}
