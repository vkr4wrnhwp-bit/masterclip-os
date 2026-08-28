/**
 * Street Banker Studio capability catalogue.
 *
 * Granted through the platform's `EntitlementService` — the same seam Live Lab
 * and Song Lab use — so Partner OS administers Studio with machinery it already
 * has. Enforcement is server-side on every route and job; a hidden nav item is
 * presentation, not a control.
 *
 * The list is deliberately fine-grained. Studio spans a wider surface than any
 * previous module — a mastering engine, a rights vault, a delivery pipeline, a
 * marketplace — and an organization that should hold the mix tools does not
 * necessarily get to grant AI licences on an artist's voice.
 */

export const STUDIO_CAPABILITIES = [
  'studio.access',
  'studio.session',
  'studio.rack',
  'studio.mix',
  'studio.mix_doctor',
  'studio.references',
  'studio.ask_the_room',
  'studio.master',
  'studio.master_album',
  'studio.translation_lab',
  'studio.versions',
  'studio.collaborate',
  'studio.approve',
  'studio.deliver',
  'studio.sonic_dna',
  'studio.record_passport',
  'studio.identity_vault',
  'studio.ai_licensing',
  'studio.marketplace',
  'studio.opportunities',
  'studio.api',
] as const

export type StudioCapability = (typeof STUDIO_CAPABILITIES)[number]

export interface StudioCapabilityInfo {
  key: StudioCapability
  label: string
  description: string
  /** Flagship-only capabilities are never granted to a partner organization. */
  flagshipOnly: boolean
  /**
   * True where the capability is architecture rather than a shipped product
   * surface. The UI labels these so nobody mistakes a schema for a feature.
   */
  preview: boolean
}

export const STUDIO_CAPABILITY_INFO: StudioCapabilityInfo[] = [
  { key: 'studio.access', label: 'Studio', description: 'Access Street Banker Studio', flagshipOnly: false, preview: false },
  { key: 'studio.session', label: 'Session', description: 'The session control room: transport, markers and notes', flagshipOnly: false, preview: false },
  { key: 'studio.rack', label: 'Rack', description: 'Modular signal-chain racks and presets', flagshipOnly: false, preview: false },
  { key: 'studio.mix', label: 'Mix Station', description: 'Mix analysis and preparation', flagshipOnly: false, preview: false },
  { key: 'studio.mix_doctor', label: 'Mix Doctor', description: 'Timestamped potential-issue detection', flagshipOnly: false, preview: false },
  { key: 'studio.references', label: 'Reference DNA', description: 'Compare a record with authorized reference tracks', flagshipOnly: false, preview: false },
  { key: 'studio.ask_the_room', label: 'Ask the Room', description: 'The advisory studio assistant', flagshipOnly: false, preview: false },
  { key: 'studio.master', label: 'Master Station', description: 'Mastering directions, renditions and loudness-matched A/B', flagshipOnly: false, preview: false },
  { key: 'studio.master_album', label: 'Album Master', description: 'Project-level mastering and album cohesion', flagshipOnly: false, preview: false },
  { key: 'studio.translation_lab', label: 'Translation Lab', description: 'Playback-context translation estimates', flagshipOnly: false, preview: false },
  { key: 'studio.versions', label: 'Version Vault', description: 'Version lineage and the difference engine', flagshipOnly: false, preview: false },
  { key: 'studio.collaborate', label: 'Collaborate', description: 'Invite collaborators and comment on the timeline', flagshipOnly: false, preview: false },
  { key: 'studio.approve', label: 'Approvals', description: 'Give formal mix, master and delivery approval', flagshipOnly: false, preview: false },
  { key: 'studio.deliver', label: 'Deliver', description: 'Delivery checks and handoff to release', flagshipOnly: false, preview: false },
  { key: 'studio.sonic_dna', label: 'Sonic DNA', description: 'Derived artist preferences and creative memory', flagshipOnly: false, preview: false },
  { key: 'studio.record_passport', label: 'Record Passport', description: 'Machine-readable provenance and the human creation ledger', flagshipOnly: false, preview: false },
  // Rights surfaces are never implicit. An organization holding the mix tools
  // has no business granting licences over an artist's voice or likeness
  // unless somebody deliberately gave it that.
  { key: 'studio.identity_vault', label: 'Identity Vault', description: 'Artist control over voice, name, image and likeness', flagshipOnly: false, preview: false },
  { key: 'studio.ai_licensing', label: 'AI licensing', description: 'Granular, revocable, logged AI-use permissions', flagshipOnly: false, preview: false },
  { key: 'studio.marketplace', label: 'Engineer marketplace', description: 'Human mix and master services', flagshipOnly: false, preview: true },
  { key: 'studio.opportunities', label: 'Opportunity Engine', description: 'Matched opportunities with stated reasoning', flagshipOnly: true, preview: true },
  { key: 'studio.api', label: 'Studio API', description: 'Programmatic access to Studio, including the licensing request boundary', flagshipOnly: false, preview: true },
]

export const FLAGSHIP_STUDIO_CAPABILITIES: StudioCapability[] = [...STUDIO_CAPABILITIES]

/** What a standard partner edition receives: everything except the internal layers. */
export const PARTNER_STUDIO_CAPABILITIES: StudioCapability[] = STUDIO_CAPABILITY_INFO.filter((info) => !info.flagshipOnly).map((info) => info.key)

/** Numeric limits, administered through the same entitlement rows. */
export const STUDIO_LIMITS = [
  'studio.max_projects',
  'studio.max_versions_per_project',
  'studio.max_renditions_per_project',
  'studio.max_references_per_project',
  'studio.max_collaborators_per_project',
  'studio.max_analysis_minutes_per_month',
] as const

export type StudioLimit = (typeof STUDIO_LIMITS)[number]

export function isStudioCapability(value: string): value is StudioCapability {
  return (STUDIO_CAPABILITIES as readonly string[]).includes(value)
}

/**
 * The rights statement a user confirms before Studio touches their audio.
 *
 * Shown at upload, stored against the project, and repeated wherever a
 * reference track is added.
 */
export const STUDIO_RIGHTS_STATEMENT =
  'I confirm I own this recording or am authorized to use it, and that uploading it here for analysis, mastering and collaboration does not breach anyone else’s rights.'

/** The narrower statement attached to a reference track. */
export const STUDIO_REFERENCE_RIGHTS_STATEMENT =
  'I confirm I am entitled to use this recording as a private reference for measurement. Street Banker measures characteristics only — it does not copy, regenerate or distribute the reference.'
