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
