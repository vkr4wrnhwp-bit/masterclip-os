import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, toStr, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { JOB_TYPES, QUEUES, QueueWorker } from '@masterclip/queue'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { encodeWavPcm16, synthesize } from '@masterclip/ai-audio'
import { REGISTER_CONFIDENCE_CEILING } from '@masterclip/song-analysis'
import { FLAGSHIP_SONG_LAB_CAPABILITIES, PARTNER_SONG_LAB_CAPABILITIES } from '@masterclip/song-lab-domain'
import { FLAGSHIP_CAPABILITIES } from '@masterclip/performance-project'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'

/**
 * Song Lab HTTP and engine tests.
 *
 * Everything runs through the real Fastify instance against the real schema,
 * real local storage, the real queue and the real analysis engine. The
 * properties tested are the release blockers: tenant isolation, entitlement
 * enforcement, rights gating, the non-destructive guarantee, human approval,
 * and the refusal to fabricate data.
 */

let runtime: Runtime
let db: Db
let app: FastifyInstance
let storageRoot: string

interface Session {
  session: string
  csrf: string
  orgId: string
  userId: string
}

async function boot(): Promise<void> {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'songlab-test-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'songlab-test-secret',
      SESSION_SECRET: 'songlab-test-session-secret',
      // The deterministic provider keeps the suite fast and independent of
      // whether ffmpeg exists on the machine running it.
      SONG_LAB_ANALYSIS_PROVIDER: 'mock-song-analysis',
    },
    true,
  )
  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'songlab-test-secret' }),
  })
  // buildServer publishes the shipped cohorts itself; the suite relies on that
  // rather than seeding them, so a regression there fails a test.
  app = await buildServer({ runtime, logger: silentLogger })
  await app.ready()
}

beforeEach(boot)
afterEach(async () => {
  await app?.close()
  await rm(storageRoot, { recursive: true, force: true })
})

const PASSWORD = 'a-sufficiently-long-password'

/**
 * Bootstraps the first organization through the real signup route.
 *
 * Signup is deliberately single-use on this platform — it exists to create the
 * flagship org and then closes. Every later organization is provisioned the way
 * a partner really would be, by `provisionOrg` below.
 */
async function signup(email: string, orgName: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password: PASSWORD, displayName: 'Tester', orgName },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { user: { id: string; orgId: string } }
  return {
    session: response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '',
    csrf: response.cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value ?? '',
    orgId: body.user.orgId,
    userId: body.user.id,
  }
}

/** A second (partner) organization, then a real login for its owner. */
async function provisionOrg(email: string, orgName: string): Promise<Session> {
  const org = await runtime.projects.createOrg(orgName)
  const user = await runtime.auth.createUser({ orgId: org.id, email, password: PASSWORD, displayName: 'Partner', orgRole: 'owner' })
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } })
  expect(response.statusCode).toBe(200)
  return {
    session: response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '',
    csrf: response.cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value ?? '',
    orgId: org.id,
    userId: user.id,
  }
}

/**
 * The flagship is the oldest org on the deployment. Tests about partner
 * behaviour need a flagship to exist *first*, or the org under test would be
 * the flagship itself and would legitimately see everything.
 */
async function bootstrapFlagship(): Promise<Session> {
  return signup('flagship-owner@example.com', 'Street Banker Flagship')
}

function headers(session: Session): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${session.session}; ${CSRF_COOKIE}=${session.csrf}`, [CSRF_HEADER]: session.csrf }
}

async function call(session: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: headers(session), ...(payload === undefined ? {} : { payload }) })
}

/** Grants Song Lab so a fresh org can use it. Signup does not grant it. */
async function grantSongLab(orgId: string, capabilities: readonly string[] = FLAGSHIP_SONG_LAB_CAPABILITIES): Promise<void> {
  await runtime.entitlements.grantAll(orgId, capabilities)
}

/**
 * Renders an experiment with a stand-in for a working ffmpeg.
 *
 * The suite runs with the placeholder renderer (no ffmpeg in CI), but the
 * accept path deliberately refuses a placeholder — so tests about accepting
 * supply a preview that is real audio.
 */
async function renderWithRealAudio(orgId: string, experimentId: string): Promise<void> {
  const experiment = await runtime.songLab.repos.experiments.getForJob(experimentId, orgId)
  const version = await runtime.songLab.repos.versions.get(orgId, experiment.sourceVersionId)
  const source = await runtime.audio.repos.assets.get(orgId, version.sourceAssetId!)
  const { projectEdl } = await import('@masterclip/audio-experiments')
  const outcome = projectEdl(experiment.editDecisionList, source.durationMs ?? experiment.predictedDurationMs ?? 0)

  const preview = await runtime.audio.assets.storeGenerated({
    orgId,
    ownerUserId: experiment.createdBy,
    bytes: demoWav(21),
    contentType: 'audio/wav',
    filename: 'preview.wav',
    area: 'song-lab-previews',
    projectType: 'song_lab',
    projectId: experiment.songLabProjectId,
    assetType: 'song_lab_experiment_preview',
    retentionKind: 'generated',
    rightsStatus: 'derived_from_authorized_source',
  })
  await runtime.songLab.repos.experiments.attachPreview(orgId, experimentId, {
    assetId: preview.id,
    durationMs: outcome.durationMs,
    renderer: 'test-real',
    rendererVersion: '1',
    placeholder: false,
  })
}

function demoWav(seed = 7): Uint8Array {
  return encodeWavPcm16(
    synthesize({ bpm: 92, bars: 16, energy: 0.6, layers: { kick: true, hat: true, bass: true, pad: true }, rootHz: 164.81, seed }),
  )
}

/** Creates a project with audio attached and analysis completed. */
async function seedProject(session: Session, title = 'Test Song'): Promise<{ projectId: string; analysisId: string }> {
  const created = await call(session, 'POST', '/api/song-lab/projects', {
    title,
    artistName: 'Example Artist',
    genre: 'alternative',
    titlePhrase: 'signal fire',
    rightsConfirmed: true,
  })
  expect(created.statusCode).toBe(200)
  const projectId = (created.json() as { project: { id: string } }).project.id

  const actor = { userId: session.userId, orgId: session.orgId, orgRole: 'owner' }
  const attached = await runtime.songLab.projects.attachUpload({
    actor,
    projectId,
    bytes: demoWav(),
    filename: 'test.wav',
    rightsConfirmed: true,
  })
  expect(attached.analysisId).not.toBeNull()
  await runtime.songLab.analysis.run(attached.analysisId!, session.orgId)
  return { projectId, analysisId: attached.analysisId! }
}

// ===========================================================================

describe('entitlements', () => {
  it('grants the bootstrap organization every Song Lab capability', async () => {
    // Otherwise a clean deployment would ship Song Lab that nobody can reach.
    const session = await bootstrapFlagship()
    const response = await call(session, 'GET', '/api/song-lab/capabilities')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { capabilities: string[]; flagship: boolean }
    expect(body.flagship).toBe(true)
    for (const capability of FLAGSHIP_SONG_LAB_CAPABILITIES) expect(body.capabilities, capability).toContain(capability)
  })

  it('refuses every Song Lab route until the organization is entitled', async () => {
    // A partner org. The bootstrap organization is the flagship and is granted
    // every capability on creation, so it is the wrong subject for this test.
    await bootstrapFlagship()
    const session = await provisionOrg('nogrant@example.com', 'Ungranted Org')
    for (const url of ['/api/song-lab/projects', '/api/song-lab/cohorts', '/api/song-lab/capabilities']) {
      const response = await call(session, 'GET', url)
      expect(response.statusCode, url).toBe(403)
      expect(response.json().error.code).toContain('song_lab.gate')
    }
  })

  it('names which layer refused', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('layer@example.com', 'Layer Org')
    const response = await call(session, 'GET', '/api/song-lab/projects')
    expect(response.json().error.code).toBe('song_lab.gate.module_entitlement')
  })

  it('allows access once entitled', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('granted@example.com', 'Granted Org')
    await grantSongLab(session.orgId)
    const response = await call(session, 'GET', '/api/song-lab/projects')
    expect(response.statusCode).toBe(200)
  })

  it('enforces a per-capability grant, not just module access', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('partial@example.com', 'Partial Org')
    // Module access only — no experiments capability.
    await runtime.entitlements.grantAll(session.orgId, ['song_lab.access', 'song_lab.analysis', 'song_lab.structure'])
    const { projectId } = await seedProject(session)
    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/experiments`)
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('song_lab.gate.capability_entitlement')
  })

  it('enforces a numeric project limit', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('limited@example.com', 'Limited Org')
    await grantSongLab(session.orgId)
    await runtime.entitlements.setLimit(session.orgId, 'song_lab.max_projects', 1)
    const first = await call(session, 'POST', '/api/song-lab/projects', {
      title: 'One',
      artistName: 'A',
      genre: 'pop',
      rightsConfirmed: true,
    })
    expect(first.statusCode).toBe(200)
    const second = await call(session, 'POST', '/api/song-lab/projects', {
      title: 'Two',
      artistName: 'A',
      genre: 'pop',
      rightsConfirmed: true,
    })
    expect(second.statusCode).toBe(403)
    expect(second.json().error.code).toBe('song_lab.gate.usage_limit')
  })

  it('hides the internal A&R view from an organization without the grant', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('artist@example.com', 'Artist Org')
    // A partner edition holds everything except the internal layers.
    await grantSongLab(session.orgId, PARTNER_SONG_LAB_CAPABILITIES)
    const { projectId } = await seedProject(session)
    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/ar`)
    expect(response.statusCode).toBe(403)
  })

  it('allows the A&R view for an entitled organization', async () => {
    const session = await signup('flagship@example.com', 'Flagship Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/ar`)
    expect(response.statusCode).toBe(200)
  })
})

describe('rights confirmation', () => {
  it('refuses to create a project without it', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('rights@example.com', 'Rights Org')
    await grantSongLab(session.orgId)
    const response = await call(session, 'POST', '/api/song-lab/projects', {
      title: 'Unconfirmed',
      artistName: 'A',
      genre: 'pop',
      rightsConfirmed: false,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('song_lab.rights_not_confirmed')
  })

  it('records a consent row the project points at', async () => {
    const session = await signup('consent@example.com', 'Consent Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    expect(project.rightsConfirmationId).toBeTruthy()
    const consent = await runtime.audio.repos.consents.get(session.orgId, project.rightsConfirmationId)
    expect(consent.accepted).toBe(true)
    expect(consent.consentType).toBe('rights_confirmation')
    // The exact wording accepted is hashed into the evidence, so a later change
    // to the statement cannot be passed off as what the user agreed to.
    expect(consent.evidence.statementHash).toBeTruthy()
  })
})

describe('tenant isolation', () => {
  it("does not list another organization's projects", async () => {
    const a = await bootstrapFlagship()
    const b = await provisionOrg('b@example.com', 'Org B')
    await grantSongLab(a.orgId)
    await grantSongLab(b.orgId)
    await seedProject(a, 'A song')

    const response = await call(b, 'GET', '/api/song-lab/projects')
    expect(response.statusCode).toBe(200)
    expect(response.json().projects).toHaveLength(0)
  })

  it("refuses to read another organization's project by id", async () => {
    const a = await bootstrapFlagship()
    const b = await provisionOrg('b2@example.com', 'Org B2')
    await grantSongLab(a.orgId)
    await grantSongLab(b.orgId)
    const { projectId } = await seedProject(a)

    const response = await call(b, 'GET', `/api/song-lab/projects/${projectId}`)
    expect(response.statusCode).toBe(404)
  })

  it("refuses to import another organization's audio", async () => {
    const a = await bootstrapFlagship()
    const b = await provisionOrg('b3@example.com', 'Org B3')
    await grantSongLab(a.orgId)
    await grantSongLab(b.orgId)
    const seeded = await seedProject(a)
    const aProject = await runtime.songLab.repos.projects.get(a.orgId, seeded.projectId)

    const bProject = await call(b, 'POST', '/api/song-lab/projects', {
      title: 'B song',
      artistName: 'B',
      genre: 'pop',
      rightsConfirmed: true,
    })
    const bProjectId = (bProject.json() as { project: { id: string } }).project.id

    const response = await call(b, 'POST', `/api/song-lab/projects/${bProjectId}/import-release`, { assetId: aProject.sourceAssetId })
    expect(response.statusCode).toBe(404)
  })

  it('offers only song-shaped audio for import, not everything the tenant owns', async () => {
    const session = await signup('importable@example.com', 'Importable Org')
    await grantSongLab(session.orgId)
    await seedProject(session)

    // A meeting recording is the tenant's audio, but it is not a record to
    // diagnose — and it belongs to a module this caller may not hold.
    await runtime.audio.assets.storeUpload({
      actor: { userId: session.userId, orgId: session.orgId, orgRole: 'owner' },
      bytes: demoWav(31),
      filename: 'private-meeting.wav',
      area: 'source',
      projectType: 'meeting',
      projectId: null,
      assetType: 'meeting_source',
      retentionKind: 'source',
      rightsStatus: 'authorized_upload',
      consentRecordId: null,
    })

    const response = await call(session, 'GET', '/api/song-lab/importable')
    const assets = (response.json() as { assets: Array<{ fileName: string; projectType: string }> }).assets
    expect(assets.some((asset) => asset.projectType === 'song_lab')).toBe(true)
    expect(assets.some((asset) => asset.fileName.includes('private-meeting'))).toBe(false)
    expect(assets.every((asset) => ['song_lab', 'remix', 'library'].includes(asset.projectType))).toBe(true)
  })

  it("does not list another organization's audio as importable", async () => {
    const a = await bootstrapFlagship()
    const b = await provisionOrg('b4@example.com', 'Org B4')
    await grantSongLab(a.orgId)
    await grantSongLab(b.orgId)
    await seedProject(a)

    const response = await call(b, 'GET', '/api/song-lab/importable')
    expect(response.json().assets).toHaveLength(0)
  })

  it('refuses a cross-tenant analysis job even when the id is known', async () => {
    const a = await bootstrapFlagship()
    const b = await provisionOrg('b5@example.com', 'Org B5')
    await grantSongLab(a.orgId)
    await grantSongLab(b.orgId)
    const { analysisId } = await seedProject(a)

    // A job payload is not a capability: the service proves the org.
    await expect(runtime.songLab.analysis.run(analysisId, b.orgId)).rejects.toThrow(/another organization/)
  })

  it('refuses a cross-tenant experiment render', async () => {
    const a = await bootstrapFlagship()
    const b = await provisionOrg('b6@example.com', 'Org B6')
    await grantSongLab(a.orgId)
    await grantSongLab(b.orgId)
    const { projectId } = await seedProject(a)
    const experiment = await call(a, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'shorter_intro',
      amount: 4,
      render: false,
    })
    const experimentId = (experiment.json() as { experiment: { id: string } }).experiment.id

    await expect(runtime.songLab.experiments.render(experimentId, b.orgId)).rejects.toThrow(/another organization/)
  })
})

describe('benchmark cohorts', () => {
  it('publishes the shipped cohorts on boot, so a fresh install has a picker', async () => {
    const session = await bootstrapFlagship()
    const response = await call(session, 'GET', '/api/song-lab/cohorts')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { cohorts: Array<{ name: string; sampleSize: number }> }
    expect(body.cohorts.length).toBeGreaterThan(0)
    expect(body.cohorts.every((cohort) => cohort.sampleSize > 0)).toBe(true)
  })

  it('hides proprietary cohorts from an unentitled organization', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('partner@example.com', 'Partner Org')
    await grantSongLab(session.orgId, PARTNER_SONG_LAB_CAPABILITIES)
    const response = await call(session, 'GET', '/api/song-lab/cohorts')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { cohorts: Array<{ proprietary: boolean }>; entitledToProprietary: boolean }
    expect(body.entitledToProprietary).toBe(false)
    expect(body.cohorts.every((cohort) => !cohort.proprietary)).toBe(true)
  })

  it('refuses to read a proprietary cohort by id without the grant', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('partner2@example.com', 'Partner Org 2')
    await grantSongLab(session.orgId, PARTNER_SONG_LAB_CAPABILITIES)
    const proprietary = await runtime.songLab.repos.cohorts.findByName(null, 'Street Banker Successful Releases')
    expect(proprietary).not.toBeNull()

    const response = await call(session, 'GET', `/api/song-lab/cohorts/${proprietary!.id}`)
    expect(response.statusCode).toBe(403)
  })

  it('shows every cohort to the flagship organization', async () => {
    // The flagship is the oldest org on the deployment, by construction.
    const flagship = await signup('flag@example.com', 'Flagship')
    await grantSongLab(flagship.orgId)
    const response = await call(flagship, 'GET', '/api/song-lab/cohorts')
    const body = response.json() as { cohorts: Array<{ proprietary: boolean }>; entitledToProprietary: boolean }
    expect(body.entitledToProprietary).toBe(true)
    expect(body.cohorts.some((cohort) => cohort.proprietary)).toBe(true)
  })

  it('reports the sample size and the provenance with every comparison', async () => {
    const session = await signup('bench@example.com', 'Bench Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const cohorts = await runtime.songLab.repos.cohorts.listVisible(session.orgId, true)
    const cohort = cohorts.find((entry) => !entry.proprietary)!

    await call(session, 'POST', `/api/song-lab/projects/${projectId}/benchmark`, { cohortId: cohort.id })
    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/benchmark`)
    const body = response.json() as { sampleSize: number; provenance: Array<{ basis: string; storesMasters: boolean }>; results: unknown[] }
    expect(body.sampleSize).toBeGreaterThan(0)
    expect(body.provenance.length).toBeGreaterThan(0)
    // The benchmark library holds derived data, never other people's masters.
    expect(body.provenance.every((source) => !source.storesMasters)).toBe(true)
    expect(body.results.length).toBeGreaterThan(0)
  })
})

describe('structure', () => {
  it('persists detected sections and exposes them as a timeline', async () => {
    const session = await signup('struct@example.com', 'Struct Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/structure`)
    expect(response.statusCode).toBe(200)
    const body = response.json() as { sections: Array<{ id: string; label: string }>; timeline: Array<{ time: string; label: string }> }
    expect(body.sections.length).toBeGreaterThan(1)
    expect(body.timeline[0]!.time).toMatch(/^\d+:\d{2}$/)
  })

  it('makes a user correction authoritative and marks it confirmed', async () => {
    const session = await signup('correct@example.com', 'Correct Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const before = await call(session, 'GET', `/api/song-lab/projects/${projectId}/structure`)
    const section = (before.json() as { sections: Array<{ id: string; label: string; startMs: number }> }).sections[1]!

    const corrected = await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/structure`, {
      corrections: [{ id: section.id, label: 'Verse One (corrected)', sectionType: 'verse', isHook: false }],
    })
    expect(corrected.statusCode).toBe(200)
    const updated = (corrected.json() as { sections: Array<{ id: string; label: string; humanConfirmed: boolean; confidence: number }> }).sections.find(
      (entry) => entry.id === section.id,
    )!
    expect(updated.label).toBe('Verse One (corrected)')
    expect(updated.humanConfirmed).toBe(true)
    // A human-set boundary is not a guess any more.
    expect(updated.confidence).toBe(1)
  })

  it('recomputes structural metrics from the corrected structure', async () => {
    const session = await signup('recompute@example.com', 'Recompute Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const before = await call(session, 'GET', `/api/song-lab/projects/${projectId}/structure`)
    const body = before.json() as { sections: Array<{ id: string; sectionType: string; startMs: number; endMs: number }>; metrics: Record<string, number> }
    const chorus = body.sections.find((entry) => entry.sectionType === 'chorus')!

    const after = await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/structure`, {
      corrections: [{ id: chorus.id, startMs: chorus.startMs + 10_000 }],
    })
    const metrics = (after.json() as { metrics: Record<string, number> }).metrics
    expect(metrics.firstChorusSeconds).toBeCloseTo((chorus.startMs + 10_000) / 1000, 0)
    expect(metrics.firstChorusSeconds).not.toBe(body.metrics.firstChorusSeconds)
  })

  it('carries a confirmed section forward through reanalysis', async () => {
    const session = await signup('reanalyze@example.com', 'Reanalyze Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const before = await call(session, 'GET', `/api/song-lab/projects/${projectId}/structure`)
    const section = (before.json() as { sections: Array<{ id: string }> }).sections[2]!
    await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/structure`, {
      corrections: [{ id: section.id, label: 'ARTIST CONFIRMED', sectionType: 'bridge' }],
    })

    const queued = await call(session, 'POST', `/api/song-lab/projects/${projectId}/reanalyze`)
    const analysisId = (queued.json() as { analysisId: string }).analysisId
    await runtime.songLab.analysis.run(analysisId, session.orgId)

    const after = await call(session, 'GET', `/api/song-lab/projects/${projectId}/structure`)
    const sections = (after.json() as { sections: Array<{ label: string; humanConfirmed: boolean }> }).sections
    const kept = sections.find((entry) => entry.label === 'ARTIST CONFIRMED')
    expect(kept, 'the confirmed section survived reanalysis').toBeDefined()
    expect(kept!.humanConfirmed).toBe(true)
  })

  it('keeps the previous analysis rather than replacing it', async () => {
    const session = await signup('history@example.com', 'History Org')
    await grantSongLab(session.orgId)
    const { projectId, analysisId } = await seedProject(session)

    const queued = await call(session, 'POST', `/api/song-lab/projects/${projectId}/reanalyze`)
    const secondId = (queued.json() as { analysisId: string }).analysisId
    await runtime.songLab.analysis.run(secondId, session.orgId)

    const history = await runtime.songLab.repos.analyses.listForProject(session.orgId, projectId)
    expect(history.length).toBeGreaterThanOrEqual(2)
    // The old result is still readable, which is what makes engine versions
    // comparable rather than silently superseded.
    expect(await runtime.songLab.repos.analyses.get(session.orgId, analysisId)).toBeTruthy()
  })
})

describe('melodic and register analysis', () => {
  it('persists a register band per section and serves it with the arrangement', async () => {
    const session = await signup('register@example.com', 'Register Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/arrangement`)
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      registerBands: Array<{ label: string; sectionType: string; median: number | null; low: number | null; high: number | null; contour: number[] }>
      register: { verseRegister: number | null; chorusRegister: number | null; chorusRegisterLift: number | null; melodicContourRepetition: number | null }
      consecutive: Array<{ rhythmicDelta: number; registerDelta: number | null; contourSimilarity: number | null }>
    }

    expect(body.registerBands.length).toBeGreaterThan(1)
    const chorus = body.registerBands.find((band) => band.sectionType === 'chorus')!
    expect(chorus.median).not.toBeNull()
    expect(chorus.low!).toBeLessThanOrEqual(chorus.median!)
    expect(chorus.high!).toBeGreaterThanOrEqual(chorus.median!)
    expect(body.register.chorusRegisterLift).not.toBeNull()
    expect(body.consecutive.some((entry) => entry.contourSimilarity !== null)).toBe(true)
  })

  it('reports no register for a section with no vocal, rather than a zero', async () => {
    const session = await signup('noregister@example.com', 'No Register Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const body = (await call(session, 'GET', `/api/song-lab/projects/${projectId}/arrangement`)).json() as {
      registerBands: Array<{ sectionType: string; median: number | null; confidence: number }>
    }
    const intro = body.registerBands.find((band) => band.sectionType === 'intro')!
    expect(intro.median).toBeNull()
    // The distinction the whole product rests on: unmeasured is null, not zero.
    expect(intro.median).not.toBe(0)
  })

  it('puts the melodic metrics in the feature vector with their own method', async () => {
    const session = await signup('vector@example.com', 'Vector Org')
    await grantSongLab(session.orgId)
    const { projectId, analysisId } = await seedProject(session)

    const analysis = await runtime.songLab.repos.analyses.get(session.orgId, analysisId)
    const metrics = analysis.featureVector!.metrics
    expect(metrics.chorus_register_lift).toBeDefined()
    expect(metrics.chorus_register_lift!.analysisMethod).toBe('verse_chorus_register_delta')
    expect(metrics.melodic_contour_repetition).toBeDefined()
    expect(metrics.rhythmic_contrast).toBeDefined()

    // And Producer View surfaces them, with the method visible.
    const producer = await call(session, 'GET', `/api/song-lab/projects/${projectId}/producer`)
    const rows = (producer.json() as { features: Array<{ key: string; method: string }> }).features
    expect(rows.some((row) => row.key === 'chorus_register_lift')).toBe(true)
    expect(rows.some((row) => row.key === 'vocal_register_range')).toBe(true)
  })

  it('carries melodic contrast into the hook architecture profile', async () => {
    const session = await signup('hookmelodic@example.com', 'Hook Melodic Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const body = (await call(session, 'GET', `/api/song-lab/projects/${projectId}/hook`)).json() as {
      profile: { rows: Array<{ metric: string; finding: string }> }
    }
    const metrics = body.profile.rows.map((row) => row.metric)
    expect(metrics).toContain('Melodic contrast')
    expect(metrics).toContain('Rhythmic contrast')
    // Present with a real figure rather than as an empty row.
    expect(body.profile.rows.find((row) => row.metric === 'Melodic contrast')!.finding).not.toBe('Not enough information')
  })

  it('recomputes the register lift from a corrected structure', async () => {
    const session = await signup('registercorrect@example.com', 'Register Correct Org')
    await grantSongLab(session.orgId)
    const { projectId, analysisId } = await seedProject(session)

    const before = (await runtime.songLab.repos.analyses.get(session.orgId, analysisId)).featureVector!.metrics.chorus_register_lift!
    const structure = (await call(session, 'GET', `/api/song-lab/projects/${projectId}/structure`)).json() as {
      sections: Array<{ id: string; sectionType: string; label: string }>
    }
    // Calling the bridge a chorus pulls the song's highest register into the
    // chorus average, so the lift has to move with the user's structure rather
    // than being carried over from the detection.
    const bridge = structure.sections.find((section) => section.sectionType === 'bridge')!
    await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/structure`, {
      corrections: [{ id: bridge.id, sectionType: 'chorus', label: 'Chorus 3' }],
    })

    const after = (await runtime.songLab.repos.analyses.get(session.orgId, analysisId)).featureVector!.metrics.chorus_register_lift!
    expect(after.value).toBeGreaterThan(before.value!)
    // A human-confirmed structure is not a guess, and the provenance says so.
    expect(after.provider).toBe('human-confirmed')
  })

  it('raises the register finding on the demo record, in the vocabulary the product uses', async () => {
    const session = await signup('registerdemo@example.com', 'Register Demo Org')
    const { seedSongLabDemo } = await import('@masterclip/song-lab-engine')
    const demo = await seedSongLabDemo(runtime.songLab, {
      orgId: session.orgId,
      userId: session.userId,
      entitlements: runtime.entitlements,
    })

    const observations = await runtime.songLab.repos.observations.listForProject(session.orgId, demo.projectId!)
    const melodic = observations.filter((observation) => observation.observationType === 'melodic_contrast')
    expect(melodic.length).toBeGreaterThan(0)

    // The register finding specifically — identified by the metric behind it
    // rather than by position, since the melodic category also carries the
    // cohort-relative contour comparison.
    const register = melodic.find((observation) => observation.sourceMetricKeys.includes('chorus_register_lift'))
    expect(register).toBeDefined()
    expect(register!.description.toLowerCase()).toContain('register')
    // The recommendation is a note for the writer; nothing here renders audio.
    expect(register!.recommendations!.every((recommendation) => !recommendation.experimentSupported)).toBe(true)

    // Never a verdict, and never a claim of transcribed pitch — across every
    // melodic observation the demo produces, not just the register one.
    const text = melodic.map((observation) => `${observation.title} ${observation.description}`).join(' ').toLowerCase()
    for (const forbidden of ['wrong', 'too low', 'will perform better', 'g5', 'bad ']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('experiments', () => {
  it('never modifies the source audio', async () => {
    const session = await signup('nondestructive@example.com', 'Nondestructive Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    const sourceAsset = await runtime.audio.repos.assets.get(session.orgId, project.sourceAssetId!)
    const before = await runtime.storage.getBuffer(sourceAsset.storageKey)

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'shorter_intro',
      amount: 4,
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id
    await runtime.songLab.experiments.render(experimentId, session.orgId)

    const after = await runtime.storage.getBuffer(sourceAsset.storageKey)
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).toBe(0)
    const stillThere = await runtime.audio.repos.assets.get(session.orgId, project.sourceAssetId!)
    expect(stillThere.checksum).toBe(sourceAsset.checksum)
  })

  it('stores the edit decision list rather than rewriting audio', async () => {
    const session = await signup('edl@example.com', 'EDL Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'earlier_chorus',
      amount: 8,
      render: false,
    })
    const experiment = (created.json() as { experiment: { editDecisionList: Array<{ type: string }>; predictedDurationMs: number } }).experiment
    expect(experiment.editDecisionList.length).toBeGreaterThan(0)
    expect(experiment.editDecisionList[0]!.type).toBe('remove_range')
    expect(experiment.predictedDurationMs).toBeGreaterThan(0)
  })

  it('creates a tempo experiment that preserves lineage when accepted', async () => {
    const session = await signup('tempo@example.com', 'Tempo Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    const sourceVersionId = project.currentVersionId!

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'tempo',
      amount: 96,
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id
    await renderWithRealAudio(session.orgId, experimentId)

    const accepted = await call(session, 'POST', `/api/song-lab/experiments/${experimentId}/accept`)
    expect(accepted.statusCode).toBe(200)
    const version = (accepted.json() as { version: { id: string; parentVersionId: string; versionType: string } }).version
    expect(version.parentVersionId).toBe(sourceVersionId)
    expect(version.versionType).toBe('song_lab_experiment')

    const lineage = await runtime.songLab.repos.versions.lineage(session.orgId, version.id)
    expect(lineage[0]!.versionType).toBe('original_upload')
    expect(lineage[lineage.length - 1]!.id).toBe(version.id)
  })

  it('accepting creates a new version and leaves the original playable', async () => {
    const session = await signup('accept@example.com', 'Accept Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const before = await call(session, 'GET', `/api/song-lab/projects/${projectId}/versions`)
    const beforeCount = (before.json() as { versions: unknown[] }).versions.length

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'shorter_intro',
      amount: 4,
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id
    await renderWithRealAudio(session.orgId, experimentId)
    await call(session, 'POST', `/api/song-lab/experiments/${experimentId}/accept`)

    const after = await call(session, 'GET', `/api/song-lab/projects/${projectId}/versions`)
    const versions = (after.json() as { versions: Array<{ versionType: string; url: string | null }> }).versions
    expect(versions.length).toBe(beforeCount + 1)
    const original = versions.find((version) => version.versionType === 'original_upload')!
    expect(original.url, 'the original is still served').toBeTruthy()
  })

  it('rejecting leaves the source version and its analysis untouched', async () => {
    const session = await signup('reject@example.com', 'Reject Org')
    await grantSongLab(session.orgId)
    const { projectId, analysisId } = await seedProject(session)
    const before = await runtime.songLab.repos.projects.get(session.orgId, projectId)

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'shorter_intro',
      amount: 4,
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id
    await runtime.songLab.experiments.render(experimentId, session.orgId)
    const rejected = await call(session, 'POST', `/api/song-lab/experiments/${experimentId}/reject`)
    expect(rejected.statusCode).toBe(200)

    const after = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    expect(after.currentVersionId).toBe(before.currentVersionId)
    expect(after.sourceAssetId).toBe(before.sourceAssetId)
    expect((await runtime.songLab.repos.analyses.get(session.orgId, analysisId)).status).toBe('complete')
  })

  it('analyses the accepted version so a version comparison has both sides', async () => {
    const session = await signup('compare@example.com', 'Compare Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const before = await runtime.songLab.repos.projects.get(session.orgId, projectId)

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'shorter_intro',
      amount: 6,
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id
    await renderWithRealAudio(session.orgId, experimentId)
    const accepted = await call(session, 'POST', `/api/song-lab/experiments/${experimentId}/accept`)
    const versionId = (accepted.json() as { version: { id: string } }).version.id

    // Drain the queue the way the worker would.
    const worker = new QueueWorker(runtime.queue, { queueName: QUEUES.songLab, concurrency: 1, logger: silentLogger })
    worker.register<{ analysisId: string; orgId: string }>(JOB_TYPES.songLabAnalyzeAudio, async ({ analysisId, orgId }) => {
      await runtime.songLab.analysis.run(analysisId, orgId)
    })
    for (let round = 0; round < 3; round++) await worker.runOnce()

    const analysis = await runtime.songLab.repos.analyses.latestForVersion(session.orgId, versionId)
    expect(analysis, 'the accepted version was analysed').not.toBeNull()
    expect(analysis!.status).toBe('complete')

    const comparison = await call(session, 'GET', `/api/song-lab/projects/${projectId}/versions/compare?a=${before.currentVersionId}&b=${versionId}`)
    expect(comparison.statusCode).toBe(200)
    const body = comparison.json() as {
      a: { analysis: { durationMs: number }; sections: Array<{ label: string; startMs: number; sectionType: string }> }
      b: { analysis: { durationMs: number } | null; sections: Array<{ label: string; startMs: number; sectionType: string; humanConfirmed: boolean }> }
    }
    expect(body.a.analysis.durationMs).toBeGreaterThan(0)
    expect(body.b.analysis).not.toBeNull()

    // The artist's structure travelled with the edit: the same chorus, at its
    // new time. Without this, the comparison would be between two different
    // sections that happen to share a name.
    const chorusA = body.a.sections.find((section) => section.sectionType === 'chorus')!
    const chorusB = body.b.sections.find((section) => section.label === chorusA.label)
    expect(chorusB, 'the chorus kept its identity across the edit').toBeDefined()
    expect(chorusB!.startMs).toBeLessThan(chorusA.startMs)
    expect(chorusB!.humanConfirmed).toBe(true)
  })

  it('drops a section the edit removed rather than fabricating a position for it', async () => {
    const session = await signup('dropped@example.com', 'Dropped Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const structure = await call(session, 'GET', `/api/song-lab/projects/${projectId}/structure`)
    const sections = (structure.json() as { sections: Array<{ id: string; label: string; startMs: number; endMs: number }> }).sections
    const victim = sections[1]!

    // Remove one section outright.
    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'custom',
      name: 'Remove a whole section',
      editDecisionList: [{ type: 'remove_range', sourceStartMs: victim.startMs, sourceEndMs: victim.endMs }],
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id
    await renderWithRealAudio(session.orgId, experimentId)
    const accepted = await call(session, 'POST', `/api/song-lab/experiments/${experimentId}/accept`)
    const versionId = (accepted.json() as { version: { id: string } }).version.id

    const worker = new QueueWorker(runtime.queue, { queueName: QUEUES.songLab, concurrency: 1, logger: silentLogger })
    worker.register<{ analysisId: string; orgId: string }>(JOB_TYPES.songLabAnalyzeAudio, async ({ analysisId, orgId }) => {
      await runtime.songLab.analysis.run(analysisId, orgId)
    })
    for (let round = 0; round < 3; round++) await worker.runOnce()

    const analysis = await runtime.songLab.repos.analyses.latestForVersion(session.orgId, versionId)
    const carried = await runtime.songLab.repos.sections.list(session.orgId, analysis!.id)
    // The removed section is gone, not relocated to a made-up position.
    expect(carried.some((section) => section.label === victim.label && section.humanConfirmed)).toBe(false)
  })

  it('refuses to accept a placeholder preview, so a silent file never becomes a version', async () => {
    const session = await signup('placeholder@example.com', 'Placeholder Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const before = await runtime.songLab.repos.projects.get(session.orgId, projectId)

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'shorter_intro',
      amount: 4,
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id

    // This suite runs with the placeholder renderer, which is exactly the
    // deployment state this guard exists for.
    const rendered = await runtime.songLab.experiments.render(experimentId, session.orgId)
    expect(rendered.placeholderPreview).toBe(true)

    const accepted = await call(session, 'POST', `/api/song-lab/experiments/${experimentId}/accept`)
    expect(accepted.statusCode).toBe(409)
    expect(accepted.json().error.code).toBe('song_lab.placeholder_preview')

    // And the project is exactly where it was.
    const after = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    expect(after.currentVersionId).toBe(before.currentVersionId)
  })

  it('refuses to accept an experiment that has not been rendered', async () => {
    const session = await signup('unrendered@example.com', 'Unrendered Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'shorter_intro',
      amount: 4,
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id
    const accepted = await call(session, 'POST', `/api/song-lab/experiments/${experimentId}/accept`)
    expect(accepted.statusCode).toBe(409)
  })

  it('serves both the original and the experiment for A/B playback', async () => {
    const session = await signup('ab@example.com', 'AB Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'shorter_intro',
      amount: 4,
      render: false,
    })
    const experimentId = (created.json() as { experiment: { id: string } }).experiment.id
    await runtime.songLab.experiments.render(experimentId, session.orgId)

    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/experiments`)
    const body = response.json() as { experiments: Array<{ previewUrl: string | null }>; original: { url: string | null } }
    expect(body.original.url).toBeTruthy()
    expect(body.experiments[0]!.previewUrl).toBeTruthy()
  })
})

describe('lyrics', () => {
  it('performs no lyric analysis when no authorized lyrics exist', async () => {
    const session = await signup('nolyrics@example.com', 'No Lyrics Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/lyrics`)
    expect(response.statusCode).toBe(200)
    const body = response.json() as { lines: unknown[]; analysis: unknown; message?: string }
    expect(body.lines).toHaveLength(0)
    // No analysis at all — not an analysis full of zeroes.
    expect(body.analysis).toBeNull()
    expect(body.message).toContain('No authorized lyrics')
  })

  it('analyses supplied lyrics and counts syllables per section', async () => {
    const session = await signup('lyrics@example.com', 'Lyrics Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const response = await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/lyrics`, {
      source: 'user_supplied',
      text: '[Verse 1]\nStreetlights counting down the block\nEvery window holding still\n\n[Chorus]\nSignal fire, signal fire\nHold the line for me tonight',
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { lines: Array<{ syllableCount: number }>; analysis: { totalSyllables: number } }
    expect(body.lines).toHaveLength(4)
    expect(body.lines.every((line) => line.syllableCount > 0)).toBe(true)
    expect(body.analysis.totalSyllables).toBeGreaterThan(20)
  })

  it('lets a user confirm the title lines, overriding detection', async () => {
    const session = await signup('title@example.com', 'Title Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/lyrics`, {
      source: 'user_supplied',
      text: 'nothing matching here\nanother plain line\na third plain line',
    })
    const marked = await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/title`, { lineIndexes: [1] })
    expect(marked.statusCode).toBe(200)
    const body = marked.json() as { lines: Array<{ lineIndex: number; titlePhrase: boolean; userConfirmed: boolean }>; analysis: { titleRepetition: number } }
    expect(body.lines[1]!.titlePhrase).toBe(true)
    expect(body.lines[1]!.userConfirmed).toBe(true)
    expect(body.analysis.titleRepetition).toBe(1)
  })

  it('handles edited lyrics by replacing the previous set', async () => {
    const session = await signup('editlyrics@example.com', 'Edit Lyrics Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/lyrics`, { source: 'user_supplied', text: 'one\ntwo\nthree' })
    const second = await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/lyrics`, { source: 'user_supplied', text: 'only one line now' })
    expect((second.json() as { lines: unknown[] }).lines).toHaveLength(1)
  })
})

describe('A&R', () => {
  it('drafts an assessment traceable to measured features', async () => {
    const session = await signup('ardraft@example.com', 'AR Draft Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/ar/draft`)
    expect(response.statusCode).toBe(200)
    const review = (response.json() as { review: { status: string; evidence: Array<{ dimension: string; metricKeys: string[] }>; why: string } }).review
    expect(review.status).toBe('draft')
    expect(review.evidence.length).toBeGreaterThan(0)
    // Every rating names the measurements it rests on.
    expect(review.evidence.every((entry) => Array.isArray(entry.metricKeys))).toBe(true)
    expect(review.why).toContain('A person decides')
  })

  it('never drafts itself into a signing or rejection decision', async () => {
    const session = await signup('arsafe@example.com', 'AR Safe Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/ar/draft`)
    const review = (response.json() as { review: { recommendation: string } }).review
    // The two states that would read as the system signing or passing on an
    // artist are never reachable without a person choosing them.
    expect(['release_ready', 'pass_for_now']).not.toContain(review.recommendation)
  })

  it('requires a human to approve, and records who', async () => {
    const session = await signup('arapprove@example.com', 'AR Approve Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const drafted = await call(session, 'POST', `/api/song-lab/projects/${projectId}/ar/draft`)
    const reviewId = (drafted.json() as { review: { id: string } }).review.id

    const approved = await call(session, 'POST', `/api/song-lab/ar-reviews/${reviewId}/approve`)
    expect(approved.statusCode).toBe(200)
    const review = (approved.json() as { review: { status: string; reviewedBy: string; reviewedAt: string } }).review
    expect(review.status).toBe('approved')
    expect(review.reviewedBy).toBe(session.userId)
    expect(review.reviewedAt).toBeTruthy()
  })

  it('refuses an approval with no named person, even from inside the engine', async () => {
    const session = await signup('arnohuman@example.com', 'AR No Human Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const draft = await runtime.songLab.ar.draft({
      actor: { userId: session.userId, orgId: session.orgId, orgRole: 'owner' },
      projectId,
    })
    await expect(runtime.songLab.repos.arReviews.approve(session.orgId, draft.id, '')).rejects.toThrow(/named person/)
  })

  it('lets an operator override a rating and the why panel', async () => {
    const session = await signup('aroverride@example.com', 'AR Override Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const drafted = await call(session, 'POST', `/api/song-lab/projects/${projectId}/ar/draft`)
    const reviewId = (drafted.json() as { review: { id: string } }).review.id

    const response = await call(session, 'PATCH', `/api/song-lab/ar-reviews/${reviewId}`, {
      hookRating: 'strong',
      recommendation: 'request_revision',
      why: 'Operator judgement: the chorus lands, the second verse does not.',
    })
    const review = (response.json() as { review: { hookRating: string; recommendation: string; why: string; reviewedBy: string } }).review
    expect(review.hookRating).toBe('strong')
    expect(review.recommendation).toBe('request_revision')
    expect(review.why).toContain('Operator judgement')
    expect(review.reviewedBy).toBe(session.userId)
  })

  it('rates a dimension with no evidence as not-enough-data rather than middling', async () => {
    const session = await signup('argap@example.com', 'AR Gap Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    // No cohort selected, so nothing cohort-relative can be rated.
    const drafted = await call(session, 'POST', `/api/song-lab/projects/${projectId}/ar/draft`)
    const review = (drafted.json() as { review: { earlyPayoffRating: string; confidence: number } }).review
    expect(review.earlyPayoffRating).toBe('not_enough_data')
    expect(review.confidence).toBeLessThan(1)
  })
})

describe('recommendations', () => {
  it('stores every recommendation unapproved until a person approves it', async () => {
    const session = await signup('rec@example.com', 'Rec Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const cohorts = await runtime.songLab.repos.cohorts.listVisible(session.orgId, true)
    await call(session, 'POST', `/api/song-lab/projects/${projectId}/benchmark`, { cohortId: cohorts[0]!.id })

    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}/recommendations`)
    const recommendations = (response.json() as { recommendations: Array<{ id: string; humanApproved: boolean }> }).recommendations
    expect(recommendations.length).toBeGreaterThan(0)
    expect(recommendations.every((recommendation) => !recommendation.humanApproved)).toBe(true)

    const approved = await call(session, 'POST', `/api/song-lab/recommendations/${recommendations[0]!.id}/approve`)
    expect((approved.json() as { recommendation: { humanApproved: boolean } }).recommendation.humanApproved).toBe(true)
  })

  it('opens a closed-loop record the moment a recommendation is made', async () => {
    const session = await signup('loop@example.com', 'Loop Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const cohorts = await runtime.songLab.repos.cohorts.listVisible(session.orgId, true)
    await call(session, 'POST', `/api/song-lab/projects/${projectId}/benchmark`, { cohortId: cohorts[0]!.id })

    const outcomes = await runtime.songLab.repos.outcomes.listForProject(session.orgId, projectId)
    expect(outcomes.length).toBeGreaterThan(0)
    // Suggested, but neither accepted nor implemented yet — an ignored
    // recommendation is data too.
    expect(outcomes.every((outcome) => !outcome.accepted && !outcome.implemented)).toBe(true)
  })

  it('records acceptance and implementation when an experiment is accepted', async () => {
    const session = await signup('loop2@example.com', 'Loop 2 Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const cohorts = await runtime.songLab.repos.cohorts.listVisible(session.orgId, true)
    await call(session, 'POST', `/api/song-lab/projects/${projectId}/benchmark`, { cohortId: cohorts[0]!.id })

    const recommendations = (
      (await call(session, 'GET', `/api/song-lab/projects/${projectId}/recommendations`)).json() as {
        recommendations: Array<{ id: string; experimentSupported: boolean }>
      }
    ).recommendations
    const renderable = recommendations.find((recommendation) => recommendation.experimentSupported)
    if (!renderable) return // this cohort produced only writing notes

    const created = await call(session, 'POST', `/api/song-lab/projects/${projectId}/experiments`, {
      experimentType: 'custom',
      recommendationId: renderable.id,
      render: false,
    })
    const experiment = (created.json() as { experiment: { id: string } | null }).experiment
    if (!experiment) return
    await renderWithRealAudio(session.orgId, experiment.id)
    await call(session, 'POST', `/api/song-lab/experiments/${experiment.id}/accept`)

    const link = await runtime.songLab.repos.outcomes.findByRecommendation(session.orgId, renderable.id)
    expect(link!.accepted).toBe(true)
    expect(link!.implemented).toBe(true)
    expect(link!.implementedVersionId).toBeTruthy()
  })

  it('phrases an attached outcome as correlation, never causation', async () => {
    const session = await signup('correl@example.com', 'Correlation Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const cohorts = await runtime.songLab.repos.cohorts.listVisible(session.orgId, true)
    await call(session, 'POST', `/api/song-lab/projects/${projectId}/benchmark`, { cohortId: cohorts[0]!.id })

    const outcomes = await runtime.songLab.repos.outcomes.listForProject(session.orgId, projectId)
    const response = await call(session, 'POST', `/api/song-lab/outcomes/${outcomes[0]!.id}`, {
      outcomeWindow: '28d',
      metrics: { completion_rate: 0.62, saves: 1840 },
    })
    expect(response.statusCode).toBe(200)
    const notes = (response.json() as { outcome: { correlationNotes: string } }).outcome.correlationNotes.toLowerCase()
    expect(notes).toContain('correlated with')
    expect(notes).toContain('cannot establish cause')
    expect(notes).not.toContain('caused')
  })
})

describe('integrations', () => {
  it('sends the approved version to Remix Lab as a real remix project', async () => {
    const session = await signup('remix@example.com', 'Remix Org')
    await grantSongLab(session.orgId)
    await runtime.audio.repos.policy.grantEntitlements(session.orgId, ['audio.remix_lab'], 'test')
    const { projectId } = await seedProject(session)

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/send-to-remix-lab`)
    expect(response.statusCode).toBe(200)
    const handoff = (response.json() as { handoff: { target: string; targetRecordId: string; status: string } }).handoff
    expect(handoff.target).toBe('remix_lab')
    expect(handoff.status).toBe('delivered')

    const remix = await runtime.audio.repos.remix.get(session.orgId, handoff.targetRecordId)
    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    expect(remix.sourceAudioAssetId).toBe(project.sourceAssetId)
    // Remix Lab inherits the rights basis rather than asking again.
    expect(remix.rightsConfirmationId).toBe(project.rightsConfirmationId)
  })

  it('refuses to send to Remix Lab without the Remix Lab entitlement', async () => {
    // A partner org, not the flagship: the flagship holds every audio
    // capability by construction, so it is the wrong subject for this test.
    await bootstrapFlagship()
    const session = await provisionOrg('noremix@example.com', 'No Remix Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)
    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/send-to-remix-lab`)
    expect(response.statusCode).toBe(403)
  })

  it('sends section markers to Live Lab', async () => {
    const session = await signup('live@example.com', 'Live Org')
    await grantSongLab(session.orgId)
    await runtime.entitlements.grantAll(session.orgId, FLAGSHIP_CAPABILITIES)
    const { projectId } = await seedProject(session)

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/send-to-live-lab`)
    expect(response.statusCode).toBe(200)
    const handoffs = await runtime.songLab.repos.handoffs.list(session.orgId, projectId)
    const live = handoffs.find((handoff) => handoff.target === 'live_lab')!
    expect((live.payload.liveMarkers as unknown[]).length).toBeGreaterThan(0)
  })

  it('requires the Song Lab review to be complete before Release Command Center', async () => {
    const session = await signup('release@example.com', 'Release Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const early = await call(session, 'POST', `/api/song-lab/projects/${projectId}/send-to-release-command`)
    expect(early.statusCode).toBe(409)

    await call(session, 'POST', `/api/song-lab/projects/${projectId}/review-complete`)
    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/send-to-release-command`)
    expect(response.statusCode).toBe(200)
    const handoff = (response.json() as { handoff: { status: string; payload: { contractVersion: string } } }).handoff
    // The module does not exist yet, so the snapshot waits rather than vanishing.
    expect(handoff.status).toBe('pending')
    expect(handoff.payload.contractVersion).toBeTruthy()
  })

  it('refuses the Operator Desk handoff without the Operator Desk entitlement', async () => {
    // Every handoff gates on its destination module: holding Song Lab is not a
    // licence to write into the CRM. A partner org, since the flagship holds
    // every audio capability by construction.
    await bootstrapFlagship()
    const session = await provisionOrg('noopdesk@example.com', 'No Operator Desk Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const lead = await runtime.audio.repos.operatorDesk.createLead({
      orgId: session.orgId,
      name: 'Example Artist',
      contactName: '',
      email: '',
      phone: '',
      artistName: 'Example Artist',
      stage: 'qualifying',
      source: 'test',
      createdBy: session.userId,
    })

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/attach-operator-desk`, { leadId: lead.id })
    expect(response.statusCode).toBe(403)
    // And nothing was written to the CRM.
    expect(await runtime.audio.repos.operatorDesk.notesForLead(session.orgId, lead.id)).toHaveLength(0)
  })

  it('attaches a project to an Operator Desk lead with a note', async () => {
    const session = await signup('opdesk@example.com', 'Operator Desk Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session, 'Signal Fire')

    const lead = await runtime.audio.repos.operatorDesk.createLead({
      orgId: session.orgId,
      name: 'Example Artist',
      contactName: 'Manager',
      email: 'manager@example.com',
      phone: '',
      artistName: 'Example Artist',
      stage: 'qualifying',
      source: 'test',
      createdBy: session.userId,
    })

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/attach-operator-desk`, { leadId: lead.id })
    expect(response.statusCode).toBe(200)
    const notes = await runtime.audio.repos.operatorDesk.notesForLead(session.orgId, lead.id)
    expect(notes.some((note) => note.sourceId === projectId && note.body.includes('Signal Fire'))).toBe(true)
  })

  it("refuses to attach to another organization's lead", async () => {
    const a = await bootstrapFlagship()
    const b = await provisionOrg('opdeskb@example.com', 'Operator Desk B')
    await grantSongLab(a.orgId)
    await grantSongLab(b.orgId)
    const { projectId } = await seedProject(a)

    const otherLead = await runtime.audio.repos.operatorDesk.createLead({
      orgId: b.orgId,
      name: 'Other artist',
      contactName: '',
      email: '',
      phone: '',
      artistName: 'Other',
      stage: 'qualifying',
      source: 'test',
      createdBy: b.userId,
    })

    const response = await call(a, 'POST', `/api/song-lab/projects/${projectId}/attach-operator-desk`, { leadId: otherLead.id })
    expect(response.statusCode).toBe(404)
  })
})

describe('signed URLs', () => {
  it('serves audio only through an expiring signed URL', async () => {
    const session = await signup('signed@example.com', 'Signed Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session)

    const response = await call(session, 'GET', `/api/song-lab/projects/${projectId}`)
    const url = (response.json() as { audioUrl: string }).audioUrl
    expect(url).toBeTruthy()
    // Signature and expiry both present — never a bare storage path.
    expect(url).toMatch(/(?:[?&]exp=|X-Amz-Expires)/i)
    expect(url).toMatch(/(?:[?&]sig=|X-Amz-Signature)/i)

    // And the expiry is in the future but bounded, not an open-ended grant.
    const expiry = Number(new URL(url, 'http://localhost').searchParams.get('exp'))
    const nowSeconds = Math.floor(Date.now() / 1000)
    expect(expiry).toBeGreaterThan(nowSeconds)
    expect(expiry).toBeLessThanOrEqual(nowSeconds + 2 * 3600)
  })
})

describe('the worker pipeline', () => {
  it('runs analysis and benchmarking through the real queue', async () => {
    const session = await signup('worker@example.com', 'Worker Org')
    await grantSongLab(session.orgId)
    const actor = { userId: session.userId, orgId: session.orgId, orgRole: 'owner' }

    const created = await call(session, 'POST', '/api/song-lab/projects', {
      title: 'Queued Song',
      artistName: 'Example Artist',
      genre: 'alternative',
      rightsConfirmed: true,
    })
    const projectId = (created.json() as { project: { id: string } }).project.id
    await runtime.songLab.projects.attachUpload({ actor, projectId, bytes: demoWav(11), filename: 'queued.wav', rightsConfirmed: true })

    const worker = new QueueWorker(runtime.queue, { queueName: QUEUES.songLab, concurrency: 1, logger: silentLogger })
    worker.register<{ analysisId: string; orgId: string }>(JOB_TYPES.songLabAnalyzeAudio, async ({ analysisId, orgId }) => {
      await runtime.songLab.analysis.run(analysisId, orgId)
    })
    worker.register<{ analysisId: string; orgId: string; cohortId: string }>(JOB_TYPES.songLabCompareBenchmark, async (payload) => {
      await runtime.songLab.benchmark.compare(payload.orgId, payload.analysisId, payload.cohortId)
    })
    for (let round = 0; round < 4; round++) await worker.runOnce()

    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    expect(project.status).toBe('analyzed')
    const analysis = await runtime.songLab.repos.analyses.latestForVersion(session.orgId, project.currentVersionId!)
    expect(analysis?.status).toBe('complete')
    expect(analysis?.featureVector).toBeTruthy()
  })
})

describe('demo mode', () => {
  it('seeds a fictional project with the documented figures and is idempotent', async () => {
    const session = await signup('demo@example.com', 'Demo Org')
    const { seedSongLabDemo } = await import('@masterclip/song-lab-engine')

    const first = await seedSongLabDemo(runtime.songLab, {
      orgId: session.orgId,
      userId: session.userId,
      entitlements: runtime.entitlements,
    })
    expect(first.seeded).toBe(true)

    const project = await runtime.songLab.repos.projects.get(session.orgId, first.projectId!)
    expect(project.title).toBe('Signal Fire')
    expect(project.artistName).toBe('Example Artist')
    expect(project.demo).toBe(true)

    const analysis = await runtime.songLab.repos.analyses.latestForVersion(session.orgId, project.currentVersionId!)
    expect(analysis!.bpm).toBe(92)
    expect(analysis!.durationMs).toBe(227_000)
    const sections = await runtime.songLab.repos.sections.list(session.orgId, analysis!.id)
    const firstChorus = sections.find((section) => section.sectionType === 'chorus')!
    expect(firstChorus.startMs).toBe(56_000)

    const experiments = await runtime.songLab.repos.experiments.list(session.orgId, project.id)
    expect(experiments.length).toBe(3)

    const second = await seedSongLabDemo(runtime.songLab, {
      orgId: session.orgId,
      userId: session.userId,
      entitlements: runtime.entitlements,
    })
    expect(second.seeded).toBe(false)
  })
})

// ===========================================================================

/**
 * Vocal-stem separation.
 *
 * The product claim under test is narrow and worth stating: measuring an
 * isolated vocal is allowed to raise the confidence attached to vocal figures,
 * and *nothing else* is. Every test here is a way of getting that wrong.
 */
describe('vocal stem separation', () => {
  async function seedWithVersion(session: Session): Promise<{ projectId: string; versionId: string }> {
    const { projectId } = await seedProject(session, 'Vocal Stem Song')
    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    return { projectId, versionId: project.currentVersionId! }
  }

  it('measures vocals from the mix until a stem exists, and says so', async () => {
    const session = await bootstrapFlagship()
    const { projectId } = await seedWithVersion(session)
    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    const analysis = await runtime.songLab.repos.analyses.latestForVersion(session.orgId, project.currentVersionId!)

    // The basis is recorded on every analysis, not only the interesting ones —
    // a vocal figure with no stated basis is a figure you cannot interpret.
    expect(analysis!.vocalAnalysis.basis).toBe('full_mix')
  })

  it('separates, stores the stem as a new asset, and never touches the original', async () => {
    const session = await bootstrapFlagship()
    const { projectId, versionId } = await seedWithVersion(session)
    const version = await runtime.songLab.repos.versions.get(session.orgId, versionId)
    const originalAssetId = version.sourceAssetId!
    const original = await runtime.audio.repos.assets.get(session.orgId, originalAssetId)

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    expect(response.statusCode).toBe(200)
    const queued = (response.json() as { vocalStem: { id: string; status: string } }).vocalStem
    expect(queued.status).toBe('pending')

    const settled = await runtime.songLab.vocalStems.run(queued.id, session.orgId)
    expect(settled.status).toBe('ready')
    expect(settled.stemName).toBe('vocals')
    expect(settled.stemAssetId).not.toBeNull()

    // The stem is a *different* asset. The mix is byte-identical to before.
    expect(settled.stemAssetId).not.toBe(originalAssetId)
    const afterwards = await runtime.audio.repos.assets.get(session.orgId, originalAssetId)
    expect(afterwards.checksum).toBe(original.checksum)
    expect(afterwards.storageKey).toBe(original.storageKey)

    // And the version still points at the mix, not at the stem.
    const versionAfter = await runtime.songLab.repos.versions.get(session.orgId, versionId)
    expect(versionAfter.sourceAssetId).toBe(originalAssetId)
  })

  it('requires the stem-separation capability, not just Song Lab', async () => {
    // Separation spends the organization's provider budget. Holding the
    // diagnostic module is not a licence to spend it.
    await bootstrapFlagship()
    const session = await provisionOrg('stems@example.com', 'Stemless Org')
    await grantSongLab(session.orgId)
    const { projectId, versionId } = await seedWithVersion(session)

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    expect(response.statusCode).toBe(403)
    // Specifically the audio capability, not Song Lab's own gate — otherwise
    // this test would pass just as well if the route were broken.
    expect(response.json().error.code).toBe('audio.gate.org_entitlement')

    // And it is genuinely reachable once that capability is granted. Note the
    // grant goes through the *audio* entitlement store: Song Lab's own
    // entitlements are a separate system and do not open this door.
    await runtime.audio.repos.policy.grantEntitlements(session.orgId, ['audio.stem_separation'], session.userId)
    const allowed = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    expect(allowed.statusCode).toBe(200)
  })

  it('refuses to separate a version belonging to another project', async () => {
    const session = await bootstrapFlagship()
    const { projectId } = await seedWithVersion(session)
    const other = await seedWithVersion(session)

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${other.versionId}/vocal-stem`)
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('song_lab.version_mismatch')
  })

  it('does not leak one tenant stem to another', async () => {
    const owner = await bootstrapFlagship()
    const { projectId, versionId } = await seedWithVersion(owner)
    const requested = await call(owner, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    const stemId = (requested.json() as { vocalStem: { id: string } }).vocalStem.id

    const intruder = await provisionOrg('intruder@example.com', 'Intruder Org')
    await grantSongLab(intruder.orgId)
    await expect(runtime.songLab.repos.vocalStems.get(intruder.orgId, stemId)).rejects.toThrow()

    // Nor through the job, which knows an id before it can prove an org.
    await expect(runtime.songLab.vocalStems.run(stemId, intruder.orgId)).rejects.toThrow(/another organization/)
  })

  it('does not pay twice for the same audio', async () => {
    const session = await bootstrapFlagship()
    const { projectId, versionId } = await seedWithVersion(session)
    const url = `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`

    const first = (await call(session, 'POST', url)).json() as { vocalStem: { id: string } }
    const second = (await call(session, 'POST', url)).json() as { vocalStem: { id: string } }
    expect(second.vocalStem.id).toBe(first.vocalStem.id)

    const all = await runtime.songLab.repos.vocalStems.list(session.orgId, projectId)
    expect(all.length).toBe(1)
  })

  it('will not measure a stem that came from different audio', async () => {
    const session = await bootstrapFlagship()
    const { projectId, versionId } = await seedWithVersion(session)
    const requested = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    const stemId = (requested.json() as { vocalStem: { id: string } }).vocalStem.id
    const ready = await runtime.songLab.vocalStems.run(stemId, session.orgId)
    expect(ready.status).toBe('ready')

    // A stem is only a stem *of* the recording it was separated from. Asking
    // with any other checksum must not return it.
    const version = await runtime.songLab.repos.versions.get(session.orgId, versionId)
    const asset = await runtime.audio.repos.assets.get(session.orgId, version.sourceAssetId!)
    expect(await runtime.songLab.repos.vocalStems.readyForVersion(session.orgId, versionId, asset.checksum)).not.toBeNull()
    expect(await runtime.songLab.repos.vocalStems.readyForVersion(session.orgId, versionId, 'a-different-checksum')).toBeNull()
  })

  /**
   * The point of the whole feature.
   *
   * Uses the real DSP provider rather than the deterministic one, because the
   * claim being tested is about measurement: the same song, analysed twice,
   * should move from a mix-based inference to a stem-based measurement, and the
   * confidence attached to its vocal figures should rise *because of that* and
   * not by decree.
   */
  it('raises vocal confidence only once it is measuring a real stem', async () => {
    const session = await bootstrapFlagship()
    // The local provider decodes WAV in-process, so this needs no ffmpeg.
    const { LocalVocalAnalysisProvider } = await import('@masterclip/song-analysis')
    runtime.songLab.providers.vocals = new LocalVocalAnalysisProvider()

    const { projectId, versionId } = await seedWithVersion(session)
    const before = await runtime.songLab.projects.reanalyze({ userId: session.userId, orgId: session.orgId, orgRole: 'owner' }, projectId)
    await runtime.songLab.analysis.run(before, session.orgId)
    const mixAnalysis = await runtime.songLab.repos.analyses.get(session.orgId, before)
    const mixOccupancy = mixAnalysis.vocalAnalysis.occupancy as { confidence: number; note?: string }

    expect(mixAnalysis.vocalAnalysis.basis).toBe('full_mix')
    expect(mixOccupancy.note).toContain('not an isolated vocal')

    const requested = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    const stemId = (requested.json() as { vocalStem: { id: string } }).vocalStem.id
    expect((await runtime.songLab.vocalStems.run(stemId, session.orgId)).status).toBe('ready')

    const after = await runtime.songLab.projects.reanalyze({ userId: session.userId, orgId: session.orgId, orgRole: 'owner' }, projectId)
    await runtime.songLab.analysis.run(after, session.orgId)
    const stemAnalysis = await runtime.songLab.repos.analyses.get(session.orgId, after)
    const stemOccupancy = stemAnalysis.vocalAnalysis.occupancy as { confidence: number; note?: string }

    expect(stemAnalysis.vocalAnalysis.basis).toBe('isolated_stem')
    expect(stemOccupancy.confidence).toBeGreaterThan(mixOccupancy.confidence)
    // The caveat is dropped because it is no longer true, not to look better.
    expect(stemOccupancy.note).toBeUndefined()

    // The earlier analysis is untouched: reanalysis adds a row, it does not
    // rewrite history, so the mix-based figures remain auditable.
    const original = await runtime.songLab.repos.analyses.get(session.orgId, before)
    expect(original.vocalAnalysis.basis).toBe('full_mix')
  })

  /**
   * The defect this suite did not catch for two releases.
   *
   * Every test above proved the stem was produced correctly, and the
   * confidence test proved the measurement improves — but it improved it by
   * calling `reanalyze` by hand. Nothing in the product did that, so an artist
   * paid for a separation, watched the card keep saying Full Mix, and was
   * offered a button reading "try separating the vocal again" for a separation
   * that had already succeeded.
   *
   * Deliberately does *not* call reanalyze. If the chain regresses, the basis
   * stays `full_mix` and this fails.
   */
  it('re-measures on its own once the stem is ready, without being asked', async () => {
    const session = await bootstrapFlagship()
    const { LocalVocalAnalysisProvider } = await import('@masterclip/song-analysis')
    runtime.songLab.providers.vocals = new LocalVocalAnalysisProvider()

    const { projectId, versionId } = await seedWithVersion(session)
    const requested = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    const stemId = (requested.json() as { vocalStem: { id: string } }).vocalStem.id

    const before = await runtime.songLab.repos.analyses.listForProject(session.orgId, projectId)
    const mixAnalysis = before.find((row) => row.status === 'complete')!
    expect(mixAnalysis.vocalAnalysis.basis).toBe('full_mix')

    expect((await runtime.songLab.vocalStems.run(stemId, session.orgId)).status).toBe('ready')

    // Separation queued a fresh analysis rather than leaving the old one to
    // stand. Compared as a set, so this cannot pass on row ordering.
    const after = await runtime.songLab.repos.analyses.listForProject(session.orgId, projectId)
    const seen = new Set(before.map((row) => row.id))
    const added = after.filter((row) => !seen.has(row.id))
    expect(added.length).toBe(1)

    await runtime.songLab.analysis.run(added[0]!.id, session.orgId)
    const remeasured = await runtime.songLab.repos.analyses.get(session.orgId, added[0]!.id)
    expect(remeasured.vocalAnalysis.basis).toBe('isolated_stem')

    // And the mix-based row is still there, unchanged.
    expect((await runtime.songLab.repos.analyses.get(session.orgId, mixAnalysis.id)).vocalAnalysis.basis).toBe('full_mix')
  })

  /**
   * A new master uploaded while separation was running makes the stem a stem of
   * the *previous* recording. Reanalysing the current version would pay for a
   * full analysis to discover the stem does not apply to it.
   */
  it('does not re-measure a version the project has already moved past', async () => {
    const session = await bootstrapFlagship()
    const { projectId, versionId } = await seedWithVersion(session)
    const requested = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    const stemId = (requested.json() as { vocalStem: { id: string } }).vocalStem.id

    // The project moves to a different current version before the job runs.
    const version = await runtime.songLab.repos.versions.get(session.orgId, versionId)
    const supersede = await runtime.songLab.repos.versions.create({
      orgId: session.orgId,
      songLabProjectId: projectId,
      parentVersionId: versionId,
      versionType: 'human_revision',
      versionLabel: 'Master 2',
      sourceAssetId: version.sourceAssetId,
      createdBy: session.userId,
    })
    await runtime.songLab.repos.projects.setSource(session.orgId, projectId, version.sourceAssetId!, supersede.id)

    const analysesBefore = (await runtime.songLab.repos.analyses.listForProject(session.orgId, projectId)).length
    expect((await runtime.songLab.vocalStems.run(stemId, session.orgId)).status).toBe('ready')

    // The stem is kept — returning to that version finds it again — but no
    // analysis was queued for a version it cannot describe.
    expect((await runtime.songLab.repos.analyses.listForProject(session.orgId, projectId)).length).toBe(analysesBefore)
    const asset = await runtime.audio.repos.assets.get(session.orgId, version.sourceAssetId!)
    expect(await runtime.songLab.repos.vocalStems.readyForVersion(session.orgId, versionId, asset.checksum)).not.toBeNull()
  })

  /**
   * The register half of the same claim.
   *
   * Section *boundaries* have to come from the full mix — an instrumental break
   * is a section change and a vocal stem is silent there — but the register of
   * those sections is better measured from the stem. These pin that the two
   * stay on their own signals.
   */
  it('re-measures each section register against the stem, and only then trusts it further', async () => {
    const session = await bootstrapFlagship()
    const { LocalVocalAnalysisProvider } = await import('@masterclip/song-analysis')
    runtime.songLab.providers.vocals = new LocalVocalAnalysisProvider()
    const actor = { userId: session.userId, orgId: session.orgId, orgRole: 'owner' as const }

    const { projectId, versionId } = await seedWithVersion(session)
    const before = await runtime.songLab.projects.reanalyze(actor, projectId)
    await runtime.songLab.analysis.run(before, session.orgId)
    const mixFeatures = await runtime.songLab.repos.sections.features(session.orgId, before)
    const mixBest = Math.max(...[...mixFeatures.values()].map((feature) => feature.register.confidence))

    const requested = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    const stemId = (requested.json() as { vocalStem: { id: string } }).vocalStem.id
    expect((await runtime.songLab.vocalStems.run(stemId, session.orgId)).status).toBe('ready')

    const after = await runtime.songLab.projects.reanalyze(actor, projectId)
    await runtime.songLab.analysis.run(after, session.orgId)
    const stemFeatures = await runtime.songLab.repos.sections.features(session.orgId, after)
    const measured = [...stemFeatures.values()].filter((feature) => feature.register.median !== null)

    expect(measured.length).toBeGreaterThan(0)
    const stemBest = Math.max(...measured.map((feature) => feature.register.confidence))
    expect(stemBest).toBeGreaterThan(mixBest)
    expect(stemBest).toBeGreaterThan(REGISTER_CONFIDENCE_CEILING.fullMix)
    // Never past the ceiling: centroid is still not pitch on a stem.
    expect(stemBest).toBeLessThanOrEqual(REGISTER_CONFIDENCE_CEILING.isolatedStem)

    // The earlier analysis keeps its mix-based bands, so the two remain
    // comparable rather than one quietly overwriting the other.
    const originalFeatures = await runtime.songLab.repos.sections.features(session.orgId, before)
    expect(Math.max(...[...originalFeatures.values()].map((f) => f.register.confidence))).toBe(mixBest)
  })

  /** The overlay itself, without the database in the way. */
  describe('stem register overlay', () => {
    const sections = [
      { sectionType: 'verse' as const, label: 'Verse 1', startMs: 0, endMs: 10_000, confidence: 0.7, orderIndex: 0 },
      { sectionType: 'instrumental' as const, label: 'Instrumental', startMs: 10_000, endMs: 20_000, confidence: 0.7, orderIndex: 1 },
    ]
    const mixFeature = (median: number) => ({
      energy: 0.5,
      vocalOccupancy: 0.8,
      arrangementDensity: 0.5,
      spectralDensity: 0.5,
      transientDensity: 0.5,
      lowFrequencyDensity: 0.4,
      stereoWidth: 0.2,
      rhythmicDensity: 0.5,
      similarityVector: [0.5],
      register: { median, low: median - 0.05, high: median + 0.05, confidence: 0.45 },
      melodicContour: [0.1, 0.2, 0.3, 0.4, 0.3, 0.2, 0.1, 0],
    })
    const structure = {
      sections,
      features: [mixFeature(0.3), mixFeature(0.4)],
      confidence: 0.7,
      provider: 'test',
      modelVersion: '1',
      method: 'test',
    }
    // Voiced across the first section, silent across the second — an
    // instrumental, which is exactly where a separated vocal has nothing.
    const curve = Array.from({ length: 200 }, (_, i) => (i < 100 ? 0.5 + Math.sin(i / 6) * 0.15 : null))
    const vocals = (basis: 'full_mix' | 'isolated_stem', values: Array<number | null> = curve) => ({
      basis,
      occupancy: { value: 0.7, confidence: 0.85, analysisMethod: 'm', provider: 'p', modelVersion: '1' },
      registerCurve: values,
      registerCurveStepSeconds: 0.1,
    })

    it('leaves the mix path exactly as the detector measured it', async () => {
      const { withStemRegisters } = await import('@masterclip/song-lab-engine')
      // Same numbers, not merely equal ones: re-deriving a mix register here
      // would be the same measurement with a fresh chance to disagree.
      expect(withStemRegisters(structure as never, vocals('full_mix') as never)).toBe(structure)
      expect(withStemRegisters(structure as never, vocals('isolated_stem', []) as never)).toBe(structure)
    })

    it('re-measures a voiced section from the stem and raises its confidence', async () => {
      const { withStemRegisters } = await import('@masterclip/song-lab-engine')
      const result = withStemRegisters(structure as never, vocals('isolated_stem') as never)
      const verse = result.features[0]!

      expect(verse.register.median).not.toBe(0.3)
      expect(verse.register.confidence).toBe(REGISTER_CONFIDENCE_CEILING.isolatedStem)
      expect(result.method).toContain('isolated_stem_register')
    })

    it('keeps the mix band for a section the stem has nothing in', async () => {
      const { withStemRegisters } = await import('@masterclip/song-lab-engine')
      const result = withStemRegisters(structure as never, vocals('isolated_stem') as never)

      // Separation can drop a passage the proxy still caught. Losing a band we
      // already had would be a downgrade wearing an upgrade's clothes.
      expect(result.features[1]!.register.median).toBe(0.4)
      expect(result.features[1]!.register.confidence).toBe(0.45)
    })
  })

  it('records unsupported separately from failed when no stem is a vocal', async () => {
    const session = await bootstrapFlagship()
    const { projectId, versionId } = await seedWithVersion(session)
    const requested = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    const stemId = (requested.json() as { vocalStem: { id: string } }).vocalStem.id

    // A provider that returns an archive rather than named stems — which is
    // exactly what the ElevenLabs adapter does today.
    const registry = runtime.audio.registry
    const original = registry.resolve('stems')
    const archiveOnly = {
      providerId: original.providerId,
      isConfigured: () => true,
      supportsZeroRetention: () => false,
      healthCheck: original.healthCheck.bind(original),
      separateStems: async () => ({
        stems: [{ name: 'stems-archive', audio: { bytes: new Uint8Array([1, 2, 3]), contentType: 'application/zip', filename: 'stems.zip' } }],
      }),
    }
    registry.register({ stems: archiveOnly as never })

    const settled = await runtime.songLab.vocalStems.run(stemId, session.orgId)
    expect(settled.status).toBe('unsupported')
    expect(settled.failureReason).toContain('stems-archive')
    expect(settled.stemAssetId).toBeNull()
  })
})

// ===========================================================================

/**
 * Lyric transcription.
 *
 * The words are a machine's guess and the timings are the point. What these
 * tests hold down is that the guess never gets promoted to the artist's own
 * words, and never quietly replaces them.
 */
describe('lyric transcription', () => {
  async function grantTranscription(session: Session): Promise<void> {
    await runtime.audio.repos.policy.grantEntitlements(session.orgId, ['audio.transcription'], session.userId)
  }

  /** Runs the queued audio transcription job and the Song Lab ingest after it. */
  async function runTranscription(session: Session, jobId: string, projectId: string): Promise<void> {
    const transcript = await runtime.audio.transcription.run(jobId)
    const job = await runtime.audio.repos.jobs.getAnyOrg(jobId)
    const config = job.configuration as { songVersionId: string }
    await runtime.songLab.lyricTranscription.ingest({
      transcriptId: transcript.id,
      orgId: session.orgId,
      userId: session.userId,
      projectId,
      versionId: config.songVersionId,
    })
  }

  it('brings back timed lines, which a pasted sheet never has', async () => {
    const session = await bootstrapFlagship()
    const { projectId } = await seedProject(session, 'Transcribe Me')

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`)
    expect(response.statusCode).toBe(200)
    const { jobId, source } = response.json() as { jobId: string; source: string }
    // No stem separated for this version, so it transcribes the mix and says so.
    expect(source).toBe('full_mix')

    await runTranscription(session, jobId, projectId)

    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    const lines = await runtime.songLab.repos.lyrics.list(session.orgId, project.currentVersionId!)
    expect(lines.length).toBeGreaterThan(0)
    // The timings are the whole reason to transcribe rather than paste.
    expect(lines.every((line) => line.startMs !== null && line.endMs !== null)).toBe(true)
    expect(lines[0]!.lyricSource).toBe('transcribed')

    // The payoff: timings place lines inside sections on their own. A pasted
    // sheet leaves every sectionId null unless a person types timecodes, and
    // the per-section density figures have nothing to work with.
    const placed = lines.filter((line) => line.sectionId !== null)
    expect(placed.length).toBeGreaterThan(0)
  })

  it('never promotes a machine transcript to the artist\'s own words', async () => {
    const session = await bootstrapFlagship()
    const { projectId } = await seedProject(session, 'Unconfirmed')
    const { jobId } = (await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`)).json() as { jobId: string }
    await runTranscription(session, jobId, projectId)

    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    const lines = await runtime.songLab.repos.lyrics.list(session.orgId, project.currentVersionId!)
    // Every line is a guess until a person says otherwise.
    expect(lines.some((line) => line.userConfirmed)).toBe(false)
  })

  it('refuses to overwrite a lyric the artist supplied', async () => {
    const session = await bootstrapFlagship()
    const { projectId } = await seedProject(session, 'Handwritten')
    await call(session, 'PATCH', `/api/song-lab/projects/${projectId}/lyrics`, {
      source: 'user_supplied',
      text: 'Signal fire, signal fire\nBurning on the shoreline',
    })

    const refused = await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`)
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.code).toBe('song_lab.lyrics_user_supplied')

    // The artist's words are still there, untouched.
    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    const lines = await runtime.songLab.repos.lyrics.list(session.orgId, project.currentVersionId!)
    expect(lines[0]!.text).toBe('Signal fire, signal fire')

    // And it proceeds once the replacement is an explicit decision.
    const allowed = await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`, { replaceUserSupplied: true })
    expect(allowed.statusCode).toBe(200)
  })

  it('requires the transcription capability, not just Song Lab', async () => {
    await bootstrapFlagship()
    const session = await provisionOrg('notranscribe@example.com', 'No Transcribe Org')
    await grantSongLab(session.orgId)
    const { projectId } = await seedProject(session, 'Ungated')

    const refused = await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.code).toBe('audio.gate.org_entitlement')

    await grantTranscription(session)
    const allowed = await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`)
    expect(allowed.statusCode).toBe(200)
  })

  it('transcribes the isolated vocal when one exists', async () => {
    const session = await bootstrapFlagship()
    const { projectId } = await seedProject(session, 'Stemmed')
    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    const versionId = project.currentVersionId!

    const requested = await call(session, 'POST', `/api/song-lab/projects/${projectId}/versions/${versionId}/vocal-stem`)
    const stemId = (requested.json() as { vocalStem: { id: string } }).vocalStem.id
    const stem = await runtime.songLab.vocalStems.run(stemId, session.orgId)
    expect(stem.status).toBe('ready')

    const response = await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`)
    const { jobId, source } = response.json() as { jobId: string; source: string }
    expect(source).toBe('isolated_stem')

    // And it is genuinely the stem asset being sent, not the mix.
    const job = await runtime.audio.repos.jobs.getAnyOrg(jobId)
    expect((job.configuration as { assetId: string }).assetId).toBe(stem.stemAssetId)
  })

  /**
   * The chain, through the real queue rather than by calling the two halves in
   * order myself. The wiring is the part most likely to be wrong: the audio
   * pipeline produces a transcript knowing nothing about lyrics, and something
   * has to notice it was raised for Song Lab and hand it back.
   */
  it('carries a transcript back to the lyric through the queue', async () => {
    const session = await bootstrapFlagship()
    const { projectId } = await seedProject(session, 'Chained')
    await call(session, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`)

    // The audio worker: transcribe, then chain when the job was raised for
    // Song Lab. This mirrors apps/worker/src/main.ts.
    const audioWorker = new QueueWorker(runtime.queue, { queueName: QUEUES.audio, concurrency: 1, logger: silentLogger })
    audioWorker.register<{ jobId: string }>(JOB_TYPES.audioTranscribe, async ({ jobId }) => {
      const transcript = await runtime.audio.transcription.run(jobId)
      const job = await runtime.audio.repos.jobs.getAnyOrg(jobId)
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

    const songLabWorker = new QueueWorker(runtime.queue, { queueName: QUEUES.songLab, concurrency: 1, logger: silentLogger })
    songLabWorker.register<{ transcriptId: string; orgId: string; userId: string; projectId: string; versionId: string }>(
      JOB_TYPES.songLabTranscribeLyrics,
      async (payload) => {
        await runtime.songLab.lyricTranscription.ingest(payload)
      },
    )

    await audioWorker.runOnce()
    for (let round = 0; round < 3; round++) await songLabWorker.runOnce()

    const project = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    const lines = await runtime.songLab.repos.lyrics.list(session.orgId, project.currentVersionId!)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]!.lyricSource).toBe('transcribed')
  })

  it('does not leak one tenant transcript into another tenant lyric', async () => {
    const owner = await bootstrapFlagship()
    const { projectId } = await seedProject(owner, 'Private Song')
    const { jobId } = (await call(owner, 'POST', `/api/song-lab/projects/${projectId}/lyrics/transcribe`)).json() as { jobId: string }
    const transcript = await runtime.audio.transcription.run(jobId)

    const intruder = await provisionOrg('lyricthief@example.com', 'Intruder Org')
    await grantSongLab(intruder.orgId)
    await expect(
      runtime.songLab.lyricTranscription.ingest({
        transcriptId: transcript.id,
        orgId: intruder.orgId,
        userId: intruder.userId,
        projectId,
        versionId: 'whatever',
      }),
    ).rejects.toThrow()
  })
})

// ===========================================================================

/**
 * Cross-roster recommendation outcomes.
 *
 * This is the only place Song Lab looks like it is making a claim about what
 * works, so it is the place where a sloppy number does the most damage. Both
 * of these tests exist because the first version of this summary got it wrong.
 */
describe('recommendation outcome summary', () => {
  /**
   * Builds `count` outcome links of one recommendation type, all released,
   * carrying one metric each.
   */
  async function seedOutcomes(
    session: Session,
    project: { projectId: string; analysisId: string },
    input: { type: string; implemented: boolean; values: number[] },
  ): Promise<void> {
    const { projectId, analysisId } = project
    const record = await runtime.songLab.repos.projects.get(session.orgId, projectId)
    // Observation and recommendation rows are inserted directly: what is under
    // test is the aggregation, and driving the full observation pipeline would
    // not let the sample sizes be controlled.
    const observationId = `sobs_test_${input.type}_${input.implemented ? 'y' : 'n'}`
    await runtime.db.run(
      `INSERT INTO song_observations
         (id, org_id, song_lab_project_id, song_version_id, song_analysis_id, benchmark_cohort_id,
          observation_type, category, title, description, severity, confidence,
          source_metric_keys, benchmark_result_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'structure', 'structure', 'fixture', 'fixture', 'Worth Testing', 0.5, '[]', '[]', 'open', ?, ?)`,
      [observationId, session.orgId, projectId, record.currentVersionId, analysisId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    )
    for (const [index, value] of input.values.entries()) {
      const recommendationId = `srec_test_${input.type}_${input.implemented ? 'y' : 'n'}_${index}`
      await runtime.db.run(
        `INSERT INTO song_recommendations
           (id, org_id, song_observation_id, recommendation_type, title, description,
            experiment_supported, confidence, human_approved, approved_by, approved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0.5, 1, ?, ?, ?)`,
        [recommendationId, session.orgId, observationId, input.type, 'fixture', 'fixture', session.userId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
      )
      const link = await runtime.songLab.repos.outcomes.record({
        orgId: session.orgId,
        songLabProjectId: projectId,
        recommendationId,
        observationId: null,
        suggestedAt: '2026-01-01T00:00:00Z',
      })
      await runtime.songLab.repos.outcomes.markAccepted(session.orgId, link.id)
      if (input.implemented) await runtime.songLab.repos.outcomes.markImplemented(session.orgId, link.id, 'sv_fixture')
      await runtime.songLab.repos.outcomes.markReleased(session.orgId, link.id, `rel_${recommendationId}`, '2026-02-01T00:00:00Z')
      await runtime.songLab.outcomes.attachOutcome({
        actor: { userId: session.userId, orgId: session.orgId, orgRole: 'owner' },
        outcomeId: link.id,
        outcomeWindow: '28d',
        metrics: { streams: value },
      })
    }
  }

  it('refuses to report a median over a handful of releases', async () => {
    const session = await bootstrapFlagship()
    const project = await seedProject(session, 'Outcome Sample')
    // Three releases. A median of three is a number, not a finding.
    await seedOutcomes(session, project, { type: 'chorus_earlier', implemented: true, values: [1000, 50_000, 90_000] })

    const response = await call(session, 'GET', '/api/song-lab/analytics/recommendations')
    expect(response.statusCode).toBe(200)
    const summary = (response.json() as { summary: Array<Record<string, any>> }).summary
    const entry = summary.find((row) => row.recommendationType === 'chorus_earlier')!

    expect(entry.implementedOutcome.sampleSize).toBe(3)
    // The value is withheld, and the reason is stated rather than implied.
    expect(entry.implementedOutcome.metrics.streams.value).toBeNull()
    expect(entry.implementedOutcome.metrics.streams.note).toContain('below the 8')
  })

  it('reports the median once the sample clears the floor', async () => {
    const session = await bootstrapFlagship()
    const project = await seedProject(session, 'Outcome Enough')
    await seedOutcomes(session, project, { type: 'chorus_earlier', implemented: true, values: [10, 20, 30, 40, 50, 60, 70, 80, 90] })

    const summary = ((await call(session, 'GET', '/api/song-lab/analytics/recommendations')).json() as { summary: Array<Record<string, any>> }).summary
    const entry = summary.find((row) => row.recommendationType === 'chorus_earlier')!

    expect(entry.implementedOutcome.sampleSize).toBe(9)
    expect(entry.implementedOutcome.metrics.streams.value).toBe(50)
    // Confidence stays well short of certainty however large the sample gets:
    // this is observational data about groups that selected themselves.
    expect(entry.implementedOutcome.metrics.streams.confidence).toBeLessThanOrEqual(0.6)
    expect(entry.implementedOutcome.metrics.streams.note).toContain('association only')
  })

  it('does not pool implemented releases with releases that ignored the note', async () => {
    const session = await bootstrapFlagship()
    const project = await seedProject(session, 'Outcome Split')
    // Two clearly separated populations. Pooling them would produce a median
    // near 500 that describes neither group.
    await seedOutcomes(session, project, { type: 'chorus_earlier', implemented: true, values: [900, 910, 920, 930, 940, 950, 960, 970] })
    await seedOutcomes(session, project, { type: 'chorus_earlier', implemented: false, values: [10, 20, 30, 40, 50, 60, 70, 80] })

    const summary = ((await call(session, 'GET', '/api/song-lab/analytics/recommendations')).json() as { summary: Array<Record<string, any>> }).summary
    const entry = summary.find((row) => row.recommendationType === 'chorus_earlier')!

    expect(entry.released).toBe(16)
    expect(entry.implemented).toBe(8)
    expect(entry.implementedOutcome.metrics.streams.value).toBe(935)
    expect(entry.notImplementedOutcome.metrics.streams.value).toBe(45)
  })

  it('still refuses the word "caused" anywhere in the response', async () => {
    const session = await bootstrapFlagship()
    const project = await seedProject(session, 'Outcome Language')
    await seedOutcomes(session, project, { type: 'chorus_earlier', implemented: true, values: [10, 20, 30, 40, 50, 60, 70, 80] })

    const body = JSON.stringify((await call(session, 'GET', '/api/song-lab/analytics/recommendations')).json()).toLowerCase()
    expect(body).toContain('association only')
    // "cannot establish that the change caused the outcome" is the one allowed
    // use, and it is a denial. Nothing may assert causation.
    expect(body).not.toMatch(/caused (a|an|the) (lift|increase|improvement)/)
    expect(body).not.toContain('because of this recommendation')
  })
})
