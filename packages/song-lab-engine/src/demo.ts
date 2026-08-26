import { encodeWavPcm16, synthesize } from '@masterclip/ai-audio'
import { FLAGSHIP_SONG_LAB_CAPABILITIES } from '@masterclip/song-lab-domain'
import type { EntitlementService } from '@masterclip/domain'
import type { SongLabLayer } from './layer.js'

/**
 * Demo mode.
 *
 * Everything here is invented: "Example Artist" and "Signal Fire" are not real,
 * and the audio is synthesized locally by the platform's own WAV generator —
 * no copyrighted recording is used, downloaded, or referenced. The figures in
 * the brief (3:47 · 92 BPM · first chorus 0:56 against a cohort median of 0:41)
 * are reproduced exactly so the demo shows the product's actual reasoning on a
 * known case.
 *
 * Idempotent: a second run finds the existing demo project and returns.
 */

export const DEMO_ARTIST = 'Example Artist'
export const DEMO_TITLE = 'Signal Fire'
export const DEMO_GENRE = 'alternative'
export const DEMO_BPM = 92
export const DEMO_DURATION_MS = 227_000 // 3:47

/** Section plan, in seconds. First chorus lands at 0:56, per the brief. */
/**
 * `register` is the fictional vocal register band and `contour` its melodic
 * shape. The verses and choruses are deliberately written a hair apart — a
 * chorus register lift of about 0.02 — so the demo carries a worked example of
 * the register finding, the same way its choruses are written similar enough to
 * carry the arrangement-contrast one.
 */
const DEMO_SECTIONS: Array<{
  type: string
  label: string
  start: number
  end: number
  energy: number
  vocal: number
  register: number | null
  contour: number[]
}> = [
  { type: 'intro', label: 'Intro', start: 0, end: 13, energy: 0.31, vocal: 0.02, register: null, contour: [] },
  { type: 'verse', label: 'Verse 1', start: 13, end: 42, energy: 0.51, vocal: 0.83, register: 0.34, contour: [-0.7, -0.3, 0.2, 0.7, 0.4, -0.1, -0.5, -0.9] },
  { type: 'pre_chorus', label: 'Pre-Chorus 1', start: 42, end: 56, energy: 0.72, vocal: 0.86, register: 0.4, contour: [-0.4, 0.1, 0.6, 1, 0.8, 0.4, 0.1, -0.3] },
  { type: 'chorus', label: 'Chorus 1', start: 56, end: 83, energy: 0.83, vocal: 0.88, register: 0.36, contour: [0.8, 0.4, -0.1, -0.6, 0.7, 0.3, -0.2, -0.8] },
  { type: 'verse', label: 'Verse 2', start: 83, end: 112, energy: 0.64, vocal: 0.85, register: 0.35, contour: [-0.65, -0.25, 0.25, 0.72, 0.42, -0.08, -0.48, -0.88] },
  { type: 'pre_chorus', label: 'Pre-Chorus 2', start: 112, end: 126, energy: 0.73, vocal: 0.86, register: 0.41, contour: [-0.38, 0.12, 0.62, 1, 0.78, 0.38, 0.08, -0.32] },
  { type: 'chorus', label: 'Chorus 2', start: 126, end: 154, energy: 0.84, vocal: 0.88, register: 0.37, contour: [0.82, 0.42, -0.08, -0.58, 0.72, 0.32, -0.18, -0.78] },
  { type: 'bridge', label: 'Bridge', start: 154, end: 177, energy: 0.7, vocal: 0.61, register: 0.53, contour: [0.1, 0.5, 1, 0.8, 0.2, -0.4, -0.8, -1] },
  { type: 'final_chorus', label: 'Final Chorus', start: 177, end: 211, energy: 0.89, vocal: 0.9, register: 0.41, contour: [0.9, 0.5, 0, -0.5, 0.8, 0.4, -0.1, -0.7] },
  { type: 'outro', label: 'Outro', start: 211, end: 227, energy: 0.35, vocal: 0.08, register: null, contour: [] },
]

/** A fictional lyric written for this seed. Short, so the density metrics move. */
const DEMO_LYRICS = `[Verse 1]
Streetlights counting down the block
Every window holding still
I was never good at waiting
But I learned to wait until

[Pre-Chorus]
The wire hums and the night gives way
Something moving in the grey

[Chorus]
Signal fire, signal fire
Burning where the road runs dry
Signal fire, hold the line for me tonight

[Verse 2]
Somebody painted over summer
Left the colour on my hands
I keep the receipts of the distance
And the promises of plans

[Pre-Chorus]
The wire hums and the night gives way
Something moving in the grey

[Chorus]
Signal fire, signal fire
Burning where the road runs dry
Signal fire, hold the line for me tonight

[Bridge]
If you cannot see me
Look for what I left alight

[Final Chorus]
Signal fire, signal fire
Burning where the road runs dry
Signal fire, hold the line for me tonight`

export interface SeedSongLabDemoInput {
  orgId: string
  userId: string
  entitlements: EntitlementService
}

export async function seedSongLabDemo(songLab: SongLabLayer, input: SeedSongLabDemoInput): Promise<{ seeded: boolean; projectId: string | null }> {
  const existing = await songLab.repos.projects.list(input.orgId, 50)
  const already = existing.find((project) => project.demo && project.title === DEMO_TITLE)
  if (already) return { seeded: false, projectId: already.id }

  // The demo org is the flagship, so it holds every Song Lab capability.
  await input.entitlements.grantAll(input.orgId, FLAGSHIP_SONG_LAB_CAPABILITIES)
  await songLab.benchmark.ensureDefaultCohorts(input.userId)

  const actor = { userId: input.userId, orgId: input.orgId, orgRole: 'owner' }

  const project = await songLab.projects.create({
    actor,
    title: DEMO_TITLE,
    artistName: DEMO_ARTIST,
    genre: DEMO_GENRE,
    titlePhrase: 'Signal fire',
    notes: 'Fictional demonstration record. Locally synthesized audio; no real recording is used.',
    rightsConfirmed: true,
    demo: true,
  })

  const { version } = await songLab.projects.attachUpload({
    actor,
    projectId: project.id,
    bytes: renderDemoAudio(),
    filename: 'signal-fire-demo.wav',
    rightsConfirmed: true,
    // The demo supplies its own analysis below. Letting the worker also analyse
    // the synthesized audio would replace the documented demo figures with
    // measurements of a placeholder recording.
    skipAnalysis: true,
  })

  // The demo writes its analysis directly rather than waiting on the worker, so
  // `pnpm seed` produces a browsable project immediately. The values are the
  // ones from the brief, which is what makes the demo legible: an analyst can
  // check the product's reasoning against numbers they already know.
  const analysis = await songLab.repos.analyses.create({
    orgId: input.orgId,
    songLabProjectId: project.id,
    songVersionId: version.id,
    analysisVersion: 'demo',
    engineVersion: 'demo-1.0.0',
    sourceChecksum: 'demo-signal-fire',
    configuration: { demo: true, note: 'Fictional analysis for demonstration. Not measured from a real recording.' },
  })

  const sections = await songLab.repos.sections.replaceAll(
    input.orgId,
    analysis.id,
    DEMO_SECTIONS.map((section, index) => ({
      sectionType: section.type as never,
      label: section.label,
      startMs: section.start * 1000,
      endMs: section.end * 1000,
      confidence: 0.72,
      humanConfirmed: false,
      isHook: section.type === 'chorus' || section.type === 'final_chorus',
      isTitlePhrase: section.type === 'chorus' || section.type === 'final_chorus',
      orderIndex: index,
      features: {
        energy: section.energy,
        vocalOccupancy: section.vocal,
        syllableDensity: null,
        arrangementDensity: round(section.energy * 0.92),
        spectralDensity: round(0.42 + section.energy * 0.28),
        transientDensity: round(0.36 + section.energy * 0.38),
        lowFrequencyDensity: round(0.3 + section.energy * 0.24),
        stereoWidth: round(0.19 + section.energy * 0.18),
        rhythmicDensity: round(0.34 + section.energy * 0.4),
        similarityVector: [section.energy, 0.3, 0.4, 0.25, 0.45, section.vocal, 0.21].map(round),
        register:
          section.register === null
            ? { median: null, low: null, high: null, confidence: 0 }
            : { median: section.register, low: round(section.register - 0.08), high: round(section.register + 0.12), confidence: 0.45 },
        melodicContour: section.contour,
      },
    })),
  )

  const source = { provider: 'demo', modelVersion: 'demo-1.0.0' }
  const measured = (value: number, confidence: number, method: string) => ({
    value,
    confidence,
    analysisMethod: method,
    provider: source.provider,
    modelVersion: source.modelVersion,
    note: 'fictional demonstration value',
  })

  await songLab.repos.analyses.complete(analysis.id, {
    durationMs: DEMO_DURATION_MS,
    bpm: DEMO_BPM,
    bpmConfidence: 0.82,
    tempoStability: 0.94,
    key: 'E minor',
    keyConfidence: 0.68,
    meter: 4,
    meterConfidence: 0.71,
    loudness: -9.4,
    dynamicRange: 7.8,
    peakDbfs: -0.7,
    stereoWidth: 0.26,
    firstVocalMs: 13_400,
    structureConfidence: 0.72,
    featureVector: {
      provenance: {
        engineVersion: 'demo-1.0.0',
        featureVectorVersion: '1.0.0',
        providers: { features: source, structure: source, vocals: source },
        sourceChecksum: 'demo-signal-fire',
        analyzedAt: new Date(0).toISOString(),
        configuration: { demo: true },
      },
      metrics: {
        duration_seconds: measured(227, 1, 'demo'),
        bpm: measured(DEMO_BPM, 0.82, 'demo'),
        tempo_stability: measured(0.94, 0.8, 'demo'),
        loudness_lufs: measured(-9.4, 0.7, 'demo'),
        dynamic_range_db: measured(7.8, 0.7, 'demo'),
        stereo_width: measured(0.26, 0.7, 'demo'),
        intro_seconds: measured(13, 0.72, 'demo'),
        first_vocal_seconds: measured(13.4, 0.6, 'demo'),
        first_chorus_seconds: measured(56, 0.72, 'demo'),
        first_hook_seconds: measured(56, 0.72, 'demo'),
        first_verse_seconds: measured(29, 0.72, 'demo'),
        second_verse_seconds: measured(29, 0.72, 'demo'),
        chorus_seconds: measured(29.7, 0.72, 'demo'),
        bridge_position_ratio: measured(0.678, 0.72, 'demo'),
        outro_seconds: measured(16, 0.72, 'demo'),
        runtime_before_first_repeat: measured(83, 0.72, 'demo'),
        runtime_after_final_hook: measured(16, 0.72, 'demo'),
        section_count: measured(10, 0.72, 'demo'),
        unique_section_count: measured(6, 0.72, 'demo'),
        chorus_count: measured(3, 0.72, 'demo'),
        verse_count: measured(2, 0.72, 'demo'),
        average_section_seconds: measured(22.7, 0.72, 'demo'),
        section_length_variance: measured(0.38, 0.72, 'demo'),
        repetition_frequency: measured(0.4, 0.72, 'demo'),
        structural_symmetry: measured(0.68, 0.72, 'demo'),
        chorus_share: measured(39, 0.72, 'demo'),
        hook_repetition: measured(3, 0.72, 'demo'),
        vocal_occupancy: measured(64, 0.45, 'demo'),
        verse_vocal_occupancy: measured(84, 0.45, 'demo'),
        chorus_vocal_occupancy: measured(88, 0.45, 'demo'),
        vocal_density_contrast: measured(0.04, 0.45, 'demo'),
        average_phrase_seconds: measured(2.6, 0.45, 'demo'),
        longest_phrase_seconds: measured(5.4, 0.45, 'demo'),
        rest_ratio: measured(36, 0.45, 'demo'),
        peak_energy_position: measured(0.779, 0.72, 'demo'),
        energy_range: measured(0.58, 0.72, 'demo'),
        chorus_energy_lift: measured(0.28, 0.72, 'demo'),
        dynamic_contrast: measured(0.17, 0.72, 'demo'),
        arrangement_density: measured(0.59, 0.72, 'demo'),
        spectral_density: measured(0.6, 0.6, 'demo'),
        transient_density: measured(0.61, 0.6, 'demo'),
        low_frequency_density: measured(0.45, 0.6, 'demo'),
        // Chorus 2 measures 94% similar to Chorus 1 — the brief's example.
        chorus_similarity: measured(94, 0.65, 'demo'),
        final_chorus_contrast: measured(0.06, 0.65, 'demo'),
        // Melodic and register. The figures follow from DEMO_SECTIONS above:
        // verses at 0.34/0.35 against choruses at 0.36/0.37/0.41 leave a lift
        // of about 0.03, which is the worked example of low register contrast.
        verse_register: measured(0.345, 0.45, 'demo'),
        chorus_register: measured(0.38, 0.45, 'demo'),
        chorus_register_lift: measured(0.035, 0.45, 'demo'),
        vocal_register_range: measured(0.39, 0.45, 'demo'),
        peak_register_position: measured(0.678, 0.45, 'demo'),
        melodic_contour_repetition: measured(97, 0.45, 'demo'),
        rhythmic_contrast: measured(0.13, 0.72, 'demo'),
      },
    },
    energyCurve: { values: demoEnergyCurve(), stepSeconds: 1 },
    // `basis` is stated here for the same reason it is stated on a real
    // analysis: a vocal figure without one cannot be interpreted. Demo values
    // are synthesized, so they are certainly not a measurement of an isolated
    // stem, and saying so keeps the demo honest about what it is showing.
    vocalAnalysis: {
      basis: 'full_mix',
      occupancy: measured(0.64, 0.45, 'demo'),
      phrases: [],
      activity: [],
      activityStepSeconds: 1,
      register: { median: 0.38, low: 0.29, high: 0.68, confidence: 0.45 },
    },
    providers: { features: source, structure: source, vocals: source },
  })

  await songLab.lyrics.setLyrics({ actor, projectId: project.id, source: 'user_supplied', text: DEMO_LYRICS })
  await songLab.lyrics.analyze(actor, project.id)

  // Select the cohort the brief describes and run the real comparison engine —
  // the demo's observations come out of the same code path a real song uses.
  const cohorts = await songLab.repos.cohorts.listVisible(input.orgId, true)
  const cohort = cohorts.find((entry) => entry.name.startsWith('Alternative')) ?? cohorts[0]
  if (cohort) {
    await songLab.repos.projects.update(input.orgId, project.id, { selectedBenchmarkCohortId: cohort.id })
    await songLab.benchmark.compare(input.orgId, analysis.id, cohort.id)
  }

  // Three experiments the artist can hear immediately: earlier chorus, +4 BPM,
  // shorter intro. Each is an edit list, not a rendered file — the preview is
  // rendered on demand like any other.
  for (const spec of [
    { type: 'earlier_chorus' as const, amount: 14, name: 'Experiment A — Earlier Chorus' },
    { type: 'tempo' as const, amount: DEMO_BPM + 4, name: 'Experiment B — +4 BPM' },
    { type: 'shorter_intro' as const, amount: 8, name: 'Experiment C — Shorter Intro' },
  ]) {
    try {
      await songLab.experiments.createExperiment({
        actor,
        projectId: project.id,
        experimentType: spec.type,
        amount: spec.amount,
        name: spec.name,
      })
    } catch {
      // An experiment the demo structure cannot support is skipped rather than
      // faked — the same behaviour a real project gets.
    }
  }

  return { seeded: true, projectId: project.id }
}

/**
 * Renders the demo audio.
 *
 * Locally synthesized, tempo-locked, sectioned to match the structure above so
 * the waveform and the timeline actually agree. Musically plain by design — it
 * exists to be analysed, not admired.
 */
function renderDemoAudio(): Uint8Array {
  const chunks: Float32Array[] = []
  for (const [index, section] of DEMO_SECTIONS.entries()) {
    const seconds = section.end - section.start
    const bars = Math.max(1, Math.round((seconds * DEMO_BPM) / 60 / 4))
    chunks.push(
      synthesize({
        bpm: DEMO_BPM,
        bars,
        energy: section.energy,
        layers: {
          kick: section.energy > 0.4,
          hat: section.energy > 0.45,
          bass: section.energy > 0.4,
          pad: true,
          riser: section.type === 'pre_chorus',
          click: false,
        },
        rootHz: 164.81, // E3 — the demo is in E minor.
        seed: 1000 + index,
        gain: 0.6,
      }),
    )
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return encodeWavPcm16(merged)
}

function demoEnergyCurve(): number[] {
  const curve: number[] = []
  for (let second = 0; second < DEMO_DURATION_MS / 1000; second++) {
    const section = DEMO_SECTIONS.find((entry) => second >= entry.start && second < entry.end)
    curve.push(round(section?.energy ?? 0.3))
  }
  return curve
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
