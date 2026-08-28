import type { Logger } from '@masterclip/shared'
import type { ProcessingJobOutcome, ProcessingJobRecord, StudioJobType } from '@masterclip/studio-domain'
import type { Actor, StudioDeps } from './deps.js'

/**
 * The processing ledger.
 *
 * Every asynchronous unit of audio work passes through here, and the reason is
 * that the three questions worth asking about a job — is it running, who ran
 * it, and did the customer get anything for it — used to have no single place
 * to be answered from. Analyses knew their own status, renditions knew theirs,
 * and neither knew what the other was doing or what it cost.
 *
 * Two invariants live in this class:
 *
 *   - **Work claimed under the same idempotency key runs once.** A redelivered
 *     queue message resolves to the job that already exists.
 *   - **A job that produced nothing usable never converts a credit.** The rule
 *     is enforced in `ProcessingJobRepo.settle`, and every path out of `run`
 *     goes through it — including the thrown-exception path, which is exactly
 *     the one a caller would forget.
 */
export class StudioProcessingService {
  constructor(private readonly deps: StudioDeps) {}

  private get logger(): Logger {
    return this.deps.logger.child({ component: 'studio-processing' })
  }

  /** Opens a job, or returns the one already open for this key. */
  async claim(input: {
    actor: Pick<Actor, 'userId' | 'orgId'>
    projectId: string
    versionId?: string | null
    jobType: StudioJobType
    subjectType: string
    subjectId: string
    idempotencyKey: string
    provider?: string
    adapter?: string
    billable?: boolean
    creditUnits?: number
    request?: Record<string, unknown>
  }): Promise<ProcessingJobRecord> {
    return this.deps.repos.processing.claim({
      orgId: input.actor.orgId,
      studioProjectId: input.projectId,
      studioVersionId: input.versionId ?? null,
      jobType: input.jobType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      // Local by default and named as such. Attribution that defaults to a
      // vendor name would let work this deployment performed itself read as a
      // professional service somebody paid for.
      provider: input.provider ?? LOCAL_PROVIDER,
      adapter: input.adapter ?? LOCAL_ADAPTER,
      idempotencyKey: input.idempotencyKey,
      // Nothing is billable yet: no payment integration exists, and marking
      // work billable against a balance nobody holds would be an invented
      // charge. The column is here so a paid adapter can set it truthfully.
      billable: input.billable ?? false,
      creditUnits: input.creditUnits ?? 0,
      request: input.request,
      createdBy: input.actor.userId,
    })
  }

  /**
   * Runs one job and settles its ledger row whatever happens.
   *
   * `jobId` is optional because a message queued before this ledger existed
   * carries no job id, and refusing to process it would strand real work in the
   * queue across the deploy. Those run exactly as they did before, unrecorded.
   */
  async run(
    ref: { jobId?: string | null; orgId: string },
    work: () => Promise<ProcessingJobOutcome>,
  ): Promise<ProcessingJobRecord | null> {
    if (!ref.jobId) {
      await work()
      return null
    }

    let job: ProcessingJobRecord
    try {
      job = await this.deps.repos.processing.start(ref.orgId, ref.jobId)
    } catch (err) {
      // A missing ledger row must not stop the work itself. The job is the
      // record of the work, not the work.
      this.logger.warn('studio.processing_job_missing', { job_id: ref.jobId, reason: err instanceof Error ? err.message : String(err) })
      await work()
      return null
    }

    try {
      const outcome = await work()
      const settled = await this.deps.repos.processing.settle(ref.orgId, job.id, outcome)
      this.logger.info('studio.processing_settled', {
        job_id: settled.id,
        job_type: settled.jobType,
        status: settled.status,
        adapter: settled.adapter,
        attempt: settled.attempt,
        credit_state: settled.creditState,
        duration_ms: settled.durationMs,
      })
      return settled
    } catch (err) {
      // A thrown error is the path where a credit would otherwise leak: the
      // work is abandoned mid-flight and nobody settles the row. Settling here
      // releases the reservation before the exception continues on to the
      // queue, which is what retries it.
      const settled = await this.deps.repos.processing.settle(ref.orgId, job.id, {
        status: 'failed',
        usableResult: false,
        errorCode: 'studio.processing_threw',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      this.logger.warn('studio.processing_failed', {
        job_id: settled.id,
        job_type: settled.jobType,
        attempt: settled.attempt,
        credit_state: settled.creditState,
      })
      throw err
    }
  }

  /**
   * The same bracket, found from the row the job settles.
   *
   * For work performed inline rather than through the queue — the demo seed,
   * a CLI, a test. Without it those paths leave a ledger row queued forever,
   * and a screen that reads "what is running" would show phantom work.
   */
  async runForSubject(
    orgId: string,
    subjectType: string,
    subjectId: string,
    work: () => Promise<ProcessingJobOutcome>,
  ): Promise<ProcessingJobRecord | null> {
    const job = await this.deps.repos.processing.forSubject(orgId, subjectType, subjectId)
    return this.run({ jobId: job?.id ?? null, orgId }, work)
  }

  /** Everything recorded for a project, newest first. */
  async list(actor: Actor, projectId: string, limit = 50): Promise<ProcessingJobRecord[]> {
    return this.deps.repos.processing.list(actor.orgId, projectId, limit)
  }

  /** What is queued or running right now. */
  async active(actor: Actor, projectId: string): Promise<ProcessingJobRecord[]> {
    return this.deps.repos.processing.active(actor.orgId, projectId)
  }
}

/**
 * The performer of record when Street Banker does the work itself.
 *
 * Named rather than left blank so a result can never be mistaken for one a
 * hosted service produced.
 */
export const LOCAL_PROVIDER = 'street-banker'
export const LOCAL_ADAPTER = 'local-dsp'

/**
 * The renderer this deployment intends to use.
 *
 * "Intends" is the operative word: the resilient renderer decides between
 * ffmpeg and the passthrough on first use, so this is what was requested and
 * the settled job records what actually ran.
 */
export const LOCAL_RENDER_ADAPTER = 'local-ffmpeg'

/**
 * Turns an analysis row's settled status into a ledger outcome.
 *
 * `unsupported` is not a failure of the attempt — the deployment could not
 * decode the file — but it is equally not a usable result, so it releases the
 * credit exactly as a failure does.
 */
export function outcomeForAnalysis(analysis: { status: string; failureReason: string | null }): ProcessingJobOutcome {
  if (analysis.status === 'ready') {
    return {
      status: 'succeeded',
      usableResult: true,
      // A successful analysis can still have a hole in it — one analyzer
      // failed. That is recorded rather than hidden, and does not change the
      // billing outcome: the report is usable.
      errorMessage: analysis.failureReason,
      result: { analyzers_failed: analysis.failureReason ? 1 : 0 },
    }
  }
  return {
    status: analysis.status === 'unsupported' ? 'unsupported' : 'failed',
    usableResult: false,
    errorCode: analysis.status === 'unsupported' ? 'studio.analysis_unsupported' : 'studio.analysis_failed',
    errorMessage: analysis.failureReason,
  }
}

/**
 * Turns a settled rendition into a ledger outcome.
 *
 * A placeholder rendition is the case worth reading twice. The job completed,
 * an output exists, and the output is the customer's own unprocessed mix
 * handed back with a note saying no renderer was available. Charging for that
 * would be charging somebody for their own audio, so it is not a usable
 * result.
 */
export function outcomeForRendition(rendition: {
  status: string
  placeholder: boolean
  renderer: string | null
  failureReason: string | null
}): ProcessingJobOutcome {
  if (rendition.status === 'ready' && !rendition.placeholder) {
    return {
      status: 'succeeded',
      usableResult: true,
      adapter: rendition.renderer,
      result: { renderer: rendition.renderer },
    }
  }
  return {
    status: rendition.placeholder || rendition.status === 'unsupported' ? 'unsupported' : 'failed',
    usableResult: false,
    adapter: rendition.renderer,
    errorCode: rendition.placeholder ? 'studio.render_unsupported' : 'studio.render_failed',
    errorMessage: rendition.failureReason,
  }
}
