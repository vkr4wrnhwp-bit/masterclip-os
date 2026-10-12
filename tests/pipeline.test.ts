import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, toNum, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { formatUsd, loadConfig, sha256File, silentLogger, usdToMicros } from '@masterclip/shared'
import { ffmpeg, probe } from '@masterclip/media-tools'
import { JOB_TYPES, QueueWorker } from '@masterclip/queue'
import { emptyShot, CharacterRecord, EnvironmentRecord } from '@masterclip/shot-schema'
import { createRuntime, MasterService, MediaFinishLease, assembleApprovedTimeline, signedReadableUrl, RenderService, finishCaptionedSongMoment, QUEUES, type Runtime } from '@masterclip/runtime'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../apps/api/src/security/csrf.js'

/**
 * End-to-end pipeline test.
 *
 * Runs the real factory against the mock provider: plan → authorize → submit →
 * poll → download → verify → technical QC → derivatives → review → promote →
 * finish → package. Everything here is genuine — real MP4s from ffmpeg, real
 * ffprobe measurements, real ledger rows — and nothing is billable.
 */
let runtime: Runtime
let db: Db
let storageRoot: string
let projectId: string
let shotId: string
let orgId: string

async function drain(render: RenderService, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    let processed = 0
    for (const queueName of [QUEUES.render, QUEUES.qc, QUEUES.media]) {
      const worker = new QueueWorker(runtime.queue, { queueName, concurrency: 1, logger: silentLogger })
      worker.register<{ jobId: string }>(JOB_TYPES.submitRender, async ({ jobId }) => void (await render.submitRender(jobId)))
      worker.register<{ jobId: string }>(JOB_TYPES.pollRender, async ({ jobId }, ctx) => {
        const result = await render.pollRender(jobId)
        if (!result.done) ctx.defer(0)
      })
      worker.register<{ jobId: string }>(JOB_TYPES.ingestOutput, async ({ jobId }) => void (await render.ingestOutputs(jobId)))
      worker.register<{ outputId: string }>(JOB_TYPES.runTechnicalQc, async ({ outputId }) => void (await render.runQc(outputId)))
      worker.register<{ outputId: string }>(JOB_TYPES.buildProxies, async ({ outputId }) => void (await render.buildDerivatives(outputId)))
      processed += await worker.runOnce(60)
    }
    if (processed === 0) break
  }
}

beforeEach(async () => {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'masterclip-pipeline-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'pipeline-test-secret',
      SESSION_SECRET: 'pipeline-test-session-secret',
      PROVIDER_POLL_INTERVAL_MS: '0',
    },
    true,
  )

  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'pipeline-test-secret' }),
  })

  // Default mock latency is 1.5s of simulated provider time; the drain loop
  // runs synchronously, so re-register with zero latency for tests.
  const { createMockProvider } = await import('@masterclip/provider-mock')
  runtime.registry.register(
    createMockProvider({
      logger: silentLogger,
      sandbox: true,
      publicBaseUrl: '',
      now: () => Date.now(),
      workDir: join(storageRoot, 'mock'),
      latencyMs: 0,
      defectRate: 0,
      failureRate: 0,
    }),
  )

  const org = await runtime.projects.createOrg('Test Org')
  orgId = org.id
  const project = await runtime.projects.create({ orgId, name: 'Pipeline Project', createdBy: 'tester' })
  projectId = project.id
  await runtime.cost.budgetStore.ensureDefaults('project', projectId)

  await runtime.bibles.createCharacter({
    projectId,
    createdBy: 'tester',
    record: CharacterRecord.parse({ character_key: 'NOVA', name: 'Nova', hair: 'wet dark bob', wardrobe: ['black leather jacket'] }),
  })
  await runtime.bibles.createEnvironment({
    projectId,
    createdBy: 'tester',
    record: EnvironmentRecord.parse({ environment_key: 'ALLEY', name: 'Rain alley' }),
  })

  const created = await runtime.projects.createShot({
    projectId,
    createdBy: 'tester',
    spec: emptyShot({
      shot_id: 'S01',
      title: 'Nova under the sign',
      generation_mode: 'text_to_video',
      action: 'she turns toward the street',
      camera_position: 'medium, chest height',
      camera_movement: 'slow dolly in',
      duration_seconds: 4,
      target_resolution: '480p',
      aspect_ratio: '16:9',
      max_cost_usd: 2,
      environment_lock: { environment_key: 'ALLEY', environment_version: 0, strength: 'strict' },
      lighting: {
        dominant_source: 'magenta neon sign',
        source_position: 'high camera left',
        color_temperature: 'magenta',
        falloff: 'rapid',
        shadow_behavior: 'hard',
        practicals: [],
      },
    }),
  })
  shotId = created.shot.id
})

afterEach(async () => {
  await runtime.close()
  await rm(storageRoot, { recursive: true, force: true })
})

function candidates(count: number, modelId = 'mock-standard') {
  return Array.from({ length: count }, (_, index) => ({
    providerId: 'mock',
    modelId,
    seed: null,
    variationLabel: `v${index}`,
    variationInstruction: index === 0 ? '' : `variation ${index}`,
    resolution: '480p',
    aspectRatio: '16:9',
    durationSeconds: 4,
  }))
}

describe('render pipeline', () => {
  it('carries a shot from plan to a packaged master', async () => {
    const render = new RenderService(runtime)

    // --- plan: quotes and authorization happen before anything is queued ----
    const plan = await render.planBatch({ projectId, shotId, batchName: 'test batch', candidates: candidates(3), createdBy: 'tester', orgId })
    expect(plan.jobIds).toHaveLength(3)
    expect(plan.estimatedMicros).toBeGreaterThan(0)

    await drain(render)

    // --- outputs exist, are real files, and have derivatives ---------------
    const outputs = await runtime.renders.listOutputs({ shotId })
    expect(outputs).toHaveLength(3)
    for (const output of outputs) {
      expect(output.sha256).toHaveLength(64)
      expect(output.proxyAssetId).toBeTruthy()
      expect(output.thumbnailAssetId).toBeTruthy()
      expect(output.contactSheetAssetId).toBeTruthy()

      const asset = await runtime.assets.get(output.assetId)
      expect(asset.bytes).toBeGreaterThan(1000)
      expect(asset.metadata.prompt).toBeTruthy()
      // Provenance: the render points back at the shot version it came from.
      expect(asset.metadata.shot_version_id).toBeTruthy()
    }

    // --- QC ran on every candidate ----------------------------------------
    for (const output of outputs) {
      const qc = await runtime.renders.qcFor(output.id)
      expect(qc.some((row) => row.layer === 'technical')).toBe(true)
      expect(qc.some((row) => row.layer === 'combined')).toBe(true)
    }

    // --- the ledger recorded both intent and charge, as sandbox ------------
    const ledger = await db.query<{ entry_type: string; sandbox: number; total: number }>(
      'SELECT entry_type, sandbox, SUM(micros) AS total FROM cost_ledger GROUP BY entry_type, sandbox',
    )
    expect(ledger.find((row) => row.entry_type === 'estimate')).toBeDefined()
    expect(ledger.find((row) => row.entry_type === 'charge')).toBeDefined()
    expect(ledger.every((row) => toNum(row.sandbox) === 1)).toBe(true)
    // Sandbox spend must never touch the live-spend allowance.
    expect(await runtime.ledger.totalLiveSpend()).toBe(0)

    // --- review and promotion ---------------------------------------------
    const passing = outputs.find((output) => output.status !== 'qc_failed') ?? outputs[0]!
    await expect(
      new MasterService(runtime).promote({ outputId: passing.id, name: 'S01 master', approvedBy: 'tester', orgId }),
    ).rejects.toThrow(/human approval/)

    await runtime.renders.addReview({
      outputId: passing.id,
      projectId,
      shotId,
      userId: 'tester',
      decision: 'approve',
      rejectionReasons: [],
      note: 'good take',
    })

    const masters = new MasterService(runtime)
    const masterId = await masters.promote({ outputId: passing.id, name: 'S01 master', approvedBy: 'tester', orgId })
    expect(masterId).toBeTruthy()

    // --- finishing and packaging ------------------------------------------
    const deliverables = await masters.finish(masterId, [{ format: 'delivery_h264' }], 'tester')
    expect(deliverables).toHaveLength(1)

    const built = await masters.buildPackage(masterId, join(storageRoot, 'packages'))
    expect(built.files.length).toBeGreaterThan(2)
    expect(built.manifestPath).toContain('provenance.json')

    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(built.manifestPath, 'utf8'))
    expect(manifest.generation.provider).toBe('mock')
    expect(manifest.generation.compiledPrompt).toContain('ALLEY')
    expect(manifest.canonicalShot.shot_id).toBe('S01')
    expect(manifest.cost.sandbox).toBe(true)
    expect(manifest.disclaimers.join(' ')).toMatch(/No AI upscaling or frame interpolation/)

    // --- metrics reflect what actually happened ---------------------------
    const metrics = await runtime.metrics.projectMetrics(projectId)
    expect(metrics.submittedCount).toBe(3)
    expect(metrics.approvedCount).toBe(1)
    expect(metrics.costPerApprovedSecond).not.toBeNull()
  })

  it('finishes a human-approved MOTION video using an exact, rights-checked song cue', async () => {
    const audioPath = join(storageRoot, 'original-track.wav')
    await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=740:duration=6', '-c:a', 'pcm_s16le', audioPath])
    const inputSha = await sha256File(audioPath)
    const stored = await runtime.storage.putFile(`${projectId}/audio/test-song/track.wav`, audioPath, {
      contentType: 'audio/wav', sha256: inputSha,
    })
    const song = await runtime.assets.create({
      projectId, kind: 'audio', storageKey: stored.key,
      filename: 'track.wav', mime: 'audio/wav', bytes: stored.bytes, sha256: stored.sha256,
      durationSeconds: 6, createdBy: 'tester',
      rights: { owner: 'Authorized Artist', authorized: true, consent: 'authorized', allowedUse: 'promotional video' },
    })

    const current = await runtime.projects.currentVersion(shotId)
    const version = await runtime.projects.addVersion({
      shotId, createdBy: 'tester', note: 'authorized music cue',
      spec: {
        ...current.spec,
        music_cue: {
          asset_id: song.id, start_seconds: 1, end_seconds: 4,
          creative_look: 'cinematic', promotional_use_attested: true,
        },
        timed_captions: [{ start_seconds: 0.3, end_seconds: 2.4, text: 'SIGNED OFF BY THE DIRECTOR' }],
      },
    })
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'music-video', candidates: candidates(1), createdBy: 'tester', orgId })
    await drain(render)
    const outputs = await runtime.renders.listOutputs({ shotId })
    const candidate = outputs[0]
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error('sandbox did not produce a valid output')
    await runtime.renders.addReview({
      outputId: candidate.id, projectId, shotId, userId: 'tester',
      decision: 'approve', rejectionReasons: [], note: 'director approved',
    })
    const masters = new MasterService(runtime)
    const masterId = await masters.promote({ outputId: candidate.id, name: 'Music Master', approvedBy: 'tester', orgId })
    // Lease owner recovery and a stale worker's failed commit are deterministic
    // without timeouts or paid providers.
    const staleLease = await MediaFinishLease.acquire(runtime, masterId)
    await expect(MediaFinishLease.acquire(runtime, masterId))
      .rejects.toMatchObject({ code: 'media_finish.busy' })
    await runtime.db.run(
      'UPDATE media_finish_leases SET expires_at = ? WHERE master_id = ?',
      ['2000-01-01T00:00:00.000Z', masterId],
    )
    const recoveredLease = await MediaFinishLease.acquire(runtime, masterId)
    await expect(staleLease.commit(async () => 'should never be committed'))
      .rejects.toMatchObject({ code: 'media_finish.lease_lost' })
    await staleLease.release()
    await recoveredLease.commit(async tx => {
      await recoveredLease.assertAudioStillAuthorized(tx, song.id, projectId)
    })
    await recoveredLease.release()


    // A newly opened browser can recover job state from the server rather
    // than the previous tab's volatile React state. Only an owner/director
    // may request a replay of a genuinely failed, nonbillable media job.
    await runtime.auth.createUser({
      orgId, email: 'finish-director@example.test',
      password: 'strong-test-password-123', displayName: 'Finish Director', orgRole: 'owner',
    })
    const server = await buildServer({ runtime, logger: silentLogger })
    await server.ready()
    try {
      const login = await server.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { email: 'finish-director@example.test', password: 'strong-test-password-123' },
      })
      expect(login.statusCode).toBe(200)
      const token = login.cookies.find(cookie => cookie.name === SESSION_COOKIE)?.value ?? ''
      const csrf = login.cookies.find(cookie => cookie.name === CSRF_COOKIE)?.value ?? ''
      const cookies = { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf }
      // The new non-destructive Music Video Timeline only accepts approved
      // project masters and rights-cleared music, and makes real signed
      // preview references without running a generation provider.
      const timelineBase = `/api/projects/${projectId}/music-timelines`
      const sourceReply = await server.inject({ method: 'GET', url: timelineBase + '/sources', cookies })
      expect(sourceReply.statusCode).toBe(200)
      expect(sourceReply.json().videos.some((v: {masterId:string})=>v.masterId===masterId)).toBe(true)
      expect(sourceReply.json().audio.some((a:{id:string})=>a.id===song.id)).toBe(true)
      // Artist review is the only entry into canonical Shot Builder. No
      // provider job is queued, and replaying the same human action is safe.
      const handoffPath = `/api/projects/${projectId}/scene-plan/handoff`
      const reviewRequest={
        requestId:'8f63fa25-cbbb-4d19-84b5-a7d1a931b71f',
        reviewed:true,promotionalUseAttested:true,
        audioAssetId:song.id,songStartSeconds:1,songEndSeconds:3.5,
        title:'Human-approved hook sequence',sectionLabel:'Artist-labelled verse',
        narrativePurpose:'Perform in a physical architectural room with a motivated camera',
        cameraDirection:'Slow centered dolly move',performanceDirection:'Controlled vocal delivery',
        visualTreatment:'Natural lighting and realistic material depth',
        aspectRatio:'9:16',
      }
      const beforeHandoffJobs=await runtime.queue.list()
      const pendingReview=await server.inject({
        method:'POST',url:handoffPath,cookies,headers:{[CSRF_HEADER]:csrf},
        payload:{...reviewRequest,reviewed:false},
      })
      expect(pendingReview.statusCode).toBe(400)
      const firstHandoff=await server.inject({
        method:'POST',url:handoffPath,cookies,headers:{[CSRF_HEADER]:csrf},
        payload:reviewRequest,
      })
      expect(firstHandoff.statusCode).toBe(200)
      expect(firstHandoff.json()).toMatchObject({deduped:false,rendered:false,queued:false})
      const canonicalShotId=firstHandoff.json().shotId
      const canonicalDetails=await server.inject({
        method:'GET',url:'/api/shots/'+canonicalShotId,cookies,
      })
      expect(canonicalDetails.statusCode).toBe(200)
      expect(canonicalDetails.json().version.spec).toMatchObject({
        generation_mode:'text_to_video',audio_mode:'none',
        music_cue:{asset_id:song.id,start_seconds:1,end_seconds:3.5},
        approval_requirements:['human_review_required','director_approval'],
      })
      const againHandoff=await server.inject({
        method:'POST',url:handoffPath,cookies,headers:{[CSRF_HEADER]:csrf},
        payload:reviewRequest,
      })
      expect(againHandoff.statusCode).toBe(200)
      expect(againHandoff.json()).toMatchObject({
        shotId:canonicalShotId,deduped:true,queued:false,rendered:false,
      })
      const changedHandoff=await server.inject({
        method:'POST',url:handoffPath,cookies,headers:{[CSRF_HEADER]:csrf},
        payload:{...reviewRequest,cameraDirection:'Different camera for same request key'},
      })
      expect(changedHandoff.statusCode).toBe(409)
      const afterHandoffJobs=await runtime.queue.list()
      expect(afterHandoffJobs.map(job=>job.id)).toEqual(beforeHandoffJobs.map(job=>job.id))

      const sequence = {
        name: 'Director first cut', audio_asset_id: song.id, song_start_seconds: 1,
        clips: [
          { master_id: masterId, source_start_seconds: 0, source_end_seconds: 1.5 },
          { master_id: masterId, source_start_seconds: 1.5, source_end_seconds: 3 },
        ],
      }
      const savedCut = await server.inject({
        method: 'POST', url: timelineBase, cookies,
        headers: { [CSRF_HEADER]: csrf }, payload: sequence,
      })
      expect(savedCut.statusCode).toBe(200)
      expect(savedCut.json()).toMatchObject({version:1,status:'saved',rendered:false})
      const timelineId = savedCut.json().timelineId
      const preview = await server.inject({
        method: 'GET', url: timelineBase + '/' + timelineId + '/preview', cookies,
      })
      expect(preview.statusCode).toBe(200)
      expect(preview.json()).toMatchObject({durationSeconds:3,rendered:false})
      expect(preview.json().clips).toHaveLength(2)
      expect(preview.json().clips[0].videoUrl).toContain('sig=')
      expect(preview.json().audioUrl).toContain('sig=')
      const requestAssembly=await server.inject({
        method:'POST',url:timelineBase+'/'+timelineId+'/assemble',cookies,
        headers:{[CSRF_HEADER]:csrf},
      })
      expect(requestAssembly.statusCode).toBe(200)
      expect(requestAssembly.json()).toMatchObject({status:'queued',version:1})
      const assemblyJob=await runtime.queue.get(requestAssembly.json().jobId)
      expect(assemblyJob?.type).toBe(JOB_TYPES.assembleMusicTimeline)
      const assemblyResult=await assembleApprovedTimeline(runtime,assemblyJob!.payload as Parameters<typeof assembleApprovedTimeline>[1])
      expect(assemblyResult.reused).toBe(false)
      const realAssembly=await runtime.assets.get(assemblyResult.assetId)
      const measuredAssembly=await probe(runtime.storage.localPath(realAssembly.storageKey)!)
      expect(measuredAssembly.video).not.toBeNull()
      expect(measuredAssembly.audio).not.toBeNull()
      expect(measuredAssembly.durationSeconds).toBeGreaterThan(2.55)
      expect(measuredAssembly.durationSeconds).toBeLessThan(3.45)
      const ancestry=(await runtime.assets.lineage(realAssembly.id)).parents.map(p=>p.assetId)
      expect(ancestry).toEqual(expect.arrayContaining([candidate.assetId,song.id]))
      const reuse=await assembleApprovedTimeline(runtime,assemblyJob!.payload as Parameters<typeof assembleApprovedTimeline>[1])
      expect(reuse).toMatchObject({assetId:realAssembly.id,reused:true})
      await runtime.queue.complete(requestAssembly.json().jobId)
      const publicResult=await server.inject({
        method:'GET',url:timelineBase+'/'+timelineId+'/exports',cookies,
      })
      expect(publicResult.statusCode).toBe(200)
      expect(publicResult.json().exports).toHaveLength(1)
      expect(publicResult.json().exports[0].url).toContain('sig=')
      expect(publicResult.json().latestJob).toMatchObject({id:requestAssembly.json().jobId,status:'completed'})

      const updatedCut = await server.inject({
        method:'PUT',url:timelineBase+'/'+timelineId,cookies,
        headers:{[CSRF_HEADER]:csrf}, payload:{expectedVersion:1,spec:{...sequence,name:'Director second cut'}},
      })
      expect(updatedCut.statusCode).toBe(200)
      expect(updatedCut.json().version).toBe(2)
      const staleVersion = await server.inject({
        method:'PUT',url:timelineBase+'/'+timelineId,cookies,
        headers:{[CSRF_HEADER]:csrf},payload:{expectedVersion:1,spec:sequence},
      })
      expect(staleVersion.statusCode).toBe(409)
      const forbiddenClip = await server.inject({
        method:'POST',url:timelineBase,cookies,headers:{[CSRF_HEADER]:csrf},
        payload:{...sequence,clips:[{master_id:'not-a-project-master',source_start_seconds:0,source_end_seconds:3}]},
      })
      expect(forbiddenClip.statusCode).not.toBe(200)

      const queued = await runtime.queue.enqueue({
        queue: QUEUES.media, type: JOB_TYPES.finishSongMoment,
        payload: { masterId, actor: 'tester', orgId }, maxAttempts: 1,
        dedupeKey: 'integration:finishing-status:' + masterId,
      })
      const listUrl = `/api/projects/${projectId}/masters`
      const before = await server.inject({ method: 'GET', url: listUrl, cookies })
      expect(before.statusCode).toBe(200)
      const masterBefore = before.json().masters.find((m: { id: string }) => m.id === masterId)
      expect(masterBefore?.finishingJobs[0]).toMatchObject({ id: queued.id, status: 'pending' })

      // A pending job is not recoverable by a second request.
      const path = `/api/masters/${masterId}/finishing/${queued.id}/retry`
      const forbiddenRetry = await server.inject({
        method: 'POST', url: path, cookies, headers: { [CSRF_HEADER]: csrf },
      })
      expect(forbiddenRetry.statusCode).toBe(409)

      // Simulate terminal worker failure without exposing its internal detail.
      await runtime.db.run(
        "UPDATE queue_jobs SET status = 'dead', last_error = ? WHERE id = ?",
        ['internal-path-and-sensitive-debug-value', queued.id],
      )
      const after = await server.inject({ method: 'GET', url: listUrl, cookies })
      const masterAfter = after.json().masters.find((m: { id: string }) => m.id === masterId)
      expect(masterAfter?.finishingJobs[0].status).toBe('dead')
      expect(JSON.stringify(masterAfter)).not.toContain('internal-path-and-sensitive-debug-value')
      const retry = await server.inject({
        method: 'POST', url: path, cookies, headers: { [CSRF_HEADER]: csrf },
      })
      expect(retry.statusCode).toBe(200)
      expect(retry.json()).toMatchObject({ status: 'queued', deduped: false })
      const again = await server.inject({
        method: 'POST', url: path, cookies, headers: { [CSRF_HEADER]: csrf },
      })
      expect(again.statusCode).toBe(200)
      expect(again.json()).toMatchObject({ jobId: retry.json().jobId, deduped: true })
    } finally {
      await server.close()
    }

    const concurrent = await Promise.allSettled([
      masters.finishWithSongMoment(masterId, 'tester', orgId),
      masters.finishWithSongMoment(masterId, 'tester', orgId),
    ])
    const winner = concurrent.find(result => result.status === 'fulfilled')
    const blocked = concurrent.find(result => result.status === 'rejected')
    expect(winner?.status).toBe('fulfilled')
    expect(blocked?.status).toBe('rejected')
    if (blocked?.status === 'rejected') expect(blocked.reason).toMatchObject({ code: 'media_finish.busy' })
    if (winner?.status !== 'fulfilled') throw new Error('finishing did not produce an approved delivery')
    const finished = winner.value
    expect((await runtime.renders.listDeliverables(masterId)).filter(d => d.spec.kind === 'song_moment')).toHaveLength(1)
    expect(finished.reused).toBe(false)
    expect(finished.sandbox).toBe(true)
    const derivative = await runtime.assets.get(finished.assetId)
    const path = runtime.storage.localPath(derivative.storageKey)
    expect(path).not.toBeNull()
    const media = await probe(path!)
    expect(media.audio).not.toBeNull()
    expect(media.video?.codec).toBe('h264')
    expect(media.durationSeconds).toBeGreaterThan(2.55)
    expect(media.durationSeconds).toBeLessThan(3.45)
    expect((await runtime.assets.lineage(finished.assetId)).parents.map(p => p.assetId)).toEqual(
      expect.arrayContaining([candidate.assetId, song.id]),
    )
    expect((await runtime.renders.listDeliverables(masterId)).some(d => d.assetId === finished.assetId)).toBe(true)
    const captioned = await finishCaptionedSongMoment(runtime, masterId, 'tester', orgId)
    expect(captioned.captionCount).toBe(1)
    expect(captioned.reused).toBe(false)
    const captionAsset = await runtime.assets.get(captioned.assetId)
    const captionInfo = await probe(runtime.storage.localPath(captionAsset.storageKey)!)
    expect(captionInfo.video).not.toBeNull()
    expect(captionInfo.audio).not.toBeNull()
    const captionParents = (await runtime.assets.lineage(captioned.assetId)).parents.map(parent => parent.assetId)
    expect(captionParents).toContain(finished.assetId)
    expect((await finishCaptionedSongMoment(runtime, masterId, 'tester', orgId))).toMatchObject({
      reused: true, assetId: captioned.assetId,
    })
    expect((await masters.finishWithSongMoment(masterId, 'tester', orgId))).toMatchObject({
      reused: true, assetId: finished.assetId,
    })
    expect(await sha256File(audioPath)).toBe(inputSha)
    expect((await runtime.projects.getVersion(version.id)).spec.music_cue?.asset_id).toBe(song.id)

    // Revoking the source never silently reauthorizes a derivative operation.
    const signedBeforeRevocation = await signedReadableUrl(runtime, captioned.assetId)
    expect(signedBeforeRevocation).toContain('/api/assets/raw')
    await runtime.assets.setRights(song.id, { consent: 'revoked', authorized: false }, 'tester')
    await expect(signedReadableUrl(runtime, captioned.assetId))
      .rejects.toMatchObject({ code: 'media_rights.revoked' })
    await expect(signedReadableUrl(runtime, finished.assetId))
      .rejects.toMatchObject({ code: 'media_rights.revoked' })
    // Already-issued signed URLs must be refused by the MOTION file server
    // on their *next* request, not just when a fresh link is requested.
    const rawServer = await buildServer({ runtime, logger: silentLogger })
    await rawServer.ready()
    try {
      const refused = await rawServer.inject({ method: 'GET', url: signedBeforeRevocation })
      expect(refused.statusCode).toBe(403)
    } finally {
      await rawServer.close()
    }
    await expect(masters.finishWithSongMoment(masterId, 'tester', orgId)).rejects.toMatchObject({ code: 'song_moment.rights' })
    await expect(finishCaptionedSongMoment(runtime, masterId, 'tester', orgId))
      .rejects.toMatchObject({ code: 'song_moment.rights' })
  }, 180_000)

  it('auto-rejects a defective render without a human ever seeing it', async () => {
    // Force every candidate defective at the provider.
    const defective = await createRuntime({
      config: loadConfig(
        { NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: storageRoot, ASSET_SIGNING_SECRET: 'pipeline-test-secret', PROVIDER_POLL_INTERVAL_MS: '0' },
        true,
      ),
      db,
      logger: silentLogger,
      mockOnly: true,
      storage: new LocalStorage({ root: storageRoot, signingSecret: 'pipeline-test-secret' }),
    })
    const { createMockProvider } = await import('@masterclip/provider-mock')
    defective.registry.register(
      createMockProvider({
        logger: silentLogger,
        sandbox: true,
        publicBaseUrl: '',
        now: () => Date.now(),
        workDir: join(storageRoot, 'defective-mock'),
        latencyMs: 0,
        defectRate: 1,
        failureRate: 0,
      }),
    )

    const render = new RenderService(defective)
    await render.planBatch({ projectId, shotId, batchName: 'defective batch', candidates: candidates(4), createdBy: 'tester', orgId })
    await drain(render)

    const outputs = await defective.renders.listOutputs({ shotId })
    expect(outputs.length).toBeGreaterThan(0)

    const actions: string[] = []
    for (const output of outputs) {
      const qc = await defective.renders.qcFor(output.id)
      const combined = qc.find((row) => row.layer === 'combined')
      actions.push(String(combined?.recommended_action))
    }
    // Every defect pattern must resolve to a machine decision, never silence.
    expect(actions.every((action) => action === 'AUTO_REJECT' || action === 'REGENERATE_WITH_CORRECTION')).toBe(true)
    expect(actions.some((action) => action === 'AUTO_REJECT')).toBe(true)
    // Shares the same Db handle as `runtime`; afterEach closes it once.
  })

  it('refuses to queue a batch that would blow the per-shot budget', async () => {
    const render = new RenderService(runtime)
    await runtime.cost.budgetStore.set({
      ...(await runtime.cost.budgetStore.ensureDefaults('project', projectId)),
      perShotCapMicros: usdToMicros(0.3),
    })

    // Each candidate is $0.20; the cap is $0.30. The first fits, and the rest
    // must be refused against the batch's running commitment rather than each
    // being re-authorized against the same empty balance.
    const plan = await render.planBatch({ projectId, shotId, batchName: 'over budget', candidates: candidates(4), createdBy: 'tester', orgId })
    expect(plan.jobIds).toHaveLength(1)
    expect(plan.skipped).toHaveLength(3)
    expect(plan.skipped[0]?.reason).toMatch(/budget/i)

    const audit = await runtime.audit.forProject(projectId)
    expect(audit.some((entry) => entry.action === 'render.denied')).toBe(true)
  })

  it('collapses duplicate cells in a batch instead of paying twice', async () => {
    const render = new RenderService(runtime)
    const duplicate = { ...candidates(1)[0]!, variationLabel: 'same', variationInstruction: 'same' }
    const plan = await render.planBatch({
      projectId,
      shotId,
      batchName: 'duplicates',
      candidates: [duplicate, { ...duplicate }, { ...duplicate }],
      createdBy: 'tester',
      orgId,
    })

    // Three identical cells describe one render; the idempotency key collapses
    // them so a sloppy matrix cannot triple the bill.
    expect(new Set(plan.jobIds).size).toBe(1)
    expect(plan.skipped.filter((s) => s.reason.includes('idempotency'))).toHaveLength(2)

    await drain(render)
    expect(await runtime.renders.listOutputs({ shotId })).toHaveLength(1)
  })

  it('survives a worker dying mid-flight', async () => {
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'resilience', candidates: candidates(2), createdBy: 'tester', orgId })

    // Claim the work and then abandon it, exactly as a killed worker would.
    const claimed = await runtime.queue.claim(QUEUES.render, 2)
    expect(claimed.length).toBeGreaterThan(0)

    const recovered = await runtime.queue.recoverStalled()
    expect(recovered).toBe(0) // lease has not expired yet

    await db.run("UPDATE queue_jobs SET lease_until = '2000-01-01T00:00:00.000Z' WHERE status = 'active'")
    expect(await runtime.queue.recoverStalled()).toBeGreaterThan(0)

    await drain(render)
    expect(await runtime.renders.listOutputs({ shotId })).toHaveLength(2)
  })

  it('records provenance from the delivery back to the shot version', async () => {
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'lineage', candidates: candidates(1), createdBy: 'tester', orgId })
    await drain(render)

    const output = (await runtime.renders.listOutputs({ shotId }))[0]!
    const proxyLineage = await runtime.assets.lineage(output.proxyAssetId ?? '')
    expect(proxyLineage.parents.map((p) => p.assetId)).toContain(output.assetId)
    expect(proxyLineage.parents[0]?.relation).toBe('proxy_of')

    const job = await runtime.renders.getJob(output.jobId)
    const version = await runtime.projects.getVersion(job.shotVersionId)
    expect(version.spec.shot_id).toBe('S01')
    expect(version.specHash).toHaveLength(64)
  })

  it('reports cost per approved second only once something is approved', async () => {
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'metrics', candidates: candidates(2), createdBy: 'tester', orgId })
    await drain(render)

    const before = await runtime.metrics.projectMetrics(projectId)
    expect(before.costPerApprovedSecond).toBeNull()

    const output = (await runtime.renders.listOutputs({ shotId }))[0]!
    await runtime.renders.addReview({ outputId: output.id, projectId, shotId, userId: 'tester', decision: 'approve', rejectionReasons: [], note: '' })

    const after = await runtime.metrics.projectMetrics(projectId)
    expect(after.costPerApprovedSecond).not.toBeNull()
    expect(formatUsd(after.costPerApprovedSecond ?? 0)).toMatch(/^\$/)
  })

  it('feeds rejection reasons back into model performance', async () => {
    const render = new RenderService(runtime)
    await render.planBatch({ projectId, shotId, batchName: 'learning', candidates: candidates(2), createdBy: 'tester', orgId })
    await drain(render)

    const outputs = await runtime.renders.listOutputs({ shotId })
    await runtime.renders.addReview({
      outputId: outputs[0]!.id,
      projectId,
      shotId,
      userId: 'tester',
      decision: 'reject',
      rejectionReasons: ['too_static', 'ai_appearance'],
      note: '',
    })
    await runtime.metrics.recordRejectionReasons(projectId, 'mock', 'mock-standard', ['too_static', 'ai_appearance'])
    await runtime.renders.addReview({ outputId: outputs[1]!.id, projectId, shotId, userId: 'tester', decision: 'approve', rejectionReasons: [], note: '' })

    const performance = await runtime.metrics.recomputeModelPerformance(projectId)
    const row = performance.find((p) => p.modelId === 'mock-standard')
    expect(row?.submitted).toBe(2)
    expect(row?.approved).toBe(1)
    expect(row?.rejected).toBe(1)

    const reasons = await runtime.metrics.rejectionBreakdown(projectId)
    expect(reasons.map((r) => r.reason)).toContain('too_static')
  })
})
