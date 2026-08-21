export * from './queue.js'
export * from './worker.js'

/** Queue names. Separate queues keep cheap bookkeeping out from behind slow renders. */
export const QUEUES = {
  render: 'render',
  media: 'media',
  qc: 'qc',
  maintenance: 'maintenance',
} as const

/** Job types handled by apps/worker. */
export const JOB_TYPES = {
  submitRender: 'render.submit',
  pollRender: 'render.poll',
  ingestOutput: 'render.ingest',
  runTechnicalQc: 'qc.technical',
  runVisualQc: 'qc.visual',
  buildProxies: 'media.proxies',
  finishMaster: 'media.finish',
  refreshCatalog: 'maintenance.refresh_catalog',
  providerHealth: 'maintenance.provider_health',
  recomputeStats: 'maintenance.recompute_stats',
} as const

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES]
