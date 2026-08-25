/**
 * Live Lab feature entitlements.
 *
 * Hiding UI is not enforcement: every capability here is checked server-side
 * before the route body runs (see apps/api/src/routes/live-lab.ts). Flagship
 * organizations get the full set; partner / white-label editions get a
 * configurable subset with limits.
 */
export const LIVE_LAB_CAPABILITIES = [
  'live_lab.access',
  'live_lab.projects',
  'live_lab.stems',
  'live_lab.midi',
  'live_lab.performance_mode',
  'live_lab.offline_cache',
  'live_lab.ai_scene_builder',
  'live_lab.remix_import',
  'live_lab.multi_output',
  'live_lab.stage_control',
  'live_lab.desktop',
  'live_lab.api',
] as const

export type LiveLabCapability = (typeof LIVE_LAB_CAPABILITIES)[number]

/** Flagship edition: everything on. */
export const FLAGSHIP_CAPABILITIES: readonly LiveLabCapability[] = LIVE_LAB_CAPABILITIES

/**
 * Configurable usage limits. `null` means unlimited; a number is enforced
 * server-side when the limited resource is created.
 */
export const LIVE_LAB_LIMITS = [
  'live_lab.max_projects',
  'live_lab.max_cloud_storage_bytes',
  'live_lab.max_package_bytes',
  'live_lab.max_ai_generations_per_month',
  'live_lab.max_stem_separation_jobs',
  'live_lab.max_ai_scene_minutes',
  'live_lab.max_collaborators',
  'live_lab.max_outputs',
  'live_lab.max_package_versions',
] as const

export type LiveLabLimit = (typeof LIVE_LAB_LIMITS)[number]

export function isLiveLabCapability(value: string): value is LiveLabCapability {
  return (LIVE_LAB_CAPABILITIES as readonly string[]).includes(value)
}

export function isLiveLabLimit(value: string): value is LiveLabLimit {
  return (LIVE_LAB_LIMITS as readonly string[]).includes(value)
}
