import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { GENRE_COHORTS, LOW_SAMPLE_THRESHOLD, describeCohort } from '@masterclip/music-benchmarking'
import { requireSongLab } from './helpers.js'
import { currentAnalysis } from './projects.js'

/** Cohort selection, custom cohorts, comparisons, observations. */
export async function registerSongLabBenchmarkRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const songLab = runtime.songLab

  app.get('/api/song-lab/cohorts', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.benchmark')
    // Whether proprietary cohorts are even listed is decided here, server-side.
    const entitled = await songLab.access.entitledToProprietaryCohorts(actor.orgId)
    return {
      cohorts: await songLab.benchmark.listCohorts(actor, entitled),
      genres: GENRE_COHORTS,
      lowSampleThreshold: LOW_SAMPLE_THRESHOLD,
      entitledToProprietary: entitled,
    }
  })

  app.get('/api/song-lab/cohorts/:id', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.benchmark')
    const { id } = request.params as { id: string }
    const entitled = await songLab.access.entitledToProprietaryCohorts(actor.orgId)
    const cohort = await songLab.repos.cohorts.getForOrg(actor.orgId, id, entitled)
    return {
      cohort,
      definition: describeCohort(cohort),
      // Provenance ships with the cohort, always. A benchmark whose basis
      // cannot be inspected is a benchmark nobody should act on.
      provenance: await songLab.repos.cohorts.provenance(id),
      lowSample: cohort.sampleSize < LOW_SAMPLE_THRESHOLD,
    }
  })

  app.post('/api/song-lab/cohorts', async (request) => {
    const current = await runtime.songLab.repos.cohorts.countCustomForOrg(
      (await requireSongLab(runtime, request, 'song_lab.custom_cohorts')).orgId,
    )
    const actor = await requireSongLab(runtime, request, 'song_lab.custom_cohorts', {
      usage: { limit: 'song_lab.max_custom_cohorts', current, what: 'custom cohort' },
    })
    const body = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(1000).default(''),
        filterDefinition: z.object({
          genre: z.array(z.string()).optional(),
          subgenre: z.array(z.string()).optional(),
          releaseYearFrom: z.number().int().min(1900).max(2100).optional(),
          releaseYearTo: z.number().int().min(1900).max(2100).optional(),
          territory: z.array(z.string()).optional(),
          labelType: z.array(z.enum(['independent', 'major', 'self_released'])).optional(),
          performanceCohort: z.array(z.string()).optional(),
          streamsFrom: z.number().int().min(0).optional(),
          streamsTo: z.number().int().min(0).optional(),
          chartedOnly: z.boolean().optional(),
          radioOnly: z.boolean().optional(),
          artistCareerStage: z.array(z.enum(['developing', 'established', 'legacy'])).optional(),
          durationSecondsFrom: z.number().int().min(0).optional(),
          durationSecondsTo: z.number().int().min(0).optional(),
          bpmFrom: z.number().int().min(0).optional(),
          bpmTo: z.number().int().min(0).optional(),
          vocalConfiguration: z.array(z.enum(['lead_male', 'lead_female', 'mixed', 'instrumental', 'unspecified'])).optional(),
          orientation: z.array(z.enum(['live', 'streaming', 'radio', 'sync'])).optional(),
          artistId: z.string().max(64).optional(),
        }),
      })
      .parse(request.body)

    return { cohort: await songLab.benchmark.createCustomCohort({ actor, ...body }) }
  })

  app.get('/api/song-lab/projects/:id/benchmark', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.benchmark')
    const { id } = request.params as { id: string }
    const project = await songLab.repos.projects.get(actor.orgId, id)
    if (!project.selectedBenchmarkCohortId) {
      return { cohort: null, results: [], observations: [], lowSample: false, message: 'Select a comparison cohort to benchmark this song.' }
    }
    const analysis = await currentAnalysis(runtime, actor.orgId, id)
    const entitled = await songLab.access.entitledToProprietaryCohorts(actor.orgId)
    const cohort = await songLab.repos.cohorts.getForOrg(actor.orgId, project.selectedBenchmarkCohortId, entitled)

    return {
      cohort,
      definition: describeCohort(cohort),
      provenance: await songLab.repos.cohorts.provenance(cohort.id),
      results: await songLab.repos.benchmarkResults.list(actor.orgId, analysis.id, cohort.id),
      observations: await songLab.repos.observations.listForProject(actor.orgId, id),
      // Surfaced, not buried: the UI is required to show LOW SAMPLE SIZE.
      lowSample: cohort.sampleSize < LOW_SAMPLE_THRESHOLD,
      sampleSize: cohort.sampleSize,
    }
  })

  app.post('/api/song-lab/projects/:id/benchmark', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.benchmark')
    const { id } = request.params as { id: string }
    const body = z.object({ cohortId: z.string().min(1) }).parse(request.body)
    const entitled = await songLab.access.entitledToProprietaryCohorts(actor.orgId)
    await songLab.benchmark.selectCohort(actor, id, body.cohortId, entitled)

    // Run inline as well as queueing, so the user sees results on this request
    // rather than polling for a job they did not ask about.
    const analysis = await currentAnalysis(runtime, actor.orgId, id)
    const { comparison, observations } = await songLab.benchmark.compare(actor.orgId, analysis.id, body.cohortId)
    return { comparison, observations }
  })

  app.get('/api/song-lab/projects/:id/observations', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    return {
      observations: await songLab.repos.observations.listForProject(actor.orgId, id),
      thingsWorthTesting: await songLab.benchmark.thingsWorthTesting(actor, id),
    }
  })

  app.get('/api/song-lab/projects/:id/recommendations', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    const observations = await songLab.repos.observations.listForProject(actor.orgId, id)
    return {
      recommendations: observations.flatMap((observation) =>
        (observation.recommendations ?? []).map((recommendation) => ({ ...recommendation, observationTitle: observation.title })),
      ),
    }
  })

  app.post('/api/song-lab/observations/:id/status', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    const body = z.object({ status: z.enum(['open', 'acknowledged', 'testing', 'accepted', 'dismissed']) }).parse(request.body)
    await songLab.repos.observations.setStatus(actor.orgId, id, body.status)
    return { observation: await songLab.repos.observations.get(actor.orgId, id) }
  })

  /** Human approval of a recommendation. There is no automatic path. */
  app.post('/api/song-lab/recommendations/:id/approve', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.access')
    const { id } = request.params as { id: string }
    return { recommendation: await songLab.repos.observations.approveRecommendation(actor.orgId, id, actor.userId) }
  })
}
