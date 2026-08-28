/**
 * The Studio record vocabulary.
 *
 * One canonical project id runs through every type in this file. Nothing here
 * defines a second identity for the same song: a mix analysis, a master
 * rendition, a delivery check, a passport and an AI permission all carry
 * `studioProjectId`, and the day a module needs its own record it gets a
 * pointer, not a copy.
 */

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

/**
 * The lifecycle a record moves through.
 *
 * Stages advance, but nothing in Studio forces them to advance in order: a
 * released record that goes back for a new mix is a real thing that happens,
 * and a state machine that refuses it would be a state machine users route
 * around.
 */
export const STUDIO_STAGES = ['create', 'analyze', 'mix', 'master', 'approve', 'package', 'release', 'market', 'monetize', 'track'] as const

export type StudioStage = (typeof STUDIO_STAGES)[number]

export const STUDIO_STAGE_LABELS: Record<StudioStage, string> = {
  create: 'Create',
  analyze: 'Analyze',
  mix: 'Mix',
  master: 'Master',
  approve: 'Approve',
  package: 'Package',
  release: 'Release',
  market: 'Market',
  monetize: 'Monetize',
  track: 'Track',
}

export interface StudioProjectRecord {
  id: string
  orgId: string
  artistName: string
  artistId: string | null
  title: string
  genre: string
  stage: StudioStage
  artworkAssetId: string | null
  currentVersionId: string | null
  approvedMixVersionId: string | null
  approvedMasterVersionId: string | null
  releaseDate: string | null
  rightsConfirmationId: string
  songLabProjectId: string | null
  liveProjectId: string | null
  releaseId: string | null
  notes: string
  demo: boolean
  archivedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

export const STUDIO_VERSION_TYPES = [
  'demo',
  'rough',
  'mix',
  'approved_mix',
  'master',
  'final_master',
  'clean',
  'instrumental',
  'acapella',
  'tv_track',
  'performance_track',
  'stems',
  'spatial',
] as const

export type StudioVersionType = (typeof STUDIO_VERSION_TYPES)[number]

export const STUDIO_VERSION_TYPE_LABELS: Record<StudioVersionType, string> = {
  demo: 'Demo',
  rough: 'Rough',
  mix: 'Mix',
  approved_mix: 'Approved Mix',
  master: 'Master',
  final_master: 'Final Master',
  clean: 'Clean',
  instrumental: 'Instrumental',
  acapella: 'Acapella',
  tv_track: 'TV Track',
  performance_track: 'Performance Track',
  stems: 'Stems',
  spatial: 'Spatial / Dolby',
}

export type StudioVersionSource = 'upload' | 'import' | 'master_render' | 'rack_render' | 'album_render' | 'external'

export interface StudioVersionRecord {
  id: string
  orgId: string
  studioProjectId: string
  parentVersionId: string | null
  versionType: StudioVersionType
  label: string
  ordinal: number
  assetId: string | null
  assetChecksum: string | null
  sourceKind: StudioVersionSource
  masterRenditionId: string | null
  durationMs: number | null
  sampleRate: number | null
  bitDepth: number | null
  channels: number | null
  approved: boolean
  approvalId: string | null
  supersededAt: string | null
  notes: string
  createdBy: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// session notes
// ---------------------------------------------------------------------------

export const STUDIO_NOTE_CATEGORIES = ['mix', 'master', 'arrangement', 'vocal', 'production', 'technical', 'other'] as const

export type StudioNoteCategory = (typeof STUDIO_NOTE_CATEGORIES)[number]

export type StudioNoteStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix'

/** Where a note came from. A machine-drafted note stays labelled for its whole life. */
export type StudioNoteOrigin = 'human' | 'mix_doctor' | 'ask_the_room'

export interface StudioNoteRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string | null
  kind: 'note' | 'marker'
  timestampMs: number | null
  endMs: number | null
  category: StudioNoteCategory
  body: string
  status: StudioNoteStatus
  assignedTo: string | null
  origin: StudioNoteOrigin
  sourceIssueId: string | null
  authorUserId: string
  authorLabel: string
  resolvedBy: string | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// rack
// ---------------------------------------------------------------------------

export const RACK_TYPES = ['vocal', 'instrument', 'mix_bus', 'master', 'custom'] as const

export type RackType = (typeof RACK_TYPES)[number]

/**
 * The fixed signal-flow stages.
 *
 * Ordering is the point: a rack that lets a reverb sit before a de-esser is a
 * modular toy, not a signal chain. Modules are reorderable *within* a stage;
 * the stages themselves are the product's opinion about signal flow.
 */
export const RACK_STAGES = ['clean', 'tune', 'shape', 'color', 'space'] as const

export type RackStage = (typeof RACK_STAGES)[number]

export const RACK_STAGE_LABELS: Record<RackStage, string> = {
  clean: 'Clean',
  tune: 'Tune',
  shape: 'Shape',
  color: 'Color',
  space: 'Space',
}

export const RACK_STAGE_DESCRIPTIONS: Record<RackStage, string> = {
  clean: 'Noise, breath and mouth',
  tune: 'Pitch and timing',
  shape: 'EQ and compression',
  color: 'Saturation and character',
  space: 'Reverb and delay',
}

export interface RackChainRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string | null
  rackType: RackType
  name: string
  abSlot: 'a' | 'b'
  stateVersion: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface RackModuleRecord {
  id: string
  orgId: string
  rackChainId: string
  stage: RackStage
  moduleType: string
  orderIndex: number
  bypassed: boolean
  params: Record<string, number | string | boolean>
  createdAt: string
  updatedAt: string
}

export interface RackHistoryRecord {
  id: string
  orgId: string
  rackChainId: string
  stateVersion: number
  action: string
  snapshot: RackModuleSnapshot[]
  createdBy: string
  createdAt: string
}

export interface RackModuleSnapshot {
  stage: RackStage
  moduleType: string
  orderIndex: number
  bypassed: boolean
  params: Record<string, number | string | boolean>
}

export interface RackPresetRecord {
  id: string
  orgId: string
  scope: 'project' | 'artist' | 'org'
  studioProjectId: string | null
  artistKey: string | null
  rackType: RackType
  name: string
  modules: RackModuleSnapshot[]
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// mix analysis
// ---------------------------------------------------------------------------

export const MIX_INPUT_KINDS = ['stereo_mix', 'vocal_plus_instrumental', 'stems', 'multitrack'] as const

export type MixInputKind = (typeof MIX_INPUT_KINDS)[number]

export type MixAnalysisStatus = 'pending' | 'ready' | 'failed' | 'unsupported'

export interface MixAnalysisRecord {
  id: string
  orgId: string
  studioProjectId: string | null
  studioVersionId: string | null
  referenceId: string | null
  sourceAssetId: string
  sourceChecksum: string
  inputKind: MixInputKind
  status: MixAnalysisStatus
  analyzerSetVersion: string
  durationMs: number | null
  sampleRate: number | null
  channels: number | null
  bitDepth: number | null
  failureReason: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface MixMetricRecord {
  analysisId: string
  metricKey: string
  orgId: string
  value: number | null
  unit: string
  confidence: number
  analysisMethod: string
  provider: string
  note: string
}

export interface MixCurveRecord {
  analysisId: string
  curveKey: string
  orgId: string
  stepMs: number
  points: Array<number | null>
}

export type MixIssueStatus = 'open' | 'ignored' | 'fixed' | 'sent_to_engineer'

export interface MixIssueRecord {
  id: string
  orgId: string
  studioProjectId: string
  analysisId: string
  issueType: string
  severity: 'low' | 'moderate' | 'high'
  confidence: number
  startMs: number
  endMs: number
  headline: string
  detail: string
  whyItMatters: string
  suggestedAction: string
  evidence: Record<string, unknown>
  /**
   * Where the finding came from and what it could not see.
   *
   * Null on rows written before the basis existed. Null means "not recorded",
   * which is a different fact from "no missing inputs" — and inventing a basis
   * for an old row would be the fabrication the field exists to prevent.
   */
  basis: Record<string, unknown> | null
  status: MixIssueStatus
  statusChangedBy: string | null
  statusChangedAt: string | null
  noteId: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// references
// ---------------------------------------------------------------------------

export type ReferenceRightsBasis = 'owned' | 'licensed' | 'authorized_private_reference'

export interface StudioReferenceRecord {
  id: string
  orgId: string
  studioProjectId: string
  label: string
  artistName: string
  title: string
  assetId: string | null
  rightsBasis: ReferenceRightsBasis
  rightsConfirmedBy: string
  rightsConfirmedAt: string
  analysisId: string | null
  /** True once the audio has been discarded and only measurements remain. */
  derivedOnly: boolean
  audioDiscardedAt: string | null
  createdBy: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// master station
// ---------------------------------------------------------------------------

export type MasterRenditionStatus = 'pending' | 'ready' | 'failed' | 'unsupported'

export interface MasterRenditionRecord {
  id: string
  orgId: string
  studioProjectId: string
  sourceVersionId: string
  slot: 'a' | 'b' | 'c'
  direction: string
  priorities: Record<string, number | boolean>
  targetLufs: number | null
  targetTruePeak: number | null
  status: MasterRenditionStatus
  renderPlan: unknown
  renderer: string | null
  rendererVersion: string | null
  placeholder: boolean
  outputAssetId: string | null
  outputAnalysisId: string | null
  matchGainDb: number | null
  failureReason: string | null
  approved: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface StudioAlbumRecord {
  id: string
  orgId: string
  title: string
  artistName: string
  status: string
  cohesionScore: number | null
  cohesionReport: string
  gapDefaultMs: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface StudioAlbumTrackRecord {
  id: string
  orgId: string
  albumId: string
  studioProjectId: string
  studioVersionId: string | null
  orderIndex: number
  gapMs: number
  createdAt: string
}

// ---------------------------------------------------------------------------
// collaboration
// ---------------------------------------------------------------------------

export const COLLABORATOR_ROLES = ['artist', 'producer', 'manager', 'ar', 'mix_engineer', 'mastering_engineer', 'label', 'other'] as const

export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number]

export const COLLABORATOR_PERMISSIONS = ['view', 'comment', 'upload', 'approve', 'download', 'admin'] as const

export type CollaboratorPermission = (typeof COLLABORATOR_PERMISSIONS)[number]

/**
 * Default permissions per role.
 *
 * A starting point an admin edits, not a rule. The important part is that
 * `approve` is not in any default set except the artist's and the label's:
 * approval is the one action that changes what a record *is*, and it should be
 * a deliberate grant.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<CollaboratorRole, CollaboratorPermission[]> = {
  artist: ['view', 'comment', 'upload', 'approve', 'download'],
  producer: ['view', 'comment', 'upload', 'download'],
  manager: ['view', 'comment'],
  ar: ['view', 'comment'],
  mix_engineer: ['view', 'comment', 'upload', 'download'],
  mastering_engineer: ['view', 'comment', 'upload', 'download'],
  label: ['view', 'comment', 'approve', 'download'],
  other: ['view'],
}

export interface StudioCollaboratorRecord {
  id: string
  orgId: string
  studioProjectId: string
  userId: string | null
  email: string
  displayName: string
  collaboratorRole: CollaboratorRole
  permissions: CollaboratorPermission[]
  invitedBy: string
  invitedAt: string
  acceptedAt: string | null
  revokedAt: string | null
  revokedBy: string | null
}

export interface StudioCommentRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string | null
  parentCommentId: string | null
  timestampMs: number | null
  body: string
  authorUserId: string
  authorLabel: string
  status: 'open' | 'resolved'
  resolvedBy: string | null
  resolvedAt: string | null
  createdAt: string
}

export type ApprovalType = 'mix' | 'master' | 'delivery'

export interface StudioApprovalRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string
  approvalType: ApprovalType
  approvedBy: string
  approvedByLabel: string
  approvedAt: string
  comments: string
  /** The bytes that were approved. An approval never transfers to other audio. */
  versionChecksum: string
  revokedAt: string | null
  revokedBy: string | null
  revokedReason: string | null
}

export interface StudioActivityRecord {
  id: string
  orgId: string
  studioProjectId: string
  actorUserId: string
  actorLabel: string
  action: string
  subjectType: string
  subjectId: string | null
  detail: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

export const DELIVERABLE_KINDS = [
  'dsp_master',
  'clean',
  'instrumental',
  'acapella',
  'tv_track',
  'performance_track',
  'stems',
  'radio_edit',
  'spatial_master',
] as const

export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number]

export const DELIVERABLE_KIND_LABELS: Record<DeliverableKind, string> = {
  dsp_master: 'DSP Master',
  clean: 'Clean',
  instrumental: 'Instrumental',
  acapella: 'Acapella',
  tv_track: 'TV Track',
  performance_track: 'Performance Track',
  stems: 'Stems',
  radio_edit: 'Radio Edit',
  spatial_master: 'Spatial Master',
}

export type DeliverableStatus = 'draft' | 'checks_passed' | 'checks_failed' | 'approved' | 'sent'

export interface StudioDeliverableRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string | null
  assetKind: DeliverableKind
  assetId: string | null
  fileName: string
  status: DeliverableStatus
  sentReleaseId: string | null
  sentAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type DeliveryCheckOutcome = 'pass' | 'warn' | 'fail' | 'unknown'

export interface DeliveryCheckRecord {
  id: string
  orgId: string
  deliverableId: string
  checkKey: string
  outcome: DeliveryCheckOutcome
  detail: string
  measured: string | null
  expected: string | null
  createdAt: string
}

export interface ReleaseMetadataRecord {
  studioProjectId: string
  orgId: string
  isrc: string | null
  upc: string | null
  primaryArtist: string
  featuredArtists: string
  labelName: string
  explicit: 'explicit' | 'clean' | 'not_explicit' | 'undeclared'
  language: string
  genre: string
  secondaryGenre: string
  copyrightLine: string
  publishingLine: string
  artworkAssetId: string | null
  credits: CreditEntry[]
  splits: SplitEntry[]
  updatedBy: string
  updatedAt: string
}

export interface CreditEntry {
  name: string
  role: string
  detail?: string
}

export interface SplitEntry {
  name: string
  role: string
  /** Percentage points. The delivery check refuses a set that does not total 100. */
  percentage: number
  publisher?: string
  ipi?: string
}

// ---------------------------------------------------------------------------
// sonic DNA and creative memory
// ---------------------------------------------------------------------------

export const SONIC_DNA_ATTRIBUTES = [
  'vocal_position',
  'vocal_brightness',
  'low_end_character',
  'dynamic_preference',
  'stereo_preference',
  'master_loudness_preference',
  'reverb_tendency',
  'frequency_tendency',
  'arrangement_tendency',
  'preferred_master_direction',
] as const

export type SonicDnaAttribute = (typeof SONIC_DNA_ATTRIBUTES)[number]

export const SONIC_DNA_LABELS: Record<SonicDnaAttribute, string> = {
  vocal_position: 'Vocal position',
  vocal_brightness: 'Vocal brightness',
  low_end_character: 'Low-end character',
  dynamic_preference: 'Dynamic preference',
  stereo_preference: 'Stereo preference',
  master_loudness_preference: 'Master loudness preference',
  reverb_tendency: 'Reverb tendencies',
  frequency_tendency: 'Frequency tendencies',
  arrangement_tendency: 'Arrangement tendencies',
  preferred_master_direction: 'Preferred master direction',
}

export interface SonicDnaRecord {
  id: string
  orgId: string
  artistKey: string
  attribute: SonicDnaAttribute
  value: number | null
  valueText: string | null
  confidence: number
  sampleSize: number
  /** The approvals this was derived from. Makes every entry checkable. */
  derivedFrom: string[]
  source: 'derived' | 'stated'
  status: 'proposed' | 'active' | 'dismissed'
  createdAt: string
  updatedAt: string
}

export interface CreativeMemoryRecord {
  id: string
  orgId: string
  scope: 'project' | 'artist'
  scopeId: string
  patternKey: string
  statement: string
  observations: number
  supporting: number
  confidence: number
  status: 'candidate' | 'promoted' | 'dismissed'
  editedStatement: string | null
  evidence: string[]
  promotedBy: string | null
  promotedAt: string | null
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// record passport and contributions
// ---------------------------------------------------------------------------

export const PASSPORT_SCHEMA_VERSION = '1.0.0'

export interface RecordPassportRecord {
  id: string
  orgId: string
  studioProjectId: string
  recordingId: string
  schemaVersion: string
  document: RecordPassportDocument
  documentHash: string
  finalizedVersionId: string | null
  finalizedAssetChecksum: string | null
  externalProfile: string | null
  status: 'draft' | 'finalized'
  createdBy: string
  createdAt: string
  updatedAt: string
}

/**
 * The passport document.
 *
 * Shaped so a DDEX/RIN exporter can be written against it without this
 * application taking a dependency on any one standard's library or version.
 * The mapping lives in an exporter; the document stays ours.
 */
export interface RecordPassportDocument {
  schemaVersion: string
  projectId: string
  recordingId: string
  title: string
  artist: string
  generatedAt: string
  contributors: PassportContributor[]
  versions: PassportVersion[]
  approvals: PassportApproval[]
  ownership: {
    declarations: string[]
    splits: SplitEntry[]
  }
  aiDisclosure: {
    /** Tools used anywhere in the record's life, with what each did. */
    toolsUsed: Array<{ tool: string; role: string; stage: string }>
    generativeUse: string[]
    voiceModelUse: string[]
    /** Explicitly recorded even when empty — silence is not a declaration. */
    declaredBy: string | null
    declaredAt: string | null
  }
  samples: Array<{ description: string; source: string; cleared: boolean | null; licenseReference: string | null }>
  licenses: Array<{ kind: string; reference: string; territories: string[]; termEnd: string | null }>
  deliveryHistory: Array<{ deliverableId: string; kind: string; sentAt: string | null; releaseId: string | null }>
}

export interface PassportContributor {
  name: string
  roles: string[]
  userId: string | null
  human: boolean
  detail: string
}

export interface PassportVersion {
  versionId: string
  label: string
  versionType: string
  createdAt: string
  createdBy: string
  checksum: string | null
  sourceKind: string
  parentVersionId: string | null
}

export interface PassportApproval {
  approvalType: string
  versionId: string
  approvedBy: string
  approvedAt: string
  versionChecksum: string
}

export const CONTRIBUTION_TYPES = [
  'lyrics',
  'melody',
  'vocals',
  'instrument',
  'production',
  'mix',
  'master',
  'arrangement',
  'engineering',
  'other',
] as const

export type ContributionType = (typeof CONTRIBUTION_TYPES)[number]

export interface ContributionRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string | null
  contributionType: ContributionType
  performedBy: string
  performerUserId: string | null
  instrument: string | null
  detail: string
  human: boolean
  aiTool: string | null
  aiRole: string | null
  declaredBy: string
  declaredAt: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// identity vault and AI licensing
// ---------------------------------------------------------------------------

export const IDENTITY_SUBJECTS = ['voice', 'name', 'image', 'likeness', 'performance_style'] as const

export type IdentitySubject = (typeof IDENTITY_SUBJECTS)[number]

export type IdentityControl = 'prohibited' | 'consent_required' | 'permitted'

export interface IdentityVaultRecord {
  id: string
  orgId: string
  artistKey: string
  subject: IdentitySubject
  control: IdentityControl
  approvedModelIds: string[]
  permittedUses: string[]
  prohibitedUses: string[]
  territories: string[]
  termStart: string | null
  termEnd: string | null
  pricing: string
  consentRecordId: string | null
  verified: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
  revokedAt: string | null
  revokedBy: string | null
}

export interface IdentityEventRecord {
  id: string
  orgId: string
  identityId: string
  event: string
  detail: string
  actorUserId: string
  createdAt: string
}

export const AI_PERMISSIONS = [
  'no_ai_use',
  'analysis_only',
  'private_artist_model',
  'licensed_derivative',
  'fan_remix',
  'commercial_sync_generation',
  'voice_use',
  'training_use',
] as const

export type AiPermission = (typeof AI_PERMISSIONS)[number]

export const AI_PERMISSION_LABELS: Record<AiPermission, string> = {
  no_ai_use: 'No AI use',
  analysis_only: 'Analysis only',
  private_artist_model: 'Private artist model',
  licensed_derivative: 'Licensed derivative use',
  fan_remix: 'Fan remix use',
  commercial_sync_generation: 'Commercial sync generation',
  voice_use: 'Voice use',
  training_use: 'Training use',
}

export type AiPermissionScope = 'master' | 'stems' | 'acapella' | 'instrumental' | 'all'

export interface AiPermissionRecord {
  id: string
  orgId: string
  studioProjectId: string
  assetScope: AiPermissionScope
  permission: AiPermission
  granted: boolean
  grantedBy: string
  grantedAt: string
  revocable: boolean
  revokedAt: string | null
  revokedBy: string | null
  territories: string[]
  termEnd: string | null
  conditions: string
  contractReference: string | null
  createdAt: string
  updatedAt: string
}

export interface AiPermissionEventRecord {
  id: string
  orgId: string
  permissionId: string
  event: string
  detail: string
  actorUserId: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// licensing requests (agent-to-agent boundary)
// ---------------------------------------------------------------------------

export type LicenseRequestStatus = 'received' | 'rights_checked' | 'priced' | 'declined' | 'awaiting_human'

export interface LicenseRequestRecord {
  id: string
  orgId: string
  requester: string
  requesterKind: 'human' | 'agent'
  brief: string
  budgetMicros: number | null
  durationSeconds: number | null
  territories: string[]
  rightsRequested: string[]
  status: LicenseRequestStatus
  matches: LicenseMatch[]
  decisionNotes: string
  /** Always false. Nothing in this application sets it. */
  executed: boolean
  createdAt: string
  updatedAt: string
}

export interface LicenseMatch {
  studioProjectId: string
  title: string
  artistName: string
  whyItMatches: string[]
  /** Null wherever a rights check could not be completed from stored data. */
  rightsClear: boolean | null
  rightsNotes: string[]
  indicativePriceMicros: number | null
  priceBasis: string
}

// ---------------------------------------------------------------------------
// marketplace
// ---------------------------------------------------------------------------

export const STUDIO_SERVICES = [
  'mix_review',
  'master_review',
  'professional_mix',
  'professional_master',
  'vocal_editing',
  'dolby_atmos',
  'stem_preparation',
  'production_consultation',
] as const

export type StudioService = (typeof STUDIO_SERVICES)[number]

export const STUDIO_SERVICE_LABELS: Record<StudioService, string> = {
  mix_review: 'Mix Review',
  master_review: 'Master Review',
  professional_mix: 'Professional Mix',
  professional_master: 'Professional Master',
  vocal_editing: 'Vocal Editing',
  dolby_atmos: 'Dolby Atmos',
  stem_preparation: 'Stem Preparation',
  production_consultation: 'Production Consultation',
}

export interface ServiceProviderRecord {
  id: string
  orgId: string
  displayName: string
  services: StudioService[]
  active: boolean
  createdAt: string
  updatedAt: string
}

export type ServiceOrderStatus = 'draft' | 'submitted' | 'accepted' | 'delivered' | 'cancelled'

export interface ServiceOrderRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string | null
  serviceKey: StudioService
  providerId: string | null
  status: ServiceOrderStatus
  feeMicros: number
  platformCommissionMicros: number
  engineerPayoutMicros: number
  rush: boolean
  rushFeeMicros: number
  tipMicros: number
  brief: string
  deliveredVersionId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// opportunities
// ---------------------------------------------------------------------------

export const OPPORTUNITY_TYPES = [
  'playlist',
  'radio',
  'sync',
  'brand_partnership',
  'support_tour',
  'venue',
  'collaboration',
  'feature',
  'producer',
  'writer',
  'press',
  'influencer',
  'fan_market',
  'licensing',
  'catalog',
] as const

export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number]

export interface OpportunityRecord {
  id: string
  orgId: string
  studioProjectId: string
  opportunityType: OpportunityType
  headline: string
  whyItMatches: string
  evidence: string[]
  expectedValueMicros: number | null
  expectedCostMicros: number | null
  confidence: number | null
  /** Names the data behind the estimate, or says there is not enough. */
  confidenceBasis: string
  status: 'open' | 'accepted' | 'dismissed'
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Ask the Room
// ---------------------------------------------------------------------------

export type RoomActionKind = 'show_me' | 'add_note' | 'compare' | 'preview_idea' | 'send_to_engineer'

export interface RoomAction {
  kind: RoomActionKind
  label: string
  /** Where the action points: a timestamp, a version pair, a rack, an issue. */
  target: Record<string, string | number>
}

export interface RoomExchangeRecord {
  id: string
  orgId: string
  studioProjectId: string
  studioVersionId: string | null
  question: string
  answer: string
  responder: string
  contextUsed: string[]
  actions: RoomAction[]
  confidence: 'high' | 'moderate' | 'low' | 'insufficient'
  /** Where the answer came from and what the room could not see. Null on older rows. */
  basis: Record<string, unknown> | null
  askedBy: string
  createdAt: string
}
