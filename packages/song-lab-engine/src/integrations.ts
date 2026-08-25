import { AppError } from '@masterclip/shared'
import { formatClock } from '@masterclip/song-feature-vectors'
import type { HandoffTarget, SongLabHandoffRecord } from '@masterclip/song-lab-domain'
import type { Actor, SongLabDeps } from './deps.js'

/**
 * Cross-module handoffs.
 *
 * Song Lab is the diagnostic layer. It does not remix, perform, or distribute —
 * it hands a *snapshot* of what was approved to the module that does. The
 * snapshot matters: a downstream module must read what the artist signed off,
 * not whatever the project has drifted into since.
 *
 * Where the target module exists in this deployment (Remix Lab, Operator Desk)
 * the handoff creates the real record. Release Command Center is not built yet,
 * so its handoff is persisted with a versioned payload and a documented
 * contract — which is what the module will read when it lands, rather than a
 * stub that silently discards the data.
 */

export interface HandoffPayload {
  /** Target-specific additions (live markers, creative notes) ride alongside. */
  [key: string]: unknown
  /** Bumped when the payload shape changes; consumers pin on this. */
  contractVersion: string
  project: { id: string; title: string; artistName: string; genre: string }
  version: { id: string; label: string; type: string; assetId: string | null }
  analysis: {
    durationMs: number | null
    bpm: number | null
    bpmConfidence: number | null
    key: string | null
    keyConfidence: number | null
    meter: number | null
  } | null
  sections: Array<{ label: string; sectionType: string; startMs: number; endMs: number; humanConfirmed: boolean; isHook: boolean }>
  lyrics: Array<{ lineIndex: number; text: string; startMs: number | null; titlePhrase: boolean }>
  rightsConfirmationId: string
  approvedNotes: string[]
  reviewCompletedAt: string | null
}

export const HANDOFF_CONTRACT_VERSION = '1.0.0'

export class SongLabIntegrationService {
  constructor(private readonly deps: SongLabDeps) {}

  /** Assembles the snapshot every target receives. */
  async buildPayload(actor: Actor, projectId: string): Promise<HandoffPayload> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.currentVersionId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_version', message: 'this project has no version to send' })
    }
    const version = await this.deps.repos.versions.get(actor.orgId, project.currentVersionId)
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, version.id)
    const sections = analysis ? await this.deps.repos.sections.list(actor.orgId, analysis.id) : []
    const lyrics = await this.deps.repos.lyrics.list(actor.orgId, version.id)
    const observations = await this.deps.repos.observations.listForProject(actor.orgId, projectId)

    return {
      contractVersion: HANDOFF_CONTRACT_VERSION,
      project: { id: project.id, title: project.title, artistName: project.artistName, genre: project.genre },
      version: { id: version.id, label: version.versionLabel, type: version.versionType, assetId: version.sourceAssetId },
      analysis: analysis
        ? {
            durationMs: analysis.durationMs,
            bpm: analysis.bpm,
            bpmConfidence: analysis.bpmConfidence,
            key: analysis.key,
            keyConfidence: analysis.keyConfidence,
            meter: analysis.meter,
          }
        : null,
      sections: sections.map((section) => ({
        label: section.label,
        sectionType: section.sectionType,
        startMs: section.startMs,
        endMs: section.endMs,
        humanConfirmed: section.humanConfirmed,
        isHook: section.isHook,
      })),
      lyrics: lyrics.map((line) => ({ lineIndex: line.lineIndex, text: line.text, startMs: line.startMs, titlePhrase: line.titlePhrase })),
      rightsConfirmationId: project.rightsConfirmationId,
      // Only observations a human accepted travel downstream. An open
      // suggestion is not a producer note.
      approvedNotes: observations
        .filter((observation) => observation.status === 'accepted')
        .map((observation) => `${observation.title}: ${observation.description}`),
      reviewCompletedAt: project.reviewCompletedAt,
    }
  }

  /**
   * Send to Remix Lab.
   *
   * Creates a real Remix Lab project pointing at the *approved* Song Lab
   * version, and carries the structure across as creative notes. Song Lab does
   * not duplicate any of Remix Lab's generative machinery — it hands over and
   * steps back.
   */
  async sendToRemixLab(actor: Actor, projectId: string, opts: { remixLane?: string; targetUse?: string } = {}): Promise<SongLabHandoffRecord> {
    const payload = await this.buildPayload(actor, projectId)
    if (!payload.version.assetId) {
      throw new AppError({ kind: 'validation', code: 'song_lab.no_audio', message: 'the approved version has no audio to send' })
    }

    const remix = await this.deps.platform.remix.create({
      orgId: actor.orgId,
      name: `${payload.project.title} — from Song Lab`,
      // Remix Lab reads the approved Song Lab version, not the raw upload.
      sourceAudioAssetId: payload.version.assetId,
      remixLane: opts.remixLane ?? 'stems',
      targetUse: opts.targetUse ?? 'social_versions',
      // The rights confirmation the artist gave Song Lab is the same basis
      // Remix Lab needs; re-asking for it would be theatre, not consent.
      rightsConfirmationId: payload.rightsConfirmationId,
      noImitationConfirmationId: payload.rightsConfirmationId,
      humanReviewRequired: true,
      createdBy: actor.userId,
    })

    // Structure, tempo, key and approved notes travel in the handoff payload,
    // which is what a producer opening the remix project reads.
    return this.record(actor, projectId, { ...payload, creativeNotes: this.creativeNotes(payload) }, 'remix_lab', remix.id)
  }

  /**
   * Send to Live Lab.
   *
   * Live Lab owns performance; what it needs from Song Lab is the map — tempo,
   * key, section markers, hooks, builds and chant opportunities. The handoff
   * carries those and nothing about how to perform them.
   */
  async sendToLiveLab(actor: Actor, projectId: string): Promise<SongLabHandoffRecord> {
    const payload = await this.buildPayload(actor, projectId)
    return this.record(actor, projectId, { ...payload, ...(await this.livePayloadExtras(actor, projectId)) }, 'live_lab', null)
  }

  /**
   * Send to Release Command Center.
   *
   * The module is not built in this deployment. The handoff is stored complete
   * and marked `pending`, so when Release Command Center arrives it reads a real
   * approved snapshot rather than finding the data was dropped on the floor.
   */
  async sendToReleaseCommand(actor: Actor, projectId: string): Promise<SongLabHandoffRecord> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.reviewCompletedAt) {
      throw new AppError({
        kind: 'conflict',
        code: 'song_lab.review_not_complete',
        message: 'mark the Song Lab review complete before sending to Release Command Center',
      })
    }
    const payload = await this.buildPayload(actor, projectId)
    return this.record(actor, projectId, payload, 'release_command_center', null, 'pending')
  }

  /** Attaches the project to an Operator Desk lead, with an A&R note. */
  async attachToOperatorDesk(actor: Actor, projectId: string, leadId: string, note?: string): Promise<SongLabHandoffRecord> {
    const payload = await this.buildPayload(actor, projectId)
    // Reading the lead through the org-scoped accessor is what stops a project
    // being attached to another tenant's lead by id.
    const lead = await this.deps.platform.operatorDesk.getLead(actor.orgId, leadId)

    await this.deps.platform.operatorDesk.addNote({
      orgId: actor.orgId,
      leadId: lead.id,
      body:
        note ??
        `Song Lab analysis complete for "${payload.project.title}". ` +
          `Runtime ${payload.analysis?.durationMs ? formatClock(payload.analysis.durationMs / 1000) : 'unknown'}, ` +
          `${payload.analysis?.bpm ? `${Math.round(payload.analysis.bpm)} BPM` : 'tempo not determined'}, ` +
          `${payload.sections.length} sections.`,
      sourceType: 'song_lab_project',
      sourceId: projectId,
      createdBy: actor.userId,
    })

    return this.record(actor, projectId, payload, 'operator_desk', lead.id)
  }

  async list(actor: Actor, projectId: string): Promise<SongLabHandoffRecord[]> {
    return this.deps.repos.handoffs.list(actor.orgId, projectId)
  }

  private async livePayloadExtras(actor: Actor, projectId: string): Promise<{ liveMarkers: Array<{ label: string; startMs: number; kind: string }> }> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    if (!project.currentVersionId) return { liveMarkers: [] }
    const analysis = await this.deps.repos.analyses.latestForVersion(actor.orgId, project.currentVersionId)
    if (!analysis) return { liveMarkers: [] }
    const sections = await this.deps.repos.sections.list(actor.orgId, analysis.id)
    return {
      liveMarkers: sections.map((section) => ({
        label: section.label,
        startMs: section.startMs,
        kind: section.isHook ? 'hook' : section.sectionType,
      })),
    }
  }

  private creativeNotes(payload: HandoffPayload): string {
    const lines = [
      `Approved Song Lab version: ${payload.version.label}.`,
      payload.analysis?.bpm ? `Tempo ${Math.round(payload.analysis.bpm)} BPM.` : 'Tempo not determined.',
      payload.analysis?.key ? `Key ${payload.analysis.key}.` : 'Key not determined.',
      'Section markers:',
      ...payload.sections.map((section) => `  ${formatClock(section.startMs / 1000)} ${section.label}${section.humanConfirmed ? ' (confirmed)' : ''}`),
    ]
    if (payload.approvedNotes.length > 0) lines.push('Approved notes:', ...payload.approvedNotes.map((note) => `  ${note}`))
    return lines.join('\n')
  }

  private async record(
    actor: Actor,
    projectId: string,
    payload: HandoffPayload,
    target: HandoffTarget,
    targetRecordId: string | null,
    status: 'pending' | 'delivered' = 'delivered',
  ): Promise<SongLabHandoffRecord> {
    const handoff = await this.deps.repos.handoffs.create({
      orgId: actor.orgId,
      songLabProjectId: projectId,
      songVersionId: payload.version.id,
      target,
      targetRecordId,
      status,
      payload: payload as unknown as Record<string, unknown>,
      createdBy: actor.userId,
    })
    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: `song_lab.handoff.${target}`,
      targetType: 'song_lab_project',
      targetId: projectId,
      data: { handoffId: handoff.id, targetRecordId, status },
    })
    return handoff
  }
}
