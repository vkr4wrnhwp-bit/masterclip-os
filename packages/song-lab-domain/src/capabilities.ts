/**
 * Song Lab capability catalogue.
 *
 * Granted through the platform's `EntitlementService` — the same seam Live Lab
 * uses — so Partner OS administers Song Lab access with the machinery it
 * already has. Enforcement is server-side on every route and job; a hidden nav
 * item is presentation, not a control.
 */

export const SONG_LAB_CAPABILITIES = [
  'song_lab.access',
  'song_lab.analysis',
  'song_lab.structure',
  'song_lab.benchmark',
  'song_lab.experiments',
  'song_lab.lyrics',
  'song_lab.hook',
  'song_lab.chant',
  'song_lab.producer_view',
  'song_lab.ar_view',
  'song_lab.signal_benchmarks',
  'song_lab.custom_cohorts',
  'song_lab.exports',
  'song_lab.api',
] as const

export type SongLabCapability = (typeof SONG_LAB_CAPABILITIES)[number]

export interface SongLabCapabilityInfo {
  key: SongLabCapability
  label: string
  description: string
  /** Flagship-only capabilities are never granted to a partner organization. */
  flagshipOnly: boolean
}

export const SONG_LAB_CAPABILITY_INFO: SongLabCapabilityInfo[] = [
  { key: 'song_lab.access', label: 'Song Lab', description: 'Access the Song Lab module', flagshipOnly: false },
  { key: 'song_lab.analysis', label: 'Song analysis', description: 'Run technical and musical analysis on authorized audio', flagshipOnly: false },
  { key: 'song_lab.structure', label: 'Structure', description: 'Section detection and manual structure correction', flagshipOnly: false },
  { key: 'song_lab.benchmark', label: 'Benchmarking', description: 'Compare a song against a cohort', flagshipOnly: false },
  { key: 'song_lab.experiments', label: 'What If? experiments', description: 'Non-destructive listening experiments', flagshipOnly: false },
  { key: 'song_lab.lyrics', label: 'Lyric analysis', description: 'Syllable, title and repetition analysis of authorized lyrics', flagshipOnly: false },
  { key: 'song_lab.hook', label: 'Hook intelligence', description: 'Hook architecture profile', flagshipOnly: false },
  { key: 'song_lab.chant', label: 'Chant Finder', description: 'Crowd-response opportunity detection', flagshipOnly: false },
  { key: 'song_lab.producer_view', label: 'Producer View', description: 'Raw feature visualization and confidence detail', flagshipOnly: false },
  // Internal A&R is Street Banker's own judgement layer about artists it works
  // with. A partner organization does not receive it by default, and an artist
  // user never sees it without a deliberate grant.
  { key: 'song_lab.ar_view', label: 'Internal A&R View', description: 'Internal A&R review and recommendation states', flagshipOnly: true },
  { key: 'song_lab.signal_benchmarks', label: 'Signal benchmarks', description: 'Proprietary Street Banker cohorts drawn from Signal', flagshipOnly: true },
  { key: 'song_lab.custom_cohorts', label: 'Custom cohorts', description: 'Build and save custom comparison cohorts', flagshipOnly: false },
  { key: 'song_lab.exports', label: 'Exports', description: 'Export analysis and benchmark results', flagshipOnly: false },
  { key: 'song_lab.api', label: 'Song Lab API', description: 'Programmatic access to Song Lab', flagshipOnly: false },
]

export const FLAGSHIP_SONG_LAB_CAPABILITIES: SongLabCapability[] = [...SONG_LAB_CAPABILITIES]

/** What a standard partner edition receives: everything except the internal layers. */
export const PARTNER_SONG_LAB_CAPABILITIES: SongLabCapability[] = SONG_LAB_CAPABILITY_INFO.filter(
  (info) => !info.flagshipOnly,
).map((info) => info.key)

/** Numeric limits, administered through the same entitlement rows. */
export const SONG_LAB_LIMITS = [
  'song_lab.max_projects',
  'song_lab.max_experiments_per_project',
  'song_lab.max_custom_cohorts',
  'song_lab.max_analysis_minutes_per_month',
] as const

export type SongLabLimit = (typeof SONG_LAB_LIMITS)[number]

export function isSongLabCapability(value: string): value is SongLabCapability {
  return (SONG_LAB_CAPABILITIES as readonly string[]).includes(value)
}
