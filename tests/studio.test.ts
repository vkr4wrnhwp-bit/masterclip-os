import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { FLAGSHIP_STUDIO_CAPABILITIES, PARTNER_STUDIO_CAPABILITIES } from '@masterclip/studio-domain'
import { outcomeForAnalysis, outcomeForRendition, seedStudioDemo, STUDIO_DEMO_TITLE, type Actor } from '@masterclip/studio-engine'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'

/**
 * Street Banker Studio HTTP and engine tests.
 *
 * Everything runs through the real Fastify instance against the real schema,
 * real local storage, the real queue and the real analysis engine. The
 * properties tested are the release blockers — the guarantees that, if they
 * broke, would make the product dishonest rather than merely buggy:
 *
 *   - tenant isolation, and the entitlement + collaborator gates
 *   - rights confirmation before any byte is stored
 *   - versions are additive; nothing is ever overwritten
 *   - an approval names the exact bytes it approved
 *   - a master A/B is loudness-matched, or says it is not
 *   - delivery refuses on a failing check and on a missing approval
 *   - the Identity Vault and AI-permission gates deny by default
 *   - agent licensing stops at a human
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
  email: string
}

async function boot(): Promise<void> {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'studio-test-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'studio-test-secret',
      SESSION_SECRET: 'studio-test-session-secret',
      // The future-facing surfaces default off; the tests that exercise them
      // turn them on explicitly, which is also the check that they are off.
      STUDIO_MARKETPLACE_ENABLED: 'false',
      STUDIO_OPPORTUNITY_ENGINE_ENABLED: 'false',
      // 64KB parts, the configured floor. A 700KB test file then genuinely
      // arrives in eleven parts, so the resume and completeness paths are
      // exercised rather than collapsed into a single-part upload.
      STUDIO_UPLOAD_PART_SIZE: '65536',
    },
    true,
  )
  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'studio-test-secret' }),
  })
  app = await buildServer({ runtime, logger: silentLogger })
  await app.ready()
}

beforeEach(boot)
afterEach(async () => {
  await app?.close()
  await rm(storageRoot, { recursive: true, force: true })
})

const PASSWORD = 'a-sufficiently-long-password'

async function signup(email: string, orgName: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: PASSWORD, displayName: 'Tester', orgName } })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { user: { id: string; orgId: string } }
  return {
    session: response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '',
    csrf: response.cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value ?? '',
    orgId: body.user.orgId,
    userId: body.user.id,
    email,
  }
}

/** A second organization, provisioned the way a partner really would be. */
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
    email,
  }
}

function headers(session: Session): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${session.session}; ${CSRF_COOKIE}=${session.csrf}`, [CSRF_HEADER]: session.csrf }
}

async function call(session: Session, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: headers(session), ...(payload === undefined ? {} : { payload }) })
}

function actorOf(session: Session, role = 'owner'): Actor {
  return { userId: session.userId, orgId: session.orgId, orgRole: role, email: session.email, displayName: 'Tester' }
}

async function grantStudio(orgId: string, capabilities: readonly string[] = FLAGSHIP_STUDIO_CAPABILITIES): Promise<void> {
  await runtime.entitlements.grantAll(orgId, capabilities)
}

const RATE = 44100

/** A deterministic stereo WAV. Real audio, so the analyzers have something to read. */
function stereoWav(opts: { seconds?: number; hz?: number; amplitude?: number; inverted?: boolean; mono?: boolean } = {}): Uint8Array {
  const seconds = opts.seconds ?? 6
  const hz = opts.hz ?? 220
  const amplitude = opts.amplitude ?? 0.3
  const channels = opts.mono ? 1 : 2
  const frames = Math.round(seconds * RATE)
  const dataBytes = frames * channels * 2
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
  view.setUint16(22, channels, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < frames; i++) {
    // A second partial keeps the spectrum from being a single bin, so the
    // spectral analyzers have a balance to describe.
    const value = (Math.sin((2 * Math.PI * hz * i) / RATE) * 0.7 + Math.sin((2 * Math.PI * hz * 5 * i) / RATE) * 0.3) * amplitude
    if (channels === 1) {
      view.setInt16(44 + i * 2, Math.round(value * 32767), true)
    } else {
      view.setInt16(44 + i * 4, Math.round(value * 32767), true)
      view.setInt16(46 + i * 4, Math.round((opts.inverted ? -value : value) * 32767), true)
    }
  }
  return new Uint8Array(buffer)
}

/** A project with one analysed version, created through the real services. */
async function seedProject(session: Session, title = 'Test Record'): Promise<{ projectId: string; versionId: string; analysisId: string }> {
  const created = await call(session, 'POST', '/api/studio/projects', { title, artistName: 'Example Artist', genre: 'alternative', rightsConfirmed: true })
  expect(created.statusCode).toBe(200)
  const projectId = (created.json() as { project: { id: string } }).project.id

  const attached = await runtime.studio.projects.attachUpload({
    actor: actorOf(session),
    projectId,
    bytes: stereoWav(),
    filename: 'mix-01.wav',
    versionType: 'mix',
    rightsConfirmed: true,
  })
  expect(attached.analysisId).not.toBeNull()
  await runtime.studio.mix.runAnalysis(attached.analysisId as string, session.orgId)
  return { projectId, versionId: attached.version.id, analysisId: attached.analysisId as string }
}

// ---------------------------------------------------------------------------

describe('access', () => {
  it('refuses Studio entirely to an organization that has not been granted it', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    const response = await call(owner, 'GET', '/api/studio/projects')
    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toMatch(/not entitled/i)
  })

  it('never lets one organization see another organization’s record', async () => {
    const flagship = await signup('flagship@example.com', 'Flagship')
    await grantStudio(flagship.orgId)
    const { projectId } = await seedProject(flagship, 'Private Record')

    const partner = await provisionOrg('partner@example.com', 'Partner')
    await grantStudio(partner.orgId, PARTNER_STUDIO_CAPABILITIES)

    // Not in their list…
    const list = await call(partner, 'GET', '/api/studio/projects')
    expect(list.statusCode).toBe(200)
    expect(list.json().projects).toHaveLength(0)

    // …and not reachable by id either, which is the query shape that leaks.
    for (const url of [`/api/studio/projects/${projectId}`, `/api/studio/projects/${projectId}/mix`, `/api/studio/projects/${projectId}/versions`]) {
      const direct = await call(partner, 'GET', url)
      expect(direct.statusCode, url).toBe(404)
    }
  })

  it('gates each capability separately', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    // Studio access, but no Master Station.
    await grantStudio(owner.orgId, ['studio.access', 'studio.session', 'studio.mix', 'studio.mix_doctor'])
    const { projectId } = await seedProject(owner)

    expect((await call(owner, 'GET', `/api/studio/projects/${projectId}/mix`)).statusCode).toBe(200)
    const master = await call(owner, 'GET', `/api/studio/projects/${projectId}/master`)
    expect(master.statusCode).toBe(403)
    expect(master.json().error.message).toMatch(/studio\.master/)
  })

  it('keeps the future-facing surfaces dark until a deployment turns them on', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)
    for (const url of [`/api/studio/projects/${projectId}/services`, `/api/studio/projects/${projectId}/opportunities`]) {
      const response = await call(owner, 'GET', url)
      expect(response.statusCode, url).toBe(403)
      expect(response.json().error.message, url).toMatch(/disabled on this deployment/)
    }
  })

  it('refuses a collaborator the permission their role does not carry', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    // A manager: view and comment, never approve.
    const manager = await runtime.auth.createUser({ orgId: owner.orgId, email: 'manager@example.com', password: PASSWORD, displayName: 'Manager', orgRole: 'member' })
    await call(owner, 'POST', `/api/studio/projects/${projectId}/collaborators`, { email: 'manager@example.com', displayName: 'Manager', role: 'manager' })

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'manager@example.com', password: PASSWORD } })
    const managerSession: Session = {
      session: login.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '',
      csrf: login.cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value ?? '',
      orgId: owner.orgId,
      userId: manager.id,
      email: 'manager@example.com',
    }

    expect((await call(managerSession, 'GET', `/api/studio/projects/${projectId}`)).statusCode).toBe(200)
    const approval = await call(managerSession, 'POST', `/api/studio/projects/${projectId}/approve`, { versionId, approvalType: 'mix' })
    expect(approval.statusCode).toBe(403)
    expect(approval.json().error.message).toMatch(/does not include approve/)
  })
})

describe('rights', () => {
  it('refuses to create a project without a rights confirmation', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const response = await call(owner, 'POST', '/api/studio/projects', {
      title: 'Unconfirmed',
      artistName: 'Example Artist',
      genre: 'alternative',
      rightsConfirmed: false,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('studio.rights_not_confirmed')
  })

  it('writes a real consent record that every later step points back to', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)
    const project = await runtime.studio.repos.projects.get(owner.orgId, projectId)
    const consent = await runtime.audio.repos.consents.get(owner.orgId, project.rightsConfirmationId)
    expect(consent.accepted).toBe(true)
    expect(consent.acceptedBy).toBe(owner.userId)
    // The statement itself is hashed, so later wording changes cannot be
    // mistaken for what the user actually agreed to.
    expect(consent.evidence.statementHash).toBeTruthy()
  })
})

describe('versions', () => {
  it('never replaces a version: a new mix supersedes, and the old audio stays', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    const second = await runtime.studio.projects.attachUpload({
      actor: actorOf(owner),
      projectId,
      bytes: stereoWav({ hz: 330 }),
      filename: 'mix-02.wav',
      versionType: 'mix',
      rightsConfirmed: true,
    })

    const versions = await runtime.studio.repos.versions.list(owner.orgId, projectId)
    expect(versions).toHaveLength(2)
    const first = versions.find((version) => version.id === versionId)!
    expect(first.assetId).not.toBeNull()
    expect(first.supersededAt).not.toBeNull()

    // The old asset is still readable — "superseded" means a newer one exists,
    // not that this one went anywhere.
    const asset = await runtime.audio.repos.assets.get(owner.orgId, first.assetId as string)
    const bytes = await runtime.storage.getBuffer(asset.storageKey)
    expect(bytes.length).toBeGreaterThan(1000)
    expect(second.version.parentVersionId).toBe(versionId)
  })

  it('refuses to delete a version that carries audio', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { versionId } = await seedProject(owner)
    await expect(runtime.studio.repos.versions.deletePlaceholder(owner.orgId, versionId)).rejects.toThrow(/never deleted/)
  })

  it('describes what changed between two versions, and refuses when it cannot', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    const second = await runtime.studio.projects.attachUpload({
      actor: actorOf(owner),
      projectId,
      // Markedly brighter and louder, so there is something real to describe.
      bytes: stereoWav({ hz: 1200, amplitude: 0.5 }),
      filename: 'mix-02.wav',
      versionType: 'mix',
      rightsConfirmed: true,
    })

    // Before the second version is analysed, the engine says so rather than
    // presenting one side's numbers as a set of changes.
    const early = await call(owner, 'GET', `/api/studio/projects/${projectId}/versions/compare?a=${versionId}&b=${second.version.id}`)
    expect(early.json().comparable).toBe(false)
    expect(early.json().incomparableReason).toMatch(/not been analysed/)
    expect(early.json().differences).toEqual([])

    await runtime.studio.mix.runAnalysis(second.analysisId as string, owner.orgId)
    const compared = await call(owner, 'GET', `/api/studio/projects/${projectId}/versions/compare?a=${versionId}&b=${second.version.id}`)
    expect(compared.json().comparable).toBe(true)
    const statements = compared.json().differences.map((difference: { statement: string }) => difference.statement)
    expect(statements.length).toBeGreaterThan(0)
    // Every statement is hedged: this compares measurements of two mixes, not
    // a record of which fader moved.
    for (const statement of statements) expect(statement).toMatch(/approximately|widened|narrowed|brighter|darker|more|less|increased|reduced|rose|fell/)
  })
})

describe('mix station', () => {
  it('stores every metric with its provenance and never fabricates one', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, analysisId } = await seedProject(owner)

    const metrics = await runtime.studio.repos.analyses.metrics(owner.orgId, analysisId)
    expect(metrics.length).toBeGreaterThan(20)
    for (const metric of metrics) {
      expect(metric.provider).toBeTruthy()
      expect(metric.analysisMethod).toBeTruthy()
      if (metric.value === null) expect(metric.confidence).toBe(0)
    }

    const report = await call(owner, 'GET', `/api/studio/projects/${projectId}/mix`)
    expect(report.statusCode).toBe(200)
    expect(report.json().readiness.caveat).toMatch(/not a judgement of the record/)
  })

  it('reports a mono file as having no stereo field rather than a bad one', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const created = await call(owner, 'POST', '/api/studio/projects', { title: 'Mono', artistName: 'A', genre: 'x', rightsConfirmed: true })
    const projectId = created.json().project.id
    const attached = await runtime.studio.projects.attachUpload({
      actor: actorOf(owner),
      projectId,
      bytes: stereoWav({ mono: true }),
      filename: 'mono.wav',
      versionType: 'mix',
      rightsConfirmed: true,
    })
    await runtime.studio.mix.runAnalysis(attached.analysisId as string, owner.orgId)

    const metrics = await runtime.studio.repos.analyses.metrics(owner.orgId, attached.analysisId as string)
    const width = metrics.find((metric) => metric.metricKey === 'stereo_width')
    expect(width?.value).toBeNull()
    expect(width?.note).toMatch(/mono/i)

    const report = await call(owner, 'GET', `/api/studio/projects/${projectId}/mix`)
    const stereo = report.json().readiness.bands.find((band: { band: string }) => band.band === 'stereo_field')
    expect(stereo.score).toBeNull()
  })

  it('turns a finding into a note that stays labelled as machine-drafted', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const created = await call(owner, 'POST', '/api/studio/projects', { title: 'Phase', artistName: 'A', genre: 'x', rightsConfirmed: true })
    const projectId = created.json().project.id
    const attached = await runtime.studio.projects.attachUpload({
      actor: actorOf(owner),
      projectId,
      bytes: stereoWav({ inverted: true, seconds: 10 }),
      filename: 'inverted.wav',
      versionType: 'mix',
      rightsConfirmed: true,
    })
    await runtime.studio.mix.runAnalysis(attached.analysisId as string, owner.orgId)

    const issues = await runtime.studio.repos.issues.list(owner.orgId, attached.analysisId as string)
    const phase = issues.find((issue) => issue.issueType === 'phase_concern')
    expect(phase, 'an out-of-phase file should raise a phase concern').toBeDefined()

    const acted = await call(owner, 'POST', `/api/studio/projects/${projectId}/issues/${phase!.id}`, { action: 'send_to_engineer' })
    expect(acted.statusCode).toBe(200)
    expect(acted.json().issue.status).toBe('sent_to_engineer')

    const notes = await runtime.studio.repos.notes.list(owner.orgId, projectId)
    const drafted = notes.find((note) => note.sourceIssueId === phase!.id)
    expect(drafted?.origin).toBe('mix_doctor')
  })

  it('refuses a reference without a rights confirmation', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)
    await expect(
      runtime.studio.mix.addReference({
        actor: actorOf(owner),
        projectId,
        bytes: stereoWav(),
        filename: 'reference.wav',
        label: 'Ref',
        artistName: 'Someone',
        title: 'Something',
        rightsBasis: 'authorized_private_reference',
        rightsConfirmed: false,
      }),
    ).rejects.toThrow(/entitled to use this recording/)
  })

  it('discards the audio of a private reference once it has been measured', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    const added = await runtime.studio.mix.addReference({
      actor: actorOf(owner),
      projectId,
      bytes: stereoWav({ hz: 900 }),
      filename: 'reference.wav',
      label: 'Ref',
      artistName: 'Someone',
      title: 'Something',
      rightsBasis: 'authorized_private_reference',
      rightsConfirmed: true,
    })
    expect(added.reference.derivedOnly).toBe(true)

    await runtime.studio.mix.runReferenceAnalysis(added.analysisId, added.reference.id, owner.orgId)

    const reference = await runtime.studio.repos.references.get(owner.orgId, added.reference.id)
    expect(reference.audioDiscardedAt).not.toBeNull()
    expect(reference.assetId).toBeNull()
    // The measurements survive the audio, which is the whole design.
    const metrics = await runtime.studio.repos.analyses.metrics(owner.orgId, added.analysisId)
    expect(metrics.length).toBeGreaterThan(20)
  })
})

describe('master station', () => {
  it('refuses to master a version it has not measured', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const created = await call(owner, 'POST', '/api/studio/projects', { title: 'Unmeasured', artistName: 'A', genre: 'x', rightsConfirmed: true })
    const projectId = created.json().project.id
    const attached = await runtime.studio.projects.attachUpload({
      actor: actorOf(owner),
      projectId,
      bytes: stereoWav(),
      filename: 'mix.wav',
      versionType: 'mix',
      rightsConfirmed: true,
      skipAnalysis: true,
    })

    const response = await call(owner, 'POST', `/api/studio/projects/${projectId}/master`, { versionId: attached.version.id, direction: 'competitive' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('studio.not_analyzed')
  })

  it('produces a readable plan and leaves the source untouched', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)
    const sourceVersion = await runtime.studio.repos.versions.get(owner.orgId, versionId)

    const response = await call(owner, 'POST', `/api/studio/projects/${projectId}/master`, { versionId, direction: 'competitive' })
    expect(response.statusCode).toBe(200)
    const plan = response.json().plan
    expect(plan.stages.at(-1).stage).toBe('limiter')
    for (const stage of plan.stages) expect(stage.description.length).toBeGreaterThan(10)

    await runtime.studio.master.renderRendition(response.json().rendition.id, owner.orgId, owner.userId)

    // The source version is byte-for-byte what it was.
    const after = await runtime.studio.repos.versions.get(owner.orgId, versionId)
    expect(after.assetId).toBe(sourceVersion.assetId)
    expect(after.assetChecksum).toBe(sourceVersion.assetChecksum)
  })

  it('marks an A/B unmatched rather than presenting an unmatched comparison as fair', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    const requested = await call(owner, 'POST', `/api/studio/projects/${projectId}/master`, { versionId, direction: 'transparent' })
    const renditionId = requested.json().rendition.id
    await runtime.studio.master.renderRendition(renditionId, owner.orgId, owner.userId)

    // No output analysis has run, so no match gain exists yet.
    const before = await call(owner, 'GET', `/api/studio/projects/${projectId}/master?versionId=${versionId}`)
    const entry = before.json().comparison.renditions.find((candidate: { rendition: { id: string } }) => candidate.rendition.id === renditionId)
    expect(entry.matchGainDb).toBeNull()
    expect(entry.loudnessMatched).toBe(false)
    expect(before.json().comparison.note).toMatch(/level-matched/)

    // Once it has, the gain is a number the client applies.
    const rendition = await runtime.studio.repos.renditions.get(owner.orgId, renditionId)
    await runtime.studio.mix.runAnalysis(rendition.outputAnalysisId as string, owner.orgId)
    await runtime.studio.master.settleRenditionAnalysis(rendition.outputAnalysisId as string, renditionId, owner.orgId)

    const after = await call(owner, 'GET', `/api/studio/projects/${projectId}/master?versionId=${versionId}`)
    const settled = after.json().comparison.renditions.find((candidate: { rendition: { id: string } }) => candidate.rendition.id === renditionId)
    expect(settled.matchGainDb).not.toBeNull()
    expect(settled.loudnessMatched).toBe(true)
  })
})

describe('approvals', () => {
  it('pins the checksum, so a later upload cannot inherit a sign-off', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    const approved = await call(owner, 'POST', `/api/studio/projects/${projectId}/approve`, { versionId, approvalType: 'mix' })
    expect(approved.statusCode).toBe(200)
    const version = await runtime.studio.repos.versions.get(owner.orgId, versionId)
    expect(approved.json().approval.versionChecksum).toBe(version.assetChecksum)

    // A newer draft does not touch the approval; it makes the session's current
    // version differ from the approved one, and the state says so.
    const second = await runtime.studio.projects.attachUpload({
      actor: actorOf(owner),
      projectId,
      bytes: stereoWav({ hz: 500 }),
      filename: 'mix-02.wav',
      versionType: 'mix',
      rightsConfirmed: true,
    })
    const state = await runtime.studio.collaboration.approvalState(actorOf(owner), projectId)
    expect(state.state.mix.approval?.studioVersionId).toBe(versionId)
    expect(state.state.mix.supersededByDraft).toBe(true)
    expect(second.version.approved).toBe(false)
  })

  it('refuses to approve a version that carries no audio', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)
    const empty = await runtime.studio.repos.versions.create({
      orgId: owner.orgId,
      studioProjectId: projectId,
      versionType: 'stems',
      sourceKind: 'external',
      createdBy: owner.userId,
    })
    const response = await call(owner, 'POST', `/api/studio/projects/${projectId}/approve`, { versionId: empty.id, approvalType: 'mix' })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('studio.approval_needs_audio')
  })

  it('learns Sonic DNA only from an approved master, and can be erased', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)
    const artistKey = 'example artist'

    // Rendering and comparing teaches it nothing.
    const requested = await call(owner, 'POST', `/api/studio/projects/${projectId}/master`, { versionId, direction: 'transparent' })
    await runtime.studio.master.renderRendition(requested.json().rendition.id, owner.orgId, owner.userId)
    expect(await runtime.studio.repos.sonicDna.list(owner.orgId, artistKey)).toHaveLength(0)

    // Approving a master does.
    await call(owner, 'POST', `/api/studio/projects/${projectId}/approve`, { versionId, approvalType: 'master' })
    const learned = await runtime.studio.repos.sonicDna.list(owner.orgId, artistKey)
    expect(learned.length).toBeGreaterThan(0)
    for (const entry of learned) {
      expect(entry.source).toBe('derived')
      // One approval is a data point, not a preference.
      expect(entry.status).toBe('proposed')
      expect(entry.derivedFrom).toContain(versionId)
    }

    // Reset is a real delete, because the product promises one.
    const reset = await call(owner, 'POST', `/api/studio/projects/${projectId}/sonic-dna/reset`)
    expect(reset.statusCode).toBe(200)
    expect(await runtime.studio.repos.sonicDna.list(owner.orgId, artistKey)).toHaveLength(0)
  })
})

describe('delivery', () => {
  it('fails the checks nobody has answered, and refuses to send', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    const created = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables`, { versionId, assetKind: 'dsp_master' })
    expect(created.statusCode).toBe(200)
    const deliverableId = created.json().deliverable.id

    const checks = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables/${deliverableId}/check`)
    const failing = checks.json().checks.filter((check: { outcome: string }) => check.outcome === 'fail').map((check: { checkKey: string }) => check.checkKey)
    // Explicit status is the one nobody can answer for the artist.
    expect(failing).toContain('explicit_status')
    expect(failing).toContain('metadata_isrc')

    const send = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables/${deliverableId}/send`, { releaseId: 'rel_1' })
    expect(send.statusCode).toBe(400)
    expect(send.json().error.code).toBe('studio.delivery_checks_failed')
  })

  it('still refuses to send once the checks pass but nobody has approved delivery', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    await call(owner, 'PUT', `/api/studio/projects/${projectId}/release-metadata`, {
      isrc: 'USABC2600001',
      primaryArtist: 'Example Artist',
      explicit: 'not_explicit',
      artworkAssetId: 'art_placeholder',
      copyrightLine: '℗ 2026 Example',
      splits: [{ name: 'Example Artist', role: 'Writer', percentage: 100 }],
    })

    const created = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables`, { versionId, assetKind: 'dsp_master' })
    const deliverableId = created.json().deliverable.id
    const checks = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables/${deliverableId}/check`)
    expect(checks.json().failed).toBe(0)

    const blocked = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables/${deliverableId}/send`, { releaseId: 'rel_1' })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().error.code).toBe('studio.delivery_not_approved')

    // With a delivery approval, it goes — and the project follows it.
    await call(owner, 'POST', `/api/studio/projects/${projectId}/approve`, { versionId, approvalType: 'delivery' })
    const sent = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables/${deliverableId}/send`, { releaseId: 'rel_1' })
    expect(sent.statusCode).toBe(200)
    expect(sent.json().deliverable.sentReleaseId).toBe('rel_1')
    const project = await runtime.studio.repos.projects.get(owner.orgId, projectId)
    expect(project.releaseId).toBe('rel_1')
    expect(project.stage).toBe('release')
  })

  it('fails a split sheet that does not total 100%', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)
    await call(owner, 'PUT', `/api/studio/projects/${projectId}/release-metadata`, {
      splits: [
        { name: 'A', role: 'Writer', percentage: 60 },
        { name: 'B', role: 'Writer', percentage: 37 },
      ],
    })
    const created = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables`, { versionId, assetKind: 'dsp_master' })
    const checks = await call(owner, 'POST', `/api/studio/projects/${projectId}/deliverables/${created.json().deliverable.id}/check`)
    const splits = checks.json().checks.find((check: { checkKey: string }) => check.checkKey === 'splits')
    expect(splits.outcome).toBe('fail')
    expect(splits.measured).toBe('97.00%')
  })
})

describe('rights vault and licensing', () => {
  it('refuses every identity use nobody has permitted', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const decision = await runtime.studio.rights.checkIdentity(actorOf(owner), 'an-artist-with-no-entry', 'voice')
    expect(decision.control).toBe('prohibited')
    expect(decision.reason).toMatch(/no entry exists/)
  })

  it('refuses to record a permitted identity use without a verified consent record', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    await expect(
      runtime.studio.rights.setIdentity({ actor: actorOf(owner), artistKey: 'example artist', subject: 'voice', control: 'permitted' }),
    ).rejects.toThrow(/verified consent record/)
  })

  it('treats an absent AI permission as a refusal, and an explicit no as overriding', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    const absent = await runtime.studio.rights.checkAiPermission(actorOf(owner), projectId, 'master', 'training_use')
    expect(absent.allowed).toBe(false)

    // Granting a narrow permission does not open the others…
    await runtime.studio.rights.setAiPermission({ actor: actorOf(owner), projectId, assetScope: 'all', permission: 'analysis_only', granted: true })
    expect((await runtime.studio.rights.checkAiPermission(actorOf(owner), projectId, 'master', 'training_use')).allowed).toBe(false)
    expect((await runtime.studio.rights.checkAiPermission(actorOf(owner), projectId, 'master', 'analysis_only')).allowed).toBe(true)

    // …and an explicit "no AI use" overrides a grant that already exists.
    await runtime.studio.rights.setAiPermission({ actor: actorOf(owner), projectId, assetScope: 'all', permission: 'no_ai_use', granted: true })
    const after = await runtime.studio.rights.checkAiPermission(actorOf(owner), projectId, 'master', 'analysis_only')
    expect(after.allowed).toBe(false)
    expect(after.reason).toMatch(/no AI use/)
  })

  it('stops an agent licensing request at a human and executes nothing', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner, 'Dark Southern Soul')
    await call(owner, 'POST', `/api/studio/projects/${projectId}/approve`, { versionId, approvalType: 'master' })
    await runtime.studio.rights.setAiPermission({
      actor: actorOf(owner),
      projectId,
      assetScope: 'master',
      permission: 'commercial_sync_generation',
      granted: true,
    })

    const response = await call(owner, 'POST', '/api/studio/licensing/requests', {
      requester: 'film-production-agent',
      requesterKind: 'agent',
      brief: 'Dark southern soul instrumental, 90 seconds, worldwide digital rights',
      budgetMicros: 3_000_000_000,
      durationSeconds: 90,
    })
    expect(response.statusCode).toBe(200)
    const request = response.json().request
    expect(request.status).toBe('awaiting_human')
    expect(request.executed).toBe(false)
    // No price is invented against a real budget.
    for (const match of request.matches) expect(match.indicativePriceMicros).toBeNull()
    expect(response.json().note).toMatch(/does not execute licences/)
  })
})

describe('record passport', () => {
  it('hashes a document that can be re-verified, and refuses to edit a finalized one', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)
    await call(owner, 'POST', `/api/studio/projects/${projectId}/contributions`, {
      contributionType: 'vocals',
      performedBy: 'Example Artist',
      human: true,
      detail: 'Lead vocal',
    })

    const built = await call(owner, 'POST', `/api/studio/projects/${projectId}/passport`)
    expect(built.statusCode).toBe(200)
    const passportId = built.json().passport.id

    const verified = await runtime.studio.passports.verify(actorOf(owner), passportId)
    expect(verified.document.valid).toBe(true)

    await call(owner, 'POST', `/api/studio/projects/${projectId}/passport/${passportId}/finalize`, { versionId })
    const finalized = await runtime.studio.repos.passports.get(owner.orgId, passportId)
    expect(finalized.status).toBe('finalized')
    const version = await runtime.studio.repos.versions.get(owner.orgId, versionId)
    expect(finalized.finalizedAssetChecksum).toBe(version.assetChecksum)

    await expect(runtime.studio.repos.passports.updateDraft(owner.orgId, passportId, finalized.document)).rejects.toThrow(/finalized passport cannot be edited/)
  })

  it('records AI-assisted work separately from human work', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    // A rendered master is an AI-assisted-tooling fact whether or not anybody
    // remembers to declare it, so the passport derives it from what happened.
    const requested = await call(owner, 'POST', `/api/studio/projects/${projectId}/master`, { versionId, direction: 'warm' })
    await runtime.studio.master.renderRendition(requested.json().rendition.id, owner.orgId, owner.userId)

    const built = await runtime.studio.passports.build({ actor: actorOf(owner), projectId })
    // The placeholder renderer produced no processing, so nothing is claimed —
    // which is itself the correct behaviour to assert.
    const rendition = await runtime.studio.repos.renditions.get(owner.orgId, requested.json().rendition.id)
    expect(built.document.aiDisclosure.toolsUsed.length).toBe(rendition.placeholder ? 0 : 1)
    expect(built.document.aiDisclosure.generativeUse).toEqual([])
  })
})

describe('demo seed', () => {
  it('produces a working demo whose numbers are real measurements', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    const result = await seedStudioDemo(runtime.studio, { orgId: owner.orgId, userId: owner.userId, email: owner.email, entitlements: runtime.entitlements })

    expect(result.created).toBe(true)
    expect(result.project.title).toBe(STUDIO_DEMO_TITLE)
    expect(result.versionIds.length).toBeGreaterThanOrEqual(2)

    const versions = await runtime.studio.repos.versions.list(owner.orgId, result.project.id)
    const latest = versions.filter((version) => version.versionType === 'mix').at(-1)!
    const analysis = await runtime.studio.repos.analyses.latestForVersion(owner.orgId, latest.id)
    expect(analysis?.status).toBe('ready')

    // Every metric is measured — a demo with holes in it teaches the product
    // is broken rather than that it is careful.
    const metrics = await runtime.studio.repos.analyses.metrics(owner.orgId, analysis!.id)
    expect(metrics.filter((metric) => metric.value === null)).toEqual([])

    // Notes land inside the audio, not past the end of it.
    const notes = await runtime.studio.repos.notes.list(owner.orgId, result.project.id)
    for (const note of notes) {
      if (note.timestampMs !== null) expect(note.timestampMs).toBeLessThanOrEqual(latest.durationMs ?? 0)
    }

    // Nothing is left looking like it is still running. A demo whose
    // processing panel says work is queued forever teaches that the product is
    // broken rather than that it is careful.
    const jobs = await runtime.studio.repos.processing.list(owner.orgId, result.project.id, 200)
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.filter((job) => job.status === 'queued' || job.status === 'running')).toEqual([])

    // Idempotent: seeding twice finds the demo rather than duplicating it.
    const again = await seedStudioDemo(runtime.studio, { orgId: owner.orgId, userId: owner.userId, email: owner.email, entitlements: runtime.entitlements })
    expect(again.created).toBe(false)
  })
})

// ---------------------------------------------------------------------------

/**
 * The processing ledger.
 *
 * One row per unit of asynchronous work. The property that matters most is the
 * billing one: work that produced nothing usable must never convert a credit,
 * on any path out — including the one where the work throws.
 */
describe('processing ledger', () => {
  it('opens a job when a version is uploaded, and names the performer', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, analysisId } = await seedProject(owner)

    const job = await runtime.studio.repos.processing.forSubject(owner.orgId, 'mix_analysis', analysisId)
    expect(job).not.toBeNull()
    expect(job!.jobType).toBe('mix_analysis')
    expect(job!.studioProjectId).toBe(projectId)
    // Work this deployment performed itself is attributed to itself. A blank
    // provider would let a local result read as a hosted service.
    expect(job!.provider).toBe('street-banker')
    expect(job!.adapter).toBe('local-dsp')
    expect(job!.billable).toBe(false)
    expect(job!.creditState).toBe('not_billable')
    // Nothing that could identify the audio goes into the ledger request.
    expect(JSON.stringify(job!.request)).not.toMatch(/storage|http|signature/i)
  })

  it('runs work claimed under the same key exactly once', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    const claim = () =>
      runtime.studio.repos.processing.claim({
        orgId: owner.orgId,
        studioProjectId: projectId,
        jobType: 'mix_analysis',
        subjectType: 'mix_analysis',
        subjectId: 'stma_subject',
        provider: 'street-banker',
        adapter: 'local-dsp',
        idempotencyKey: 'redelivered-message',
        createdBy: owner.userId,
      })

    const first = await claim()
    const second = await claim()
    expect(second.id).toBe(first.id)

    const all = await runtime.studio.repos.processing.list(owner.orgId, projectId, 200)
    expect(all.filter((job) => job.idempotencyKey === 'redelivered-message')).toHaveLength(1)
  })

  it('consumes a credit only when the work produced something usable', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    const billable = async (key: string) =>
      runtime.studio.repos.processing.claim({
        orgId: owner.orgId,
        studioProjectId: projectId,
        jobType: 'master_render',
        subjectType: 'master_rendition',
        subjectId: key,
        provider: 'some-vendor',
        adapter: 'vendor-master-v1',
        idempotencyKey: key,
        billable: true,
        creditUnits: 1,
        createdBy: owner.userId,
      })

    const good = await runtime.studio.repos.processing.start(owner.orgId, (await billable('good')).id)
    expect(good.creditState).toBe('reserved')
    const settledGood = await runtime.studio.repos.processing.settle(owner.orgId, good.id, { status: 'succeeded', usableResult: true })
    expect(settledGood.creditState).toBe('consumed')

    // Failure, and the two shapes of "finished but useless".
    for (const [key, outcome] of [
      ['failed', { status: 'failed' as const, usableResult: false }],
      ['unsupported', { status: 'unsupported' as const, usableResult: false }],
      ['empty', { status: 'succeeded' as const, usableResult: false }],
    ] as const) {
      const job = await runtime.studio.repos.processing.start(owner.orgId, (await billable(key)).id)
      const settled = await runtime.studio.repos.processing.settle(owner.orgId, job.id, outcome)
      expect(settled.creditState).toBe('released')
    }
  })

  it('releases the credit when the work throws, and lets the error reach the queue', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    const job = await runtime.studio.repos.processing.claim({
      orgId: owner.orgId,
      studioProjectId: projectId,
      jobType: 'stem_separation',
      subjectType: 'studio_version',
      subjectId: 'stv_throwing',
      provider: 'some-vendor',
      adapter: 'vendor-stems-v1',
      idempotencyKey: 'throwing-work',
      billable: true,
      creditUnits: 1,
      createdBy: owner.userId,
    })

    await expect(
      runtime.studio.processing.run({ jobId: job.id, orgId: owner.orgId }, async () => {
        throw new Error('the provider hung up')
      }),
    ).rejects.toThrow('the provider hung up')

    const settled = await runtime.studio.repos.processing.get(owner.orgId, job.id)
    expect(settled.status).toBe('failed')
    expect(settled.creditState).toBe('released')
    expect(settled.errorMessage).toBe('the provider hung up')
    expect(settled.attempt).toBe(1)
  })

  it('does not charge for a placeholder master — the customer got their own audio back', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    const requested = await call(owner, 'POST', `/api/studio/projects/${projectId}/master`, { versionId, direction: 'warm' })
    const renditionId = requested.json().rendition.id
    const rendition = await runtime.studio.master.renderRendition(renditionId, owner.orgId, owner.userId)
    // The test runtime renders with the passthrough, which is the case this is
    // about: a completed job whose output is the unprocessed source.
    expect(rendition.placeholder).toBe(true)

    const outcome = outcomeForRendition(rendition)
    expect(outcome.usableResult).toBe(false)
    expect(outcome.status).toBe('unsupported')
  })

  it('settles the ledger from the analysis it ran, without inventing a cost', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { analysisId } = await seedProject(owner)

    const analysis = await runtime.studio.repos.analyses.get(owner.orgId, analysisId)
    const job = await runtime.studio.repos.processing.forSubject(owner.orgId, 'mix_analysis', analysisId)
    const settled = await runtime.studio.processing.run({ jobId: job!.id, orgId: owner.orgId }, async () => outcomeForAnalysis(analysis))

    expect(settled!.status).toBe('succeeded')
    // Null, not zero. A provider that reported no cost has not reported a cost
    // of nothing, and an accounting column must not blur the two.
    expect(settled!.costMicros).toBeNull()
    expect(settled!.finishedAt).not.toBeNull()
  })

  it('says who will perform the work, and whether they can, before anything is rendered', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)

    const response = await call(owner, 'GET', '/api/studio/processing-providers')
    expect(response.statusCode).toBe(200)
    const render = response.json().providers.find((status: { capability: string }) => status.capability === 'render_master')

    // Named, and named as local. An unattributed result could be mistaken for
    // a hosted professional service.
    expect(render.provider).toBe('street-banker')
    expect(render.local).toBe(true)
    expect(['ready', 'degraded', 'unavailable']).toContain(render.readiness)
    if (render.readiness !== 'ready') expect(render.reason).toBeTruthy()
  })

  it('serves the ledger for a project, and never for another organization’s', async () => {
    const flagship = await signup('flagship@example.com', 'Flagship')
    await grantStudio(flagship.orgId)
    const { projectId } = await seedProject(flagship)

    const mine = await call(flagship, 'GET', `/api/studio/projects/${projectId}/jobs`)
    expect(mine.statusCode).toBe(200)
    expect(mine.json().jobs.length).toBeGreaterThan(0)

    const partner = await provisionOrg('partner@example.com', 'Partner')
    await grantStudio(partner.orgId, PARTNER_STUDIO_CAPABILITIES)
    const theirs = await call(partner, 'GET', `/api/studio/projects/${projectId}/jobs`)
    expect(theirs.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------

/**
 * The provenance chain.
 *
 * The property under test is the one an activity log cannot offer: that a
 * removed or altered event is *detectable*. The tests tamper with the table
 * directly, because that is the threat the chain exists to notice.
 */
describe('provenance chain', () => {
  it('records the record\u2019s history in order, starting from the rights basis', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    const response = await call(owner, 'GET', `/api/studio/projects/${projectId}/provenance`)
    expect(response.statusCode).toBe(200)
    const events = response.json().events as Array<{ sequence: number; eventType: string; previousHash: string | null; payload: Record<string, unknown> }>

    expect(events[0]?.eventType).toBe('project.created')
    expect(events[0]?.previousHash).toBeNull()
    expect(events[1]?.eventType).toBe('rights.confirmed')
    expect(events.map((event) => event.eventType)).toContain('version.added')

    // Contiguous, and each linked to the one before it.
    events.forEach((event, index) => expect(event.sequence).toBe(index + 1))

    // The chain records checksums, never storage locations or signed URLs.
    const serialized = JSON.stringify(events)
    expect(serialized).not.toMatch(/organizations\//)
    expect(serialized).not.toMatch(/sig=|X-Amz-Signature/)

    expect(response.json().verification).toMatchObject({ intact: true, brokenAt: null })
  })

  it('notices an altered event, and says which one', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    const before = await runtime.studio.repos.provenance.verify(owner.orgId, projectId)
    expect(before.intact).toBe(true)
    expect(before.headHash).toBeTruthy()

    // Rewrite the payload of event 2 without recomputing its hash — the exact
    // partial edit the chain exists to catch.
    await db.run("UPDATE studio_provenance_events SET payload = ? WHERE org_id = ? AND studio_project_id = ? AND sequence = 2", [
      JSON.stringify({ statement: 'nobody confirmed anything' }),
      owner.orgId,
      projectId,
    ])

    const after = await runtime.studio.repos.provenance.verify(owner.orgId, projectId)
    expect(after.intact).toBe(false)
    expect(after.brokenAt).toBe(2)
    expect(after.reason).toMatch(/altered/)
    // A broken chain has no head hash to offer: there is nothing to pin to.
    expect(after.headHash).toBeNull()
  })

  it('notices a removed event', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    await db.run('DELETE FROM studio_provenance_events WHERE org_id = ? AND studio_project_id = ? AND sequence = 2', [owner.orgId, projectId])

    const after = await runtime.studio.repos.provenance.verify(owner.orgId, projectId)
    expect(after.intact).toBe(false)
    expect(after.brokenAt).toBe(2)
    expect(after.reason).toMatch(/missing/)
  })

  it('never claims to be cryptographic proof', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    const response = await call(owner, 'GET', `/api/studio/projects/${projectId}/provenance`)
    const statement = response.json().statement as string

    // Nothing is signed, and the surface says so rather than letting a reader
    // infer a guarantee the code cannot support.
    expect(statement).toMatch(/tamper-evident/i)
    expect(statement).toMatch(/not cryptographic proof/i)
    expect(statement).not.toMatch(/\bsigned by\b|\bcryptographically verified\b/i)
  })

  it('records an approval against the exact bytes it approved', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)
    const version = await runtime.studio.repos.versions.get(owner.orgId, versionId)

    const approved = await call(owner, 'POST', `/api/studio/projects/${projectId}/approve`, { versionId, approvalType: 'mix', comments: 'good' })
    expect(approved.statusCode).toBe(200)

    const events = await runtime.studio.repos.provenance.list(owner.orgId, projectId)
    const approval = events.find((event) => event.eventType === 'approval.granted')
    expect(approval?.payload.versionChecksum).toBe(version.assetChecksum)
    expect((await runtime.studio.repos.provenance.verify(owner.orgId, projectId)).intact).toBe(true)
  })
})

// ---------------------------------------------------------------------------

/**
 * Where a recommendation came from.
 *
 * The basis has to survive the round trip. A taxonomy that exists only in the
 * analysis module and is lost on the way to the database would be decoration.
 */
describe('recommendation basis', () => {
  it('stores what each finding rested on, and serves it back', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId } = await seedProject(owner)

    // An out-of-phase file, so the detectors actually fire and there is a
    // finding whose basis can be checked.
    const attached = await runtime.studio.projects.attachUpload({
      actor: actorOf(owner),
      projectId,
      bytes: stereoWav({ inverted: true }),
      filename: 'out-of-phase.wav',
      versionType: 'mix',
      rightsConfirmed: true,
    })
    const versionId = attached.version.id
    const analysisId = attached.analysisId as string
    await runtime.studio.mix.runAnalysis(analysisId, owner.orgId)

    const issues = await runtime.studio.repos.issues.list(owner.orgId, analysisId)
    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(issue.basis).not.toBeNull()
      expect(issue.basis).toMatchObject({ source: expect.any(String), confidenceLabel: expect.any(String) })
    }

    const response = await call(owner, 'GET', `/api/studio/projects/${projectId}/mix?versionId=${versionId}`)
    expect(response.statusCode).toBe(200)
    const served = response.json().issues as Array<{ basis: { statement: string; missingInputs: string[] } | null }>
    for (const issue of served) {
      expect(issue.basis?.statement).toBeTruthy()
      expect(Array.isArray(issue.basis?.missingInputs)).toBe(true)
    }

    // Readiness carries it too, and names what it could not measure.
    const bands = response.json().readiness.bands as Array<{ band: string; score: number | null; basis: { missingInputs: string[] } }>
    for (const band of bands) {
      expect(band.basis).toBeTruthy()
      if (band.score === null) expect(band.basis.missingInputs.length).toBeGreaterThan(0)
    }
  })

  it('tells the room what it could not see', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const { projectId, versionId } = await seedProject(owner)

    const asked = await call(owner, 'POST', `/api/studio/projects/${projectId}/ask`, {
      versionId,
      question: 'is the vocal sitting right?',
    })
    expect(asked.statusCode).toBe(200)
    const basis = asked.json().exchange.basis as { missingInputs: string[]; sourceLabel: string }

    expect(basis.sourceLabel).toBeTruthy()
    // No references were added and no vocal stem supplied, and the answer says
    // both rather than presenting itself as fully informed.
    expect(basis.missingInputs.join(' ')).toMatch(/reference tracks/)
    expect(basis.missingInputs.join(' ')).toMatch(/isolated vocal stem/)
  })
})

// ---------------------------------------------------------------------------

/**
 * Resumable uploads.
 *
 * The properties: a file arrives in parts, an interrupted upload resumes from
 * what the server already holds, and nothing incomplete or mis-sized ever
 * becomes a version.
 */
describe('resumable upload', () => {
  async function openSession(session: Session, projectId: string, bytes: Uint8Array, fileName = 'mix.wav') {
    const response = await call(session, 'POST', `/api/studio/projects/${projectId}/uploads`, {
      fileName,
      contentType: 'audio/wav',
      totalBytes: bytes.length,
      versionType: 'mix',
      rightsConfirmed: true,
    })
    expect(response.statusCode).toBe(200)
    return response.json() as { session: { id: string; partCount: number; partSize: number; transport: string }; received: number[] }
  }

  async function sendPart(session: Session, projectId: string, sessionId: string, index: number, bytes: Uint8Array) {
    return app.inject({
      method: 'PUT',
      url: `/api/studio/projects/${projectId}/uploads/${sessionId}/parts/${index}`,
      headers: { ...headers(session), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(bytes),
    })
  }

  it('accepts a file in parts and builds one version from them', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const created = await call(owner, 'POST', '/api/studio/projects', {
      title: 'Chunked',
      artistName: 'Example Artist',
      genre: 'alternative',
      rightsConfirmed: true,
    })
    const projectId = created.json().project.id
    const audio = stereoWav({ seconds: 4 })

    const plan = await openSession(owner, projectId, audio)
    // Local storage has no direct-upload endpoint, so the parts come through
    // the API — and the session says so rather than pretending otherwise.
    expect(plan.session.transport).toBe('api')
    // The point of the test is the multi-part path. If a config change ever
    // collapsed this to one part it would still pass while proving nothing.
    expect(plan.session.partCount).toBeGreaterThan(1)

    for (let index = 0; index < plan.session.partCount; index++) {
      const offset = index * plan.session.partSize
      const part = audio.slice(offset, offset + plan.session.partSize)
      expect((await sendPart(owner, projectId, plan.session.id, index, part)).statusCode).toBe(200)
    }

    const completed = await call(owner, 'POST', `/api/studio/projects/${projectId}/uploads/${plan.session.id}/complete`)
    expect(completed.statusCode).toBe(200)
    const versionId = completed.json().versionId

    // The version exists, carries the whole file, and was queued for analysis.
    const version = await runtime.studio.repos.versions.get(owner.orgId, versionId)
    expect(version.assetId).not.toBeNull()
    const asset = await runtime.audio.repos.assets.get(owner.orgId, version.assetId as string)
    expect(asset.fileSize).toBe(audio.length)

    const stored = await runtime.storage.getBuffer(asset.storageKey)
    expect(Buffer.from(stored).equals(Buffer.from(audio))).toBe(true)
  })

  it('resumes from the parts the server already holds', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const created = await call(owner, 'POST', '/api/studio/projects', {
      title: 'Interrupted',
      artistName: 'Example Artist',
      genre: 'alternative',
      rightsConfirmed: true,
    })
    const projectId = created.json().project.id
    const audio = stereoWav({ seconds: 4 })
    const plan = await openSession(owner, projectId, audio)

    // Send the first part, then "lose the connection".
    await sendPart(owner, projectId, plan.session.id, 0, audio.slice(0, plan.session.partSize))

    const resumed = await call(owner, 'GET', `/api/studio/projects/${projectId}/uploads/${plan.session.id}`)
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json().received).toContain(0)

    // Completing now must refuse: an upload missing a part is not a file.
    expect(plan.session.partCount).toBeGreaterThan(1)
    const premature = await call(owner, 'POST', `/api/studio/projects/${projectId}/uploads/${plan.session.id}/complete`)
    expect(premature.statusCode).toBe(400)
    expect(premature.json().error.code).toBe('studio.upload_incomplete')
  })

  it('refuses a part that is not the size the plan called for', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const created = await call(owner, 'POST', '/api/studio/projects', {
      title: 'Truncated',
      artistName: 'Example Artist',
      genre: 'alternative',
      rightsConfirmed: true,
    })
    const projectId = created.json().project.id
    const audio = stereoWav({ seconds: 4 })
    const plan = await openSession(owner, projectId, audio)

    // A short part is how a truncated upload becomes a file that analyses
    // cleanly and is wrong.
    const short = await sendPart(owner, projectId, plan.session.id, 0, audio.slice(0, 128))
    expect(short.statusCode).toBe(400)
    expect(short.json().error.code).toBe('studio.upload_part_size')
  })

  it('refuses to open a session without a rights confirmation', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const created = await call(owner, 'POST', '/api/studio/projects', {
      title: 'Unconfirmed',
      artistName: 'Example Artist',
      genre: 'alternative',
      rightsConfirmed: true,
    })
    const projectId = created.json().project.id

    const response = await call(owner, 'POST', `/api/studio/projects/${projectId}/uploads`, {
      fileName: 'mix.wav',
      contentType: 'audio/wav',
      totalBytes: 1024,
      versionType: 'mix',
      rightsConfirmed: false,
    })
    // Refused before a single byte is accepted, not after the file has landed.
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('studio.rights_not_confirmed')
  })

  it('reclaims an abandoned upload and the storage it held', async () => {
    const owner = await signup('owner@example.com', 'Flagship')
    await grantStudio(owner.orgId)
    const created = await call(owner, 'POST', '/api/studio/projects', {
      title: 'Abandoned',
      artistName: 'Example Artist',
      genre: 'alternative',
      rightsConfirmed: true,
    })
    const projectId = created.json().project.id
    const audio = stereoWav({ seconds: 4 })
    const plan = await openSession(owner, projectId, audio)
    await sendPart(owner, projectId, plan.session.id, 0, audio.slice(0, plan.session.partSize))

    const parts = await runtime.studio.repos.uploads.parts(owner.orgId, plan.session.id)
    expect(parts.length).toBe(1)
    expect(await runtime.storage.exists(parts[0]!.storageKey)).toBe(true)

    const aborted = await call(owner, 'DELETE', `/api/studio/projects/${projectId}/uploads/${plan.session.id}`)
    expect(aborted.statusCode).toBe(200)
    expect(aborted.json().session.status).toBe('aborted')
    // The bytes are gone, not merely forgotten.
    expect(await runtime.storage.exists(parts[0]!.storageKey)).toBe(false)
    expect(await runtime.studio.repos.uploads.parts(owner.orgId, plan.session.id)).toEqual([])
  })

  it('never lets one organization touch another’s upload session', async () => {
    const flagship = await signup('flagship@example.com', 'Flagship')
    await grantStudio(flagship.orgId)
    const created = await call(flagship, 'POST', '/api/studio/projects', {
      title: 'Private',
      artistName: 'Example Artist',
      genre: 'alternative',
      rightsConfirmed: true,
    })
    const projectId = created.json().project.id
    const plan = await openSession(flagship, projectId, stereoWav({ seconds: 4 }))

    const partner = await provisionOrg('partner@example.com', 'Partner')
    await grantStudio(partner.orgId, PARTNER_STUDIO_CAPABILITIES)
    const peek = await call(partner, 'GET', `/api/studio/projects/${projectId}/uploads/${plan.session.id}`)
    expect(peek.statusCode).toBe(404)
  })
})
