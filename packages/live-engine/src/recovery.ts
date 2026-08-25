import { z } from 'zod/v4'

/**
 * Crash recovery.
 *
 * The performance state is persisted on every meaningful change. After a
 * reload or crash the app *offers* to restore — it never restarts audio by
 * itself, because unexpected sound through a PA is worse than silence.
 */

export const PerformanceSnapshot = z.object({
  snapshotVersion: z.literal(1),
  projectId: z.string(),
  packageVersion: z.number().int().nullable(),
  savedAt: z.string(),
  currentItemId: z.string().nullable(),
  currentSceneId: z.string().nullable(),
  setPosition: z.number().int().min(0),
  bpm: z.number(),
  clickEnabled: z.boolean(),
  locked: z.boolean(),
  stems: z.array(
    z.object({
      id: z.string(),
      gain: z.number(),
      pan: z.number(),
      muted: z.boolean(),
      solo: z.boolean(),
    }),
  ),
  outputs: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
  midiDeviceIds: z.array(z.string()),
})
export type PerformanceSnapshot = z.infer<typeof PerformanceSnapshot>

export interface SnapshotStore {
  save(snapshot: PerformanceSnapshot): Promise<void>
  load(projectId: string): Promise<PerformanceSnapshot | null>
  clear(projectId: string): Promise<void>
}

/** In-memory store for tests. */
export class MemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, PerformanceSnapshot>()

  async save(snapshot: PerformanceSnapshot): Promise<void> {
    this.snapshots.set(snapshot.projectId, snapshot)
  }

  async load(projectId: string): Promise<PerformanceSnapshot | null> {
    return this.snapshots.get(projectId) ?? null
  }

  async clear(projectId: string): Promise<void> {
    this.snapshots.delete(projectId)
  }
}

/**
 * Web store backed by localStorage. Guarded reads/writes: a full or blocked
 * storage must never take the show down.
 */
export class LocalStorageSnapshotStore implements SnapshotStore {
  constructor(private readonly prefix = 'livelab.recovery.') {}

  async save(snapshot: PerformanceSnapshot): Promise<void> {
    try {
      localStorage.setItem(this.prefix + snapshot.projectId, JSON.stringify(snapshot))
    } catch {
      // Persisting state is best-effort; playback continues regardless.
    }
  }

  async load(projectId: string): Promise<PerformanceSnapshot | null> {
    try {
      const raw = localStorage.getItem(this.prefix + projectId)
      if (!raw) return null
      const parsed = PerformanceSnapshot.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  async clear(projectId: string): Promise<void> {
    try {
      localStorage.removeItem(this.prefix + projectId)
    } catch {
      // ignore
    }
  }
}
