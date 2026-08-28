import { synthesize } from '@masterclip/ai-audio'
import type { EntitlementService } from '@masterclip/domain'
import { FLAGSHIP_STUDIO_CAPABILITIES, type StudioProjectRecord } from '@masterclip/studio-domain'
import type { StudioLayer } from './layer.js'
import type { Actor } from './deps.js'
import { outcomeForAnalysis, outcomeForRendition } from './processing.js'

/**
 * Demo mode.
 *
 * Everything here is invented: "Example Artist" and "Signal Fire" are not real,
 * and the audio is synthesized locally by the platform's own generator — no
 * copyrighted recording is used, downloaded or referenced. The reference track
 * the demo compares against is likewise synthesized and labelled as an internal
 * demonstration reference, so the Reference DNA surface can be exercised
 * without anybody's catalogue.
 *
 * The analysis is *real*: the demo audio goes through the same analyzer set as
 * a user's upload, so the numbers on screen are measurements of the file rather
 * than curated fixtures. A demo whose figures were written by hand would show
 * the product's aspirations rather than its behaviour.
 *
 * Idempotent: a second run finds the existing demo project and returns.
 */

export const STUDIO_DEMO_ARTIST = 'Example Artist'
export const STUDIO_DEMO_TITLE = 'Signal Fire'
export const STUDIO_DEMO_GENRE = 'alternative'
const DEMO_BPM = 92

export interface StudioDemoResult {
  project: StudioProjectRecord
  created: boolean
  versionIds: string[]
  rackId: string | null
  renditionIds: string[]
}

export async function seedStudioDemo(
  studio: StudioLayer,
  input: { orgId: string; userId: string; email?: string; entitlements: EntitlementService },
): Promise<StudioDemoResult> {
  await input.entitlements.grantAll(input.orgId, FLAGSHIP_STUDIO_CAPABILITIES)

  const actor: Actor = {
    userId: input.userId,
    orgId: input.orgId,
    orgRole: 'owner',
    email: input.email ?? 'demo@masterclip.local',
    displayName: 'Demo Producer',
  }

  const existing = (await studio.repos.projects.list(input.orgId, { limit: 200 })).find(
    (project) => project.demo && project.title === STUDIO_DEMO_TITLE,
  )
  if (existing) {
    return {
      project: existing,
      created: false,
      versionIds: (await studio.repos.versions.list(input.orgId, existing.id)).map((version) => version.id),
      rackId: (await studio.repos.racks.listChains(input.orgId, existing.id))[0]?.id ?? null,
      renditionIds: (await studio.repos.renditions.list(input.orgId, existing.id)).map((rendition) => rendition.id),
    }
  }

  const project = await studio.projects.create({
    actor,
    title: STUDIO_DEMO_TITLE,
    artistName: STUDIO_DEMO_ARTIST,
    genre: STUDIO_DEMO_GENRE,
    notes: 'Fictional demonstration project. All audio is synthesized locally by Street Banker.',
    releaseDate: new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10),
    rightsConfirmed: true,
    demo: true,
  })

  // --- two mixes, so the difference engine has something real to compare ----
  const mixOne = await studio.projects.attachUpload({
    actor,
    projectId: project.id,
    bytes: demoMix({ seed: 41, brightness: 0.5, width: 0.25, level: 0.55 }),
    filename: 'signal-fire-mix-01.wav',
    versionType: 'mix',
    notes: 'First full mix.',
    rightsConfirmed: true,
    skipAnalysis: true,
  })
  const mixTwo = await studio.projects.attachUpload({
    actor,
    projectId: project.id,
    bytes: demoMix({ seed: 41, brightness: 0.72, width: 0.42, level: 0.62 }),
    filename: 'signal-fire-mix-02.wav',
    versionType: 'mix',
    notes: 'Brighter, wider, a little louder — the revision the difference engine describes.',
    rightsConfirmed: true,
    skipAnalysis: true,
  })

  // Analysis runs inline rather than through the queue so a freshly seeded
  // deployment shows a complete Studio without a worker having run yet. Each
  // one still settles its ledger row: a demo whose processing panel says work
  // is queued forever teaches that the product is broken.
  for (const version of [mixOne.version, mixTwo.version]) {
    if (!version.assetId || !version.assetChecksum) continue
    const analysisId = await studio.projects.queueAnalysis(actor, project.id, version.id, version.assetId, version.assetChecksum)
    await studio.processing.runForSubject(input.orgId, 'mix_analysis', analysisId, async () =>
      outcomeForAnalysis(await studio.mix.runAnalysis(analysisId, input.orgId)),
    )
  }

  // --- a reference, measured and then discarded ----------------------------
  const reference = await studio.mix.addReference({
    actor,
    projectId: project.id,
    bytes: demoMix({ seed: 77, brightness: 0.85, width: 0.55, level: 0.78 }),
    filename: 'demonstration-reference.wav',
    label: 'Demonstration reference',
    artistName: 'Street Banker',
    title: 'Synthesized demonstration reference',
    // Owned: this file is Street Banker's own synthesized audio, so the demo
    // does not model an authorization it does not have.
    rightsBasis: 'owned',
    rightsConfirmed: true,
  })
  await studio.processing.runForSubject(input.orgId, 'mix_analysis', reference.analysisId, async () => {
    await studio.mix.runReferenceAnalysis(reference.analysisId, reference.reference.id, input.orgId)
    return outcomeForAnalysis(await studio.repos.analyses.get(input.orgId, reference.analysisId))
  })

  // --- notes on the timeline ----------------------------------------------
  const currentVersionId = mixTwo.version.id
  // Timestamps sit inside the demo audio's actual length. A note at 1:31 on a
  // 45-second file is the kind of detail that makes a demo feel assembled
  // rather than real, and it is the first thing anyone notices.
  for (const note of [
    { timestampMs: 11_000, category: 'vocal' as const, body: 'Lead needs to come forward through this line.' },
    { timestampMs: 24_000, category: 'arrangement' as const, body: 'Second verse could lose a layer — it is competing with the vocal.' },
    { timestampMs: 37_000, category: 'mix' as const, body: 'Low end feels heavier here than in the first chorus.' },
  ]) {
    await studio.repos.notes.create({
      orgId: input.orgId,
      studioProjectId: project.id,
      studioVersionId: currentVersionId,
      kind: 'note',
      timestampMs: note.timestampMs,
      category: note.category,
      body: note.body,
      origin: 'human',
      authorUserId: input.userId,
      authorLabel: 'Demo Producer',
    })
  }
  await studio.repos.notes.create({
    orgId: input.orgId,
    studioProjectId: project.id,
    studioVersionId: currentVersionId,
    kind: 'marker',
    timestampMs: 18_000,
    category: 'arrangement',
    body: 'Chorus 1',
    origin: 'human',
    authorUserId: input.userId,
    authorLabel: 'Demo Producer',
  })

  // --- a vocal rack --------------------------------------------------------
  const rack = await studio.racks.create({ actor, projectId: project.id, versionId: currentVersionId, rackType: 'vocal' })

  // --- collaborators -------------------------------------------------------
  for (const collaborator of [
    { email: 'engineer@example.invalid', displayName: 'Demo Mix Engineer', role: 'mix_engineer' as const },
    { email: 'manager@example.invalid', displayName: 'Demo Manager', role: 'manager' as const },
  ]) {
    await studio.collaboration.invite({ actor, projectId: project.id, ...collaborator })
  }

  // --- two master directions, so the A/B has something in it ---------------
  const renditionIds: string[] = []
  for (const direction of ['transparent', 'competitive'] as const) {
    const { rendition } = await studio.master.requestRendition({ actor, projectId: project.id, versionId: currentVersionId, direction })
    renditionIds.push(rendition.id)
    await studio.processing.runForSubject(input.orgId, 'master_rendition', rendition.id, async () =>
      outcomeForRendition(await studio.master.renderRendition(rendition.id, input.orgId, input.userId)),
    )
    const refreshed = await studio.repos.renditions.get(input.orgId, rendition.id)
    if (refreshed.outputAnalysisId) {
      const outputAnalysisId = refreshed.outputAnalysisId
      await studio.processing.runForSubject(input.orgId, 'mix_analysis', outputAnalysisId, async () => {
        const analysis = await studio.mix.runAnalysis(outputAnalysisId, input.orgId)
        await studio.master.settleRenditionAnalysis(outputAnalysisId, rendition.id, input.orgId)
        return outcomeForAnalysis(analysis)
      })
    }
  }

  // --- release metadata, deliberately incomplete ---------------------------
  // The explicit status and the ISRC are left unset on purpose: the demo's
  // Delivery tab should show real failing checks, because a delivery screen
  // where everything is already green teaches nothing.
  await studio.repos.releaseMetadata.upsert(
    input.orgId,
    project.id,
    {
      primaryArtist: STUDIO_DEMO_ARTIST,
      labelName: 'Street Banker (demo)',
      genre: STUDIO_DEMO_GENRE,
      language: 'en',
      copyrightLine: `℗ ${new Date().getFullYear()} Street Banker (demo)`,
      credits: [
        { name: STUDIO_DEMO_ARTIST, role: 'Performer' },
        { name: 'Demo Producer', role: 'Producer' },
      ],
      splits: [
        { name: STUDIO_DEMO_ARTIST, role: 'Writer', percentage: 60 },
        { name: 'Demo Producer', role: 'Producer', percentage: 40 },
      ],
    },
    input.userId,
  )

  // --- the human creation ledger ------------------------------------------
  for (const contribution of [
    { contributionType: 'lyrics' as const, performedBy: STUDIO_DEMO_ARTIST, human: true, detail: 'Written for this demonstration.' },
    { contributionType: 'vocals' as const, performedBy: STUDIO_DEMO_ARTIST, human: true, detail: 'Fictional performance.' },
    {
      contributionType: 'master' as const,
      performedBy: 'Street Banker Master Station',
      human: false,
      aiTool: 'Street Banker Master Station',
      aiRole: 'Applied a declared mastering chain; no generative model was involved.',
      detail: 'Automated mastering chain.',
    },
  ]) {
    await studio.repos.contributions.create({
      orgId: input.orgId,
      studioProjectId: project.id,
      ...contribution,
      declaredBy: input.userId,
    })
  }

  // --- rights posture ------------------------------------------------------
  // Analysis-only is granted; training use is explicitly withheld. Both are
  // positive statements, which is the point of the module.
  await studio.rights.setAiPermission({
    actor,
    projectId: project.id,
    assetScope: 'all',
    permission: 'analysis_only',
    granted: true,
    conditions: 'Street Banker may measure this recording to produce diagnostics for its rights holder.',
  })
  await studio.rights.setAiPermission({
    actor,
    projectId: project.id,
    assetScope: 'all',
    permission: 'training_use',
    granted: false,
    conditions: 'This recording is not made available for model training.',
  })
  await studio.rights.setIdentity({
    actor,
    artistKey: STUDIO_DEMO_ARTIST.toLowerCase(),
    subject: 'voice',
    control: 'prohibited',
    prohibitedUses: ['voice cloning', 'synthetic performance'],
    pricing: 'Not licensed.',
  })

  const versions = await studio.repos.versions.list(input.orgId, project.id)
  return {
    project: await studio.repos.projects.get(input.orgId, project.id),
    created: true,
    versionIds: versions.map((version) => version.id),
    rackId: rack.chain.id,
    renditionIds,
  }
}

// ---------------------------------------------------------------------------
// synthesized demo audio
// ---------------------------------------------------------------------------

const DEMO_SECONDS = 45
const DEMO_RATE = 44100

/**
 * A stereo demo mix.
 *
 * Built on the platform's own synthesizer so the audio is genuinely musical
 * material rather than noise, then resampled to 44.1 kHz and decorrelated into
 * two channels — Mix Station measures stereo behaviour and sibilance, and a
 * 22.05 kHz mono file would leave half its analyzers with nothing to read.
 *
 * `brightness`, `width` and `level` are what make Mix 01 and Mix 02 genuinely
 * different files, so the difference engine describes real measured changes.
 */
function demoMix(opts: { seed: number; brightness: number; width: number; level: number }): Uint8Array {
  const bars = Math.max(1, Math.round((DEMO_SECONDS * DEMO_BPM) / (4 * 60)))
  // Two passes rather than one. A single low-rooted pass is overwhelmingly
  // low-frequency in *power* terms — a demo record that measures 98% of its
  // energy below 200 Hz makes every band on the readiness screen read as a
  // fault, which teaches the wrong thing about the product. The upper pass adds
  // real midrange and top so the demo is a plausible mix rather than a bass
  // tone with decoration.
  const low = synthesize({
    bpm: DEMO_BPM,
    bars,
    energy: 0.7,
    layers: { kick: true, bass: true },
    rootHz: 55,
    seed: opts.seed,
    gain: opts.level * 0.45,
  })
  const upper = synthesize({
    bpm: DEMO_BPM,
    bars,
    energy: 0.8,
    layers: { hat: true, pad: true, click: true },
    rootHz: 330,
    seed: opts.seed + 7,
    gain: opts.level * 1.15,
  })

  // Linear resample from the synthesizer's 22.05 kHz to 44.1 kHz.
  const sourceFrames = Math.max(low.length, upper.length)
  const frames = Math.round((sourceFrames / 22050) * DEMO_RATE)
  const mixed = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const position = (i * 22050) / DEMO_RATE
    const index = Math.floor(position)
    const fraction = position - index
    const at = (buffer: Float32Array) => (buffer[index] ?? 0) * (1 - fraction) + (buffer[index + 1] ?? buffer[index] ?? 0) * fraction
    mixed[i] = at(low) + at(upper)
  }

  // A gentle 30 Hz high-pass. Nothing musical lives down there and leaving it
  // in would spend the demo's headroom on inaudible energy.
  let carry = 0
  for (let i = 0; i < frames; i++) {
    carry = carry * 0.996 + mixed[i] * 0.004
    mixed[i] -= carry
  }

  // Normalized to a fixed peak before the stereo stage, so the demo mix arrives
  // with real headroom. A demo that lands at 0 dBFS would open Mix Doctor on
  // "little headroom before mastering" — a correct finding about a synthesis
  // artefact, and the wrong first thing for the product to say about itself.
  let peak = 0
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(mixed[i]))
  const normalize = peak > 0 ? 0.5 / peak : 1
  for (let i = 0; i < frames; i++) mixed[i] *= normalize

  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  // Width is a *swap*, not a mid/side add and subtract. Adding the side signal
  // to one channel and subtracting it from the other looks symmetric but is
  // not: the cross term between the dry signal and the side signal has a sign,
  // so one channel systematically carries more energy and the stereo analyzer
  // correctly reports a channel imbalance. Giving each channel the same two
  // signals with the weights swapped is symmetric by construction, and keeps
  // the amplitude bounded because the weights still sum to one.
  const delay = Math.round(0.004 * DEMO_RATE)
  // The channel difference is (dry − delayed) × (1 − 2·wet), so it *shrinks* as
  // the mix weight approaches an even split: wet = 0.5 is mono. The parameter
  // is named `width`, so it has to map the other way round.
  const wet = 0.5 - Math.max(0, Math.min(1, opts.width)) * 0.45
  let previousLeft = 0
  let previousRight = 0
  for (let i = 0; i < frames; i++) {
    const dry = mixed[i]
    const delayed = mixed[Math.max(0, i - delay)]
    const l = dry * (1 - wet) + delayed * wet
    const r = delayed * (1 - wet) + dry * wet
    // High shelf: the difference between the sample and a smoothed version is
    // the high-frequency content, scaled by `brightness`.
    previousLeft = previousLeft * 0.85 + l * 0.15
    previousRight = previousRight * 0.85 + r * 0.15
    left[i] = Math.max(-0.99, Math.min(0.99, l + (l - previousLeft) * opts.brightness))
    right[i] = Math.max(-0.99, Math.min(0.99, r + (r - previousRight) * opts.brightness))
  }

  return encodeStereoWav(left, right, DEMO_RATE)
}

function encodeStereoWav(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
  const frames = Math.min(left.length, right.length)
  const dataBytes = frames * 4
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 4, true)
  view.setUint16(32, 4, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), true)
    view.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), true)
  }
  return new Uint8Array(buffer)
}
