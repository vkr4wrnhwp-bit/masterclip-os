import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError, formatUsd, newId, sha256File, type MicroUsd } from '@masterclip/shared'
import { JOB_TYPES, QUEUES } from '@masterclip/queue'
import { toNum } from '@masterclip/database'
import { objectKey, type StorageDriver } from '@masterclip/asset-storage'
import { AUDIT_ACTIONS, type RenderJob } from '@masterclip/domain'
import {
  isQuoteValid,
  signCallbackUrl,
  type CanonicalRenderRequest,
  type ModelTier,
  type PriceQuote,
  type ProviderInputAsset,
} from '@masterclip/provider-core'
import { compilePrompt, type PromptDialect } from '@masterclip/prompt-compiler'
import {
  contactSheet,
  extractFrames,
  makeThumbnail,
  probe,
  sampleTimestamps,
  transcode,
} from '@masterclip/media-tools'
import { decide, runTechnicalQc, runVisualQc, HeuristicVisionClient, type VisionClient } from '@masterclip/qc-engine'
import { ClaudeVisionClient } from '@masterclip/agents'
import { CanonicalShot, deriveRequirements, type CanonicalShot as Shot } from '@masterclip/shot-schema'
import type { Runtime } from './index.js'

export interface PlannedCandidate {
  providerId: string
  modelId: string
  seed: string | null
  variationLabel: string
  variationInstruction: string
  resolution: string
  aspectRatio: string
  durationSeconds: number
}

export interface PlanResult {
  jobIds: string[]
  skipped: Array<{ candidate: PlannedCandidate; reason: string }>
  estimatedMicros: MicroUsd
  warnings: string[]
}

/**
 * The render pipeline.
 *
 * Every stage is a queue job, so the whole thing survives a browser close, an
 * API restart, or a worker crash: state lives in the database and a lost lease
 * simply returns the work to the pool.
 *
 * The ordering that matters: **quote → authorize → submit**, in that order,
 * every time. Nothing calls a provider's `submit()` except
 * {@link RenderService.submitRender}, and that method cannot reach the provider
 * without passing the cost controller first.
 */
export class RenderService {
  constructor(private readonly rt: Runtime) {}

  // ==========================================================================
  // planning
  // ==========================================================================

  /**
   * Turns a matrix of candidates into queued render jobs.
   *
   * Quoting happens here, before anything is queued, so the operator sees the
   * real total. A candidate that cannot be quoted or authorized is skipped with
   * a reason rather than silently dropped or optimistically submitted.
   */
  async planBatch(input: {
    projectId: string
    shotId: string
    batchName: string
    candidates: PlannedCandidate[]
    createdBy: string
    orgId: string
    humanApproved?: boolean
  }): Promise<PlanResult> {
    const shot = await this.rt.projects.getShot(input.shotId)
    const version = await this.rt.projects.currentVersion(input.shotId)
    const project = await this.rt.projects.get(input.projectId)
    const warnings: string[] = []
    const skipped: PlanResult['skipped'] = []

    const bibles = await this.rt.bibles.resolveForShot(input.projectId, {
      identity: version.spec.identity_locks.map((l) => ({ character_key: l.character_key, character_version: l.character_version })),
      environment: version.spec.environment_lock
        ? {
            environment_key: version.spec.environment_lock.environment_key,
            environment_version: version.spec.environment_lock.environment_version,
          }
        : null,
    })

    // Identity work only proceeds against explicitly authorized reference packs.
    const identityAssets = new Set<string>()
    for (const character of bibles.characters.values()) {
      if (version.spec.identity_locks.some((lock) => lock.character_key === character.character_key && lock.strength === 'strict')) {
        for (const reference of character.references) identityAssets.add(reference.asset_id)
      }
    }
    if (identityAssets.size > 0) await this.rt.assets.requireAuthorizedForIdentity([...identityAssets])

    const batch = await this.rt.renders.createBatch({
      projectId: input.projectId,
      name: input.batchName,
      matrix: { candidates: input.candidates },
      estimatedMicros: 0,
      candidateCount: input.candidates.length,
      createdBy: input.createdBy,
    })

    const jobIds: string[] = []
    let estimatedTotal = 0
    // Running total so each candidate is authorized against what the batch has
    // already committed, not against the balance at plan time.
    let committedMicros = 0

    for (const candidate of input.candidates) {
      try {
        const provider = this.rt.registry.get(candidate.providerId)
        const model = await this.rt.registry.findModel(candidate.providerId, candidate.modelId)

        const spec: Shot = CanonicalShot.parse({
          ...version.spec,
          target_resolution: candidate.resolution,
          aspect_ratio: candidate.aspectRatio,
          duration_seconds: candidate.durationSeconds,
        })

        const compiled = compilePrompt({
          shot: spec,
          styleBible: project.styleBible,
          characters: bibles.characters,
          environments: bibles.environments,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          capabilities: model.capabilities,
          variation: { index: 0, instruction: candidate.variationInstruction, label: candidate.variationLabel },
        })
        warnings.push(...compiled.warnings.map((w) => `${candidate.providerId}/${candidate.modelId}: ${w}`))

        const request = await this.buildRequest({
          projectId: input.projectId,
          shotId: input.shotId,
          shotVersionId: version.id,
          spec,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          prompt: compiled.prompt,
          negativePrompt: compiled.negativePrompt,
          seed: candidate.seed,
          requestId: newId('job', this.rt.clock.now()),
        })

        const validation = await provider.validate(request)
        if (!validation.ok) {
          skipped.push({ candidate, reason: `provider validation failed: ${validation.errors.join('; ')}` })
          continue
        }
        // validate() works out the provider-legal duration and records it in
        // `adjustments`, but nothing ever applied it: the request kept its
        // original value, the quote was bound to that value, and every adapter
        // then submitted `Math.round(durationSeconds)`. So a 7.6s shot was
        // priced at 7.6s and generated at 8s — the quote described a request
        // the provider never received, and on a per-second model the difference
        // is charged to us.
        applyAdjustments(request, validation.adjustments)

        const quote = await provider.quote(request)
        const quoteId = await this.rt.quotes.save(quote, { projectId: input.projectId, shotId: input.shotId })

        const authorization = await this.rt.cost.authorize({
          orgId: input.orgId,
          projectId: input.projectId,
          shotId: input.shotId,
          batchId: batch.id,
          request,
          quote,
          tier: model.capabilities.tier,
          committedMicros,
          ...(input.humanApproved !== undefined ? { humanApproved: input.humanApproved } : {}),
        })
        warnings.push(...authorization.warnings.map((w) => `${candidate.providerId}/${candidate.modelId}: ${w}`))

        if (!authorization.allowed) {
          skipped.push({ candidate, reason: authorization.denials.map((d) => d.message).join('; ') })
          await this.rt.audit.record({
            orgId: input.orgId,
            projectId: input.projectId,
            actor: input.createdBy,
            action: AUDIT_ACTIONS.renderDenied,
            targetType: 'shot',
            targetId: input.shotId,
            data: { denials: authorization.denials, estimated: quote.estimatedMicros },
          })
          continue
        }

        const { job, created } = await this.rt.renders.createJob({
          batchId: batch.id,
          projectId: input.projectId,
          sceneId: shot.sceneId,
          shotId: input.shotId,
          shotVersionId: version.id,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          routingProfile: spec.routing_profile,
          compiledPrompt: compiled.prompt,
          request: { ...request, requestId: '' } as unknown as Record<string, unknown>,
          estimatedMicros: quote.estimatedMicros,
          quoteId,
          seed: candidate.seed,
          sandbox: this.isSandboxProvider(candidate.providerId),
          createdBy: input.createdBy,
        })

        if (!created) {
          skipped.push({ candidate, reason: 'identical render already queued (idempotency) — reusing the existing job' })
        }
        jobIds.push(job.id)
        estimatedTotal += quote.estimatedMicros
        committedMicros += quote.estimatedMicros

        await this.rt.queue.enqueue({
          queue: QUEUES.render,
          type: JOB_TYPES.submitRender,
          payload: { jobId: job.id },
          dedupeKey: `submit:${job.id}`,
          maxAttempts: 3,
        })
      } catch (err) {
        skipped.push({ candidate, reason: err instanceof Error ? err.message : String(err) })
      }
    }

    await this.rt.renders.setBatchStatus(batch.id, jobIds.length > 0 ? 'running' : 'cancelled')
    return { jobIds, skipped, estimatedMicros: estimatedTotal, warnings }
  }

  private isSandboxProvider(providerId: string): boolean {
    return providerId === 'mock' || this.rt.config.isSandbox
  }

  /** Builds a provider-agnostic request, resolving reference assets to inputs. */
  private async buildRequest(input: {
    projectId: string
    shotId: string
    shotVersionId: string
    spec: Shot
    providerId: string
    modelId: string
    prompt: string
    negativePrompt: string
    seed: string | null
    requestId: string
  }): Promise<CanonicalRenderRequest> {
    const requirements = deriveRequirements(input.spec)
    const resolve = async (assetId: string | null): Promise<ProviderInputAsset | undefined> => {
      if (!assetId) return undefined
      const asset = await this.rt.assets.find(assetId)
      if (!asset) return undefined
      const localPath = this.rt.storage.localPath(asset.storageKey)
      return {
        assetId: asset.id,
        sha256: asset.sha256,
        mime: asset.mime,
        bytes: asset.bytes,
        ...(localPath ? { localPath } : {}),
        ...(asset.width ? { width: asset.width } : {}),
        ...(asset.height ? { height: asset.height } : {}),
      }
    }

    const references: ProviderInputAsset[] = []
    for (const assetId of input.spec.source_assets) {
      const resolved = await resolve(assetId)
      if (resolved) references.push(resolved)
    }

    const webhookUrl =
      this.rt.config.publicBaseUrl && this.rt.config.WEBHOOK_SECRET
        ? signCallbackUrl(this.rt.config.WEBHOOK_SECRET, this.rt.config.publicBaseUrl, input.providerId, input.requestId)
        : ''

    const firstFrame = await resolve(input.spec.first_frame_asset)
    const lastFrame = await resolve(input.spec.last_frame_asset)
    const video = await resolve(input.spec.reference_video_assets[0] ?? null)

    return {
      requestId: input.requestId,
      projectId: input.projectId,
      shotId: input.shotId,
      shotVersionId: input.shotVersionId,
      providerId: input.providerId,
      modelId: input.modelId,
      mode: input.spec.generation_mode,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      durationSeconds: input.spec.duration_seconds,
      resolution: input.spec.target_resolution,
      aspectRatio: input.spec.aspect_ratio,
      fps: input.spec.fps,
      seed: input.seed,
      audio: { mode: input.spec.audio_mode, dialogue: input.spec.dialogue, ambient: input.spec.ambient_audio },
      inputs: {
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        references,
        ...(video ? { video } : {}),
      },
      webhookUrl,
      sandbox: this.isSandboxProvider(input.providerId),
      maxCostMicros: Math.round(input.spec.max_cost_usd * 1_000_000),
      metadata: { width: String(requirements.width), height: String(requirements.height), shot_category: input.spec.shot_category },
    }
  }

  // ==========================================================================
  // submit
  // ==========================================================================

  /**
   * Submits a queued job.
   *
   * Re-quotes and re-authorizes even though planning already did: a job can sit
   * in the queue for hours, prices move, and budgets get spent by other jobs in
   * the meantime. Authorizing at plan time and submitting later without
   * re-checking is how a batch overruns its budget.
   */
  async submitRender(jobId: string): Promise<void> {
    const job = await this.rt.renders.getJob(jobId)
    if (job.status !== 'queued' && job.status !== 'blocked') {
      this.rt.logger.debug('render.submit_skipped', { job_id: jobId, status: job.status })
      return
    }

    const provider = this.rt.registry.get(job.providerId)
    const request = this.requestFor(job)
    const model = await this.rt.registry.findModel(job.providerId, job.modelId)
    const project = await this.rt.projects.get(job.projectId)

    await this.rt.renders.updateJob(jobId, { status: 'authorizing' })

    const quote = await this.freshQuote(job, request, model.capabilities.tier)
    const authorization = await this.rt.cost.authorize({
      orgId: project.orgId,
      projectId: job.projectId,
      shotId: job.shotId,
      batchId: job.batchId,
      request,
      quote,
      tier: model.capabilities.tier,
    })

    if (!authorization.allowed) {
      await this.rt.renders.updateJob(jobId, {
        status: 'blocked',
        error: { code: 'budget.denied', denials: authorization.denials },
      })
      await this.rt.audit.record({
        orgId: project.orgId,
        projectId: job.projectId,
        actor: job.createdBy,
        action: AUDIT_ACTIONS.renderDenied,
        targetType: 'render_job',
        targetId: jobId,
        data: { denials: authorization.denials },
      })
      // Not a queue failure: the job is parked until a human raises the budget
      // or approves it. Retrying on a timer would just re-deny.
      throw new AppError({
        kind: 'budget_exceeded',
        code: 'render.blocked',
        message: `render blocked: ${authorization.denials.map((d) => d.message).join('; ')}`,
      })
    }

    const attemptNumber = job.attempts + 1
    const attemptId = await this.rt.renders.recordAttempt({
      jobId,
      attempt: attemptNumber,
      providerId: job.providerId,
      modelId: job.modelId,
      status: 'submitting',
      estimatedMicros: quote.estimatedMicros,
      billable: !job.sandbox,
    })

    const startedAt = this.rt.clock.now()
    try {
      const submitted = await provider.submit(request)
      await this.rt.renders.updateJob(jobId, {
        status: 'submitted',
        externalJobId: submitted.externalJobId,
        attempts: attemptNumber,
        estimatedMicros: quote.estimatedMicros,
        submittedAt: this.rt.clock.isoNow(),
        error: null,
      })
      await this.rt.renders.completeAttempt(attemptId, { status: 'submitted', latencyMs: this.rt.clock.now() - startedAt })

      // The estimate is recorded now; the charge is recorded when the provider
      // reports one. The gap between them is the variance report.
      await this.rt.ledger.append({
        orgId: project.orgId,
        projectId: job.projectId,
        sceneId: job.sceneId,
        shotId: job.shotId,
        batchId: job.batchId,
        jobId,
        attemptId,
        providerId: job.providerId,
        modelId: job.modelId,
        entryType: 'estimate',
        micros: quote.estimatedMicros,
        billableSeconds: request.durationSeconds,
        quoteId: job.quoteId,
        externalRequestId: submitted.externalJobId,
        sandbox: job.sandbox,
        note: `${quote.source}/${quote.confidence}`,
        createdBy: job.createdBy,
      })

      await this.rt.audit.record({
        orgId: project.orgId,
        projectId: job.projectId,
        actor: job.createdBy,
        action: AUDIT_ACTIONS.renderSubmitted,
        targetType: 'render_job',
        targetId: jobId,
        data: { provider: job.providerId, model: job.modelId, estimated: formatUsd(quote.estimatedMicros), external: submitted.externalJobId },
      })

      await this.rt.queue.enqueue({
        queue: QUEUES.render,
        type: JOB_TYPES.pollRender,
        payload: { jobId },
        delayMs: this.rt.config.PROVIDER_POLL_INTERVAL_MS,
        dedupeKey: `poll:${jobId}`,
        maxAttempts: 200,
      })
    } catch (err) {
      await this.rt.renders.completeAttempt(attemptId, {
        status: 'failed',
        latencyMs: this.rt.clock.now() - startedAt,
        error: { message: err instanceof Error ? err.message : String(err) },
      })
      await this.rt.renders.updateJob(jobId, {
        status: 'failed',
        attempts: attemptNumber,
        failedAt: this.rt.clock.isoNow(),
        error: { message: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
  }

  /** Reuses a still-valid quote; otherwise asks the provider again. */
  private async freshQuote(job: RenderJob, request: CanonicalRenderRequest, _tier: ModelTier): Promise<PriceQuote> {
    if (job.quoteId) {
      const existing = await this.rt.quotes.get(job.quoteId)
      if (existing && isQuoteValid(existing, request, this.rt.clock.now()).ok) return existing
    }
    const provider = this.rt.registry.get(job.providerId)
    const quote = await provider.quote(request)
    const quoteId = await this.rt.quotes.save(quote, { projectId: job.projectId, shotId: job.shotId })
    await this.rt.renders.updateJob(job.id, { quoteId, estimatedMicros: quote.estimatedMicros })
    return quote
  }

  private requestFor(job: RenderJob): CanonicalRenderRequest {
    return { ...(job.request as unknown as CanonicalRenderRequest), requestId: job.id }
  }

  // ==========================================================================
  // poll
  // ==========================================================================

  /**
   * Checks provider state. Returns a delay in ms when the job is still running,
   * so the queue re-schedules rather than blocking a worker slot on a sleep.
   */
  async pollRender(jobId: string): Promise<{ done: boolean; deferMs: number }> {
    const job = await this.rt.renders.getJob(jobId)
    if (!job.externalJobId) throw new AppError({ kind: 'internal', message: `job ${jobId} has no external id to poll` })
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return { done: true, deferMs: 0 }

    const submittedAt = job.submittedAt ? Date.parse(job.submittedAt) : this.rt.clock.now()
    if (this.rt.clock.now() - submittedAt > this.rt.config.PROVIDER_JOB_TIMEOUT_MS) {
      // Ask once more before giving up. Timing out is our decision, not the
      // provider's: the generation may well have finished — or failed — while we
      // were waiting, and a final status is the only chance to learn what it
      // cost. Failing the job without asking discarded that, and since the poll
      // loop stops at a terminal state nothing would ever ask again.
      let finalCost: MicroUsd | null = null
      let finalSeconds: number | null = null
      try {
        const last = await this.rt.registry.get(job.providerId).getStatus(job.externalJobId)
        finalCost = last.actualMicros
        finalSeconds = last.billableSeconds
      } catch (err) {
        this.rt.logger.warn('render.timeout_status_failed', { jobId, err: String(err) })
      }
      await this.rt.renders.updateJob(jobId, {
        status: 'failed',
        failedAt: this.rt.clock.isoNow(),
        error: { code: 'provider.timeout', message: `no terminal state after ${Math.round(this.rt.config.PROVIDER_JOB_TIMEOUT_MS / 60000)} minutes` },
      })
      // The provider started work, so it very likely billed for it. Charge what
      // it reported, or the estimate when it reports nothing — the alternative
      // is a generation that cost money and left no trace in any budget.
      await chargeJobOnce(
        this.rt,
        job,
        finalCost ?? job.estimatedMicros,
        finalSeconds,
        finalCost === null ? 'timed out with no provider cost; charged at estimate' : 'timed out; charged at the provider-reported cost',
      )
      return { done: true, deferMs: 0 }
    }

    const provider = this.rt.registry.get(job.providerId)
    const status = await provider.getStatus(job.externalJobId)

    if (status.state === 'queued' || status.state === 'running') {
      if (job.status !== 'processing') await this.rt.renders.updateJob(jobId, { status: 'processing' })
      return { done: false, deferMs: this.rt.config.PROVIDER_POLL_INTERVAL_MS }
    }

    if (status.state === 'failed' || status.state === 'cancelled') {
      await this.rt.renders.updateJob(jobId, {
        status: status.state === 'cancelled' ? 'cancelled' : 'failed',
        failedAt: this.rt.clock.isoNow(),
        error: status.error ?? { message: status.state },
      })
      // A provider-side generation failure may still have been billed. Record
      // whatever charge the provider reported rather than assuming zero.
      if (status.actualMicros && status.actualMicros > 0) await this.recordCharge(job, status.actualMicros, status.billableSeconds)
      return { done: true, deferMs: 0 }
    }

    await this.rt.renders.updateJob(jobId, { status: 'downloading', completedAt: this.rt.clock.isoNow() })
    await this.settleCharge(job, status)

    await this.rt.queue.enqueue({
      queue: QUEUES.render,
      type: JOB_TYPES.ingestOutput,
      payload: { jobId },
      dedupeKey: `ingest:${jobId}`,
      maxAttempts: 5,
    })
    return { done: true, deferMs: 0 }
  }

  /**
   * Writes the charge for a completed generation, falling back to the estimate
   * when the provider does not report a cost.
   *
   * Five of seven adapters — fal, Google, Luma, Replicate and the self-hosted
   * one — always return `actualMicros: null`, because their APIs simply do not
   * return a price. Skipping the ledger write in that case meant no `charge`
   * row was ever produced for them, and every budget built from charges,
   * including the global live-spend cap, read $0 for ever. The money was spent;
   * only the record was missing.
   *
   * So an unpriced completion is charged at its estimate and labelled as such.
   * That is deliberately the conservative direction: a cap fed slightly wrong
   * numbers refuses too early, whereas a cap fed nothing never refuses at all.
   * `variance()` will show a zero delta for these rows, which is the signal
   * that the figure is ours rather than the provider's.
   */
  /**
   * Refuses QC work once the global live-spend ceiling is gone.
   *
   * QC is not a provider generation, so it never passes through
   * `CostController.authorize()` — which is where every other spend meets the
   * cap. That left one class of real spending permanently outside the only
   * global limit in the system. This is the narrow equivalent: the same ledger
   * total, the same ceiling, checked before the request rather than after.
   */
  private async assertQcSpendAllowed(outputId: string): Promise<void> {
    if (this.rt.config.isSandbox) return
    const spent = (await this.rt.ledger.totalLiveSpend()) + (await this.rt.ledger.committedInFlight())
    const cap = this.rt.config.liveSpendCapMicros
    if (spent < cap) return
    throw new AppError({
      kind: 'budget_exceeded',
      code: 'qc.live_cap',
      message: `visual QC needs to spend, but live spend of ${formatUsd(spent)} has reached the ${formatUsd(cap, 2)} cap`,
      details: { outputId },
    })
  }

  private async settleCharge(job: RenderJob, status: { actualMicros: MicroUsd | null; billableSeconds: number | null }): Promise<void> {
    if (status.actualMicros !== null) {
      await this.recordCharge(job, status.actualMicros, status.billableSeconds)
      return
    }
    this.rt.logger.warn('render.cost_unreported', {
      jobId: job.id,
      providerId: job.providerId,
      modelId: job.modelId,
      chargedMicros: job.estimatedMicros,
      note: 'provider reported no cost; charged at estimate so the spend is not invisible to budgets',
    })
    await this.recordCharge(job, job.estimatedMicros, status.billableSeconds, 'provider reported no cost; charged at estimate')
  }

  private async recordCharge(job: RenderJob, micros: MicroUsd, seconds: number | null, note?: string): Promise<void> {
    await chargeJobOnce(this.rt, job, micros, seconds, note ?? 'provider-reported charge')
  }


  // ==========================================================================
  // ingest
  // ==========================================================================

  /** Downloads outputs, verifies them, stores them, and queues QC. */
  async ingestOutputs(jobId: string): Promise<string[]> {
    const job = await this.rt.renders.getJob(jobId)
    if (!job.externalJobId) throw new AppError({ kind: 'internal', message: `job ${jobId} has no external id` })

    const existing = await this.rt.renders.listOutputs({ jobId })
    if (existing.length > 0) return existing.map((o) => o.id)

    const provider = this.rt.registry.get(job.providerId)
    const status = await provider.getStatus(job.externalJobId)
    if (status.state !== 'succeeded' || status.outputs.length === 0) {
      throw new AppError({ kind: 'provider_failed', code: 'ingest.no_outputs', message: `job ${jobId} has no downloadable outputs` })
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'masterclip-ingest-'))
    const outputIds: string[] = []
    try {
      const downloads = await provider.downloadOutputs({ externalJobId: job.externalJobId, outputs: status.outputs }, tempDir)

      for (const download of downloads) {
        const info = await probe(download.localPath).catch(() => null)
        const assetId = newId('ast', this.rt.clock.now())
        const key = objectKey({
          projectId: job.projectId,
          kind: 'generated_video',
          id: assetId,
          filename: `${job.shotId}_${download.index}.mp4`,
        })
        const stored = await this.rt.storage.putFile(key, download.localPath, {
          contentType: download.mime,
          sha256: download.sha256,
        })

        const asset = await this.rt.assets.create({
          projectId: job.projectId,
          kind: 'generated_video',
          storageKey: stored.key,
          filename: `${job.shotId}_${download.index}.mp4`,
          mime: download.mime,
          bytes: stored.bytes,
          sha256: stored.sha256,
          width: info?.video?.width ?? null,
          height: info?.video?.height ?? null,
          durationSeconds: info?.durationSeconds ?? null,
          fps: info?.video?.fps ?? null,
          hasAudio: Boolean(info?.audio),
          metadata: {
            provider: job.providerId,
            model: job.modelId,
            external_job_id: job.externalJobId,
            prompt: job.compiledPrompt,
            shot_version_id: job.shotVersionId,
            seed: job.seed,
          },
          rights: {
            owner: 'generated',
            source: `${job.providerId}/${job.modelId}`,
            license: 'provider terms apply',
            consent: 'not_applicable',
            allowedUse: 'project use',
            authorized: true,
            notes: 'machine-generated output',
          },
          createdBy: job.createdBy,
          parents: this.parentAssetsFor(job),
        })

        const output = await this.rt.renders.createOutput({
          jobId,
          attemptId: null,
          projectId: job.projectId,
          shotId: job.shotId,
          assetId: asset.id,
          proxyAssetId: null,
          thumbnailAssetId: null,
          contactSheetAssetId: null,
          outputIndex: download.index,
          providerId: job.providerId,
          modelId: job.modelId,
          durationSeconds: info?.durationSeconds ?? null,
          width: info?.video?.width ?? null,
          height: info?.video?.height ?? null,
          fps: info?.video?.fps ?? null,
          hasAudio: Boolean(info?.audio),
          sha256: stored.sha256,
          status: 'ingested',
          metadata: { compiled_prompt: job.compiledPrompt, routing_profile: job.routingProfile },
        })
        outputIds.push(output.id)

        await this.rt.queue.enqueue({
          queue: QUEUES.qc,
          type: JOB_TYPES.runTechnicalQc,
          payload: { outputId: output.id },
          dedupeKey: `qc:${output.id}`,
        })
        await this.rt.queue.enqueue({
          queue: QUEUES.media,
          type: JOB_TYPES.buildProxies,
          payload: { outputId: output.id },
          dedupeKey: `proxies:${output.id}`,
        })
      }

      await this.rt.renders.updateJob(jobId, { status: 'completed' })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
    return outputIds
  }

  private parentAssetsFor(job: RenderJob): Array<{ assetId: string; relation: 'generated_from' }> {
    const request = job.request as unknown as CanonicalRenderRequest
    const parents: Array<{ assetId: string; relation: 'generated_from' }> = []
    if (request?.inputs?.firstFrame) parents.push({ assetId: request.inputs.firstFrame.assetId, relation: 'generated_from' })
    if (request?.inputs?.lastFrame) parents.push({ assetId: request.inputs.lastFrame.assetId, relation: 'generated_from' })
    for (const reference of request?.inputs?.references ?? []) parents.push({ assetId: reference.assetId, relation: 'generated_from' })
    return parents
  }

  // ==========================================================================
  // quality control
  // ==========================================================================

  /**
   * Runs both QC layers and records the verdict.
   *
   * Technical QC always runs and is free. Visual QC runs only on clips that
   * passed technically — paying a vision model to look at a black frame is
   * money spent to learn what ffmpeg already proved.
   */
  async runQc(outputId: string): Promise<{ action: string; technicalPass: boolean }> {
    const output = await this.rt.renders.getOutput(outputId)
    const job = await this.rt.renders.getJob(output.jobId)
    const version = await this.rt.projects.getVersion(job.shotVersionId)
    const asset = await this.rt.assets.get(output.assetId)
    const project = await this.rt.projects.get(output.projectId)

    const { path: localPath, cleanup } = await this.localCopy(asset.storageKey, 'qc')
    try {
      const siblings = await this.rt.renders.siblingHashes(output.jobId)
      const technical = await runTechnicalQc(localPath, version.spec, { siblingHashes: siblings })

      await this.rt.renders.saveQc({
        outputId,
        layer: 'technical',
        engine: 'ffprobe+ffmpeg',
        technicalPass: technical.pass,
        recommendedAction: technical.pass ? 'PENDING_VISUAL' : 'AUTO_REJECT',
        confidence: 0.98,
        hardFailures: technical.hardFailures.map((f) => f.message),
        warnings: technical.warnings.map((f) => f.message),
        raw: technical.measurements,
        costMicros: 0,
      })

      let visual = null
      let framePaths: string[] = []
      if (technical.pass) {
        const frameDir = join(tmpdir(), `masterclip-frames-${outputId}`)
        const frames = await extractFrames(localPath, sampleTimestamps(technical.measurements.durationSeconds, 6), frameDir, {
          width: 768,
          prefix: outputId,
        })
        framePaths = frames.map((f) => f.path)

        // Vision QC spends real Anthropic money, and it used to do so with no
        // reference to the cap at all: the charge was appended to the ledger
        // after the fact, so QC kept spending long after LIVE_SPEND_CAP_USD was
        // exhausted. It is not a provider generation and does not go through
        // authorize(), but it must still respect the one global ceiling.
        await this.assertQcSpendAllowed(outputId)

        const client = this.visionClient(() => technical)
        const characters = [...(await this.rt.bibles.listCharacters(output.projectId))]
          .filter((c) => version.spec.identity_locks.some((lock) => lock.character_key === c.characterKey))
          .map((c) => c.record)

        visual = await runVisualQc(client, {
          shot: version.spec,
          characters,
          technical,
          framePaths,
          tier: version.spec.routing_profile === 'HERO' ? 'deep' : 'fast',
        })

        // A negative cost is the sentinel for "this model is not in the pricing
        // table". Skipping the ledger write for it, as `> 0` did, hid the spend
        // from every budget — precisely the outcome the sentinel exists to
        // prevent. Pinning a dated model snapshot in ANTHROPIC_QC_MODEL is
        // ordinary practice, so this is reachable by configuration alone.
        if (visual.costMicros < 0) {
          this.rt.logger.error('qc.unpriced_model', {
            outputId,
            engine: visual.engine,
            note: 'visual QC ran on a model with no entry in the pricing table; its cost is unknown and therefore unbudgeted',
          })
        }
        if (visual.costMicros !== 0) {
          await this.rt.ledger.append({
            orgId: project.orgId,
            projectId: output.projectId,
            shotId: output.shotId,
            jobId: output.jobId,
            outputId,
            providerId: 'anthropic',
            modelId: visual.engine,
            entryType: 'qc',
            micros: visual.costMicros,
            sandbox: false,
            note: 'visual QC',
            createdBy: job.createdBy,
          })
        }
        await rm(frameDir, { recursive: true, force: true })
      }

      const report = decide({ shot: version.spec, technical, visual })

      await this.rt.renders.saveQc({
        outputId,
        layer: 'combined',
        engine: report.engines.visual,
        technicalPass: report.technical_pass,
        creativeScore: report.creative_score,
        identityScore: report.identity_score,
        continuityScore: report.continuity_score,
        motionScore: report.motion_score,
        realismScore: report.realism_score,
        recommendedAction: report.recommended_action,
        confidence: report.confidence,
        hardFailures: report.hard_failures,
        warnings: report.warnings,
        raw: report,
        costMicros: report.costMicros,
      })

      await this.rt.renders.updateOutput(outputId, {
        status: report.recommended_action === 'AUTO_REJECT' ? 'qc_failed' : technical.pass ? 'qc_passed' : 'qc_failed',
      })

      return { action: report.recommended_action, technicalPass: technical.pass }
    } finally {
      await cleanup()
    }
  }

  private visionClient(technicalProvider: () => ReturnType<typeof runTechnicalQc> extends Promise<infer T> ? T : never): VisionClient {
    if (this.rt.agents.available) {
      return new ClaudeVisionClient({
        client: this.rt.agents.client,
        fastModel: this.rt.config.ANTHROPIC_QC_MODEL,
        deepModel: this.rt.config.ANTHROPIC_MODEL,
      }) as unknown as VisionClient
    }
    return new HeuristicVisionClient(technicalProvider)
  }

  // ==========================================================================
  // derivatives and finishing
  // ==========================================================================

  /**
   * Review proxy, thumbnail, and contact sheet — everything the grid needs.
   *
   * Returns `false` without raising when the source is unreadable. A truncated
   * or corrupt download has nothing to proxy, and QC has already recorded *why*;
   * failing here would only dead-letter a job that can never succeed.
   */
  async buildDerivatives(outputId: string): Promise<boolean> {
    const output = await this.rt.renders.getOutput(outputId)
    const asset = await this.rt.assets.get(output.assetId)
    const { path: localPath, cleanup } = await this.localCopy(asset.storageKey, 'derive')
    const workDir = await mkdtemp(join(tmpdir(), 'masterclip-derive-'))

    try {
      const readable = await probe(localPath).then(
        (info) => info.video !== null,
        () => false,
      )
      if (!readable) {
        this.rt.logger.warn('render.derivatives_skipped', { output_id: outputId, reason: 'source is not a readable video container' })
        await this.rt.renders.updateOutput(outputId, {
          status: 'qc_failed',
          metadata: { ...output.metadata, derivatives_skipped: 'source container unreadable' },
        })
        return false
      }

      const proxyPath = join(workDir, 'proxy.mp4')
      await transcode(localPath, proxyPath, { format: 'review_h264', width: 854 })
      const proxy = await this.storeDerived(output.projectId, 'proxy', proxyPath, 'proxy.mp4', 'video/mp4', asset.id, 'proxy_of', output.jobId)

      const thumbPath = join(workDir, 'thumb.jpg')
      await makeThumbnail(localPath, thumbPath, { width: 640 })
      const thumb = await this.storeDerived(output.projectId, 'thumbnail', thumbPath, 'thumb.jpg', 'image/jpeg', asset.id, 'thumbnail_of', output.jobId)

      const sheetPath = join(workDir, 'contact.jpg')
      await contactSheet(localPath, sheetPath, { columns: 4, rows: 3, tileWidth: 320 })
      const sheet = await this.storeDerived(
        output.projectId,
        'contact_sheet',
        sheetPath,
        'contact.jpg',
        'image/jpeg',
        asset.id,
        'contact_sheet_of',
        output.jobId,
      )

      await this.rt.renders.updateOutput(outputId, {
        proxyAssetId: proxy,
        thumbnailAssetId: thumb,
        contactSheetAssetId: sheet,
      })
      return true
    } finally {
      await rm(workDir, { recursive: true, force: true })
      await cleanup()
    }
  }

  private async storeDerived(
    projectId: string,
    kind: 'proxy' | 'thumbnail' | 'contact_sheet' | 'frame' | 'master' | 'delivery' | 'sidecar',
    localPath: string,
    filename: string,
    mime: string,
    parentAssetId: string,
    relation: 'proxy_of' | 'thumbnail_of' | 'contact_sheet_of' | 'frame_of' | 'master_of' | 'delivery_of',
    createdBy: string,
  ): Promise<string> {
    const assetId = newId('ast', this.rt.clock.now())
    const key = objectKey({ projectId, kind, id: assetId, filename })
    const sha = await sha256File(localPath)
    const stored = await this.rt.storage.putFile(key, localPath, { contentType: mime, sha256: sha })
    const asset = await this.rt.assets.create({
      projectId,
      kind,
      storageKey: stored.key,
      filename,
      mime,
      bytes: stored.bytes,
      sha256: stored.sha256,
      metadata: { derived: true },
      rights: { owner: 'generated', source: 'derived', license: 'inherits parent', consent: 'not_applicable', authorized: true },
      createdBy,
      parents: [{ assetId: parentAssetId, relation }],
    })
    return asset.id
  }

  /** Stages a stored object on local disk for ffmpeg, which needs a path. */
  private async localCopy(storageKey: string, label: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const direct = this.rt.storage.localPath(storageKey)
    if (direct) return { path: direct, cleanup: async () => {} }
    const dir = await mkdtemp(join(tmpdir(), `masterclip-${label}-`))
    const path = await this.rt.storage.materialize(storageKey, join(dir, 'source.mp4'))
    return { path, cleanup: async () => rm(dir, { recursive: true, force: true }) }
  }
}

export type { StorageDriver }

/**
 * Writes at most one `charge` row per render job.
 *
 * Three separate paths settle a job — the poll loop, an operator cancel, and
 * the poll timeout — and two of them can run concurrently: a provider webhook
 * enqueues a poll under its own dedupe key while the timer poll is still
 * scheduled, so both can observe the same terminal state and both call through
 * here. `downloading` is not a terminal guard, so nothing upstream stopped the
 * second one. One generation would then appear in the ledger as two charges,
 * which inflates every budget and the global cap against work that happened
 * once.
 *
 * Idempotence lives here rather than in each caller because "one generation,
 * one charge" is a property of the ledger, not of whoever happens to notice the
 * job finished first.
 *
 * Returns the micros written, or null when a charge already existed.
 */
export async function chargeJobOnce(
  rt: Runtime,
  job: RenderJob,
  micros: MicroUsd,
  seconds: number | null,
  note: string,
): Promise<MicroUsd | null> {
  const existing = await rt.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cost_ledger WHERE job_id = ? AND entry_type = 'charge'`,
    [job.id],
  )
  if (toNum(existing?.n, 0) > 0) return null

  const project = await rt.projects.get(job.projectId)
  await rt.ledger.append({
    orgId: project.orgId,
    projectId: job.projectId,
    sceneId: job.sceneId,
    shotId: job.shotId,
    batchId: job.batchId,
    jobId: job.id,
    providerId: job.providerId,
    modelId: job.modelId,
    entryType: 'charge',
    micros,
    billableSeconds: seconds,
    quoteId: job.quoteId,
    externalRequestId: job.externalJobId,
    sandbox: job.sandbox,
    note,
    createdBy: 'render-service',
  })
  return micros
}

/**
 * Settles a job an operator cancelled.
 *
 * Cancelling stops the poll loop, so this is the last chance to record what the
 * generation cost. A job that had reached the provider is charged at its
 * estimate whether or not the cancel was confirmed: providers bill for work
 * already done, several refuse to cancel past a point of no return, and the two
 * error directions are not symmetric — over-counting refuses the next render
 * slightly too early, under-counting lets the cap approve work that was
 * actually paid for. A job still queued locally never reached anyone and costs
 * nothing.
 */
export async function settleCancelledJob(rt: Runtime, jobId: string, opts: { providerStopped: boolean }): Promise<MicroUsd | null> {
  const job = await rt.renders.getJob(jobId)
  const reachedProvider = Boolean(job.externalJobId)
  if (!reachedProvider) return null
  const note = opts.providerStopped
    ? 'cancelled at the provider; charged at estimate since work already done is usually billed'
    : 'cancel not confirmed by the provider; charged at estimate'
  return chargeJobOnce(rt, job, job.estimatedMicros, null, note)
}

/**
 * Applies the corrections `validate()` worked out, so the request that gets
 * priced is the request that gets submitted.
 *
 * Only fields whose value the provider genuinely dictates are applied;
 * anything else is left alone and remains visible in `adjustments` for the
 * caller to report.
 */
export function applyAdjustments(
  request: CanonicalRenderRequest,
  adjustments: Array<{ field: string; from: string; to: string; reason: string }>,
): void {
  for (const adjustment of adjustments) {
    if (adjustment.field !== 'durationSeconds') continue
    const snapped = Number(adjustment.to)
    if (Number.isFinite(snapped) && snapped > 0) request.durationSeconds = snapped
  }
}
