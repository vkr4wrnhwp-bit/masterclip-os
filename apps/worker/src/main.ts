import { createRuntime, RenderService, QueueWorker, QUEUES } from '@masterclip/runtime'
import { JOB_TYPES } from '@masterclip/queue'
import { applyEnvFile, loadConfig } from '@masterclip/shared'

/**
 * The render worker.
 *
 * Generation never happens inside an HTTP request: the API queues work and this
 * process performs it. Two consequences the architecture depends on — a render
 * survives the browser being closed and the API being restarted, and a worker
 * crash returns leased jobs to the pool instead of losing them.
 */
async function main(): Promise<void> {
  applyEnvFile()
  const config = loadConfig()
  const runtime = await createRuntime({ workerId: `worker-${process.pid}` })
  const render = new RenderService(runtime)
  const logger = runtime.logger.child({ component: 'worker' })

  const queueNames = [QUEUES.render, QUEUES.qc, QUEUES.media, QUEUES.maintenance, QUEUES.audio, QUEUES.live, QUEUES.songLab]
  const workers = queueNames.map((queueName) => {
    const worker = new QueueWorker(runtime.queue, {
      queueName,
      concurrency: config.WORKER_CONCURRENCY,
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      logger: logger.child({ queue: queueName }),
      clock: runtime.clock,
    })

    worker.register<{ jobId: string }>(JOB_TYPES.submitRender, async ({ jobId }) => {
      await render.submitRender(jobId)
    })

    worker.register<{ jobId: string }>(JOB_TYPES.pollRender, async ({ jobId }, ctx) => {
      await ctx.heartbeat()
      const result = await render.pollRender(jobId)
      // Deferring rather than sleeping keeps the worker slot free for other
      // renders while this one cooks on the provider's side.
      if (!result.done) ctx.defer(result.deferMs)
    })

    worker.register<{ jobId: string }>(JOB_TYPES.ingestOutput, async ({ jobId }, ctx) => {
      await ctx.heartbeat()
      const outputs = await render.ingestOutputs(jobId)
      ctx.logger.info('worker.ingested', { job_id: jobId, outputs: outputs.length })
    })

    worker.register<{ outputId: string }>(JOB_TYPES.runTechnicalQc, async ({ outputId }, ctx) => {
      await ctx.heartbeat()
      const result = await render.runQc(outputId)
      ctx.logger.info('worker.qc', { output_id: outputId, action: result.action, technical_pass: result.technicalPass })
    })

    worker.register<{ outputId: string }>(JOB_TYPES.buildProxies, async ({ outputId }, ctx) => {
      await ctx.heartbeat()
      await render.buildDerivatives(outputId)
    })

    worker.register(JOB_TYPES.providerHealth, async () => {
      const health = await runtime.registry.health()
      for (const entry of health) {
        await runtime.db.run(
          `INSERT INTO provider_health (provider_id, status, latency_ms, message, consecutive_failures, checked_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider_id) DO UPDATE SET
             status = excluded.status, latency_ms = excluded.latency_ms, message = excluded.message,
             checked_at = excluded.checked_at,
             consecutive_failures = CASE WHEN excluded.status = 'healthy' THEN 0 ELSE provider_health.consecutive_failures + 1 END`,
          [entry.providerId, entry.status, entry.latencyMs, entry.message, 0, entry.checkedAt],
        )
      }
    })

    worker.register<{ projectId: string }>(JOB_TYPES.recomputeStats, async ({ projectId }) => {
      await runtime.metrics.recomputeModelPerformance(projectId)
    })

    // Live Lab AI scene generation. Asynchronous by design: the artist keeps
    // rehearsing while this renders, and results never replace live audio —
    // they land as options awaiting explicit acceptance.
    worker.register<{ jobId: string }>(JOB_TYPES.liveAiGenerate, async ({ jobId }, ctx) => {
      await ctx.heartbeat()
      await runtime.liveLabService.runAiJob(jobId)
    })

    worker.register(JOB_TYPES.refreshCatalog, async () => {
      await runtime.registry.models({ refresh: true })
    })

    // ----- Street Banker Audio Intelligence ---------------------------------
    const audio = runtime.audio

    worker.register<{ jobId: string }>(JOB_TYPES.audioTranscribe, async ({ jobId }, ctx) => {
      await ctx.heartbeat()
      const transcript = await audio.transcription.run(jobId)

      // A transcript raised for Song Lab is a lyric. The transcription
      // pipeline stays ignorant of that — it produces words and timings — and
      // the chaining lives here, in the layer that knows about both.
      const job = await audio.repos.jobs.getAnyOrg(jobId)
      const config = job.configuration as { purpose?: string; songLabProjectId?: string; songVersionId?: string }
      if (config.purpose === 'song_lab' && config.songLabProjectId && config.songVersionId) {
        await runtime.queue.enqueue({
          queue: QUEUES.songLab,
          type: JOB_TYPES.songLabTranscribeLyrics,
          payload: {
            transcriptId: transcript.id,
            orgId: job.orgId,
            userId: job.userId,
            projectId: config.songLabProjectId,
            versionId: config.songVersionId,
          },
          dedupeKey: `song_lab.lyrics.transcribe:${transcript.id}`,
        })
      }
    })

    worker.register<{ meetingId: string }>(JOB_TYPES.audioExtractMeeting, async ({ meetingId }, ctx) => {
      await ctx.heartbeat()
      await audio.meetings.runExtraction(meetingId)
    })

    worker.register<{ briefId: string }>(JOB_TYPES.audioRenderBrief, async ({ briefId }, ctx) => {
      await ctx.heartbeat()
      await audio.briefs.runRender(briefId)
    })

    worker.register<{ projectId: string }>(JOB_TYPES.audioDubbingSubmit, async ({ projectId }, ctx) => {
      await ctx.heartbeat()
      await audio.globalRelease.runSubmit(projectId)
    })

    worker.register<{ projectId: string }>(JOB_TYPES.audioDubbingPoll, async ({ projectId }, ctx) => {
      await ctx.heartbeat()
      const result = await audio.globalRelease.runPoll(projectId)
      if (!result.done) ctx.defer(config.PROVIDER_POLL_INTERVAL_MS)
    })

    worker.register<{ jobId: string }>(JOB_TYPES.audioCampaignGenerate, async ({ jobId }, ctx) => {
      await ctx.heartbeat()
      await audio.campaigns.runGenerate(jobId)
    })

    worker.register<{ jobId: string }>(JOB_TYPES.audioRemixGenerate, async ({ jobId }, ctx) => {
      await ctx.heartbeat()
      await audio.remix.runOperation(jobId)
    })

    worker.register<{ conversationId: string }>(JOB_TYPES.audioAgentPostCall, async ({ conversationId }, ctx) => {
      await ctx.heartbeat()
      await audio.operatorAgent.runPostCall(conversationId)
    })

    worker.register<{ orgId: string; agentId: string }>(JOB_TYPES.audioAgentSync, async ({ orgId, agentId }, ctx) => {
      await ctx.heartbeat()
      await audio.operatorAgent.syncToProvider(orgId, agentId)
    })

    worker.register<{ eventId: string }>(JOB_TYPES.audioWebhookProcess, async ({ eventId }, ctx) => {
      await ctx.heartbeat()
      await audio.webhooks.process(eventId)
    })

    // ----- Street Banker Song Lab -------------------------------------------
    //
    // Analysis and rendering both read audio and can take minutes on a long
    // master, so neither happens inside an HTTP request. Each job carries the
    // organization it acts for and the service proves it against the record —
    // a job payload is not a capability.
    const songLab = runtime.songLab

    worker.register<{ analysisId: string; orgId: string }>(JOB_TYPES.songLabAnalyzeAudio, async ({ analysisId, orgId }, ctx) => {
      await ctx.heartbeat()
      const result = await songLab.analysis.run(analysisId, orgId)
      ctx.logger.info('song_lab.analyzed', {
        analysis_id: analysisId,
        sections: result.sections.length,
        duration_ms: result.analysis.durationMs,
      })
    })

    // Reanalysis is the same work against the same guarantees: a new row, the
    // old result preserved, human-confirmed sections carried forward.
    worker.register<{ analysisId: string; orgId: string }>(JOB_TYPES.songLabReanalyze, async ({ analysisId, orgId }, ctx) => {
      await ctx.heartbeat()
      await songLab.analysis.run(analysisId, orgId)
    })

    worker.register<{ transcriptId: string; orgId: string; userId: string; projectId: string; versionId: string }>(
      JOB_TYPES.songLabTranscribeLyrics,
      async (payload, ctx) => {
        await ctx.heartbeat()
        const lines = await songLab.lyricTranscription.ingest(payload)
        ctx.logger.info('song_lab.lyrics_ingested', { project_id: payload.projectId, lines: lines.length })
      },
    )

    /**
     * Vocal separation.
     *
     * Completes rather than throws when the provider returns no identifiable
     * vocal: the row records `unsupported` and the vocal figures stay on the
     * mix-based proxy. Dead-lettering that would be wrong — nothing is broken,
     * the provider simply cannot do it.
     *
     * A successful separation queues a reanalysis of its own, so this handler
     * settles the stem and the follow-on measurement arrives as a separate job.
     */
    worker.register<{ vocalStemId: string; orgId: string }>(JOB_TYPES.songLabSeparateVocal, async ({ vocalStemId, orgId }, ctx) => {
      await ctx.heartbeat()
      const stem = await songLab.vocalStems.run(vocalStemId, orgId)
      ctx.logger.info('song_lab.vocal_stem_settled', {
        vocal_stem_id: vocalStemId,
        status: stem.status,
        stem_name: stem.stemName,
      })
    })

    worker.register<{ analysisId: string; orgId: string; cohortId: string }>(
      JOB_TYPES.songLabCompareBenchmark,
      async ({ analysisId, orgId, cohortId }, ctx) => {
        await ctx.heartbeat()
        const { observations } = await songLab.benchmark.compare(orgId, analysisId, cohortId)
        ctx.logger.info('song_lab.benchmarked', { analysis_id: analysisId, cohort_id: cohortId, observations: observations.length })
      },
    )

    worker.register<{ experimentId: string; orgId: string }>(JOB_TYPES.songLabRenderExperiment, async ({ experimentId, orgId }, ctx) => {
      await ctx.heartbeat()
      const experiment = await songLab.experiments.render(experimentId, orgId)
      ctx.logger.info('song_lab.experiment_rendered', {
        experiment_id: experimentId,
        renderer: experiment.renderer,
        placeholder: experiment.placeholderPreview,
      })
    })

    // Self-perpetuating maintenance ticks: each run re-arms the next time
    // bucket, and the bucketed dedupe key stops restarts from stacking them.
    worker.register(JOB_TYPES.audioRetentionSweep, async (_payload, ctx) => {
      await ctx.heartbeat()
      await audio.retention.sweep()
      await enqueueAudioTick(JOB_TYPES.audioRetentionSweep, RETENTION_TICK_MS)
    })

    worker.register(JOB_TYPES.audioScheduleTick, async (_payload, ctx) => {
      await ctx.heartbeat()
      const generated = await audio.briefs.runScheduleTick()
      if (generated > 0) ctx.logger.info('audio.scheduled_briefs', { generated })
      await enqueueAudioTick(JOB_TYPES.audioScheduleTick, SCHEDULE_TICK_MS)
    })

    return worker
  })

  const RETENTION_TICK_MS = 15 * 60_000
  const SCHEDULE_TICK_MS = 60 * 60_000
  async function enqueueAudioTick(type: string, delayMs: number): Promise<void> {
    const bucket = Math.floor((Date.now() + delayMs) / delayMs)
    await runtime.queue.enqueue({
      queue: QUEUES.audio,
      type,
      payload: {},
      delayMs,
      dedupeKey: `${type}:${bucket}`,
    })
  }
  await enqueueAudioTick(JOB_TYPES.audioRetentionSweep, 5_000)
  await enqueueAudioTick(JOB_TYPES.audioScheduleTick, 10_000)

  for (const worker of workers) worker.start()
  logger.info('worker.started', {
    // Derived from the workers actually started. A second hand-maintained
    // list drifted once already, reporting the live queue as absent while
    // it was in fact running — precisely the wrong hint for an operator
    // debugging a stuck job.
    queues: queueNames,
    concurrency: config.WORKER_CONCURRENCY,
    mode: config.MASTERCLIP_MODE,
    providers: runtime.registry.list().map((p) => `${p.providerId}${p.isConfigured() ? '' : ' (unconfigured)'}`),
  })

  const shutdown = async (signal: string) => {
    logger.info('worker.stopping', { signal })
    await Promise.all(workers.map((w) => w.stop()))
    await runtime.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'worker.fatal', err: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
