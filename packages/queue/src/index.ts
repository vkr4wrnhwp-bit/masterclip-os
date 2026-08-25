export * from './queue.js'
export * from './worker.js'

/** Queue names. Separate queues keep cheap bookkeeping out from behind slow renders. */
export const QUEUES = {
  render: 'render',
  media: 'media',
  qc: 'qc',
  maintenance: 'maintenance',
  audio: 'audio',
  live: 'live',
  songLab: 'song_lab',
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
  // Street Banker Audio Intelligence
  audioTranscribe: 'audio.transcribe',
  audioExtractMeeting: 'audio.meeting.extract',
  audioRenderBrief: 'audio.brief.render',
  audioDubbingSubmit: 'audio.dubbing.submit',
  audioDubbingPoll: 'audio.dubbing.poll',
  audioCampaignGenerate: 'audio.campaign.generate',
  audioRemixGenerate: 'audio.remix.generate',
  audioAgentPostCall: 'audio.agent.post_call',
  audioAgentSync: 'audio.agent.sync',
  audioRetentionSweep: 'audio.retention.sweep',
  audioScheduleTick: 'audio.schedule.tick',
  audioWebhookProcess: 'audio.webhook.process',
  liveAiGenerate: 'live.ai.generate',
  // Street Banker Song Lab
  songLabValidateUpload: 'song_lab.upload.validate',
  songLabAnalyzeAudio: 'song_lab.audio.analyze',
  songLabDetectStructure: 'song_lab.structure.detect',
  songLabAnalyzeVocal: 'song_lab.vocal.analyze',
  songLabSeparateVocal: 'song_lab.vocal.separate',
  songLabTranscribeLyrics: 'song_lab.lyrics.transcribe',
  songLabAnalyzeLyrics: 'song_lab.lyrics.analyze',
  songLabBuildFeatures: 'song_lab.features.build',
  songLabCompareBenchmark: 'song_lab.benchmark.compare',
  songLabGenerateObservations: 'song_lab.observations.generate',
  songLabRenderExperiment: 'song_lab.experiment.render',
  songLabGenerateWaveform: 'song_lab.waveform.generate',
  songLabUpdateOutcome: 'song_lab.outcome.update',
  songLabReanalyze: 'song_lab.reanalyze',
} as const

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES]
