import type { CanonicalShot, CharacterRecord, EnvironmentRecord, RejectionReason, StyleBible } from '@masterclip/shot-schema'
import type { MicroUsd } from '@masterclip/shared'

export interface Org {
  id: string
  name: string
  createdAt: string
}

export interface Project {
  id: string
  orgId: string
  name: string
  slug: string
  brief: string
  styleBible: StyleBible
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export interface Scene {
  id: string
  projectId: string
  name: string
  ordinal: number
  synopsis: string
  createdAt: string
}

export interface Shot {
  id: string
  projectId: string
  sceneId: string | null
  shotKey: string
  title: string
  currentVersion: number
  ordinal: number
  createdAt: string
  updatedAt: string
}

export interface ShotVersion {
  id: string
  shotId: string
  version: number
  spec: CanonicalShot
  specHash: string
  note: string
  locked: boolean
  createdBy: string
  createdAt: string
}

export type AssetKind =
  | 'reference_image'
  | 'reference_video'
  | 'audio'
  | 'generated_video'
  | 'frame'
  | 'proxy'
  | 'thumbnail'
  | 'contact_sheet'
  | 'master'
  | 'delivery'
  | 'sidecar'

export type ConsentStatus = 'not_applicable' | 'unverified' | 'authorized' | 'revoked'

/**
 * Rights travel with every asset. Nothing in the system infers permission from
 * the fact that a file exists: identity-preserving generation checks
 * `authorized` explicitly and refuses otherwise.
 */
export interface AssetRights {
  owner: string
  source: string
  license: string
  consent: ConsentStatus
  allowedUse: string
  expiresAt: string | null
  notes: string
  authorized: boolean
}

export interface Asset {
  id: string
  projectId: string
  kind: AssetKind
  storageKey: string
  filename: string
  mime: string
  bytes: number
  sha256: string
  width: number | null
  height: number | null
  durationSeconds: number | null
  fps: number | null
  hasAudio: boolean | null
  metadata: Record<string, unknown>
  rights: AssetRights
  createdBy: string
  createdAt: string
}

export type LineageRelation =
  | 'generated_from'
  | 'frame_of'
  | 'proxy_of'
  | 'thumbnail_of'
  | 'contact_sheet_of'
  | 'master_of'
  | 'delivery_of'
  | 'reference_for'

export type RenderJobStatus =
  | 'queued'
  | 'authorizing'
  | 'blocked'
  | 'submitted'
  | 'processing'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface RenderJob {
  id: string
  batchId: string | null
  projectId: string
  sceneId: string | null
  shotId: string
  shotVersionId: string
  providerId: string
  modelId: string
  routingProfile: string
  compiledPrompt: string
  request: Record<string, unknown>
  requestHash: string
  idempotencyKey: string
  status: RenderJobStatus
  externalJobId: string | null
  quoteId: string | null
  estimatedMicros: MicroUsd
  actualMicros: MicroUsd
  attempts: number
  seed: string | null
  sandbox: boolean
  priority: number
  error: Record<string, unknown> | null
  createdBy: string
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  completedAt: string | null
  failedAt: string | null
  cancelledAt: string | null
}

export interface RenderBatch {
  id: string
  projectId: string
  name: string
  status: 'planned' | 'running' | 'completed' | 'cancelled'
  matrix: Record<string, unknown>
  estimatedMicros: MicroUsd
  actualMicros: MicroUsd
  stopLossMicros: MicroUsd | null
  candidateCount: number
  createdBy: string
  createdAt: string
  cancelledAt: string | null
  completedAt: string | null
}

export interface RenderOutput {
  id: string
  jobId: string
  attemptId: string | null
  projectId: string
  shotId: string
  assetId: string
  proxyAssetId: string | null
  thumbnailAssetId: string | null
  contactSheetAssetId: string | null
  outputIndex: number
  providerId: string
  modelId: string
  durationSeconds: number | null
  width: number | null
  height: number | null
  fps: number | null
  hasAudio: boolean
  sha256: string
  status: 'ingested' | 'qc_passed' | 'qc_failed' | 'approved' | 'rejected' | 'promoted'
  metadata: Record<string, unknown>
  createdAt: string
}

export type ReviewDecision = 'approve' | 'reject' | 'rank' | 'promote' | 'reset'

export interface Review {
  id: string
  outputId: string
  projectId: string
  shotId: string
  userId: string
  decision: ReviewDecision
  rankOrder: number | null
  rejectionReasons: RejectionReason[]
  note: string
  createdAt: string
}

export interface Master {
  id: string
  projectId: string
  sceneId: string | null
  shotId: string
  outputId: string
  name: string
  status: 'approved' | 'finished' | 'delivered' | 'archived'
  sourceAssetId: string
  masterAssetId: string | null
  approvedBy: string
  approvedAt: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface MasterDeliverable {
  id: string
  masterId: string
  format: string
  assetId: string
  spec: Record<string, unknown>
  createdAt: string
}

export interface ProjectBibles {
  characters: Array<{ id: string; record: CharacterRecord; version: number; locked: boolean }>
  environments: Array<{ id: string; record: EnvironmentRecord; version: number; locked: boolean }>
}
