import { AppError } from '@masterclip/shared'
import { computeReleaseReadiness, metricValue } from '@masterclip/mix-analysis'
import { STUDIO_SERVICE_LABELS, type OpportunityRecord, type ServiceOrderRecord, type StudioService } from '@masterclip/studio-domain'
import { actorLabel, type Actor, type StudioDeps } from './deps.js'
import { toMixMetrics } from './mix.js'

/**
 * HUMAN ENGINEER MARKETPLACE and the OPPORTUNITY ENGINE.
 *
 * Both are architecture-first by design, and both refuse rather than pretend:
 *
 *   - The marketplace has a service catalogue in code and providers in data. An
 *     org with no configured providers cannot order anything, and the API says
 *     so rather than showing an empty picker that looks broken. Nothing here
 *     takes payment; the money fields exist so the revenue structure is
 *     modelled, and every one of them is zero until a payment integration sets
 *     them.
 *   - The opportunity engine only emits an opportunity it can explain. Every
 *     record carries `whyItMatches` and a `confidenceBasis`, and where the data
 *     to estimate value does not exist the estimate is null and the basis says
 *     which data is missing — rather than a plausible number nobody should act
 *     on.
 */
export class StudioMarketService {
  constructor(private readonly deps: StudioDeps) {}

  // --- marketplace ---------------------------------------------------------

  /**
   * What can actually be ordered right now.
   *
   * The catalogue is always returned so the surface can show what the
   * marketplace *will* offer, with `available: false` on everything until a
   * provider covers it.
   */
  async catalogue(actor: Actor) {
    const providers = await this.deps.repos.serviceProviders.listActive(actor.orgId)
    return {
      services: (Object.keys(STUDIO_SERVICE_LABELS) as StudioService[]).map((key) => ({
        key,
        label: STUDIO_SERVICE_LABELS[key],
        available: providers.some((provider) => provider.services.includes(key)),
        providers: providers.filter((provider) => provider.services.includes(key)).map((provider) => ({ id: provider.id, displayName: provider.displayName })),
      })),
      providerCount: providers.length,
      note:
        providers.length === 0
          ? 'No engineers are configured for this organization yet, so nothing can be ordered. The service catalogue is shown so you can see what the marketplace will cover.'
          : '',
    }
  }

  /**
   * Places an order.
   *
   * Refuses without a configured provider for the service — the one rule the
   * spec is explicit about. Fees are recorded but not charged: no payment
   * integration exists, and the order stays `draft` until one does.
   */
  async order(input: {
    actor: Actor
    projectId: string
    versionId?: string | null
    serviceKey: StudioService
    providerId: string
    brief: string
    rush?: boolean
  }): Promise<ServiceOrderRecord> {
    const providers = await this.deps.repos.serviceProviders.listActive(input.actor.orgId)
    const provider = providers.find((candidate) => candidate.id === input.providerId)
    if (!provider) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.provider_not_configured',
        message: 'that engineer is not configured for this organization, so this service cannot be ordered',
      })
    }
    if (!provider.services.includes(input.serviceKey)) {
      throw new AppError({
        kind: 'validation',
        code: 'studio.service_not_offered',
        message: `${provider.displayName} does not offer ${STUDIO_SERVICE_LABELS[input.serviceKey]}`,
      })
    }

    const order = await this.deps.repos.serviceOrders.create({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      studioVersionId: input.versionId ?? null,
      serviceKey: input.serviceKey,
      providerId: provider.id,
      brief: input.brief,
      ...(input.rush !== undefined ? { rush: input.rush } : {}),
      createdBy: input.actor.userId,
    })

    await this.deps.repos.activity.record({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      actorUserId: input.actor.userId,
      actorLabel: actorLabel(input.actor),
      action: 'service.ordered',
      subjectType: 'service_order',
      subjectId: order.id,
      detail: `${STUDIO_SERVICE_LABELS[input.serviceKey]} · ${provider.displayName}`,
    })
    return order
  }

  async orders(actor: Actor, projectId: string): Promise<ServiceOrderRecord[]> {
    return this.deps.repos.serviceOrders.list(actor.orgId, projectId)
  }

  // --- opportunity engine --------------------------------------------------

  /**
   * Generates opportunities for a project from what the platform actually
   * knows.
   *
   * Today that is: the record's own measurements, its stage, its rights
   * position, its readiness, and its release date. The dimensions the spec
   * eventually wants — streaming, social, touring, audience, campaign
   * performance — are not connected to Studio yet, and the engine says which
   * are missing rather than pretending it weighed them.
   */
  async generate(actor: Actor, projectId: string): Promise<OpportunityRecord[]> {
    const project = await this.deps.repos.projects.get(actor.orgId, projectId)
    const versionId = project.approvedMasterVersionId ?? project.currentVersionId
    const analysis = versionId ? await this.deps.repos.analyses.latestForVersion(actor.orgId, versionId) : null
    const metrics = analysis ? toMixMetrics(await this.deps.repos.analyses.metrics(actor.orgId, analysis.id)) : []
    const permissions = await this.deps.repos.aiPermissions.list(actor.orgId, projectId)
    const deliverables = await this.deps.repos.deliverables.list(actor.orgId, projectId)

    // Regenerating replaces the open set rather than accumulating: a
    // recommendation about a mix that has since been remastered is noise.
    await this.deps.repos.opportunities.clearFor(actor.orgId, projectId)

    const missing: string[] = []
    if (!analysis) missing.push('audio analysis')
    if (!project.releaseId) missing.push('release and streaming data')
    missing.push('audience, social, touring and campaign data (not yet connected to Studio)')
    const basisSuffix = `Estimates rest only on what Street Banker holds for this project. Not weighed: ${missing.join('; ')}.`

    const written: OpportunityRecord[] = []
    const readiness = metrics.length > 0 ? computeReleaseReadiness(metrics) : null

    // 1. Sync — driven by rights position, which is the thing that actually
    //    decides whether a sync opportunity is real.
    const syncClear = await this.deps.repos.aiPermissions.isAllowed(actor.orgId, projectId, 'master', 'commercial_sync_generation')
    const hasInstrumental = deliverables.some((deliverable) => deliverable.assetKind === 'instrumental')
    if (project.approvedMasterVersionId) {
      written.push(
        await this.deps.repos.opportunities.create({
          orgId: actor.orgId,
          studioProjectId: projectId,
          opportunityType: 'sync',
          headline: syncClear.allowed ? 'This record is rights-ready for sync pitching' : 'Sync pitching is blocked on rights, not on the record',
          whyItMatches: syncClear.allowed
            ? `There is an approved master and commercial sync generation is permitted on it.${hasInstrumental ? ' An instrumental deliverable also exists, which most sync briefs require.' : ' No instrumental deliverable exists yet; most sync briefs ask for one.'}`
            : `There is an approved master, but ${syncClear.reason}. Sync is a rights question before it is a music question.`,
          evidence: [
            `approved master: ${project.approvedMasterVersionId}`,
            `sync permission: ${syncClear.allowed ? 'granted' : syncClear.reason}`,
            `instrumental deliverable: ${hasInstrumental ? 'present' : 'absent'}`,
          ],
          expectedValueMicros: null,
          expectedCostMicros: null,
          confidence: syncClear.allowed ? 0.5 : 0.7,
          confidenceBasis: `Based on the project's stored rights permissions and deliverables. ${basisSuffix}`,
        }),
      )
    }

    // 2. Fan remix / licensed fan creation — only where a permission exists.
    const remix = permissions.find((permission) => permission.permission === 'fan_remix' && permission.granted && !permission.revokedAt)
    const hasStems = deliverables.some((deliverable) => deliverable.assetKind === 'stems')
    if (remix) {
      written.push(
        await this.deps.repos.opportunities.create({
          orgId: actor.orgId,
          studioProjectId: projectId,
          opportunityType: 'fan_market',
          headline: 'Fan remix use is permitted on this record',
          whyItMatches: `A fan remix permission is on file${remix.territories.length > 0 ? ` for ${remix.territories.join(', ')}` : ''}.${hasStems ? ' Stems are already prepared.' : ' Preparing stems is the practical next step.'}`,
          evidence: [`permission: ${remix.id}`, `stems: ${hasStems ? 'prepared' : 'not prepared'}`, remix.conditions || 'no additional conditions recorded'],
          expectedValueMicros: null,
          expectedCostMicros: null,
          confidence: 0.6,
          confidenceBasis: `Based on the stored AI-use permissions for this project. ${basisSuffix}`,
        }),
      )
    }

    // 3. Playlist readiness — a technical observation, framed as one.
    if (readiness?.score !== null && readiness !== null) {
      const translation = readiness.bands.find((band) => band.band === 'streaming_translation')
      written.push(
        await this.deps.repos.opportunities.create({
          orgId: actor.orgId,
          studioProjectId: projectId,
          opportunityType: 'playlist',
          headline:
            (translation?.score ?? 0) >= 80
              ? 'Technically ready for playlist pitching'
              : 'Worth resolving the translation findings before playlist pitching',
          whyItMatches:
            (translation?.score ?? 0) >= 80
              ? `Streaming translation scores ${translation?.score}: ${translation?.detected}`
              : `Streaming translation scores ${translation?.score ?? 'unmeasured'}. ${translation?.recommendation ?? ''}`,
          evidence: [`release readiness: ${readiness.score}/100 over ${readiness.bandsScored} bands`, translation?.detected ?? 'translation not measured'],
          expectedValueMicros: null,
          expectedCostMicros: null,
          confidence: 0.4,
          confidenceBasis: `A technical readiness observation only — it says nothing about whether an editor would playlist the record. ${basisSuffix}`,
        }),
      )
    }

    // 4. Release timing — only when there is a date to reason about.
    if (project.releaseDate) {
      const days = Math.round((new Date(project.releaseDate).getTime() - this.deps.clock.now()) / 86_400_000)
      const readyToShip = deliverables.filter((deliverable) => deliverable.status === 'checks_passed' || deliverable.status === 'approved' || deliverable.status === 'sent').length
      written.push(
        await this.deps.repos.opportunities.create({
          orgId: actor.orgId,
          studioProjectId: projectId,
          opportunityType: 'catalog',
          headline: days < 0 ? 'The release date has passed' : days < 28 ? `${days} days to release — delivery is the critical path` : `${days} days to release`,
          whyItMatches:
            days < 28
              ? `${readyToShip} of ${deliverables.length} deliverable(s) have passed their checks. DSPs generally want assets several weeks ahead of a release date.`
              : `${readyToShip} of ${deliverables.length} deliverable(s) have passed their checks, with time in hand.`,
          evidence: [`release date: ${project.releaseDate}`, `deliverables ready: ${readyToShip}/${deliverables.length}`, `stage: ${project.stage}`],
          expectedValueMicros: null,
          expectedCostMicros: null,
          confidence: 0.8,
          confidenceBasis: `Counted from the stored release date and delivery state. ${basisSuffix}`,
        }),
      )
    }

    return written
  }

  async opportunities(actor: Actor, projectId: string): Promise<OpportunityRecord[]> {
    return this.deps.repos.opportunities.list(actor.orgId, projectId)
  }

  async setOpportunityStatus(actor: Actor, id: string, status: 'open' | 'accepted' | 'dismissed'): Promise<OpportunityRecord> {
    return this.deps.repos.opportunities.setStatus(actor.orgId, id, status)
  }
}
