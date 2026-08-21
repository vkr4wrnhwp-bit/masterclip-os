import { AspectRatio, GenerationMode, TargetResolution } from '@masterclip/shot-schema'
import type { CanonicalRenderRequest, PriceQuote } from './types.js'
import type { VideoProvider } from './provider.js'
import { isQuoteValid } from './pricing.js'

/**
 * Provider contract tests, expressed as plain checks rather than a vitest
 * suite so the same battery runs from unit tests, from `masterclip doctor`,
 * and against a live sandbox key without duplicating the expectations.
 *
 * Every adapter must pass these. They are what stops "the types compile" from
 * being mistaken for "the integration works".
 */
export interface ContractCheck {
  name: string
  ok: boolean
  detail: string
  skipped?: boolean
}

export function sampleRequest(overrides: Partial<CanonicalRenderRequest> = {}): CanonicalRenderRequest {
  return {
    requestId: 'job_contract_0001',
    projectId: 'proj_contract',
    shotId: 'shot_contract',
    shotVersionId: 'sver_contract',
    providerId: overrides.providerId ?? 'mock',
    modelId: overrides.modelId ?? 'mock-draft',
    mode: GenerationMode.enum.text_to_video,
    prompt: 'A woman stands under a single neon sign, rain on the pavement, 50mm, shallow depth of field.',
    negativePrompt: 'plastic skin, warped anatomy',
    durationSeconds: 5,
    resolution: TargetResolution.enum['720p'],
    aspectRatio: AspectRatio.enum['16:9'],
    fps: 24,
    seed: null,
    audio: { mode: 'none', dialogue: '', ambient: '' },
    inputs: { references: [] },
    webhookUrl: '',
    sandbox: true,
    maxCostMicros: 2_000_000,
    metadata: {},
    ...overrides,
  }
}

/**
 * Verdict from whoever is allowed to say yes to spending money.
 *
 * Mirrors the cost controller's `Authorization` rather than reimplementing it,
 * so the battery cannot develop a second, laxer opinion about what is
 * affordable.
 */
export interface ContractSubmitApproval {
  allowed: boolean
  reason?: string
}

export interface ContractOptions {
  /** Skips submit/poll/download. Use when no sandbox credential is available. */
  submitAndPoll?: boolean
  destDir?: string
  nowMs?: number
  /** Overrides for the request used against this provider. */
  request?: Partial<CanonicalRenderRequest>
  pollTimeoutMs?: number
  /**
   * Required before this battery may put a real request on the wire.
   *
   * `submit()` here talks to the provider directly — that is the whole point of
   * a contract test — which means it is the one code path in the system that
   * can reach a paid endpoint without passing the cost controller. Rather than
   * duplicate the controller's rules, the battery refuses to submit at all
   * unless the caller hands it something that has already applied them. The CLI
   * wires this to the real controller; unit tests against the mock pass a stub.
   *
   * Without it, `submitAndPoll` records a failure instead of spending.
   */
  approveSubmit?: (input: { request: CanonicalRenderRequest; quote: PriceQuote }) => Promise<ContractSubmitApproval>
}

export async function runProviderContract(provider: VideoProvider, opts: ContractOptions = {}): Promise<ContractCheck[]> {
  const checks: ContractCheck[] = []
  const now = opts.nowMs ?? Date.now()
  const record = (name: string, ok: boolean, detail: string, skipped = false) => {
    checks.push({ name, ok, detail, skipped })
    return ok
  }

  // --- catalog --------------------------------------------------------------
  let models
  try {
    models = await provider.listModels()
    record('listModels returns a non-empty catalog', models.length > 0, `${models.length} models`)
    record(
      'every model declares provider id, capabilities and modes',
      models.every((m) => m.providerId === provider.providerId && m.capabilities.modes.length > 0),
      models
        .filter((m) => m.providerId !== provider.providerId || m.capabilities.modes.length === 0)
        .map((m) => m.modelId)
        .join(', ') || 'all valid',
    )
    record(
      'pricing is either a formula or explicitly absent (never a fabricated zero)',
      models.every((m) => m.pricing === null || m.pricing.basis !== 'unknown' || m.pricing.dynamic),
      'checked',
    )
  } catch (err) {
    record('listModels returns a non-empty catalog', false, String(err))
    return checks
  }

  const model = models.find((m) => m.enabled) ?? models[0]
  if (!model) return checks

  const request = sampleRequest({
    providerId: provider.providerId,
    modelId: model.modelId,
    mode: model.capabilities.modes[0],
    resolution: model.capabilities.resolutions[0],
    aspectRatio: model.capabilities.aspectRatios[0],
    durationSeconds: model.capabilities.duration.allowedSeconds?.[0] ?? model.capabilities.duration.minSeconds,
    ...(opts.request ?? {}),
  })

  // --- capabilities ---------------------------------------------------------
  try {
    const capabilities = await provider.getCapabilities(model.modelId)
    record('getCapabilities resolves for a listed model', capabilities.modes.length > 0, capabilities.modes.join(', '))
  } catch (err) {
    record('getCapabilities resolves for a listed model', false, String(err))
  }

  try {
    await provider.getCapabilities('definitely-not-a-real-model')
    record('getCapabilities rejects an unknown model', false, 'resolved instead of throwing')
  } catch {
    record('getCapabilities rejects an unknown model', true, 'threw as expected')
  }

  // --- validation -----------------------------------------------------------
  try {
    const validation = await provider.validate(request)
    record('validate accepts a well-formed request', validation.ok, validation.errors.join('; ') || 'ok')
  } catch (err) {
    record('validate accepts a well-formed request', false, String(err))
  }

  try {
    const bad = await provider.validate({ ...request, durationSeconds: 999 })
    record('validate rejects an out-of-range duration', !bad.ok, bad.errors.join('; ') || 'accepted 999s')
  } catch {
    record('validate rejects an out-of-range duration', true, 'threw as expected')
  }

  // --- quoting --------------------------------------------------------------
  // Hoisted: the submit gate below has to show the caller what this request
  // costs before anyone approves it, and an unquotable request must never be
  // submittable.
  let priced: PriceQuote | null = null
  try {
    const quote = await provider.quote(request)
    const valid = isQuoteValid(quote, request, now)
    priced = quote
    record('quote returns a request-bound, time-limited price', valid.ok, valid.reason || `${quote.estimatedMicros} µUSD (${quote.source})`)
    record(
      'quote never reports a confident zero price',
      quote.estimatedMicros > 0 || quote.confidence === 'unknown',
      `${quote.estimatedMicros} µUSD confidence=${quote.confidence}`,
    )
  } catch (err) {
    record('quote returns a request-bound, time-limited price', false, String(err))
  }

  // --- health ---------------------------------------------------------------
  try {
    const health = await provider.healthCheck()
    record('healthCheck reports a known status', ['healthy', 'degraded', 'unavailable', 'unconfigured'].includes(health.status), health.status)
  } catch (err) {
    record('healthCheck reports a known status', false, String(err))
  }

  // --- submit / poll / download --------------------------------------------
  if (!opts.submitAndPoll) {
    record('submit → poll → download round trip', true, 'skipped (no sandbox credential)', true)
    return checks
  }

  // The one place in this system that can reach a billable endpoint without
  // going through RenderService. It does not get to skip the question.
  if (!opts.approveSubmit) {
    record(
      'submit → poll → download round trip',
      false,
      'refused: --submit needs an authorization callback, so a contract run cannot spend money outside the cost controller',
    )
    return checks
  }

  if (!priced) {
    record('submit → poll → download round trip', false, 'refused: cannot price this request, so it cannot be approved')
    return checks
  }

  let approval: ContractSubmitApproval
  try {
    approval = await opts.approveSubmit({ request, quote: priced })
  } catch (err) {
    record('submit → poll → download round trip', false, `authorization threw: ${String(err)}`)
    return checks
  }
  if (!approval.allowed) {
    record('submit → poll → download round trip', true, `not authorized: ${approval.reason ?? 'declined'}`, true)
    return checks
  }

  try {
    const submitted = await provider.submit(request)
    record('submit returns an external job id', Boolean(submitted.externalJobId), submitted.externalJobId)

    const deadline = Date.now() + (opts.pollTimeoutMs ?? 120_000)
    let status = await provider.getStatus(submitted.externalJobId)
    while (status.state !== 'succeeded' && status.state !== 'failed' && status.state !== 'cancelled' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      status = await provider.getStatus(submitted.externalJobId)
    }
    record('job reaches a terminal state', status.state === 'succeeded', `${status.state}: ${status.error?.message ?? ''}`)

    if (status.state === 'succeeded') {
      record('successful job carries at least one output', status.outputs.length > 0, `${status.outputs.length} outputs`)
      if (opts.destDir) {
        const assets = await provider.downloadOutputs({ externalJobId: submitted.externalJobId, outputs: status.outputs }, opts.destDir)
        record(
          'downloadOutputs writes verifiable files',
          assets.length > 0 && assets.every((a) => a.bytes > 0 && a.sha256.length === 64),
          assets.map((a) => `${a.localPath} (${a.bytes}B)`).join(', '),
        )
      }
    }
  } catch (err) {
    record('submit → poll → download round trip', false, String(err))
  }

  return checks
}

export function contractSummary(checks: ContractCheck[]): { passed: number; failed: number; skipped: number; failures: ContractCheck[] } {
  const failures = checks.filter((c) => !c.ok && !c.skipped)
  return {
    passed: checks.filter((c) => c.ok && !c.skipped).length,
    failed: failures.length,
    skipped: checks.filter((c) => c.skipped).length,
    failures,
  }
}
