import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { ffmpeg } from '@masterclip/media-tools'
import { loadConfig, sha256File, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'

let app: FastifyInstance
let rt: Runtime
let db: Db
let root = ''
let userId = ''
let orgId = ''
let projectId = ''
let audioId = ''
let session = ''
let csrf = ''

beforeEach(async () => {
  db = await createTestDb()
  root = await mkdtemp(join(tmpdir(), 'motion-wave-api-'))
  const config = loadConfig({
    NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', STORAGE_LOCAL_ROOT: root,
    ASSET_SIGNING_SECRET: 'waveform-test-key', SESSION_SECRET: 'waveform-test-session', LOG_LEVEL: 'error',
  }, true)
  rt = await createRuntime({ db, config, mockOnly: true, logger: silentLogger,
    storage: new LocalStorage({ root, signingSecret: 'waveform-test-key' }) })
  app = await buildServer({ runtime: rt, logger: silentLogger })
  await app.ready()
  const signed = await app.inject({ method: 'POST', url: '/api/auth/signup',
    payload: { email: 'director@example.test', password: 'secure-password-123', displayName: 'Director', orgName: 'First Org' } })
  expect(signed.statusCode).toBe(200)
  userId = signed.json().user.id
  orgId = signed.json().org.id
  session = signed.cookies.find(c => c.name === SESSION_COOKIE)?.value ?? ''
  csrf = signed.cookies.find(c => c.name === CSRF_COOKIE)?.value ?? ''
  const proj = await rt.projects.create({ orgId, name: 'Song Video Pilot', createdBy: userId })
  projectId = proj.id

  const path = join(root, 'song.wav')
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', path])
  const sha = await sha256File(path)
  const stored = await rt.storage.putFile(`${projectId}/audio/fixture/song.wav`, path, { contentType: 'audio/wav', sha256: sha })
  const recording = await rt.assets.create({
    projectId, kind: 'audio', storageKey: stored.key, filename: 'song.wav',
    mime: 'audio/wav', bytes: stored.bytes, sha256: stored.sha256,
    durationSeconds: 3, createdBy: userId,
    rights: { owner: 'The Artist', authorized: true, consent: 'authorized', allowedUse: 'promotional video' },
  })
  audioId = recording.id
}, 90_000)

afterEach(async () => {
  await app?.close()
  await rt?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('MOTION native audio permissions', () => {
  it('requires authentication for real waveform data', async () => {
    const refused = await app.inject({ method: 'GET', url: `/api/assets/${audioId}/waveform` })
    expect(refused.statusCode).toBe(401)
    const response = await app.inject({ method: 'GET', url: `/api/assets/${audioId}/waveform`,
      cookies: { [SESSION_COOKIE]: session } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ assetId: audioId, source: 'decoded_pcm' })
    expect(response.json().peaks).toHaveLength(160)
  }, 80_000)

  it('authorizes beat analysis for the project and rejects revoked audio', async () => {
    const url = `/api/assets/${audioId}/beats`
    const anonymous = await app.inject({ method: 'GET', url })
    expect(anonymous.statusCode).toBe(401)
    const authorized = await app.inject({
      method: 'GET', url, cookies: { [SESSION_COOKIE]: session },
    })
    expect(authorized.statusCode).toBe(200)
    expect(authorized.json()).toMatchObject({ assetId: audioId, source: 'decoded_pcm_onset', analysisVersion: 1 })
    expect(typeof authorized.json().confidence).toBe('number')
    await rt.assets.setRights(audioId, { consent: 'revoked', authorized: false }, userId)
    const refused = await app.inject({
      method: 'GET', url, cookies: { [SESSION_COOKIE]: session },
    })
    expect(refused.statusCode).toBe(403)
  }, 90_000)

  it('does not reveal waveform across organization boundaries', async () => {
    const other = await rt.projects.createOrg('Other Org')
    await rt.auth.createUser({ orgId: other.id, email: 'other@example.test',
      password: 'secure-password-456', displayName: 'Other', orgRole: 'owner' })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email: 'other@example.test', password: 'secure-password-456' } })
    expect(login.statusCode).toBe(200)
    const otherSession = login.cookies.find(c => c.name === SESSION_COOKIE)?.value ?? ''
    const denied = await app.inject({ method: 'GET', url: `/api/assets/${audioId}/waveform`,
      cookies: { [SESSION_COOKIE]: otherSession } })
    expect(denied.statusCode).toBe(403)
  })

  it('saves a promotional-use-attested music cue on an existing authorized project', async () => {
    const created = await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/quick-create`,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { title: 'Teaser', creativeDirection: 'One practical lamp lights the singer in a grounded room.',
        audioAssetId: audioId, startSeconds: 0.5, endSeconds: 2.5, look: 'cinematic',
        promotionalUseAttested: true },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({ status: 'draft', audioEmbedded: false, rendered: false })
    const version = await rt.projects.currentVersion(created.json().shotId)
    expect(version.spec.music_cue).toMatchObject({
      asset_id: audioId, start_seconds: 0.5, end_seconds: 2.5, promotional_use_attested: true,
    })
  })

  it('protects canonical scene handoffs across projects and after audio revocation', async () => {
    const endpoint = `/api/projects/${projectId}/scene-plan/handoff`
    const payload = {
      requestId:'47bdfe90-ea24-4baa-ad34-9d4df4f33c1e',
      reviewed:true,promotionalUseAttested:true,audioAssetId:audioId,
      songStartSeconds:.25,songEndSeconds:2.25,
      title:'Artist checked camera plan',sectionLabel:'Intro',
      narrativePurpose:'Vocal performance in a real recording room',
      cameraDirection:'Slow inward dolly',performanceDirection:'Singer moves toward a single lamp',
      visualTreatment:'Practical light and natural material detail',aspectRatio:'16:9',
    }
    const anonymous=await app.inject({method:'POST',url:endpoint,payload})
    expect(anonymous.statusCode).toBe(401)
    const other=await rt.projects.createOrg('Separate Music Company')
    await rt.auth.createUser({
      orgId:other.id,email:'foreign-handoff@example.test',
      password:'safe-password-456',displayName:'Foreign',orgRole:'owner',
    })
    const login=await app.inject({method:'POST',url:'/api/auth/login',
      payload:{email:'foreign-handoff@example.test',password:'safe-password-456'}})
    const otherSession=login.cookies.find(c=>c.name===SESSION_COOKIE)?.value??''
    const otherCsrf=login.cookies.find(c=>c.name===CSRF_COOKIE)?.value??''
    const foreign=await app.inject({method:'POST',url:endpoint,
      cookies:{[SESSION_COOKIE]:otherSession,[CSRF_COOKIE]:otherCsrf},
      headers:{[CSRF_HEADER]:otherCsrf},payload})
    expect(foreign.statusCode).toBe(403)
    const created=await app.inject({method:'POST',url:endpoint,
      cookies:{[SESSION_COOKIE]:session,[CSRF_COOKIE]:csrf},
      headers:{[CSRF_HEADER]:csrf},payload})
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({rendered:false,queued:false})
    const original=await rt.projects.currentVersion(created.json().shotId)
    expect(original.spec.music_cue?.asset_id).toBe(audioId)
    await rt.assets.setRights(audioId,{consent:'revoked',authorized:false},userId)
    const revoked=await app.inject({method:'POST',url:endpoint,
      cookies:{[SESSION_COOKIE]:session,[CSRF_COOKIE]:csrf},
      headers:{[CSRF_HEADER]:csrf},payload})
    expect(revoked.statusCode).toBe(403)
  })

  it('persists project-owned creative treatments and refuses duplicate names', async () => {
    const path = `/api/projects/${projectId}/creative-treatments`
    const withoutSession = await app.inject({ method: 'POST', url: path, payload: {
      name: 'After dark', look: 'cinematic', aspect_ratio: '9:16', direction: 'One red practical behind the singer.'
    } })
    expect(withoutSession.statusCode).toBe(401)
    const created = await app.inject({
      method: 'POST', url: path,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { name: 'After dark', look: 'cinematic', aspect_ratio: '9:16', direction: 'One red practical behind the singer.' },
    })
    expect(created.statusCode).toBe(200)
    expect((await rt.projects.get(projectId)).styleBible.saved_treatments).toMatchObject([
      { name: 'After dark', look: 'cinematic', aspect_ratio: '9:16' },
    ])
    const listed = await app.inject({ method: 'GET', url: path, cookies: { [SESSION_COOKIE]: session } })
    expect(listed.json().treatments).toHaveLength(1)
    const duplicate = await app.inject({
      method: 'POST', url: path,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { name: 'AFTER DARK', look: 'editorial', aspect_ratio: '4:5', direction: 'A clean editorial sequence.' },
    })
    expect(duplicate.statusCode).toBe(409)
  })

  it('saves a source-linked visual alternative with captions without rendering it', async () => {
    const created = await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/quick-create`,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: {
        title: 'Performance original',
        creativeDirection: 'Performing below a believable fluorescent ceiling fixture.',
        audioAssetId: audioId,
        startSeconds: 0.5, endSeconds: 2.5,
        promotionalUseAttested: true,
        captions: [{ start_seconds: 0, end_seconds: 1.3, text: 'Opening hook' }],
      },
    })
    expect(created.statusCode).toBe(200)
    const response = await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/quick-variants`,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { sourceShotId: created.json().shotId, label: 'Alternate angle',
        direction: 'Slow, physically grounded tracking shot to the vocalist.', look: 'editorial' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ sourceShotId: created.json().shotId, status: 'draft', rendered: false })
    const version = await rt.projects.currentVersion(response.json().shotId)
    expect(version.spec.creative_variant?.source_shot_id).toBe(created.json().shotId)
    expect(version.spec.timed_captions[0]?.text).toBe('Opening hook')
    expect(version.spec.music_cue?.creative_look).toBe('editorial')
    expect(await rt.renders.listOutputs({ shotId: response.json().shotId })).toHaveLength(0)
  })

  it('refuses already-signed local audio links after rights revocation', async () => {
    const getLink = () => app.inject({
      method: 'GET', url: `/api/assets/${audioId}/url`,
      cookies: { [SESSION_COOKIE]: session },
    })
    const before = await getLink()
    expect(before.statusCode).toBe(200)
    const signedUrl = String(before.json().url)
    expect(signedUrl).toContain('/api/assets/raw')
    const playable = await app.inject({ method: 'GET', url: signedUrl })
    expect(playable.statusCode).toBe(200)

    await rt.assets.setRights(audioId, { consent: 'revoked', authorized: false }, userId)
    const refusedNew = await getLink()
    expect(refusedNew.statusCode).toBe(403)
    const refusedOld = await app.inject({ method: 'GET', url: signedUrl })
    expect(refusedOld.statusCode).toBe(403)

    // Keep the record visible to its owner, but never mint playable URLs.
    const listed = await app.inject({
      method: 'GET', url: `/api/projects/${projectId}/assets`,
      cookies: { [SESSION_COOKIE]: session },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().assets.find((item: {id:string})=>item.id===audioId)?.url).toBeNull()
  })

  it('saves artist-labelled sections only on the authorized project with a version check', async () => {
    const url=`/api/projects/${projectId}/music-structure/${audioId}`
    const cookies={ [SESSION_COOKIE]:session,[CSRF_COOKIE]:csrf }
    const before=await app.inject({method:'GET',url,cookies})
    expect(before.statusCode).toBe(200)
    expect(before.json()).toMatchObject({version:0,sections:[]})
    const sections=[{id:'intro-1',kind:'intro',label:'Intro',start_seconds:0,end_seconds:1.5},
      {id:'hook-1',kind:'chorus',label:'Hook',start_seconds:1.5,end_seconds:2.5}]
    const saved=await app.inject({method:'PUT',url,cookies,headers:{[CSRF_HEADER]:csrf},
      payload:{expectedVersion:0,sections}})
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({version:1,sections})
    const repeated=await app.inject({method:'PUT',url,cookies,headers:{[CSRF_HEADER]:csrf},
      payload:{expectedVersion:0,sections}})
    expect(repeated.statusCode).toBe(409)
    const crossing=await app.inject({method:'PUT',url,cookies,headers:{[CSRF_HEADER]:csrf},
      payload:{expectedVersion:1,sections:[{...sections[0],end_seconds:2},sections[1]]}})
    expect(crossing.statusCode).toBe(400)
    await rt.assets.setRights(audioId,{consent:'revoked',authorized:false},userId)
    const blocked=await app.inject({method:'GET',url,cookies})
    expect(blocked.statusCode).toBe(403)
  })

  it('refuses an audio source when its consent has been revoked', async () => {
    await rt.assets.setRights(audioId, { consent: 'revoked', authorized: false }, userId)
    const denied = await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/quick-create`,
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
      payload: { title: 'Teaser', creativeDirection: 'One practical lamp lights the performer.',
        audioAssetId: audioId, startSeconds: 0.5, endSeconds: 2.5, promotionalUseAttested: true },
    })
    expect(denied.statusCode).toBe(403)
  })
})
