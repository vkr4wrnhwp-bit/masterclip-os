import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, sha256Hex, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { synthesizeWav } from '@masterclip/ai-audio'
import { FLAGSHIP_CAPABILITIES } from '@masterclip/performance-project'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'

/**
 * Live Lab HTTP tests: entitlement enforcement, tenant isolation, rights
 * gating, the async AI pipeline, package verification, and Stage Control —
 * all through the real Fastify instance.
 */

let runtime: Runtime
let db: Db
let app: FastifyInstance
let storageRoot: string

const OWNER = { email: 'artist@example.com', password: 'a-sufficiently-long-password' }

interface Session {
  session: string
  csrf: string
  orgId: string
  userId: string
}

async function boot(): Promise<void> {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'livelab-test-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'livelab-test-secret',
      SESSION_SECRET: 'livelab-test-session-secret',
    },
    true,
  )
  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'livelab-test-secret' }),
  })
  app = await buildServer({ runtime, logger: silentLogger })
  await app.ready()
}

beforeEach(async () => {
  await boot()
})

afterEach(async () => {
  await app?.close()
  await rm(storageRoot, { recursive: true, force: true })
})

/** Bootstrap owner via signup — the route grants flagship entitlements. */
async function signupOwner(): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email: OWNER.email, password: OWNER.password, displayName: 'Artist', orgName: 'Flagship Org' },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { user: { id: string; orgId: string }; org: { id: string } }
  return {
    session: response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '',
    csrf: response.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? '',
    orgId: body.org.id,
    userId: body.user.id,
  }
}

/** A second organization, created directly (signup closes after the first). */
async function secondOrg(capabilities: readonly string[] = FLAGSHIP_CAPABILITIES): Promise<Session> {
  const org = await runtime.projects.createOrg('Partner Org')
  const user = await runtime.auth.createUser({
    orgId: org.id,
    email: `partner-${Math.random().toString(36).slice(2)}@example.com`,
    password: OWNER.password,
    displayName: 'Partner',
    orgRole: 'owner',
  })
  await runtime.entitlements.grantAll(org.id, capabilities)
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: OWNER.password } })
  expect(response.statusCode).toBe(200)
  return {
    session: response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '',
    csrf: response.cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? '',
    orgId: org.id,
    userId: user.id,
  }
}

function call(who: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    cookies: { [SESSION_COOKIE]: who.session, [CSRF_COOKIE]: who.csrf },
    headers: { [CSRF_HEADER]: who.csrf },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
}

async function createProject(who: Session, name = 'Test Set'): Promise<string> {
  const response = await call(who, 'POST', '/api/live-lab/projects', { name, masterTempo: 120 })
  expect(response.statusCode).toBe(200)
  return (response.json() as { project: { id: string } }).project.id
}

/** Seeds one song with a scene, a clip and stems straight through the repos. */
async function seedSong(who: Session, projectId: string) {
  const wav = synthesizeWav({ bpm: 120, bars: 2, energy: 0.7, layers: { kick: true, bass: true }, seed: 11 })
  const key = `${projectId}/test/${Math.random().toString(36).slice(2)}.wav`
  await runtime.storage.putBuffer(key, wav, { contentType: 'audio/wav' })
  const asset = await runtime.liveLab.createAsset({
    orgId: who.orgId,
    liveProjectId: projectId,
    kind: 'audio',
    storageKey: key,
    filename: 'track.wav',
    mime: 'audio/wav',
    bytes: wav.length,
    sha256: sha256Hex(wav),
    rightsConfirmed: true,
    createdBy: who.userId,
  })
  const item = await runtime.liveLab.createItem({ orgId: who.orgId, liveProjectId: projectId, type: 'song', title: 'TRACK ONE', bpm: 120 })
  const scene = await runtime.liveLab.createScene({
    orgId: who.orgId,
    liveProjectId: projectId,
    liveSetItemId: item.id,
    name: 'HOOK',
    sceneType: 'chorus',
    bars: 2,
  })
  await runtime.liveLab.createClip({
    orgId: who.orgId,
    liveProjectId: projectId,
    liveSceneId: scene.id,
    name: 'hook',
    sourceAssetId: asset.id,
  })
  const clickWav = synthesizeWav({ bpm: 120, bars: 2, energy: 0.5, layers: { click: true }, seed: 12 })
  const clickKey = `${projectId}/test/click-${Math.random().toString(36).slice(2)}.wav`
  await runtime.storage.putBuffer(clickKey, clickWav, { contentType: 'audio/wav' })
  const clickAsset = await runtime.liveLab.createAsset({
    orgId: who.orgId,
    liveProjectId: projectId,
    kind: 'click',
    storageKey: clickKey,
    filename: 'click.wav',
    mime: 'audio/wav',
    bytes: clickWav.length,
    sha256: sha256Hex(clickWav),
    rightsConfirmed: true,
    createdBy: who.userId,
  })
  const stem = await runtime.liveLab.createStem({
    orgId: who.orgId,
    liveProjectId: projectId,
    liveSetItemId: item.id,
    stemType: 'click',
    sourceAssetId: clickAsset.id,
  })
  return { asset, item, scene, stem }
}

// ---------------------------------------------------------------------------

describe('entitlements', () => {
  it('a non-entitled organization cannot use Live Lab at all', async () => {
    await signupOwner()
    const partner = await secondOrg([]) // no grants
    const response = await call(partner, 'GET', '/api/live-lab/projects')
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('entitlement.missing')
  })

  it('the AI Scene Builder requires its own capability', async () => {
    await signupOwner()
    const partner = await secondOrg(['live_lab.access', 'live_lab.projects'])
    const projectId = await createProject(partner)
    const response = await call(partner, 'POST', `/api/live-lab/projects/${projectId}/ai-scenes`, {
      request: { prompt: 'sparse intro', bars: 8, tempoBehavior: 'keep', keyBehavior: 'keep', energy: 'low', instrumentation: [], intendedTransition: '', rightsConfirmed: true },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('entitlement.missing')
  })

  it('limits are enforced server-side', async () => {
    const owner = await signupOwner()
    await runtime.entitlements.setLimit(owner.orgId, 'live_lab.max_projects', 1)
    await createProject(owner, 'First')
    const response = await call(owner, 'POST', '/api/live-lab/projects', { name: 'Second' })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('entitlement.limit')
  })

  it('the signup bootstrap org gets flagship capabilities', async () => {
    const owner = await signupOwner()
    const response = await call(owner, 'GET', '/api/live-lab/capabilities')
    expect(response.statusCode).toBe(200)
    const caps = (response.json() as { capabilities: string[] }).capabilities
    expect(caps).toContain('live_lab.access')
    expect(caps).toContain('live_lab.ai_scene_builder')
  })
})

describe('tenant isolation', () => {
  it('live projects, scenes, stems and mappings never cross organizations', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const { scene, stem } = await seedSong(owner, projectId)
    const mappingResponse = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings`, {
      deviceIdentifier: 'dev', channel: 0, messageType: 'note_on', noteOrController: 36, targetType: 'pad', targetId: 'pad:0',
    })
    expect(mappingResponse.statusCode).toBe(200)
    const mappingId = (mappingResponse.json() as { mapping: { id: string } }).mapping.id

    const intruder = await secondOrg()
    expect((await call(intruder, 'GET', `/api/live-lab/projects/${projectId}`)).statusCode).toBe(403)
    expect((await call(intruder, 'PATCH', `/api/live-lab/scenes/${scene.id}`, { name: 'MINE NOW' })).statusCode).toBe(403)
    expect((await call(intruder, 'PATCH', `/api/live-lab/stems/${stem.id}`, { muted: true })).statusCode).toBe(403)
    expect((await call(intruder, 'DELETE', `/api/live-lab/midi-mappings/${mappingId}`)).statusCode).toBe(403)
    expect((await call(intruder, 'DELETE', `/api/live-lab/projects/${projectId}`)).statusCode).toBe(403)

    // Remix import from a foreign project is refused even when asset ids leak.
    const foreignAssets = await runtime.liveLab.listAssets(projectId)
    const theirProject = await createProject(intruder, 'Their Set')
    const importResponse = await call(intruder, 'POST', `/api/live-lab/projects/${theirProject}/import-remix`, {
      sourceLiveProjectId: projectId,
      assetIds: [foreignAssets[0]!.id],
    })
    expect(importResponse.statusCode).toBe(403)
  })
})

describe('set building', () => {
  it('creates projects, items, scenes and reorders the set', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)

    const itemA = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/set-items`, { type: 'song', title: 'OPENING' })
    const itemB = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/set-items`, { type: 'outro', title: 'OUTRO' })
    const idA = (itemA.json() as { item: { id: string } }).item.id
    const idB = (itemB.json() as { item: { id: string } }).item.id

    await call(owner, 'PATCH', `/api/live-lab/projects/${projectId}/set`, { order: [idB, idA] })
    const set = (await call(owner, 'GET', `/api/live-lab/projects/${projectId}/set`)).json() as { items: Array<{ id: string }> }
    expect(set.items.map((i) => i.id)).toEqual([idB, idA])

    const sceneResponse = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/scenes`, {
      liveSetItemId: idA,
      name: 'DROP',
      sceneType: 'drop',
      bars: 8,
      quantization: '2bars',
      loopEnabled: true,
    })
    expect(sceneResponse.statusCode).toBe(200)
    const scene = (sceneResponse.json() as { scene: { id: string; quantization: string } }).scene
    expect(scene.quantization).toBe('2bars')

    const patched = await call(owner, 'PATCH', `/api/live-lab/scenes/${scene.id}`, { followAction: 'next_scene' })
    expect((patched.json() as { scene: { followAction: string } }).scene.followAction).toBe('next_scene')
  })

  it('rejects uploads without rights confirmation', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const wav = synthesizeWav({ bpm: 120, bars: 1, energy: 0.5, layers: { kick: true }, seed: 5 })
    const boundary = '----livelabboundary'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.wav"\r\ncontent-type: audio/wav\r\n\r\n`),
      Buffer.from(wav),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const response = await app.inject({
      method: 'POST',
      url: `/api/live-lab/projects/${projectId}/upload`,
      cookies: { [SESSION_COOKIE]: owner.session, [CSRF_COOKIE]: owner.csrf },
      headers: { [CSRF_HEADER]: owner.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('live.rights_required')
  })

  it('accepts an upload with rights confirmed and records who confirmed', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const wav = synthesizeWav({ bpm: 120, bars: 1, energy: 0.5, layers: { kick: true }, seed: 6 })
    const boundary = '----livelabboundary'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="rightsConfirmed"\r\n\r\ntrue\r\n`),
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.wav"\r\ncontent-type: audio/wav\r\n\r\n`),
      Buffer.from(wav),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const response = await app.inject({
      method: 'POST',
      url: `/api/live-lab/projects/${projectId}/upload`,
      cookies: { [SESSION_COOKIE]: owner.session, [CSRF_COOKIE]: owner.csrf },
      headers: { [CSRF_HEADER]: owner.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    expect(response.statusCode).toBe(200)
    const asset = (response.json() as { asset: { rightsConfirmed: boolean; rightsConfirmedBy: string } }).asset
    expect(asset.rightsConfirmed).toBe(true)
    expect(asset.rightsConfirmedBy).toBe(owner.userId)
  })
})

describe('MIDI mappings', () => {
  it('persist, warn on duplicates, and replace only when asked', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const body = { deviceIdentifier: 'dev', channel: 0, messageType: 'note_on', noteOrController: 36, targetType: 'pad', targetId: 'pad:0' }

    const first = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings`, body)
    expect(first.statusCode).toBe(200)

    const duplicate = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings`, { ...body, targetId: 'pad:1' })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error.code).toBe('live.midi_duplicate')

    const replaced = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings`, {
      ...body,
      targetId: 'pad:1',
      replaceDuplicate: true,
    })
    expect(replaced.statusCode).toBe(200)

    const list = (await call(owner, 'GET', `/api/live-lab/projects/${projectId}/midi-mappings`)).json() as { mappings: Array<{ targetId: string }> }
    expect(list.mappings).toHaveLength(1)
    expect(list.mappings[0]!.targetId).toBe('pad:1')
  })
})

describe('AI scene builder', () => {
  const aiRequest = {
    prompt: 'a sparse eight bar intro, drums enter after four bars',
    bars: 8,
    tempoBehavior: 'keep',
    keyBehavior: 'keep',
    energy: 'low',
    instrumentation: ['drums', 'bass', 'pad'],
    intendedTransition: 'into the first chorus',
    rightsConfirmed: true,
  }

  it('requires rights confirmation', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const response = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/ai-scenes`, {
      request: { ...aiRequest, rightsConfirmed: false },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('live.rights_required')
  })

  it('blocks real-person imitation prompts', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const response = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/ai-scenes`, {
      request: { ...aiRequest, prompt: 'an intro in the style of Drake' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('live.prompt_refused')
  })

  it('runs asynchronously, never touches existing scenes, preserves lineage, and accepts explicitly', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const { item, scene } = await seedSong(owner, projectId)
    const clipsBefore = (await runtime.liveLab.listClips(projectId)).filter((c) => c.liveSceneId === scene.id)

    const created = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/ai-scenes`, {
      liveSetItemId: item.id,
      request: aiRequest,
    })
    expect(created.statusCode).toBe(200)
    const jobId = (created.json() as { job: { id: string; status: string } }).job.id
    expect((created.json() as { job: { status: string } }).job.status).toBe('queued')

    // The job was queued, not executed inline; the worker's handler runs it.
    await runtime.liveLabService.runAiJob(jobId)
    const ready = (await call(owner, 'GET', `/api/live-lab/ai-jobs/${jobId}`)).json() as {
      job: { status: string; outputAssetIds: string[] }
      options: Array<{ asset: { id: string; lineage: Record<string, unknown> | null } }>
    }
    expect(ready.job.status).toBe('ready')
    expect(ready.job.outputAssetIds).toHaveLength(3)
    expect(ready.options[0]!.asset.lineage).toMatchObject({ provider: 'mock-audio', prompt: aiRequest.prompt, rightsConfirmed: true })
    expect(ready.options[0]!.asset.lineage!.approvedBy).toBeNull()

    // Generation must never modify the existing scene's audio.
    const clipsAfter = (await runtime.liveLab.listClips(projectId)).filter((c) => c.liveSceneId === scene.id)
    expect(clipsAfter).toEqual(clipsBefore)

    // Accepting is the explicit step that creates a new scene and approves lineage.
    const accepted = await call(owner, 'POST', `/api/live-lab/ai-jobs/${jobId}/accept`, {
      assetId: ready.job.outputAssetIds[0],
      mode: 'add_scene',
      liveSetItemId: item.id,
      sceneName: 'GENERATED INTRO',
    })
    expect(accepted.statusCode).toBe(200)
    const sceneId = (accepted.json() as { sceneId: string }).sceneId
    const newScene = await runtime.liveLab.getScene(sceneId)
    expect(newScene.name).toBe('GENERATED INTRO')
    const approvedAsset = await runtime.liveLab.getAsset(ready.job.outputAssetIds[0]!)
    expect(approvedAsset.lineage?.approvedBy).toBe(owner.userId)
  })

  it('a failed provider marks the job failed without touching the project', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    // A job whose source asset lacks rights confirmation fails in the worker.
    const badAsset = await runtime.liveLab.createAsset({
      orgId: owner.orgId,
      liveProjectId: projectId,
      kind: 'audio',
      storageKey: 'nowhere.wav',
      filename: 'nowhere.wav',
      mime: 'audio/wav',
      bytes: 10,
      sha256: 'x'.repeat(64),
      rightsConfirmed: false,
      createdBy: owner.userId,
    })
    const job = await runtime.liveLab.createAiJob({
      orgId: owner.orgId,
      liveProjectId: projectId,
      sourceAssetId: badAsset.id,
      provider: 'mock-audio',
      operation: 'scene.generate',
      configuration: { ...aiRequest, rightsConfirmed: true } as never,
      createdBy: owner.userId,
    })
    await runtime.liveLabService.runAiJob(job.id)
    const after = await runtime.liveLab.getAiJob(job.id)
    expect(after.status).toBe('failed')
    expect(after.error).toMatch(/rights/)
  })
})

describe('performance package', () => {
  it('builds, verifies with matching device checksums, and reaches READY', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    await seedSong(owner, projectId)

    const built = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/performance-package`)
    expect(built.statusCode).toBe(200)
    const { package: record, report } = built.json() as {
      package: { id: string; status: string }
      report: { status: string }
    }
    expect(report.status).toBe('ready')
    expect(record.status).toBe('verifying')

    // Simulate the performance device: hash exactly the cached bytes.
    const files = (await call(owner, 'GET', `/api/live-lab/performance-packages/${record.id}`)).json() as {
      files: Array<{ path: string; assetId: string; bytes: number }>
    }
    const reported = []
    for (const file of files.files) {
      const asset = await runtime.liveLab.getAsset(file.assetId)
      const bytes = await runtime.storage.getBuffer(asset.storageKey)
      reported.push({ path: file.path, sha256: sha256Hex(bytes), bytes: bytes.length, decodable: true })
    }
    const verified = await call(owner, 'POST', `/api/live-lab/performance-packages/${record.id}/verify`, { files: reported })
    expect(verified.statusCode).toBe(200)
    expect((verified.json() as { status: string }).status).toBe('ready')
    expect((verified.json() as { package: { verifiedAt: string | null } }).package.verifiedAt).not.toBeNull()
  })

  it('a missing or corrupted cached asset prevents READY', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    await seedSong(owner, projectId)
    const built = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/performance-package`)
    const record = (built.json() as { package: { id: string } }).package

    const files = (await call(owner, 'GET', `/api/live-lab/performance-packages/${record.id}`)).json() as {
      files: Array<{ path: string; bytes: number }>
    }
    // Device reports one file missing and the rest wrong: not READY.
    const reported = files.files.slice(1).map((file) => ({ path: file.path, sha256: 'f'.repeat(64), bytes: file.bytes, decodable: true }))
    const verified = await call(owner, 'POST', `/api/live-lab/performance-packages/${record.id}/verify`, { files: reported })
    const body = verified.json() as { status: string; issues: Array<{ code: string }> }
    expect(body.status).toBe('error')
    expect(body.issues.some((i) => i.code === 'missing_file')).toBe(true)
    expect(body.issues.some((i) => i.code === 'checksum_mismatch')).toBe(true)
  })
})

describe('stage control', () => {
  it('exports a handoff with setlist order and click requirements', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    await seedSong(owner, projectId)

    const response = await call(owner, 'GET', `/api/live-lab/projects/${projectId}/stage-control`)
    expect(response.statusCode).toBe(200)
    const handoff = (response.json() as { handoff: { kind: string; setlist: Array<{ title: string; clickRequired: boolean }> } }).handoff
    expect(handoff.kind).toBe('live_lab.stage_control.handoff')
    expect(handoff.setlist[0]!.title).toBe('TRACK ONE')
    expect(handoff.setlist[0]!.clickRequired).toBe(true)
  })

  it('accepts a Stage Control session document', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const response = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/stage-control`, {
      kind: 'stage_control.live_lab.session',
      version: 1,
      showSessionId: 'show-1',
      venue: 'The Basement',
      soundcheckTime: null,
      monitorAssignments: [],
      technicalNotes: 'stage left power is flaky',
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('performance analytics', () => {
  it('syncs event batches when the device comes back online', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const response = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/events`, {
      events: [
        { eventType: 'set_started', payload: {}, localTimestamp: new Date().toISOString() },
        { eventType: 'scene_launched', payload: { sceneId: 's1' }, localTimestamp: new Date().toISOString() },
      ],
    })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { recorded: number }).recorded).toBe(2)
  })
})
