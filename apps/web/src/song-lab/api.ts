/** Typed client for the Street Banker Song Lab API. */

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const match = document.cookie.match(/(?:^|;\s*)masterclip_csrf=([^;]*)/)
  const token = method === 'GET' || method === 'HEAD' ? '' : match?.[1] ? decodeURIComponent(match[1]) : ''
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...(token ? { 'x-csrf-token': token } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const envelope = (body as { error?: { message?: string } })?.error
    throw new Error(envelope?.message ?? `${response.status} ${response.statusText}`)
  }
  return body as T
}

const get = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) })
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })
const upload = <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form })

export interface SongLabProject {
  id: string
  artistName: string
  title: string
  genre: string
  status: string
  sourceAssetId: string | null
  currentVersionId: string | null
  selectedBenchmarkCohortId: string | null
  titlePhrase: string
  notes: string
  demo: boolean
  reviewCompletedAt: string | null
  createdAt: string
}

export interface SongVersion {
  id: string
  parentVersionId: string | null
  versionType: string
  versionLabel: string
  sourceAssetId: string | null
  experimentId: string | null
  notes: string
  createdAt: string
  url?: string | null
}

export interface Measured<T = number> {
  value: T | null
  confidence: number
  analysisMethod: string
  provider: string
  modelVersion: string
  note?: string
}

export interface SongAnalysis {
  id: string
  status: string
  durationMs: number | null
  bpm: number | null
  bpmConfidence: number | null
  tempoStability: number | null
  key: string | null
  keyConfidence: number | null
  meter: number | null
  loudness: number | null
  dynamicRange: number | null
  peakDbfs: number | null
  stereoWidth: number | null
  structureConfidence: number | null
  engineVersion: string
  sourceChecksum: string
  featureVector: { metrics: Record<string, Measured> } | null
  /**
   * `basis` says whether the vocal figures were measured from an isolated
   * vocal or inferred from the full mix. The UI shows it next to them, because
   * the same occupancy percentage means two different things either way.
   */
  vocalAnalysis: { basis?: 'full_mix' | 'isolated_stem'; occupancy?: Measured } & Record<string, unknown>
  energyCurve: { values: number[]; stepSeconds: number }
  providers: Record<string, { provider: string; modelVersion: string }>
  failureReason: string | null
  createdAt: string
}

export interface SongSection {
  id: string
  sectionType: string
  label: string
  startMs: number
  endMs: number
  confidence: number
  humanConfirmed: boolean
  isHook: boolean
  isTitlePhrase: boolean
  orderIndex: number
}

export interface SongRecommendation {
  id: string
  recommendationType: string
  title: string
  description: string
  experimentSupported: boolean
  confidence: number
  humanApproved: boolean
  observationTitle?: string
}

export interface SongObservation {
  id: string
  observationType: string
  category: string
  title: string
  description: string
  severity: 'worth_testing' | 'potential_opportunity' | 'needs_review' | 'informational'
  confidence: number
  sourceMetricKeys: string[]
  status: string
  recommendations?: SongRecommendation[]
}

export interface BenchmarkResult {
  id: string
  metricKey: string
  songValue: number | null
  percentile: number | null
  cohortMedian: number | null
  cohortMean: number | null
  p10: number | null
  p25: number | null
  p75: number | null
  p90: number | null
  sampleSize: number
  confidence: number
  classification: string
  classificationLabel: string
  summary: string
}

export interface BenchmarkCohort {
  id: string
  orgId: string | null
  name: string
  description: string
  cohortType: string
  sampleSize: number
  proprietary: boolean
  definition?: string
  lowSample?: boolean
}

export interface SongExperiment {
  id: string
  name: string
  experimentType: string
  intent: string
  editDecisionList: Array<{ type: string; sourceStartMs?: number; sourceEndMs?: number; destinationMs?: number; value?: number; note?: string }>
  bpmOverride: number | null
  status: string
  previewAssetId: string | null
  predictedDurationMs: number | null
  renderedDurationMs: number | null
  renderer: string | null
  placeholderPreview: boolean
  acceptedVersionId: string | null
  failureReason: string | null
  createdAt: string
  previewUrl?: string | null
}

export interface SectionContrast {
  fromLabel: string
  toLabel: string
  similarity: number
  energyDelta: number
  spectralDelta: number
  vocalDelta: number | null
  stereoWidthDelta: number | null
  lowFrequencyDelta: number
  transientDelta: number
  arrangementDelta: number
  rhythmicDelta: number
  registerDelta: number | null
  contourSimilarity: number | null
}

/** Melodic and register analysis. Every figure is nullable — see RegisterPanel. */
export interface RegisterMetrics {
  vocalRegisterRange: number | null
  verseRegister: number | null
  chorusRegister: number | null
  chorusRegisterLift: number | null
  peakRegisterPosition: number | null
  melodicContourRepetition: number | null
  rhythmicContrast: number | null
  confidence: number
}

export interface SectionRegisterBand {
  orderIndex: number
  label: string
  sectionType: string
  startMs: number
  endMs: number
  median: number | null
  low: number | null
  high: number | null
  confidence: number
  isHook: boolean
  contour: number[]
}

export interface BuildAnalysis {
  targetLabel: string
  approachLabel: string
  startMs: number
  transitionStrength: number
  band: 'strong' | 'moderate' | 'minimal'
  observation: string
  experimentIdeas: string[]
  renderableWithStems: boolean
}

export interface ChantOpportunity {
  sectionLabel: string
  startMs: number
  endMs: number
  score: number
  signals: { vocalSpace: number; downbeatStrength: number; harmonicSimplicity: number; repetition: number; recurring: boolean }
  observation: string
  patterns: Array<{ pattern: string; label: string; rhythm: string; description: string }>
}

export interface LyricLine {
  id: string
  lineIndex: number
  text: string
  syllableCount: number
  titlePhrase: boolean
  hookPhrase: boolean
  startMs: number | null
  lyricSource: string
}

export interface LyricAnalysis {
  totalSyllables: number
  syllablesPerSecond: number | null
  chorusSyllablesPerSecond: number | null
  verseSyllablesPerSecond: number | null
  medianHookLineSyllables: number | null
  titleRepetition: number
  titlePlacement: Array<{ sectionOrderIndex: number; sectionType: string | null; count: number }>
  lyricRepetition: number
  verseChorusVocabularyOverlap: number | null
  sections: Array<{
    sectionOrderIndex: number
    sectionType: string | null
    lineCount: number
    syllableCount: number
    syllablesPerSecond: number | null
    medianLineSyllables: number
    longestLineSyllables: number
    titleAppearances: number
  }>
  rhymeGroups: Array<{ key: string; lineIndexes: number[] }>
  unavailable: string[]
}

export interface HookProfile {
  rows: Array<{ metric: string; finding: string; classification: string; confidence: number; confidenceLabel: string }>
  firstHookSeconds: number | null
  titleRepetition: number | null
  hookRepetition: number | null
  experiments: Array<{ title: string; description: string; experimentSupported: boolean; recommendationId: string | null }>
}

export interface ProducerFeatureRow {
  key: string
  label: string
  /** The raw measurement. Null means "not enough information", never zero. */
  value: number | string | null
  display: string
  confidence: number
  confidenceLabel: string
  method: string
  provider: string
  modelVersion: string
  note: string | null
}

export interface ArReview {
  id: string
  structureRating: string
  hookRating: string
  earlyPayoffRating: string
  arrangementContrastRating: string
  vocalMemorabilityRating: string
  streamingFitRating: string
  livePotentialRating: string
  syncPotentialRating: string
  recommendation: string
  why: string
  evidence: Array<{ dimension: string; metricKeys: string[]; note: string }>
  confidence: number
  status: string
  reviewedBy: string | null
  reviewedAt: string | null
  createdAt: string
}

export interface ProjectDetail {
  project: SongLabProject
  versions: SongVersion[]
  analysis: SongAnalysis | null
  sections: SongSection[]
  observations: SongObservation[]
  audioUrl: string | null
  timeline: Array<{ time: string; label: string; confirmed: boolean }>
  thingsWorthTesting: SongObservation[]
}

export interface OutcomeGroup {
  sampleSize: number
  metrics: Record<string, Measured>
}

export interface RecommendationOutcome {
  recommendationType: string
  suggested: number
  accepted: number
  implemented: number
  released: number
  implementedOutcome: OutcomeGroup
  notImplementedOutcome: OutcomeGroup
}

export interface SongVocalStem {
  id: string
  songVersionId: string
  stemAssetId: string | null
  status: 'pending' | 'ready' | 'failed' | 'unsupported'
  stemName: string | null
  provider: string
  failureReason: string | null
  createdAt: string
}

export const songLabApi = {
  capabilities: () =>
    get<{ capabilities: string[]; flagship: boolean; rightsStatement: string; analysisProvider: string }>('/api/song-lab/capabilities'),

  projects: () => get<{ projects: SongLabProject[] }>('/api/song-lab/projects'),
  project: (id: string) => get<ProjectDetail>(`/api/song-lab/projects/${id}`),
  vocalStems: (id: string) => get<{ vocalStems: SongVocalStem[] }>(`/api/song-lab/projects/${id}/vocal-stems`),
  transcribeLyrics: (id: string, replaceUserSupplied = false) =>
    post<{ jobId: string; source: 'isolated_stem' | 'full_mix' }>(`/api/song-lab/projects/${id}/lyrics/transcribe`, { replaceUserSupplied }),
  separateVocal: (id: string, versionId: string) =>
    post<{ vocalStem: SongVocalStem }>(`/api/song-lab/projects/${id}/versions/${versionId}/vocal-stem`, {}),
  createProject: (body: {
    title: string
    artistName: string
    genre: string
    titlePhrase?: string
    notes?: string
    rightsConfirmed: boolean
  }) => post<{ project: SongLabProject }>('/api/song-lab/projects', body),
  updateProject: (id: string, body: Record<string, unknown>) => patch<{ project: SongLabProject }>(`/api/song-lab/projects/${id}`, body),
  deleteProject: (id: string) => del<{ ok: boolean }>(`/api/song-lab/projects/${id}`),

  uploadAudio: (id: string, file: File, rightsConfirmed: boolean) => {
    const form = new FormData()
    form.append('rightsConfirmed', rightsConfirmed ? 'true' : 'false')
    form.append('file', file)
    return upload<{ project: SongLabProject; version: SongVersion; analysisId: string | null }>(`/api/song-lab/projects/${id}/upload`, form)
  },
  importable: () =>
    get<{ assets: Array<{ id: string; fileName: string; projectType: string; durationMs: number | null; createdAt: string }> }>(
      '/api/song-lab/importable',
    ),
  importAsset: (id: string, assetId: string, label?: string) =>
    post<{ project: SongLabProject; version: SongVersion }>(`/api/song-lab/projects/${id}/import-release`, { assetId, label }),
  reanalyze: (id: string) => post<{ analysisId: string }>(`/api/song-lab/projects/${id}/reanalyze`),

  structure: (id: string) =>
    get<{ analysisId: string; sections: SongSection[]; metrics: Record<string, number | null>; timeline: ProjectDetail['timeline'] }>(
      `/api/song-lab/projects/${id}/structure`,
    ),
  correctStructure: (
    id: string,
    body: {
      corrections?: Array<{
        id: string
        sectionType?: string
        label?: string
        startMs?: number
        endMs?: number
        isHook?: boolean
        isTitlePhrase?: boolean
        deleted?: boolean
      }>
      added?: Array<{ sectionType: string; label: string; startMs: number; endMs: number }>
    },
  ) => patch<{ sections: SongSection[]; metrics: Record<string, number | null>; timeline: ProjectDetail['timeline'] }>(
    `/api/song-lab/projects/${id}/structure`,
    body,
  ),

  energy: (id: string) =>
    get<{
      sections: Array<{ label: string; sectionType: string; startMs: number; endMs: number; energy: number; vocalOccupancy: number | null; arrangementDensity: number }>
      curve: number[]
      stepSeconds: number
    }>(`/api/song-lab/projects/${id}/energy`),
  arrangement: (id: string) =>
    get<{
      consecutive: SectionContrast[]
      repeats: SectionContrast[]
      builds: BuildAnalysis[]
      register: RegisterMetrics
      registerBands: SectionRegisterBand[]
    }>(`/api/song-lab/projects/${id}/arrangement`),
  hook: (id: string) => get<{ profile: HookProfile }>(`/api/song-lab/projects/${id}/hook`),
  tempo: (id: string) =>
    get<{
      bpm: number | null
      bpmConfidence: number | null
      tempoStability: number | null
      meter: number | null
      benchmark: BenchmarkResult | null
      suggestions: Array<{ delta: number; bpm: number }>
    }>(`/api/song-lab/projects/${id}/tempo`),
  producer: (id: string) =>
    get<{
      features: ProducerFeatureRow[]
      sections: SongSection[]
      contrasts: SectionContrast[]
      builds: BuildAnalysis[]
      registerBands: SectionRegisterBand[]
      providers: Record<string, { provider: string; modelVersion: string }>
      engineVersion: string
      sourceChecksum: string
    }>(`/api/song-lab/projects/${id}/producer`),

  cohorts: () =>
    get<{ cohorts: BenchmarkCohort[]; genres: string[]; lowSampleThreshold: number; entitledToProprietary: boolean }>('/api/song-lab/cohorts'),
  cohort: (id: string) =>
    get<{
      cohort: BenchmarkCohort
      definition: string
      provenance: Array<{ kind: string; name: string; basis: string; capturedAt: string; storesMasters: boolean }>
      lowSample: boolean
    }>(`/api/song-lab/cohorts/${id}`),
  createCohort: (body: { name: string; description?: string; filterDefinition: Record<string, unknown> }) =>
    post<{ cohort: BenchmarkCohort }>('/api/song-lab/cohorts', body),
  benchmark: (id: string) =>
    get<{
      cohort: BenchmarkCohort | null
      definition?: string
      provenance?: Array<{ kind: string; name: string; basis: string; capturedAt: string; storesMasters: boolean }>
      results: BenchmarkResult[]
      observations: SongObservation[]
      lowSample: boolean
      sampleSize?: number
      message?: string
    }>(`/api/song-lab/projects/${id}/benchmark`),
  selectCohort: (id: string, cohortId: string) => post<unknown>(`/api/song-lab/projects/${id}/benchmark`, { cohortId }),

  observations: (id: string) =>
    get<{ observations: SongObservation[]; thingsWorthTesting: SongObservation[] }>(`/api/song-lab/projects/${id}/observations`),
  setObservationStatus: (id: string, status: string) => post<unknown>(`/api/song-lab/observations/${id}/status`, { status }),
  approveRecommendation: (id: string) => post<{ recommendation: SongRecommendation }>(`/api/song-lab/recommendations/${id}/approve`),

  experiments: (id: string) =>
    get<{ experiments: SongExperiment[]; original: SongVersion | null; currentVersionId: string | null }>(
      `/api/song-lab/projects/${id}/experiments`,
    ),
  createExperiment: (
    id: string,
    body: {
      experimentType: string
      name?: string
      amount?: number
      sectionOrderIndex?: number
      repeatFinalHook?: boolean
      recommendationId?: string
      render?: boolean
    },
  ) => post<{ experiment: SongExperiment | null; message?: string }>(`/api/song-lab/projects/${id}/experiments`, body),
  experiment: (id: string) =>
    get<{ experiment: SongExperiment; previewUrl: string | null; sectionMapping: Array<{ label: string; sourceMs: number; outputMs: number | null }> }>(
      `/api/song-lab/experiments/${id}`,
    ),
  renderExperiment: (id: string) => post<{ ok: boolean }>(`/api/song-lab/experiments/${id}/render`),
  acceptExperiment: (id: string, versionLabel?: string) => post<{ version: SongVersion }>(`/api/song-lab/experiments/${id}/accept`, { versionLabel }),
  rejectExperiment: (id: string) => post<{ ok: boolean }>(`/api/song-lab/experiments/${id}/reject`),

  lyrics: (id: string) => get<{ lines: LyricLine[]; analysis: LyricAnalysis | null; message?: string }>(`/api/song-lab/projects/${id}/lyrics`),
  setLyrics: (id: string, text: string, source = 'user_supplied') =>
    patch<{ lines: LyricLine[]; analysis: LyricAnalysis }>(`/api/song-lab/projects/${id}/lyrics`, { text, source }),
  markTitleLines: (id: string, lineIndexes: number[]) =>
    post<{ lines: LyricLine[]; analysis: LyricAnalysis }>(`/api/song-lab/projects/${id}/lyrics/title`, { lineIndexes }),
  markHookLines: (id: string, lineIndexes: number[]) =>
    post<{ lines: LyricLine[]; analysis: LyricAnalysis }>(`/api/song-lab/projects/${id}/lyrics/hook`, { lineIndexes }),
  chant: (id: string) => get<{ opportunities: ChantOpportunity[] }>(`/api/song-lab/projects/${id}/chant`),

  versions: (id: string) => get<{ versions: SongVersion[] }>(`/api/song-lab/projects/${id}/versions`),
  compareVersions: (id: string, a: string, b: string) =>
    get<{
      a: { version: SongVersion; analysis: SongAnalysis | null; sections: SongSection[]; url: string | null; lineage: SongVersion[] }
      b: { version: SongVersion; analysis: SongAnalysis | null; sections: SongSection[]; url: string | null; lineage: SongVersion[] }
    }>(`/api/song-lab/projects/${id}/versions/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),

  ar: (id: string) => get<{ review: ArReview | null; history: ArReview[]; ratings: string[]; recommendations: string[] }>(`/api/song-lab/projects/${id}/ar`),
  recommendationOutcomes: () =>
    get<{ summary: RecommendationOutcome[]; note: string }>('/api/song-lab/analytics/recommendations'),
  draftAr: (id: string) => post<{ review: ArReview }>(`/api/song-lab/projects/${id}/ar/draft`),
  updateAr: (id: string, body: Record<string, unknown>) => patch<{ review: ArReview }>(`/api/song-lab/ar-reviews/${id}`, body),
  approveAr: (id: string) => post<{ review: ArReview }>(`/api/song-lab/ar-reviews/${id}/approve`),

  handoffs: (id: string) =>
    get<{ handoffs: Array<{ id: string; target: string; status: string; targetRecordId: string | null; createdAt: string }> }>(
      `/api/song-lab/projects/${id}/handoffs`,
    ),
  sendToRemixLab: (id: string) => post<unknown>(`/api/song-lab/projects/${id}/send-to-remix-lab`),
  sendToLiveLab: (id: string) => post<unknown>(`/api/song-lab/projects/${id}/send-to-live-lab`),
  sendToReleaseCommand: (id: string) => post<unknown>(`/api/song-lab/projects/${id}/send-to-release-command`),
  attachOperatorDesk: (id: string, leadId: string, note?: string) =>
    post<unknown>(`/api/song-lab/projects/${id}/attach-operator-desk`, { leadId, note }),
  markReviewComplete: (id: string) => post<{ project: SongLabProject }>(`/api/song-lab/projects/${id}/review-complete`),
}

/** `0:56` — the timeline format used throughout Song Lab. */
export function clock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function seconds(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : clock(value * 1000)
}
