import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, toStr, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { AppError, loadConfig, silentLogger, usdToMicros } from '@masterclip/shared'
import { DurableQueue, JOB_TYPES, QUEUES, QueueWorker } from '@masterclip/queue'
import type { AudioTranscriptionProvider, ProviderHealth } from '@masterclip/audio-core'
import { signElevenLabsPayload } from '@masterclip/audio-providers'
import { createAudioLayer, seedAudioDemo, type AudioLayer } from '@masterclip/audio-engine'

/**
 * Audio Intelligence integration tests.
 *
 * Everything runs against the real engine: real SQLite schema, real local
 * object storage, real queue, real mock providers producing real WAV bytes.
 * The properties tested here are the release blockers named in the platform's
 * policy: tenant isolation, consent, moderation, human approval, webhook
 * authenticity, budgets, retention, and revocation.
 */

let db: Db
let storageRoot: string
let audio: AudioLayer
let queue: DurableQueue
let orgA: string
let orgB: string
const userA = 'usr_test_a'
const userB = 'usr_test_b'
const actorA = { userId: userA, orgId: '', orgRole: 'owner' }
const actorB = { userId: userB, orgId: '', orgRole: 'owner' }

const wavBytes = () => {
  // A tiny but valid RIFF/WAVE file.
  const pcm = new Int16Array(2200)
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 8) * 12000)
  const buffer = Buffer.alloc(44 + pcm.length * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + pcm.length * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(22050, 24)
  buffer.writeUInt32LE(44100, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(pcm.length * 2, 40)
  for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(pcm[i]!, 44 + i * 2)
  return new Uint8Array(buffer)
}

async function drainAudioQueue(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    const worker = new QueueWorker(queue, { queueName: QUEUES.audio, concurrency: 1, logger: silentLogger })
    worker.register<{ jobId: string }>(JOB_TYPES.audioTranscribe, async ({ jobId }) => void (await audio.transcription.run(jobId)))
    worker.register<{ meetingId: string }>(JOB_TYPES.audioExtractMeeting, async ({ meetingId }) => audio.meetings.runExtraction(meetingId))
    worker.register<{ briefId: string }>(JOB_TYPES.audioRenderBrief, async ({ briefId }) => audio.briefs.runRender(briefId))
    worker.register<{ projectId: string }>(JOB_TYPES.audioDubbingSubmit, async ({ projectId }) => audio.globalRelease.runSubmit(projectId))
    worker.register<{ projectId: string }>(JOB_TYPES.audioDubbingPoll, async ({ projectId }, ctx) => {
      const result = await audio.globalRelease.runPoll(projectId)
      if (!result.done) ctx.defer(0)
    })
    worker.register<{ jobId: string }>(JOB_TYPES.audioCampaignGenerate, async ({ jobId }) => audio.campaigns.runGenerate(jobId))
    worker.register<{ jobId: string }>(JOB_TYPES.audioRemixGenerate, async ({ jobId }) => audio.remix.runOperation(jobId))
    worker.register<{ conversationId: string }>(JOB_TYPES.audioAgentPostCall, async ({ conversationId }) => audio.operatorAgent.runPostCall(conversationId))
    worker.register<{ eventId: string }>(JOB_TYPES.audioWebhookProcess, async ({ eventId }) => audio.webhooks.process(eventId))
    const processed = await worker.runOnce(50)
    if (processed === 0) break
  }
}

beforeEach(async () => {
  db = await createTestDb()
  storageRoot = await mkdtemp(join(tmpdir(), 'audio-intel-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      MASTERCLIP_MODE: 'sandbox',
      LOG_LEVEL: 'error',
      STORAGE_LOCAL_ROOT: storageRoot,
      ASSET_SIGNING_SECRET: 'audio-test-secret',
      SESSION_SECRET: 'audio-test-session',
      ELEVENLABS_WEBHOOK_SECRET: 'whsec_audio_test',
      MUSIC_GENERATION_ENABLED: 'true',
      MUSIC_INPAINTING_ENABLED: 'true',
      VOICE_CLONING_ENABLED: 'true',
    },
    true,
  )
  const storage = new LocalStorage({ root: storageRoot, signingSecret: 'audio-test-secret' })
  queue = new DurableQueue(db, { logger: silentLogger })
  audio = createAudioLayer({ config, logger: silentLogger, db, storage, queue, mockOnly: true })

  orgA = 'org_test_a'
  orgB = 'org_test_b'
  const now = new Date().toISOString()
  for (const [id, name] of [
    [orgA, 'Street Banker Flagship'],
    [orgB, 'Partner Org'],
  ] as const) {
    await db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', [id, name, now])
  }
  actorA.orgId = orgA
  actorB.orgId = orgB
  await audio.repos.policy.updatePolicy(orgA, { allowMusicGeneration: true, allowVoiceCloning: true })
  await audio.repos.policy.updatePolicy(orgB, { allowMusicGeneration: true, allowVoiceCloning: true })
})

afterEach(async () => {
  await db.close()
  await rm(storageRoot, { recursive: true, force: true })
})

async function createMeetingA(consent = true) {
  return audio.meetings.createWithUpload({
    actor: actorA,
    title: 'A&R call — Nova Verge',
    meetingType: 'A&R Call',
    operatorLeadId: null,
    bytes: wavBytes(),
    filename: 'call.wav',
    consent: { accepted: consent },
  })
}

describe('consent gates', () => {
  it('refuses a meeting upload without the consent acknowledgment', async () => {
    await expect(createMeetingA(false)).rejects.toMatchObject({ code: 'audio.consent_required' })
  })

  it('stores the consent record with the meeting', async () => {
    const meeting = await createMeetingA()
    expect(meeting.consentRecordId).toBeTruthy()
    const consent = await audio.repos.consents.get(orgA, meeting.consentRecordId!)
    expect(consent.accepted).toBe(true)
    expect(consent.disclosureText.length).toBeGreaterThan(20)
  })
})

describe('meeting intelligence pipeline', () => {
  it('transcribes, extracts a draft, and commits only approved items to Operator Desk', async () => {
    const lead = await audio.repos.operatorDesk.createLead({ orgId: orgA, name: 'Nova Verge', source: 'manual', createdBy: userA })
    const meeting = await audio.meetings.createWithUpload({
      actor: actorA,
      title: 'Distribution discussion',
      meetingType: 'Distribution Discussion',
      operatorLeadId: lead.id,
      bytes: wavBytes(),
      filename: 'dist.wav',
      consent: { accepted: true },
    })
    await drainAudioQueue()

    const refreshed = await audio.repos.meetings.get(orgA, meeting.id)
    expect(refreshed.status).toBe('draft')
    expect(refreshed.transcriptId).toBeTruthy()

    const segments = await audio.repos.transcripts.segments(orgA, refreshed.transcriptId!)
    expect(segments.length).toBeGreaterThan(3)
    expect(segments[0]!.endMs).toBeGreaterThan(segments[0]!.startMs)

    // Speaker renaming persists and is marked manually confirmed.
    await audio.repos.transcripts.renameSpeaker(orgA, refreshed.transcriptId!, 'speaker_0', 'Rio Calder')
    const speakers = await audio.repos.transcripts.speakers(orgA, refreshed.transcriptId!)
    expect(speakers.find((s) => s.providerSpeakerKey === 'speaker_0')).toMatchObject({ displayName: 'Rio Calder', manuallyConfirmed: true })

    // Inferred deal terms are labelled as such — never presented as agreed.
    const dealVariables = await audio.repos.meetings.dealVariables(orgA, meeting.id)
    expect(dealVariables.length).toBeGreaterThan(0)
    for (const variable of dealVariables) expect(['inferred', 'needs_verification']).toContain(variable.extractionType)

    const actionItems = await audio.repos.meetings.actionItems(orgA, meeting.id)
    expect(actionItems.length).toBeGreaterThan(0)

    // Approve one action item, reject the rest; commit.
    await audio.repos.meetings.setItemApproval(orgA, meeting.id, 'action', actionItems[0]!.id, 'approved')
    const result = await audio.meetings.commit(actorA, meeting.id)
    expect(result.tasks).toBe(1)

    const tasks = await audio.repos.operatorDesk.tasksForLead(orgA, lead.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.sourceType).toBe('meeting')

    // A committed meeting cannot be committed twice.
    await expect(audio.meetings.commit(actorA, meeting.id)).rejects.toMatchObject({ kind: 'conflict' })
  })
})

describe('tenant isolation', () => {
  it('never lets one org read another org’s records', async () => {
    const meeting = await createMeetingA()
    await drainAudioQueue()
    const refreshed = await audio.repos.meetings.get(orgA, meeting.id)

    await expect(audio.repos.meetings.get(orgB, meeting.id)).rejects.toMatchObject({ kind: 'not_found' })
    await expect(audio.repos.assets.get(orgB, refreshed.audioAssetId!)).rejects.toMatchObject({ kind: 'not_found' })
    await expect(audio.repos.transcripts.get(orgB, refreshed.transcriptId!)).rejects.toMatchObject({ kind: 'not_found' })
    expect(await audio.repos.transcripts.segments(orgB, refreshed.transcriptId!)).toHaveLength(0)
    expect(await audio.repos.meetings.list(orgB)).toHaveLength(0)
  })

  it('scopes storage keys under the owning organization', async () => {
    const meeting = await createMeetingA()
    const asset = await audio.repos.assets.get(orgA, meeting.audioAssetId!)
    expect(asset.storageKey.startsWith(`organizations/${orgA}/audio/`)).toBe(true)
  })

  it('keeps voice profiles and conversations tenant-scoped', async () => {
    const profile = await audio.voiceVault.register({
      actor: actorA,
      ownerName: 'Nova Verge',
      profileName: 'Narration',
      providerVoiceId: 'mock-voice-1',
      ownerConsentConfirmed: true,
      permittedUses: { commercial: true },
      validUntil: null,
    })
    await expect(audio.repos.voiceVault.get(orgB, profile.id)).rejects.toMatchObject({ kind: 'not_found' })
    await expect(audio.repos.voiceVault.requireUsable(orgB, profile.id, 'commercial', Date.now())).rejects.toMatchObject({ kind: 'not_found' })

    const agents = await audio.operatorAgent.ensureDefaultAgents(orgA, userA)
    const session = await audio.operatorAgent.startConversation({ actor: null, orgId: orgA, agentId: agents[0]!.id, channel: 'web' })
    await expect(audio.repos.agents.getConversation(orgB, session.conversation.id)).rejects.toMatchObject({ kind: 'not_found' })
    await expect(audio.operatorAgent.userTurn(orgB, session.conversation.id, 'hello')).rejects.toMatchObject({ kind: 'not_found' })
  })
})

describe('signal briefs', () => {
  it('preserves confidence language and renders playable audio', async () => {
    const brief = await audio.briefs.create({
      actor: actorA,
      briefType: 'rights_health',
      title: 'Rights health brief',
      items: [
        { statement: 'Two tracks still carry a claim from the previous distributor.', confidence: 'needs_verification' },
        { statement: 'The new split sheet is signed.', confidence: 'confirmed' },
      ],
    })
    expect(brief.script).toMatch(/Needs verification/)
    await audio.briefs.enqueueRender(actorA, brief.id)
    await drainAudioQueue()
    const rendered = await audio.repos.briefs.get(orgA, brief.id)
    expect(rendered.status).toBe('ready')
    const asset = await audio.repos.assets.get(orgA, rendered.audioAssetId!)
    expect(asset.mimeType).toBe('audio/wav')
    // Usage was recorded for the synthesis.
    const usage = await audio.repos.usage.list(orgA)
    expect(usage.some((entry) => entry.operation === 'tts')).toBe(true)
  })
})

describe('operator agent', () => {
  it('shows the disclosure before any interaction', async () => {
    const agents = await audio.operatorAgent.ensureDefaultAgents(orgA, userA)
    const session = await audio.operatorAgent.startConversation({ actor: null, orgId: orgA, agentId: agents[0]!.id, channel: 'web' })
    expect(session.disclosure).toMatch(/AI-powered/)
    const conversation = await audio.repos.agents.getConversation(orgA, session.conversation.id)
    expect(conversation.transcript[0]!.text).toMatch(/AI-powered/)
    expect(conversation.disclosureShownAt).toBeTruthy()
  })

  it('never approves a deal or promises outcomes', async () => {
    const agents = await audio.operatorAgent.ensureDefaultAgents(orgA, userA)
    const session = await audio.operatorAgent.startConversation({ actor: null, orgId: orgA, agentId: agents[0]!.id, channel: 'web' })
    const result = await audio.operatorAgent.userTurn(orgA, session.conversation.id, 'Will I be approved? Can you guarantee streams?')
    expect(result.reply).toMatch(/human team/i)
    expect(result.reply).not.toMatch(/you are approved|we guarantee/i)
  })

  it('transfers to a human on request and files a priority callback task', async () => {
    const agents = await audio.operatorAgent.ensureDefaultAgents(orgA, userA)
    const session = await audio.operatorAgent.startConversation({ actor: null, orgId: orgA, agentId: agents[0]!.id, channel: 'web' })
    await audio.operatorAgent.userTurn(orgA, session.conversation.id, 'Rio Calder')
    const result = await audio.operatorAgent.userTurn(orgA, session.conversation.id, 'I want to speak to a human please')
    expect(result.humanTransfer).toBe(true)
    expect(result.ended).toBe(true)
    const conversation = await audio.repos.agents.getConversation(orgA, session.conversation.id)
    expect(conversation.humanTransferStatus).toBe('requested')
    expect(conversation.operatorLeadId).toBeTruthy()
    const tasks = await audio.repos.operatorDesk.tasksForLead(orgA, conversation.operatorLeadId!)
    expect(tasks.some((task) => /human operator/i.test(task.description))).toBe(true)
  })

  it('completes intake and routes a qualified lead to Operator Desk', async () => {
    const agents = await audio.operatorAgent.ensureDefaultAgents(orgA, userA)
    const session = await audio.operatorAgent.startConversation({ actor: null, orgId: orgA, agentId: agents[0]!.id, channel: 'web' })
    const script = ['Rio Calder', 'Nova Verge', 'rio@novaverge.example', 'Chorusline', 'An EP in March', 'Yes we own it', 'Wider reach']
    let ended = false
    for (const line of script) {
      const result = await audio.operatorAgent.userTurn(orgA, session.conversation.id, line)
      ended = result.ended
      if (ended) break
    }
    expect(ended).toBe(true)
    const conversation = await audio.repos.agents.getConversation(orgA, session.conversation.id)
    expect(conversation.status).toBe('ended')
    expect(conversation.operatorLeadId).toBeTruthy()
    const lead = await audio.repos.operatorDesk.getLead(orgA, conversation.operatorLeadId!)
    expect(lead.email).toBe('rio@novaverge.example')
  })
})

describe('remix lab', () => {
  const create = (rights: boolean, noImitation: boolean, filename = 'song.wav') =>
    audio.remix.create({
      actor: actorA,
      name: 'Title track',
      bytes: wavBytes(),
      filename,
      remixLane: 'stems',
      targetUse: 'social_versions',
      rightsConfirmed: rights,
      noImitationConfirmed: noImitation,
    })

  it('requires both rights checkboxes independently', async () => {
    await expect(create(false, true)).rejects.toMatchObject({ code: 'remix.rights_required' })
    await expect(create(true, false)).rejects.toMatchObject({ code: 'remix.no_imitation_required' })
  })

  it('blocks imitation prompts before the provider and allows neutral ones', async () => {
    const project = await create(true, true)
    await expect(
      audio.remix.enqueueOperation(actorA, { remixProjectId: project.id, operation: 'concept', prompt: 'make it sound like Marisol Vane' }),
    ).rejects.toMatchObject({ code: 'remix.prompt_blocked' })
    const jobId = await audio.remix.enqueueOperation(actorA, {
      remixProjectId: project.id,
      operation: 'concept',
      prompt: 'slow tempo, warm analog texture, sparse drums',
    })
    expect(jobId).toBeTruthy()
    await drainAudioQueue()
    const versions = await audio.repos.remix.versions(orgA, project.id)
    expect(versions.some((version) => version.versionType === 'concept')).toBe(true)
  })

  it('records a provider rights screen without accusing the artist, and does not auto-retry', async () => {
    const project = await create(true, true, 'screenme.wav')
    await audio.remix.enqueueOperation(actorA, { remixProjectId: project.id, operation: 'upload_screen' })
    await drainAudioQueue()
    const refreshed = await audio.repos.remix.get(orgA, project.id)
    expect(refreshed.providerScreening).toBe('rights_review_required')
    expect(refreshed.status).toBe('provider_rights_review')
    const jobs = await audio.repos.jobs.list(orgA, { operation: 'upload_screen' })
    expect(jobs[0]!.status).toBe('failed')
    expect(jobs[0]!.errorMessage).toMatch(/rights review required/i)
    expect(jobs[0]!.errorMessage).not.toMatch(/infring/i)
    // The queue is drained — nothing re-submitted itself.
    expect((await queue.stats(QUEUES.audio)).pending).toBe(0)
  })

  it('separates stems with full lineage and enforces the ordered release gate', async () => {
    const project = await create(true, true)
    await audio.remix.enqueueOperation(actorA, { remixProjectId: project.id, operation: 'stems' })
    await drainAudioQueue()
    const versions = await audio.repos.remix.versions(orgA, project.id)
    expect(versions.length).toBeGreaterThanOrEqual(4)
    for (const version of versions) {
      expect(version.generationMetadata.sourceAssetIds).toEqual([project.sourceAudioAssetId])
      expect(version.generationMetadata.rightsConfirmationId).toBe(project.rightsConfirmationId)
    }
    // release_ready without producer approval is refused.
    await expect(audio.repos.remix.setApproval(orgA, project.id, 'release_ready', userA)).rejects.toMatchObject({
      code: 'remix.needs_producer_review',
    })
    await audio.repos.remix.setApproval(orgA, project.id, 'producer_approved', userA)
    await audio.repos.remix.setApproval(orgA, project.id, 'release_ready', userA)
    const approved = await audio.repos.remix.get(orgA, project.id)
    expect(approved.finalApprovalStatus).toBe('release_ready')
  })
})

describe('voice vault', () => {
  it('requires owner consent and a provider-verified reference', async () => {
    await expect(
      audio.voiceVault.register({
        actor: actorA,
        ownerName: 'A',
        profileName: 'P',
        providerVoiceId: 'mock-voice-1',
        ownerConsentConfirmed: false,
        permittedUses: {},
        validUntil: null,
      }),
    ).rejects.toMatchObject({ code: 'voice.consent_required' })
  })

  it('blocks generation for pending, expired, unpermitted, and revoked voices', async () => {
    const pending = await audio.voiceVault.register({
      actor: actorA,
      ownerName: 'A',
      profileName: 'Pending',
      providerVoiceId: 'mock-voice-unverified-1',
      ownerConsentConfirmed: true,
      permittedUses: { commercial: true },
      validUntil: null,
    })
    await expect(audio.repos.voiceVault.requireUsable(orgA, pending.id, 'commercial', Date.now())).rejects.toMatchObject({
      code: 'voice.unverified',
    })

    const expired = await audio.voiceVault.register({
      actor: actorA,
      ownerName: 'B',
      profileName: 'Expired',
      providerVoiceId: 'mock-voice-2',
      ownerConsentConfirmed: true,
      permittedUses: { commercial: true },
      validUntil: new Date(Date.now() - 1000).toISOString(),
    })
    await expect(audio.repos.voiceVault.requireUsable(orgA, expired.id, 'commercial', Date.now())).rejects.toMatchObject({
      code: 'voice.expired',
    })

    const scoped = await audio.voiceVault.register({
      actor: actorA,
      ownerName: 'C',
      profileName: 'InternalOnly',
      providerVoiceId: 'mock-voice-3',
      ownerConsentConfirmed: true,
      permittedUses: { internal: true, commercial: false },
      validUntil: null,
    })
    await expect(audio.repos.voiceVault.requireUsable(orgA, scoped.id, 'commercial', Date.now())).rejects.toMatchObject({
      code: 'voice.use_not_permitted',
    })

    await audio.voiceVault.revoke(actorA, scoped.id)
    await expect(audio.repos.voiceVault.requireUsable(orgA, scoped.id, 'internal', Date.now())).rejects.toMatchObject({
      code: 'voice.revoked',
    })
    // Revocation cascades: consent revoked, audit written.
    const profile = await audio.repos.voiceVault.get(orgA, scoped.id)
    const consent = await audio.repos.consents.get(orgA, profile.consentRecordId)
    expect(consent.revokedAt).toBeTruthy()
  })

  it('a campaign voiceover with a revoked voice never reaches the provider', async () => {
    const profile = await audio.voiceVault.register({
      actor: actorA,
      ownerName: 'D',
      profileName: 'RevokeMe',
      providerVoiceId: 'mock-voice-4',
      ownerConsentConfirmed: true,
      permittedUses: { commercial: true },
      validUntil: null,
    })
    const campaign = await audio.campaigns.create({
      actor: actorA,
      name: 'Announcement',
      templateType: 'release_announcement',
      usageContext: 'social',
      rightsBasis: 'owned',
    })
    await audio.voiceVault.revoke(actorA, profile.id)
    await expect(
      audio.campaigns.enqueueGenerate(actorA, { campaignId: campaign.id, operation: 'voiceover', text: 'Out now', voiceProfileId: profile.id }),
    ).rejects.toMatchObject({ code: 'voice.revoked' })
  })
})

describe('budgets and usage', () => {
  it('hard-stops when the monthly cap is exhausted and warns near it', async () => {
    await audio.repos.usage.setBudget({
      orgId: orgA,
      scope: 'org',
      scopeId: orgA,
      monthlyCapMicros: usdToMicros(1),
      perJobCapMicros: null,
      approvalAboveMicros: null,
      warnThresholdPct: 0.5,
      hardStop: true,
    })
    // Below the cap: allowed with a warning past 50%.
    const warned = await audio.repos.usage.check(orgA, userA, 'audio.transcription', usdToMicros(0.6))
    expect(warned.allowed).toBe(true)
    expect(warned.warning).toMatch(/%/)

    await audio.repos.usage.record({
      orgId: orgA,
      userId: userA,
      projectType: 'meeting',
      projectId: null,
      provider: 'mock-audio',
      operation: 'transcription',
      model: 'mock',
      unit: 'seconds',
      inputUnits: 600,
      outputUnits: 0,
      estimatedCostMicros: usdToMicros(0.99),
      finalCostMicros: 0,
      currency: 'USD',
      providerRequestId: null,
      jobId: null,
    })
    const blocked = await audio.repos.usage.check(orgA, userA, 'audio.transcription', usdToMicros(0.5))
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toMatch(/budget/)
  })

  it('enforces a per-job maximum', async () => {
    await audio.repos.usage.setBudget({
      orgId: orgA,
      scope: 'org',
      scopeId: orgA,
      monthlyCapMicros: null,
      perJobCapMicros: usdToMicros(0.1),
      approvalAboveMicros: null,
      warnThresholdPct: 0.8,
      hardStop: true,
    })
    const verdict = await audio.repos.usage.check(orgA, userA, 'audio.dubbing', usdToMicros(5))
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toMatch(/per-job/)
  })

  it('budgets in org A do not constrain org B', async () => {
    await audio.repos.usage.setBudget({
      orgId: orgA,
      scope: 'org',
      scopeId: orgA,
      monthlyCapMicros: usdToMicros(0.01),
      perJobCapMicros: null,
      approvalAboveMicros: null,
      warnThresholdPct: 0.8,
      hardStop: true,
    })
    const verdict = await audio.repos.usage.check(orgB, userB, 'audio.transcription', usdToMicros(1))
    expect(verdict.allowed).toBe(true)
  })
})

describe('zero retention', () => {
  it('rejects the job before any bytes reach a provider that cannot honour it', async () => {
    // A stub provider that is configured but cannot process without retention.
    const stub: AudioTranscriptionProvider = {
      providerId: 'retaining-provider',
      isConfigured: () => true,
      supportsZeroRetention: () => false,
      healthCheck: async (): Promise<ProviderHealth> => ({ providerId: 'retaining-provider', status: 'healthy', message: 'ok', checkedAt: new Date().toISOString() }),
      transcribe: async () => {
        throw new Error('bytes must never get here for a zero-retention org')
      },
      getTranscriptionStatus: async () => {
        throw new Error('unused')
      },
    }
    audio.registry.register({ transcription: stub })
    await audio.repos.policy.updateSettings(orgA, { defaultProviders: { transcription: 'retaining-provider' } })
    await audio.repos.policy.updatePolicy(orgA, { requireZeroRetention: true })

    const meeting = await createMeetingA()
    await drainAudioQueue()
    const jobs = await audio.repos.jobs.list(orgA, { operation: 'transcription' })
    expect(jobs[0]!.status).toBe('failed')
    expect(jobs[0]!.errorCode).toBe('audio.zero_retention_unavailable')
    const refreshed = await audio.repos.meetings.get(orgA, meeting.id)
    expect(refreshed.status).toBe('failed')
  })
})

describe('retention cleanup', () => {
  it('deletes expired content but keeps audit metadata', async () => {
    const meeting = await createMeetingA()
    await drainAudioQueue()
    const refreshed = await audio.repos.meetings.get(orgA, meeting.id)
    const asset = await audio.repos.assets.get(orgA, refreshed.audioAssetId!)

    // Force both past their retention deadline.
    const past = new Date(Date.now() - 1000).toISOString()
    await db.run('UPDATE audio_assets SET retention_expires_at = ? WHERE id = ?', [past, asset.id])
    await db.run('UPDATE audio_transcripts SET retention_expires_at = ? WHERE id = ?', [past, refreshed.transcriptId])

    const swept = await audio.retention.sweep()
    expect(swept.assets).toBe(1)
    expect(swept.transcripts).toBe(1)

    // Bytes gone, soft-deleted row still proves what existed.
    await expect(audio.repos.assets.get(orgA, asset.id)).rejects.toMatchObject({ kind: 'not_found' })
    const row = await db.get('SELECT deleted_at, delete_reason, consent_record_id FROM audio_assets WHERE id = ?', [asset.id])
    expect(toStr(row!.deleted_at)).toBeTruthy()
    expect(toStr(row!.delete_reason)).toBe('retention_expired')
    expect(toStr(row!.consent_record_id)).toBeTruthy()
    // Transcript content purged; segments removed; row survives.
    const transcriptRow = await db.get('SELECT full_text, status FROM audio_transcripts WHERE id = ?', [refreshed.transcriptId])
    expect(toStr(transcriptRow!.full_text)).toBe('')
    expect(toStr(transcriptRow!.status)).toBe('deleted')
  })
})

describe('provider webhooks', () => {
  const secret = 'whsec_audio_test'

  it('accepts signed events, stores them, and dedupes duplicate deliveries', async () => {
    const body = JSON.stringify({ type: 'ping', event_id: 'evt_1' })
    const header = signElevenLabsPayload(body, secret)
    const first = await audio.webhooks.receiveElevenLabs(body, header)
    const second = await audio.webhooks.receiveElevenLabs(body, header)
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    const events = await audio.repos.webhookEvents.list({ provider: 'elevenlabs' })
    expect(events.filter((event) => event.externalEventId === 'evt_1')).toHaveLength(1)
  })

  it('rejects unsigned and mis-signed deliveries and records the rejection', async () => {
    const body = JSON.stringify({ type: 'ping', event_id: 'evt_2' })
    await expect(audio.webhooks.receiveElevenLabs(body, null)).rejects.toBeInstanceOf(AppError)
    await expect(audio.webhooks.receiveElevenLabs(body, 't=1,v0=deadbeef')).rejects.toBeInstanceOf(AppError)
    const rejected = await audio.repos.webhookEvents.list({ status: 'rejected' })
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected[0]!.signatureValid).toBe(false)
  })

  it('completes an awaiting transcription job from a verified webhook', async () => {
    // Park a job as awaiting provider delivery.
    const meeting = await createMeetingA()
    const jobs = await audio.repos.jobs.list(orgA, { operation: 'transcription' })
    await audio.repos.jobs.markAwaitingProvider(jobs[0]!.id, 'stt_abc')
    // Remove the queued run so the webhook is the only completion path.
    await db.run(`UPDATE queue_jobs SET status = 'cancelled' WHERE job_type = ?`, [JOB_TYPES.audioTranscribe])

    const body = JSON.stringify({
      type: 'speech_to_text_transcription',
      event_id: 'evt_stt_1',
      data: {
        transcription_id: 'stt_abc',
        transcription: {
          language_code: 'en',
          text: 'Delivered by webhook.',
          words: [{ text: 'Delivered by webhook.', start: 0.2, end: 1.4, type: 'word', speaker_id: 'speaker_0', logprob: -0.01 }],
        },
      },
    })
    await audio.webhooks.receiveElevenLabs(body, signElevenLabsPayload(body, secret))
    await drainAudioQueue()

    const refreshed = await audio.repos.meetings.get(orgA, meeting.id)
    expect(refreshed.transcriptId).toBeTruthy()
    const transcript = await audio.repos.transcripts.get(orgA, refreshed.transcriptId!)
    expect(transcript.fullText).toBe('Delivered by webhook.')
    const job = await audio.repos.jobs.get(orgA, jobs[0]!.id)
    expect(job.status).toBe('complete')
  })
})

describe('access gate', () => {
  it('gives the flagship org root access while partner orgs need explicit grants', async () => {
    // orgA is the oldest org on this deployment — the flagship — and holds
    // every capability without a grant row.
    let decision = await audio.access.decide({ capability: 'audio.meeting_intelligence', actor: actorA })
    expect(decision.allowed).toBe(true)

    // A partner org with no grant is refused at the entitlement layer.
    decision = await audio.access.decide({ capability: 'audio.meeting_intelligence', actor: actorB })
    expect(decision.failed?.name).toBe('org_entitlement')
  })

  it('walks the layers in order: flag, entitlement, toggle, permission, budget', async () => {
    await audio.repos.policy.grantEntitlements(orgB, ['audio.meeting_intelligence'], userA)
    let decision = await audio.access.decide({ capability: 'audio.meeting_intelligence', actor: actorB })
    expect(decision.allowed).toBe(true)

    // Org admin switches the granted capability off.
    await audio.repos.policy.setEntitlementEnabled(orgB, 'audio.meeting_intelligence', false)
    decision = await audio.access.decide({ capability: 'audio.meeting_intelligence', actor: actorB })
    expect(decision.failed?.name).toBe('org_toggle')
    await audio.repos.policy.setEntitlementEnabled(orgB, 'audio.meeting_intelligence', true)

    // Feature toggles apply to the flagship too — root access, not immunity.
    await audio.repos.policy.updateSettings(orgA, { featureToggles: { 'audio.meeting_intelligence': false } })
    decision = await audio.access.decide({ capability: 'audio.meeting_intelligence', actor: actorA })
    expect(decision.failed?.name).toBe('org_toggle')
    await audio.repos.policy.updateSettings(orgA, { featureToggles: {} })

    // Role floor.
    decision = await audio.access.decide({ capability: 'audio.meeting_intelligence', actor: { ...actorB, orgRole: 'member' }, minimumRole: 'admin' })
    expect(decision.failed?.name).toBe('user_permission')

    // Budget hard stop surfaces as the usage_limit layer.
    await audio.repos.usage.setBudget({
      orgId: orgB,
      scope: 'org',
      scopeId: orgB,
      monthlyCapMicros: 0,
      perJobCapMicros: null,
      approvalAboveMicros: null,
      warnThresholdPct: 0.8,
      hardStop: true,
    })
    decision = await audio.access.decide({ capability: 'audio.meeting_intelligence', actor: actorB, estimatedCostMicros: 1 })
    expect(decision.failed?.name).toBe('usage_limit')
  })
})

describe('transcript correction', () => {
  it('applies a human edit to the segment and rebuilds the full text', async () => {
    const meeting = await createMeetingA()
    await drainAudioQueue()
    const refreshed = await audio.repos.meetings.get(orgA, meeting.id)
    const segments = await audio.repos.transcripts.segments(orgA, refreshed.transcriptId!)
    await audio.repos.transcripts.updateSegmentText(orgA, refreshed.transcriptId!, segments[0]!.id, 'Corrected opening line.')
    const transcript = await audio.repos.transcripts.get(orgA, refreshed.transcriptId!)
    expect(transcript.fullText.startsWith('Corrected opening line.')).toBe(true)
    // Cross-tenant correction attempts fail like any other access.
    await expect(
      audio.repos.transcripts.updateSegmentText(orgB, refreshed.transcriptId!, segments[1]!.id, 'nope'),
    ).rejects.toMatchObject({ kind: 'not_found' })
  })
})

describe('operator desk updates', () => {
  it('updates lead contact details and completes tasks', async () => {
    const lead = await audio.repos.operatorDesk.createLead({ orgId: orgA, name: 'Nova Verge', source: 'manual', createdBy: userA })
    await audio.repos.operatorDesk.updateLeadContact(orgA, lead.id, { email: 'rio@novaverge.example', stage: 'qualified' })
    const updated = await audio.repos.operatorDesk.getLead(orgA, lead.id)
    expect(updated.email).toBe('rio@novaverge.example')
    expect(updated.stage).toBe('qualified')

    const task = await audio.repos.operatorDesk.createTask({
      orgId: orgA,
      leadId: lead.id,
      description: 'Send split sheet',
      sourceType: 'manual',
      sourceId: 'test',
      createdBy: userA,
    })
    await audio.repos.operatorDesk.setTaskStatus(orgA, task.id, 'done')
    const tasks = await audio.repos.operatorDesk.tasksForLead(orgA, lead.id)
    expect(tasks[0]!.status).toBe('done')
    expect(tasks[0]!.completedAt).toBeTruthy()
    // Other tenants cannot flip this org's tasks.
    await expect(audio.repos.operatorDesk.setTaskStatus(orgB, task.id, 'cancelled')).rejects.toMatchObject({ kind: 'not_found' })
  })
})

describe('agent provider sync', () => {
  it('pushes the definition to the provider and records the provider agent id', async () => {
    const agents = await audio.operatorAgent.ensureDefaultAgents(orgA, userA)
    const intake = agents.find((agent) => agent.agentType === 'intake_orchestrator')!
    await audio.repos.agents.addKnowledgeDoc({
      orgId: orgA,
      agentId: intake.id,
      name: 'Distribution FAQ',
      content: 'Street Banker distributes to major platforms. Decisions are made by the human team.',
      createdBy: userA,
    })
    const synced = await audio.operatorAgent.syncToProvider(orgA, intake.id)
    expect(synced.providerAgentId).toBeTruthy()
    expect(synced.provider).toBe('mock-audio')
    // Re-sync updates in place rather than creating a second provider agent.
    const resynced = await audio.operatorAgent.syncToProvider(orgA, intake.id)
    expect(resynced.providerAgentId).toBe(synced.providerAgentId)
  })
})

describe('caption assets', () => {
  it('stores separate SRT and VTT caption files per dubbed language', async () => {
    const project = await audio.globalRelease.create({
      actor: actorA,
      name: 'Trailer',
      bytes: wavBytes(),
      filename: 'trailer.wav',
      sourceLanguage: 'en',
      targetLanguages: ['es'],
      voiceStrategy: 'approved_narrator',
      rightsConfirmed: true,
    })
    await drainAudioQueue()
    await audio.globalRelease.approveTranscript(actorA, project.id)
    await drainAudioQueue()
    const refreshed = await audio.repos.dubbing.get(orgA, project.id)
    expect(refreshed.status).toBe('quality_review')
    expect(refreshed.targets[0]!.status).toBe('ready')
    const assets = await audio.repos.assets.list(orgA, { projectType: 'global_release', projectId: project.id })
    expect(assets.some((asset) => asset.assetType === 'captions_srt')).toBe(true)
    expect(assets.some((asset) => asset.assetType === 'captions_vtt')).toBe(true)
    expect(assets.some((asset) => asset.assetType === 'dubbed_audio')).toBe(true)
  })
})

describe('demo seed', () => {
  it('is idempotent and entirely runnable without credentials', async () => {
    const first = await seedAudioDemo(audio, { orgId: orgA, userId: userA })
    expect(first.seeded).toBe(true)
    const second = await seedAudioDemo(audio, { orgId: orgA, userId: userA })
    expect(second.seeded).toBe(false)
    expect((await audio.repos.meetings.list(orgA)).length).toBeGreaterThanOrEqual(7)
    expect((await audio.repos.briefs.list(orgA)).length).toBeGreaterThanOrEqual(5)
    expect((await audio.repos.agents.listConversations(orgA)).length).toBeGreaterThanOrEqual(3)
  })
})

describe('partner entitlement administration', () => {
  it('applies a preset, toggles a grant off without losing it, and revokes', async () => {
    // Preset grants the partner org its plan's capabilities.
    const preset = ['audio.meeting_intelligence', 'audio.transcription', 'audio.signal_briefs'] as const
    await audio.repos.policy.grantEntitlements(orgB, [...preset], userA)
    let entitlements = await audio.repos.policy.listEntitlements(orgB)
    expect(entitlements.map((e) => e.capability).sort()).toEqual([...preset].sort())
    expect(entitlements.every((e) => e.enabled)).toBe(true)

    // Switching off keeps the grant row but closes the gate.
    await audio.repos.policy.setEntitlementEnabled(orgB, 'audio.transcription', false)
    entitlements = await audio.repos.policy.listEntitlements(orgB)
    expect(entitlements.find((e) => e.capability === 'audio.transcription')).toMatchObject({ enabled: false })
    let decision = await audio.access.decide({ capability: 'audio.transcription', actor: actorB })
    expect(decision.failed?.name).toBe('org_toggle')

    // Switching back on restores access without re-granting.
    await audio.repos.policy.setEntitlementEnabled(orgB, 'audio.transcription', true)
    decision = await audio.access.decide({ capability: 'audio.transcription', actor: actorB })
    expect(decision.allowed).toBe(true)

    // Revoking removes the grant entirely.
    await audio.repos.policy.revokeEntitlement(orgB, 'audio.transcription')
    entitlements = await audio.repos.policy.listEntitlements(orgB)
    expect(entitlements.find((e) => e.capability === 'audio.transcription')).toBeUndefined()
    decision = await audio.access.decide({ capability: 'audio.transcription', actor: actorB })
    expect(decision.failed?.name).toBe('org_entitlement')
  })

  it('toggling one org never affects another', async () => {
    await audio.repos.policy.grantEntitlements(orgB, ['audio.signal_briefs'], userA)
    await audio.repos.policy.setEntitlementEnabled(orgB, 'audio.signal_briefs', false)
    // orgA is the flagship: implicit access, untouched by orgB's toggle.
    const decision = await audio.access.decide({ capability: 'audio.signal_briefs', actor: actorA })
    expect(decision.allowed).toBe(true)
  })

  it('reports per-org budgets and month spend for the admin console', async () => {
    await audio.repos.usage.setBudget({
      orgId: orgB,
      scope: 'org',
      scopeId: orgB,
      monthlyCapMicros: usdToMicros(25),
      perJobCapMicros: null,
      approvalAboveMicros: null,
      warnThresholdPct: 0.8,
      hardStop: true,
    })
    await audio.repos.usage.record({
      orgId: orgB,
      userId: userB,
      projectType: 'meeting',
      projectId: null,
      provider: 'mock-audio',
      operation: 'transcription',
      model: 'mock',
      unit: 'seconds',
      inputUnits: 120,
      outputUnits: 0,
      estimatedCostMicros: usdToMicros(2),
      finalCostMicros: 0,
      currency: 'USD',
      providerRequestId: null,
      jobId: null,
    })
    const budgets = await audio.repos.usage.listBudgets(orgB)
    expect(budgets).toHaveLength(1)
    expect(budgets[0]!.monthlyCapMicros).toBe(usdToMicros(25))
    const summary = await audio.repos.usage.summary(orgB)
    expect(summary.monthSpendMicros).toBe(usdToMicros(2))
    // Spend is per-tenant: the flagship's ledger is untouched.
    expect((await audio.repos.usage.summary(orgA)).monthSpendMicros).toBe(0)
  })
})
