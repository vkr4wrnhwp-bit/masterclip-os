import { AppError } from '@masterclip/shared'
import { metricValue } from '@masterclip/mix-analysis'
import type { DeliverableKind, DeliveryCheckOutcome, StudioDeliverableRecord } from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'
import { toMixMetrics } from './mix.js'

/**
 * Delivery Centre.
 *
 * Runs the checks a distributor would run, before a distributor runs them, and
 * says which is a hard failure and which is a caution. The distinction matters:
 * a missing ISRC will be rejected outright, while an unusual sample rate is a
 * choice somebody may have made deliberately.
 *
 * SEND TO RELEASE is gated on `fail` count being zero *and* a delivery
 * approval existing. Warnings never block — a product that refuses to ship over
 * a warning teaches people to ignore warnings.
 */
export class StudioDeliveryService {
  constructor(private readonly deps: StudioDeps) {}

  async createDeliverable(input: {
    actor: Actor
    projectId: string
    versionId: string
    assetKind: DeliverableKind
    fileName?: string
  }): Promise<StudioDeliverableRecord> {
    const version = await this.deps.repos.versions.get(input.actor.orgId, input.versionId)
    if (version.studioProjectId !== input.projectId) {
      throw new AppError({ kind: 'validation', code: 'studio.version_mismatch', message: 'that version belongs to a different project' })
    }
    const project = await this.deps.repos.projects.get(input.actor.orgId, input.projectId)

    const deliverable = await this.deps.repos.deliverables.create({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      studioVersionId: version.id,
      assetKind: input.assetKind,
      assetId: version.assetId,
      fileName: input.fileName ?? deliveryFileName(project.artistName, project.title, input.assetKind),
      createdBy: input.actor.userId,
    })

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'deliverable.created',
      subjectType: 'deliverable',
      subjectId: deliverable.id,
      detail: input.assetKind,
    })

    // Checked immediately: a deliverable whose problems surface only when
    // somebody remembers to press a button is a deliverable that ships broken.
    await this.runChecks(input.actor, deliverable.id)
    return this.deps.repos.deliverables.get(input.actor.orgId, deliverable.id)
  }

  /**
   * Runs every delivery check.
   *
   * A check that cannot be evaluated returns `unknown` rather than `pass`. An
   * unchecked box presented as a tick is exactly how a bad master reaches a DSP.
   */
  async runChecks(actor: Actor, deliverableId: string) {
    const deliverable = await this.deps.repos.deliverables.get(actor.orgId, deliverableId)
    const project = await this.deps.repos.projects.get(actor.orgId, deliverable.studioProjectId)
    const metadata = await this.deps.repos.releaseMetadata.get(actor.orgId, project.id)
    const version = deliverable.studioVersionId ? await this.deps.repos.versions.get(actor.orgId, deliverable.studioVersionId) : null
    const analysis = version ? await this.deps.repos.analyses.latestForVersion(actor.orgId, version.id) : null
    const metrics = analysis ? toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysis.id)) : []

    const checks: Array<{ checkKey: string; outcome: DeliveryCheckOutcome; detail: string; measured?: string | null; expected?: string | null }> = []

    // --- the file itself ---------------------------------------------------
    if (!version?.assetId) {
      checks.push({ checkKey: 'file_present', outcome: 'fail', detail: 'This deliverable has no audio attached.', expected: 'an audio file' })
    } else {
      const asset = await this.deps.platform.audioAssetRepo.get(actor.orgId, version.assetId).catch(() => null)
      checks.push(
        asset
          ? {
              checkKey: 'file_type',
              outcome: LOSSLESS_TYPES.has(asset.mimeType) ? 'pass' : 'fail',
              detail: LOSSLESS_TYPES.has(asset.mimeType)
                ? 'Lossless source, which is what every DSP wants.'
                : 'DSPs require a lossless master. A lossy file cannot be un-compressed by encoding it again.',
              measured: asset.mimeType,
              expected: 'audio/wav, audio/flac or audio/aiff',
            }
          : { checkKey: 'file_type', outcome: 'unknown', detail: 'The audio file could not be read to check its type.' },
      )

      checks.push(
        version.sampleRate === null
          ? { checkKey: 'sample_rate', outcome: 'unknown', detail: 'Sample rate could not be determined — the version has not been analysed.' }
          : version.sampleRate >= 44100
            ? { checkKey: 'sample_rate', outcome: 'pass', detail: 'At or above CD rate.', measured: `${version.sampleRate} Hz`, expected: '44100 Hz or higher' }
            : {
                checkKey: 'sample_rate',
                outcome: 'fail',
                detail: 'Below 44.1 kHz. Most DSPs reject this outright.',
                measured: `${version.sampleRate} Hz`,
                expected: '44100 Hz or higher',
              },
      )

      checks.push(
        version.bitDepth === null
          ? { checkKey: 'bit_depth', outcome: 'unknown', detail: 'Bit depth could not be read from the file header.' }
          : version.bitDepth >= 16
            ? {
                checkKey: 'bit_depth',
                outcome: version.bitDepth >= 24 ? 'pass' : 'warn',
                detail: version.bitDepth >= 24 ? '24-bit or better.' : '16-bit is accepted, but 24-bit gives the DSP’s own encoder more to work with.',
                measured: `${version.bitDepth}-bit`,
                expected: '24-bit',
              }
            : { checkKey: 'bit_depth', outcome: 'fail', detail: 'Below 16-bit.', measured: `${version.bitDepth}-bit`, expected: '16-bit minimum' },
      )
    }

    // --- what the analysis found ------------------------------------------
    const truePeak = metricValue(metrics, 'true_peak_dbtp')
    const clipping = metricValue(metrics, 'clipping_runs')
    checks.push(
      truePeak === null
        ? { checkKey: 'clipping', outcome: 'unknown', detail: 'Peak level has not been measured for this version.' }
        : truePeak > 0
          ? {
              checkKey: 'clipping',
              outcome: 'fail',
              detail: 'The estimated true peak is above full scale, which will distort after lossy encoding.',
              measured: `${truePeak.toFixed(2)} dBTP`,
              expected: '−1.0 dBTP or lower',
            }
          : truePeak > -0.5
            ? {
                checkKey: 'clipping',
                outcome: 'warn',
                detail: 'Very little margin before full scale. −1 dBTP is the conventional ceiling for streaming delivery.',
                measured: `${truePeak.toFixed(2)} dBTP`,
                expected: '−1.0 dBTP or lower',
              }
            : {
                checkKey: 'clipping',
                outcome: clipping && clipping > 0 ? 'warn' : 'pass',
                detail: clipping && clipping > 0 ? `${clipping} clipping run(s) detected inside the programme.` : 'Peak level and clipping look fine.',
                measured: `${truePeak.toFixed(2)} dBTP`,
                expected: '−1.0 dBTP or lower',
              },
    )

    // --- metadata ----------------------------------------------------------
    checks.push(requiredText('naming', deliverable.fileName, 'File name', 'a file name'))
    checks.push(
      metadata?.isrc
        ? { checkKey: 'metadata_isrc', outcome: 'pass', detail: 'ISRC present.', measured: metadata.isrc }
        : { checkKey: 'metadata_isrc', outcome: 'fail', detail: 'No ISRC. Distribution cannot proceed without one.', expected: 'an ISRC' },
    )
    checks.push(requiredText('metadata_artist', metadata?.primaryArtist ?? '', 'Primary artist', 'the primary artist name'))
    checks.push(
      metadata?.copyrightLine
        ? { checkKey: 'metadata_copyright', outcome: 'pass', detail: 'Copyright line present.' }
        : { checkKey: 'metadata_copyright', outcome: 'warn', detail: 'No copyright line. Most DSPs display one.' },
    )
    checks.push(
      metadata && metadata.explicit !== 'undeclared'
        ? { checkKey: 'explicit_status', outcome: 'pass', detail: `Declared as ${metadata.explicit}.`, measured: metadata.explicit }
        : {
            checkKey: 'explicit_status',
            outcome: 'fail',
            detail: 'Explicit status has not been declared. Nobody can declare it for you, and every DSP requires it.',
            expected: 'explicit, clean or not explicit',
          },
    )

    checks.push(
      metadata?.artworkAssetId || project.artworkAssetId
        ? { checkKey: 'artwork', outcome: 'pass', detail: 'Artwork attached.' }
        : { checkKey: 'artwork', outcome: 'fail', detail: 'No artwork attached.', expected: 'a square cover image' },
    )

    checks.push(
      (metadata?.credits.length ?? 0) > 0
        ? { checkKey: 'credits', outcome: 'pass', detail: `${metadata?.credits.length} credit(s) recorded.` }
        : { checkKey: 'credits', outcome: 'warn', detail: 'No credits recorded. They travel with the release and are hard to add later.' },
    )

    // Splits are checked arithmetically, not merely for presence: a split sheet
    // that totals 97% is worse than no split sheet, because it looks complete.
    const splitTotal = (metadata?.splits ?? []).reduce((sum, split) => sum + (Number.isFinite(split.percentage) ? split.percentage : 0), 0)
    checks.push(
      (metadata?.splits.length ?? 0) === 0
        ? { checkKey: 'splits', outcome: 'warn', detail: 'No splits recorded.' }
        : Math.abs(splitTotal - 100) < 0.01
          ? { checkKey: 'splits', outcome: 'pass', detail: 'Splits total 100%.', measured: `${splitTotal.toFixed(2)}%`, expected: '100%' }
          : {
              checkKey: 'splits',
              outcome: 'fail',
              detail: 'The split sheet does not total 100%.',
              measured: `${splitTotal.toFixed(2)}%`,
              expected: '100%',
            },
    )

    const written = await this.deps.repos.deliverables.replaceChecks(actor.orgId, deliverableId, checks)
    const failed = written.filter((check) => check.outcome === 'fail').length
    await this.deps.repos.deliverables.setStatus(actor.orgId, deliverableId, failed > 0 ? 'checks_failed' : 'checks_passed')

    return {
      deliverable: await this.deps.repos.deliverables.get(actor.orgId, deliverableId),
      checks: written,
      failed,
      warned: written.filter((check) => check.outcome === 'warn').length,
      unknown: written.filter((check) => check.outcome === 'unknown').length,
    }
  }

  /**
   * Hands a deliverable to the release workflow.
   *
   * Two gates, both hard: no failing checks, and a delivery approval on the
   * version. Studio owns the project record throughout the lifecycle, so this
   * marks the deliverable sent, moves the project to the release stage, and
   * records the release id it was handed to — the link the passport's delivery
   * history points at.
   */
  async sendToRelease(actor: Actor, deliverableId: string, releaseId: string) {
    const deliverable = await this.deps.repos.deliverables.get(actor.orgId, deliverableId)
    const checks = await this.deps.repos.deliverables.checks(actor.orgId, deliverableId)
    const failed = checks.filter((check) => check.outcome === 'fail')
    if (failed.length > 0) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.delivery_checks_failed',
        message: `${failed.length} delivery check${failed.length === 1 ? '' : 's'} still failing: ${failed.map((check) => check.checkKey).join(', ')}`,
        details: { failed: failed.map((check) => ({ check: check.checkKey, detail: check.detail })) },
      })
    }

    const approval = await this.deps.repos.approvals.current(actor.orgId, deliverable.studioProjectId, 'delivery')
    if (!approval) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.delivery_not_approved',
        message: 'delivery has not been approved for this project — a person signs this off, not a check',
      })
    }

    await this.deps.repos.deliverables.markSent(actor.orgId, deliverableId, releaseId)
    await this.deps.repos.projects.update(actor.orgId, deliverable.studioProjectId, { releaseId })
    await this.deps.repos.projects.setStage(actor.orgId, deliverable.studioProjectId, 'release')

    await this.deps.repos.activity.record({
      orgId: actor.orgId,
      studioProjectId: deliverable.studioProjectId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      action: 'deliverable.sent',
      subjectType: 'deliverable',
      subjectId: deliverableId,
      detail: `${deliverable.assetKind} → release ${releaseId}`,
    })
    await this.deps.audit.record({
      orgId: actor.orgId,
      actor: actor.userId,
      action: 'studio.delivery.sent',
      targetType: 'studio_deliverable',
      targetId: deliverableId,
      data: { releaseId, approvalId: approval.id },
    })
    // Where the record went, and on whose sign-off. This is the event a rights
    // question years later is most likely to be about.
    await this.deps.repos.provenance.append({
      orgId: actor.orgId,
      studioProjectId: deliverable.studioProjectId,
      eventType: 'delivery.sent',
      subjectType: 'studio_deliverable',
      subjectId: deliverableId,
      actorUserId: actor.userId,
      actorLabel: actorLabel(actor),
      payload: { assetKind: deliverable.assetKind, releaseId, approvalId: approval.id },
    })

    return this.deps.repos.deliverables.get(actor.orgId, deliverableId)
  }
}

const LOSSLESS_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aiff', 'audio/x-aiff'])

function requiredText(
  checkKey: string,
  value: string,
  label: string,
  expected: string,
): { checkKey: string; outcome: DeliveryCheckOutcome; detail: string; measured?: string | null; expected?: string | null } {
  return value && value.trim().length > 0
    ? { checkKey, outcome: 'pass', detail: `${label} present.`, measured: value }
    : { checkKey, outcome: 'fail', detail: `${label} is missing.`, expected }
}

export function deliveryFileName(artist: string, title: string, kind: DeliverableKind): string {
  const clean = (value: string) => value.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'untitled'
  return `${clean(artist)}-${clean(title)}-${kind}.wav`
}
