import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'

/**
 * Live Lab's AI Scene Builder composes through the platform's music layer
 * rather than keeping a second, parallel provider stack. These assert the
 * wiring end to end: that the runtime registers it, and that a job actually
 * generates through it and lands as accepted-shaped assets with lineage
 * naming the platform provider.
 */
let runtime: Runtime
let db: Db
let storageRoot: string

beforeEach(async () => {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'livelab-platform-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      SESSION_SECRET: 'platform-test-session',
      ASSET_SIGNING_SECRET: 'platform-test-asset',
      // The operator's configured rates. Live Lab prices through these rather
      // than knowing anything about money itself.
      AUDIO_RATE_CARD: JSON.stringify({ music_per_track_usd: 0.25 }),
    },
    true,
  )
  runtime = await createRuntime({
    config,
    db,
    logger: silentLogger,
    mockOnly: true,
    storage: new LocalStorage({ root: storageRoot, signingSecret: 'platform-test-asset' }),
  })
})

afterEach(async () => {
  await runtime?.close()
  await rm(storageRoot, { recursive: true, force: true })
})

function platformProviderId(): string {
  const id = runtime.liveLabService.audioProviders.list().find((p) => p.id.startsWith('platform:'))?.id
  expect(id, 'the runtime should register a platform music provider').toBeDefined()
  return id!
}

describe('Live Lab composes through the platform audio layer', () => {
  it('registers the platform music provider alongside the local synthesizer', () => {
    const ids = runtime.liveLabService.audioProviders.list().map((p) => p.id)
    // The local synthesizer always remains, so Live Lab still works in a build
    // with no audio platform and no credentials at all.
    expect(ids).toContain('mock-audio')
    expect(ids.some((id) => id.startsWith('platform:'))).toBe(true)
  })

  it('generates a scene through the platform provider, with platform lineage', async () => {
    const org = await runtime.projects.createOrg('Platform Org')
    const user = await runtime.auth.createUser({
      orgId: org.id,
      email: 'platform@example.com',
      password: 'a-sufficiently-long-password',
      displayName: 'Artist',
      orgRole: 'owner',
    })
    const project = await runtime.liveLab.createProject({ orgId: org.id, name: 'Platform Set', masterTempo: 120, createdBy: user.id })
    const item = await runtime.liveLab.createItem({ orgId: org.id, liveProjectId: project.id, type: 'song', title: 'TRACK ONE', bpm: 120 })

    const job = await runtime.liveLab.createAiJob({
      orgId: org.id,
      liveProjectId: project.id,
      liveSetItemId: item.id,
      provider: platformProviderId(),
      operation: 'scene.generate',
      configuration: {
        prompt: 'an eight bar sparse intro that opens the show',
        bars: 8,
        tempoBehavior: 'keep',
        keyBehavior: 'keep',
        energy: 'low',
        instrumentation: ['drums', 'sub bass'],
        intendedTransition: 'into the first hook',
        rightsConfirmed: true,
      } as never,
      createdBy: user.id,
    })

    await runtime.liveLabService.runAiJob(job.id)

    const done = await runtime.liveLab.getAiJob(job.id)
    expect(done.status).toBe('ready')
    expect(done.outputAssetIds).toHaveLength(3)

    const asset = await runtime.liveLab.getAsset(done.outputAssetIds[0]!)
    // Lineage records the platform provider, not the local synthesizer.
    expect(asset.lineage?.provider).toMatch(/^platform:/)
    expect(asset.lineage?.rightsConfirmed).toBe(true)
    // Still awaiting explicit human acceptance, exactly as with the mock.
    expect(asset.lineage?.approvedBy).toBeNull()
    // The bytes are real and the recorded mime matches what was stored, rather
    // than being assumed to be WAV.
    const bytes = await runtime.storage.getBuffer(asset.storageKey)
    expect(bytes.length).toBeGreaterThan(0)
    expect(['audio/wav', 'audio/mpeg', 'audio/mp4']).toContain(asset.mime)
  })

  it('refuses an unsafe prompt on the platform path too', async () => {
    const org = await runtime.projects.createOrg('Safety Org')
    const user = await runtime.auth.createUser({
      orgId: org.id,
      email: 'safety@example.com',
      password: 'a-sufficiently-long-password',
      displayName: 'Artist',
      orgRole: 'owner',
    })
    const project = await runtime.liveLab.createProject({ orgId: org.id, name: 'Safety Set', createdBy: user.id })
    const job = await runtime.liveLab.createAiJob({
      orgId: org.id,
      liveProjectId: project.id,
      provider: platformProviderId(),
      operation: 'scene.generate',
      configuration: {
        prompt: 'an intro in the style of Drake',
        bars: 8,
        tempoBehavior: 'keep',
        keyBehavior: 'keep',
        energy: 'low',
        instrumentation: [],
        intendedTransition: '',
        rightsConfirmed: true,
      } as never,
      createdBy: user.id,
    })

    await runtime.liveLabService.runAiJob(job.id)
    const done = await runtime.liveLab.getAiJob(job.id)
    // Screened at the provider boundary, so a job created by any future caller
    // that skipped the route's check still cannot reach a real provider.
    expect(done.status).toBe('failed')
    expect(done.error).toMatch(/refused/)
    expect(done.outputAssetIds).toHaveLength(0)
  })
})

describe('generated scene length', () => {
  it('reports the audio that came back, not the length that was asked for', async () => {
    // The platform mock clamps music to 3-30s, so a 16-bar request at 100 BPM
    // (38.4s) comes back short. Reporting the ask would have the engine
    // schedule 8 seconds of audio that does not exist.
    const provider = runtime.liveLabService.audioProviders.list().find((p) => p.id.startsWith('platform:'))
    expect(provider, 'platform provider should be registered').toBeDefined()

    const result = await provider!.generateScene({
      orgId: 'org_test',
      bpm: 100,
      beatsPerBar: 4,
      seed: 5,
      request: {
        prompt: 'a long rolling section',
        bars: 16,
        tempoBehavior: 'keep',
        keyBehavior: 'keep',
        energy: 'medium',
        instrumentation: ['bass'],
        intendedTransition: '',
        rightsConfirmed: true,
      },
    })

    const requestedMs = 16 * 4 * (60 / 100) * 1000
    expect(requestedMs).toBeCloseTo(38_400, 0)
    for (const option of result.options) {
      expect(option.durationMs).not.toBeNull()
      // Matches the bytes, and so is shorter than what was requested.
      expect(option.durationMs!).toBeLessThan(requestedMs)
      expect(option.durationMs!).toBeGreaterThan(0)
    }
  })
})

describe('platform spend is visible to the platform', () => {
  it('records a Live Lab generation in the audio usage ledger', async () => {
    const org = await runtime.projects.createOrg('Ledger Org')
    const user = await runtime.auth.createUser({
      orgId: org.id,
      email: `ledger-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'a-sufficiently-long-password',
      displayName: 'Artist',
      orgRole: 'owner',
    })
    const project = await runtime.liveLab.createProject({
      orgId: org.id,
      name: 'Ledger Set',
      artistId: null,
      createdBy: user.id,
    })

    const before = await runtime.audio.repos.usage.list(org.id)

    const job = await runtime.liveLab.createAiJob({
      orgId: org.id,
      liveProjectId: project.id,
      liveSetItemId: null,
      sourceAssetId: null,
      provider: platformProviderId(),
      operation: 'scene_generation',
      configuration: {
        prompt: 'a dark rolling section',
        bars: 8,
        tempoBehavior: 'keep',
        keyBehavior: 'keep',
        energy: 'medium',
        instrumentation: ['bass'],
        intendedTransition: '',
        rightsConfirmed: true,
      },
      createdBy: user.id,
    })
    await runtime.liveLabService.runAiJob(job.id)
    expect((await runtime.liveLab.getAiJob(job.id)).status).toBe('ready')

    const after = await runtime.audio.repos.usage.list(org.id)
    expect(after.length).toBe(before.length + 1)

    const entry = after[0]!
    // Attributed to Live Lab rather than filed under some other feature.
    expect(entry.projectType).toBe('live_lab')
    expect(entry.projectId).toBe(project.id)
    expect(entry.jobId).toBe(job.id)
    expect(entry.provider).toContain('platform')
    expect(entry.operation).toBe('scene_generation')
    // Units the provider measured, not a price this layer invented.
    expect(entry.unit).toBeTruthy()
    expect(entry.outputUnits).toBeGreaterThan(0)
  })

  it('does not put the local synthesizer in a ledger of purchases', async () => {
    const org = await runtime.projects.createOrg('Mock Org')
    const user = await runtime.auth.createUser({
      orgId: org.id,
      email: `mock-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'a-sufficiently-long-password',
      displayName: 'Artist',
      orgRole: 'owner',
    })
    const project = await runtime.liveLab.createProject({ orgId: org.id, name: 'Mock Set', artistId: null, createdBy: user.id })

    const job = await runtime.liveLab.createAiJob({
      orgId: org.id,
      liveProjectId: project.id,
      liveSetItemId: null,
      sourceAssetId: null,
      provider: 'mock-audio',
      operation: 'scene_generation',
      configuration: {
        prompt: 'a warm pad',
        bars: 4,
        tempoBehavior: 'keep',
        keyBehavior: 'keep',
        energy: 'low',
        instrumentation: ['pad'],
        intendedTransition: '',
        rightsConfirmed: true,
      },
      createdBy: user.id,
    })
    await runtime.liveLabService.runAiJob(job.id)
    expect((await runtime.liveLab.getAiJob(job.id)).status).toBe('ready')

    // Nothing was bought, so nothing is owed and nothing is recorded.
    expect(await runtime.audio.repos.usage.list(org.id)).toHaveLength(0)
  })
})

describe('Live Lab spend counts toward the budget', () => {
  it('prices a generation through the operator rate card and moves month spend', async () => {
    const org = await runtime.projects.createOrg('Priced Org')
    const user = await runtime.auth.createUser({
      orgId: org.id,
      email: `priced-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'a-sufficiently-long-password',
      displayName: 'Artist',
      orgRole: 'owner',
    })
    const project = await runtime.liveLab.createProject({ orgId: org.id, name: 'Priced Set', artistId: null, createdBy: user.id })

    // Nothing spent yet.
    expect(await runtime.audio.repos.usage.monthSpendMicros(org.id)).toBe(0)

    const job = await runtime.liveLab.createAiJob({
      orgId: org.id,
      liveProjectId: project.id,
      liveSetItemId: null,
      sourceAssetId: null,
      provider: platformProviderId(),
      operation: 'scene_generation',
      configuration: {
        prompt: 'a driving section',
        bars: 8,
        tempoBehavior: 'keep',
        keyBehavior: 'keep',
        energy: 'high',
        instrumentation: ['drums'],
        intendedTransition: '',
        rightsConfirmed: true,
      },
      createdBy: user.id,
    })
    await runtime.liveLabService.runAiJob(job.id)
    expect((await runtime.liveLab.getAiJob(job.id)).status).toBe('ready')

    // Three options at $0.25 each = $0.75 = 750,000 micros. The figure comes
    // from the operator's rate card, not from anything Live Lab knows.
    const entry = (await runtime.audio.repos.usage.list(org.id))[0]!
    expect(entry.estimatedCostMicros).toBe(750_000)

    // And it reaches the number budgets actually read.
    expect(await runtime.audio.repos.usage.monthSpendMicros(org.id)).toBe(750_000)
  })
})
