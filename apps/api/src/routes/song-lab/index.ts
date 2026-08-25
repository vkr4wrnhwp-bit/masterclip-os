import type { FastifyInstance } from 'fastify'
import type { Runtime } from '@masterclip/runtime'
import { registerSongLabProjectRoutes } from './projects.js'
import { registerSongLabBenchmarkRoutes } from './benchmark.js'
import { registerSongLabExperimentRoutes } from './experiments.js'
import { registerSongLabLyricRoutes } from './lyrics.js'
import { registerSongLabArRoutes } from './ar.js'

export async function registerSongLabRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  // Publish the cohorts this deployment ships with. Idempotent, and
  // deployment-level rather than per-organization — without it a fresh install
  // has a working benchmark engine and an empty cohort picker, which reads as
  // a broken feature rather than an unconfigured one. A failure here must not
  // stop the API from booting: the picker degrades, nothing else does.
  if (runtime.config.SONG_LAB_ENABLED && runtime.config.SONG_LAB_BENCHMARKS_ENABLED) {
    try {
      await runtime.songLab.benchmark.ensureDefaultCohorts('system')
    } catch (err) {
      runtime.logger.warn('song_lab.default_cohorts_failed', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  await registerSongLabProjectRoutes(app, runtime)
  await registerSongLabBenchmarkRoutes(app, runtime)
  await registerSongLabExperimentRoutes(app, runtime)
  await registerSongLabLyricRoutes(app, runtime)
  await registerSongLabArRoutes(app, runtime)
}
