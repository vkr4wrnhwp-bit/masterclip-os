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
import { sniffMime } from '../apps/api/src/routes/assets.js'
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

describe('keyboard zone mapping', () => {
  it('maps a run of keys onto a song’s scenes in performance order', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const { item, scene } = await seedSong(owner, projectId)
    const second = await runtime.liveLab.createScene({
      orgId: owner.orgId,
      liveProjectId: projectId,
      liveSetItemId: item.id,
      name: 'DROP',
      sceneType: 'drop',
      sortOrder: 1,
    })

    // C5 = 72, the default scene-launch zone.
    const response = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings/bulk`, {
      deviceIdentifier: 'keys-88',
      channel: 0,
      startNote: 72,
      targetType: 'scene',
      targetIds: [scene.id, second.id],
    })
    expect(response.statusCode).toBe(200)
    const mappings = (response.json() as { mappings: Array<{ noteOrController: number; targetId: string; messageType: string }> }).mappings
    expect(mappings).toHaveLength(2)
    // Consecutive notes, in the order given — not an arbitrary shuffle.
    expect(mappings[0]).toMatchObject({ noteOrController: 72, targetId: scene.id, messageType: 'note_on' })
    expect(mappings[1]).toMatchObject({ noteOrController: 73, targetId: second.id })
  })

  it('refuses to half-map a keyboard when a target is not in the project', async () => {
    const owner = await signupOwner()
    const projectA = await createProject(owner, 'A')
    const projectB = await createProject(owner, 'B')
    const seeded = await seedSong(owner, projectA)
    const mine = await seedSong(owner, projectB)

    const response = await call(owner, 'POST', `/api/live-lab/projects/${projectB}/midi-mappings/bulk`, {
      deviceIdentifier: 'keys-88',
      channel: 0,
      startNote: 60,
      targetType: 'scene',
      // Second id belongs to another project: the whole request must fail.
      targetIds: [mine.scene.id, seeded.scene.id],
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('live.unknown_scene')
    // Nothing was written — not even the valid first target.
    expect(await runtime.liveLab.listMappings(projectB)).toHaveLength(0)
  })

  it('warns before overwriting keys that are already mapped, then replaces on request', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const { scene } = await seedSong(owner, projectId)
    await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings`, {
      deviceIdentifier: 'keys-88',
      channel: 0,
      messageType: 'note_on',
      noteOrController: 60,
      targetType: 'stop',
    })

    const refused = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings/bulk`, {
      deviceIdentifier: 'keys-88',
      channel: 0,
      startNote: 60,
      targetType: 'scene',
      targetIds: [scene.id],
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('live.midi_duplicate')

    const replaced = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings/bulk`, {
      deviceIdentifier: 'keys-88',
      channel: 0,
      startNote: 60,
      targetType: 'scene',
      targetIds: [scene.id],
      replaceExisting: true,
    })
    expect(replaced.statusCode).toBe(200)
    const all = await runtime.liveLab.listMappings(projectId)
    expect(all).toHaveLength(1)
    expect(all[0]!.targetType).toBe('scene')
  })

  it('refuses a run that would pass the top of the keyboard', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const response = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings/bulk`, {
      deviceIdentifier: 'keys-88',
      channel: 0,
      startNote: 120,
      targetType: 'pad',
      targetIds: Array.from({ length: 16 }, (_, i) => `pad:${i}`),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('live.zone_overflow')
  })

  it('validates pad target ids', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const response = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings/bulk`, {
      deviceIdentifier: 'keys-88',
      channel: 0,
      startNote: 36,
      targetType: 'pad',
      targetIds: ['pad:0', 'pad:99'],
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('live.unknown_pad')
  })

  it('requires the midi entitlement', async () => {
    await signupOwner()
    const partner = await secondOrg(['live_lab.access', 'live_lab.projects'])
    const projectId = await createProject(partner)
    const response = await call(partner, 'POST', `/api/live-lab/projects/${projectId}/midi-mappings/bulk`, {
      deviceIdentifier: 'keys-88',
      channel: 0,
      startNote: 60,
      targetType: 'pad',
      targetIds: ['pad:0'],
    })
    expect(response.statusCode).toBe(403)
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

  it('a rejected assign_pad accept leaves no orphan scene behind', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    const { item } = await seedSong(owner, projectId)
    const created = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/ai-scenes`, {
      liveSetItemId: item.id,
      request: aiRequest,
    })
    const jobId = (created.json() as { job: { id: string } }).job.id
    await runtime.liveLabService.runAiJob(jobId)
    const job = await runtime.liveLab.getAiJob(jobId)
    const scenesBefore = await runtime.liveLab.listScenes(projectId)
    const clipsBefore = await runtime.liveLab.listClips(projectId)

    // assign_pad without padIndex is refused — and refused *before* anything
    // is created, so a retry does not accumulate scenes.
    const refused = await call(owner, 'POST', `/api/live-lab/ai-jobs/${jobId}/accept`, {
      assetId: job.outputAssetIds[0],
      mode: 'assign_pad',
      liveSetItemId: item.id,
    })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.code).toBe('live.pad_required')
    expect(await runtime.liveLab.listScenes(projectId)).toHaveLength(scenesBefore.length)
    expect(await runtime.liveLab.listClips(projectId)).toHaveLength(clipsBefore.length)

    // With a pad index it succeeds and binds the pad.
    const accepted = await call(owner, 'POST', `/api/live-lab/ai-jobs/${jobId}/accept`, {
      assetId: job.outputAssetIds[0],
      mode: 'assign_pad',
      liveSetItemId: item.id,
      padIndex: 3,
    })
    expect(accepted.statusCode).toBe(200)
    const project = await runtime.liveLab.getProject(projectId)
    expect(project.padMap[3]!.mode).toBe('scene')
    expect(project.padMap[3]!.targetId).toBe((accepted.json() as { sceneId: string }).sceneId)
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

describe('live set builder', () => {
  it('suggests set structure, clicks and pads — and applies only what was approved', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    // Three songs, one without a BPM; one already has a click stem.
    const first = await seedSong(owner, projectId) // TRACK ONE, bpm 120, has click
    const second = await runtime.liveLab.createItem({ orgId: owner.orgId, liveProjectId: projectId, type: 'song', title: 'TRACK TWO', bpm: 124 })
    const third = await runtime.liveLab.createItem({ orgId: owner.orgId, liveProjectId: projectId, type: 'song', title: 'TRACK THREE' })

    const planResponse = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/build-set`, {})
    expect(planResponse.statusCode).toBe(200)
    const plan = (planResponse.json() as { suggestions: Array<{ id: string; kind: string }> }).suggestions
    const ids = plan.map((s) => s.id)
    expect(ids).toContain('walk_on')
    expect(ids).toContain('interlude')
    expect(ids).toContain('encore')
    expect(ids).toContain('outro')
    expect(ids).toContain(`click:${second.id}`)
    expect(ids).not.toContain(`click:${first.item.id}`) // already has one
    expect(ids).toContain(`bpm:${third.id}`) // informational, not applicable
    expect(ids).toContain('pad_map')

    // Approval is required: apply with nothing approved is refused.
    const refused = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/build-set`, { apply: true })
    expect(refused.statusCode).toBe(400)

    // Approve a subset only.
    const applied = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/build-set`, {
      apply: true,
      suggestionIds: ['walk_on', 'outro', `click:${second.id}`, 'pad_map', `bpm:${third.id}`],
    })
    expect(applied.statusCode).toBe(200)
    expect((applied.json() as { applied: string[] }).applied.sort()).toEqual(['walk_on', `click:${second.id}`, 'outro', 'pad_map'].sort())

    const items = await runtime.liveLab.listItems(projectId)
    const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder)
    // Walk-on first, outro last; unapproved interlude/encore were NOT added.
    expect(ordered[0]!.type).toBe('walk_on')
    expect(ordered.at(-1)!.type).toBe('outro')
    expect(items.some((i) => i.type === 'interlude')).toBe(false)
    expect(items.some((i) => i.type === 'encore')).toBe(false)
    // Existing songs are untouched.
    expect(items.find((i) => i.id === first.item.id)?.title).toBe('TRACK ONE')

    // The click stem exists, is routed to the click output, and its
    // placeholder audio carries approved lineage.
    const stems = await runtime.liveLab.listStems(projectId)
    const click = stems.find((s) => s.liveSetItemId === second.id && s.stemType === 'click')
    expect(click).toBeDefined()
    expect(click!.outputId).toBe('click')
    const clickAsset = await runtime.liveLab.getAsset(click!.sourceAssetId)
    expect(clickAsset.lineage?.provider).toBe('local-synth')
    expect(clickAsset.lineage?.approvedBy).toBe(owner.userId)
    expect(clickAsset.rightsConfirmed).toBe(true)

    // The pad map is populated with a STOP pad and at least one scene pad.
    const project = await runtime.liveLab.getProject(projectId)
    expect(project.padMap.some((p) => p.mode === 'scene')).toBe(true)
    expect(project.padMap[15]!.mode).toBe('stop')

    // Applied suggestions do not come back on the next plan.
    const replan = (await call(owner, 'POST', `/api/live-lab/projects/${projectId}/build-set`, {})).json() as {
      suggestions: Array<{ id: string }>
    }
    const replanIds = replan.suggestions.map((s) => s.id)
    expect(replanIds).not.toContain('walk_on')
    expect(replanIds).not.toContain('outro')
    expect(replanIds).not.toContain(`click:${second.id}`)
    expect(replanIds).toContain('interlude')
    expect(replanIds).toContain('encore')
  })
})

describe('data integrity guards', () => {
  it('normalizes a short pad map to a dense 16-pad grid', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    // A client sending only the pads it changed must not persist holes: the
    // grid is addressed by index everywhere that reads it.
    const response = await call(owner, 'PATCH', `/api/live-lab/projects/${projectId}`, {
      padMap: [{ index: 2, mode: 'stop', label: 'STOP', targetId: null, color: '' }],
    })
    expect(response.statusCode).toBe(200)
    const padMap = (response.json() as { project: { padMap: Array<{ index: number; mode: string } | null> } }).project.padMap
    expect(padMap).toHaveLength(16)
    expect(padMap.every((pad) => pad !== null && pad !== undefined)).toBe(true)
    expect(padMap[2]!.mode).toBe('stop')
    expect(padMap[0]!.mode).toBe('empty')
    // And the set builder can still read it without dereferencing a hole.
    expect((await call(owner, 'POST', `/api/live-lab/projects/${projectId}/build-set`, {})).statusCode).toBe(200)
  })

  it('refuses cross-project set items and assets even within one organization', async () => {
    const owner = await signupOwner()
    const projectA = await createProject(owner, 'Set A')
    const projectB = await createProject(owner, 'Set B')
    const seeded = await seedSong(owner, projectA)

    // A set item from project A cannot receive a stem in project B.
    const stemResponse = await call(owner, 'POST', `/api/live-lab/projects/${projectB}/stems`, {
      liveSetItemId: seeded.item.id,
      stemType: 'drums',
      sourceAssetId: seeded.asset.id,
    })
    expect(stemResponse.statusCode).toBe(403)

    // Nor a scene, nor a clip built from project A's audio.
    const itemB = await runtime.liveLab.createItem({ orgId: owner.orgId, liveProjectId: projectB, type: 'song', title: 'B ONE', bpm: 120 })
    const sceneResponse = await call(owner, 'POST', `/api/live-lab/projects/${projectB}/scenes`, {
      liveSetItemId: itemB.id,
      name: 'HOOK',
      clipAssetId: seeded.asset.id,
    })
    expect(sceneResponse.statusCode).toBe(403)
  })

  it('creates the default outputs exactly once under concurrent reads', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner)
    // Two project GETs racing (StrictMode double-invokes effects) used to
    // insert Master/Cue/Click twice, doubling them in the manifest.
    await Promise.all([
      call(owner, 'GET', `/api/live-lab/projects/${projectId}`),
      call(owner, 'GET', `/api/live-lab/projects/${projectId}`),
      call(owner, 'GET', `/api/live-lab/projects/${projectId}`),
    ])
    const outputs = await runtime.liveLab.listOutputs(projectId)
    expect(outputs).toHaveLength(3)
    expect(outputs.map((o) => o.type).sort()).toEqual(['click', 'cue', 'master'])
  })

  it('accepts a tagless MP3 frame sync, not just ID3 and FF FB', () => {
    // A valid MPEG audio frame sets the 11 sync bits; the layer/bitrate bits
    // that follow vary. Refusing FF FA / FF F3 rejected real MP3 exports.
    for (const second of [0xfb, 0xfa, 0xf3, 0xe0]) {
      expect(sniffMime(new Uint8Array([0xff, second, 0x90, 0x00]))).toBe('audio/mpeg')
    }
    expect(sniffMime(new Uint8Array([0xff, 0x0f, 0x00, 0x00]))).toBeNull()
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

/**
 * Regressions found by review of the duplication, AI-accept and platform
 * provider paths. Each of these passed typecheck and the existing suite.
 */
describe('duplicating a set', () => {
  it('repoints pads at the copies rather than the source project', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner, 'Original')
    const { scene, stem } = await seedSong(owner, projectId)

    // A pad grid wired to the source project's records.
    const padded = await call(owner, 'PATCH', `/api/live-lab/projects/${projectId}`, {
      padMap: [
        { index: 0, mode: 'scene', label: 'HOOK', targetId: scene.id, color: '' },
        { index: 1, mode: 'stem_mute', label: 'CLICK', targetId: stem.id, color: '' },
      ],
    })
    expect(padded.statusCode).toBe(200)

    const duplicated = await call(owner, 'POST', '/api/live-lab/projects', { name: 'Copy', duplicateOf: projectId })
    expect(duplicated.statusCode).toBe(200)
    const copyId = (duplicated.json() as { project: { id: string } }).project.id

    const bundle = (await call(owner, 'GET', `/api/live-lab/projects/${copyId}`)).json() as {
      project: { padMap: Array<{ index: number; mode: string; targetId: string | null }> }
      scenes: Array<{ id: string }>
      stems: Array<{ id: string }>
    }
    const scenePad = bundle.project.padMap.find((p) => p.index === 0)
    const stemPad = bundle.project.padMap.find((p) => p.index === 1)

    // The point: not the source ids, and not dangling — the copies' own ids.
    expect(scenePad?.targetId).not.toBe(scene.id)
    expect(stemPad?.targetId).not.toBe(stem.id)
    expect(bundle.scenes.map((s) => s.id)).toContain(scenePad?.targetId)
    expect(bundle.stems.map((s) => s.id)).toContain(stemPad?.targetId)
  })

  it('clears a pad whose target did not survive instead of leaving it dangling', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner, 'Original')
    await seedSong(owner, projectId)
    await call(owner, 'PATCH', `/api/live-lab/projects/${projectId}`, {
      padMap: [{ index: 2, mode: 'scene', label: 'GONE', targetId: 'lscn_does_not_exist', color: '' }],
    })

    const duplicated = await call(owner, 'POST', '/api/live-lab/projects', { name: 'Copy', duplicateOf: projectId })
    const copyId = (duplicated.json() as { project: { id: string } }).project.id
    const bundle = (await call(owner, 'GET', `/api/live-lab/projects/${copyId}`)).json() as {
      project: { padMap: Array<{ index: number; mode: string; targetId: string | null }> }
    }
    const pad = bundle.project.padMap.find((p) => p.index === 2)
    expect(pad?.mode).toBe('empty')
    expect(pad?.targetId).toBeNull()
  })

  it('remaps follow targets and never points one at the source project', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner, 'Original')
    const { item, scene } = await seedSong(owner, projectId)
    const second = await runtime.liveLab.createScene({
      orgId: owner.orgId,
      liveProjectId: projectId,
      liveSetItemId: item.id,
      name: 'OUTRO',
      sceneType: 'outro',
      bars: 2,
    })
    await runtime.liveLab.updateScene(scene.id, { followAction: 'target', followTargetSceneId: second.id })

    const duplicated = await call(owner, 'POST', '/api/live-lab/projects', { name: 'Copy', duplicateOf: projectId })
    const copyId = (duplicated.json() as { project: { id: string } }).project.id
    const scenes = await runtime.liveLab.listScenes(copyId)
    const hook = scenes.find((s) => s.name === 'HOOK')
    const outro = scenes.find((s) => s.name === 'OUTRO')

    expect(hook?.followAction).toBe('target')
    expect(hook?.followTargetSceneId).toBe(outro?.id)
    expect(hook?.followTargetSceneId).not.toBe(second.id)
  })

  it('leaves no project behind when the source cannot be duplicated', async () => {
    const owner = await signupOwner()
    const partner = await secondOrg()
    const theirs = await createProject(partner, 'Theirs')

    const before = (await call(owner, 'GET', '/api/live-lab/projects')).json() as { projects: unknown[] }
    const refused = await call(owner, 'POST', '/api/live-lab/projects', { name: 'Steal', duplicateOf: theirs })
    expect(refused.statusCode).toBeGreaterThanOrEqual(400)

    // The orphan used to count against live_lab.max_projects forever.
    const after = (await call(owner, 'GET', '/api/live-lab/projects')).json() as { projects: unknown[] }
    expect(after.projects.length).toBe(before.projects.length)
  })
})

describe('accepting an AI scene', () => {
  it('refuses to replace a scene belonging to another project', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner, 'Set A')
    const otherId = await createProject(owner, 'Set B')
    await seedSong(owner, projectId)
    const other = await seedSong(owner, otherId)

    const created = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/ai-scenes`, {
      request: {
        prompt: 'a dark rolling bassline',
        bars: 4,
        tempoBehavior: 'keep',
        keyBehavior: 'keep',
        energy: 'high',
        instrumentation: ['bass'],
        intendedTransition: '',
        rightsConfirmed: true,
      },
    })
    expect(created.statusCode).toBe(200)
    const jobId = (created.json() as { job: { id: string } }).job.id
    await runtime.liveLabService.runAiJob(jobId)
    const job = await runtime.liveLab.getAiJob(jobId)
    const assetId = job.outputAssetIds[0] ?? ''

    const clipsBefore = (await runtime.liveLab.listClips(otherId)).filter((c) => c.liveSceneId === other.scene.id)
    const refused = await call(owner, 'POST', `/api/live-lab/ai-jobs/${jobId}/accept`, {
      assetId,
      mode: 'replace_scene',
      sceneId: other.scene.id,
    })
    expect(refused.statusCode).toBe(403)

    // Same org, but another project — its clips must be untouched.
    const clipsAfter = (await runtime.liveLab.listClips(otherId)).filter((c) => c.liveSceneId === other.scene.id)
    expect(clipsAfter.map((c) => c.id)).toEqual(clipsBefore.map((c) => c.id))
  })

  it('does not stamp lineage approval on a request it rejects', async () => {
    const owner = await signupOwner()
    const projectId = await createProject(owner, 'Set A')
    await seedSong(owner, projectId)

    const created = await call(owner, 'POST', `/api/live-lab/projects/${projectId}/ai-scenes`, {
      request: {
        prompt: 'a warm pad wash',
        bars: 4,
        tempoBehavior: 'keep',
        keyBehavior: 'keep',
        energy: 'low',
        instrumentation: ['pad'],
        intendedTransition: '',
        rightsConfirmed: true,
      },
    })
    const jobId = (created.json() as { job: { id: string } }).job.id
    await runtime.liveLabService.runAiJob(jobId)
    const job = await runtime.liveLab.getAiJob(jobId)
    const assetId = job.outputAssetIds[0] ?? ''

    // replace_scene with no sceneId is rejected after the approval used to run.
    const refused = await call(owner, 'POST', `/api/live-lab/ai-jobs/${jobId}/accept`, { assetId, mode: 'replace_scene' })
    expect(refused.statusCode).toBe(400)

    const asset = await runtime.liveLab.getAsset(assetId)
    const lineage = (asset.lineage ?? {}) as Record<string, unknown>
    expect(lineage.approvedBy ?? null).toBeNull()
  })
})
