import { ALL_AUDIO_CAPABILITIES } from '@masterclip/audio-core'
import { mockTranscript, renderWav, seedFromString } from '@masterclip/audio-providers'
import type { AudioLayer } from './layer.js'

/**
 * Demo mode: everything fictional, everything runnable without credentials.
 *
 * No real artists, managers, labels, distributors, releases, or voices —
 * every name below is invented for this seed. Idempotent: a second run
 * detects the existing demo lead and returns.
 */
export async function seedAudioDemo(audio: AudioLayer, input: { orgId: string; userId: string }): Promise<{ seeded: boolean }> {
  const { orgId, userId } = input
  const existingLeads = await audio.repos.operatorDesk.listLeads(orgId, 5)
  if (existingLeads.some((lead) => lead.source === 'audio-demo')) return { seeded: false }

  // The flagship org carries every capability, including provider admin.
  await audio.repos.policy.grantEntitlements(orgId, ALL_AUDIO_CAPABILITIES, 'seed')
  await audio.repos.policy.getPolicy(orgId)
  // The demo exercises music and voice features, so its policy allows them;
  // real organizations opt in deliberately.
  await audio.repos.policy.updatePolicy(orgId, { allowMusicGeneration: true, allowVoiceCloning: true })
  await audio.repos.policy.updateSettings(orgId, {
    protectedNames: ['Nova Verge', 'Marisol Vane', 'Chorusline Collective'],
  })
  for (const term of ['Nova Verge', 'Marisol Vane', 'Chorusline', 'Harbor Lights EP', 'Basalt City']) {
    await audio.repos.policy.addKeyterm(orgId, { term, category: 'artist', sensitivity: 'shareable' }, userId)
  }

  const lead = await audio.repos.operatorDesk.createLead({
    orgId,
    name: 'Nova Verge — distribution',
    contactName: 'Rio Calder',
    email: 'rio@novaverge.example',
    phone: '',
    artistName: 'Nova Verge',
    stage: 'qualifying',
    source: 'audio-demo',
    createdBy: userId,
  })

  // Meetings: a mix of committed history and a fresh draft to review.
  const meetingSpecs = [
    { title: 'A&R call — Nova Verge', type: 'A&R Call' },
    { title: 'A&R call — Marisol Vane', type: 'A&R Call' },
    { title: 'A&R call — The Basalt Choir', type: 'A&R Call' },
    { title: 'Onboarding — Nova Verge', type: 'Artist Onboarding' },
    { title: 'Onboarding — Marisol Vane', type: 'Artist Onboarding' },
    { title: 'Manager sync — Rio Calder', type: 'Manager Meeting' },
    { title: 'Distribution terms — Harbor Lights EP', type: 'Distribution Discussion' },
  ]
  for (const [index, spec] of meetingSpecs.entries()) {
    const bytes = renderWav({ frequency: 160 + index * 20, durationSeconds: 6, seed: seedFromString(spec.title) })
    const meeting = await audio.meetings.createWithUpload({
      actor: { userId, orgId, orgRole: 'owner' },
      title: spec.title,
      meetingType: spec.type,
      operatorLeadId: lead.id,
      bytes,
      filename: `${spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.wav`,
      consent: { accepted: true },
    })
    // Complete the pipeline inline so demo data is reviewable immediately.
    const transcript = await audio.repos.transcripts.createFromNormalized({
      orgId,
      audioAssetId: meeting.audioAssetId!,
      provider: 'mock-audio',
      transcript: mockTranscript(true, seedFromString(spec.title)),
      retentionExpiresAt: null,
    })
    await audio.repos.meetings.attachTranscript(meeting.id, transcript.id)
    await audio.meetings.runExtraction(meeting.id)
  }

  // Signal briefs — five, with confidence language preserved.
  const briefSpecs: Array<{ type: string; title: string; items: Array<{ statement: string; confidence: 'confirmed' | 'likely' | 'needs_verification' }> }> = [
    {
      type: 'daily_scout',
      title: 'Daily scout brief',
      items: [
        { statement: 'Nova Verge’s pre-save page traffic doubled overnight in Basalt City.', confidence: 'confirmed' },
        { statement: 'The spike traces to one playlist add on a mid-size editorial list.', confidence: 'likely' },
      ],
    },
    {
      type: 'weekly_executive',
      title: 'Weekly executive brief',
      items: [
        { statement: 'Three distribution deals moved to contract review this week.', confidence: 'confirmed' },
        { statement: 'Two catalogs under audit show recoverable royalties.', confidence: 'needs_verification' },
      ],
    },
    {
      type: 'rights_health',
      title: 'Rights health brief',
      items: [{ statement: 'Two Nova Verge tracks still carry a Content ID claim from a previous distributor.', confidence: 'needs_verification' }],
    },
    {
      type: 'deal_pipeline',
      title: 'Deal pipeline brief',
      items: [{ statement: 'The Harbor Lights EP license proposal is awaiting the ISRC list.', confidence: 'confirmed' }],
    },
    {
      type: 'follow_up',
      title: 'Follow-up brief',
      items: [{ statement: 'Rio Calder expects the split sheet template by Friday.', confidence: 'confirmed' }],
    },
  ]
  for (const spec of briefSpecs) {
    const brief = await audio.briefs.create({
      actor: { userId, orgId, orgRole: 'owner' },
      briefType: spec.type,
      title: spec.title,
      items: spec.items,
    })
    await audio.briefs.runRender(brief.id)
  }

  // Operator agent + three conversations, one with a human transfer.
  const agents = await audio.operatorAgent.ensureDefaultAgents(orgId, userId)
  const intake = agents.find((a) => a.agentType === 'intake_orchestrator')!
  await audio.repos.agents.update(orgId, intake.id, { status: 'active' })
  const scripts: string[][] = [
    ['Rio Calder', 'Nova Verge', 'rio@novaverge.example', 'Chorusline, two years', 'Harbor Lights EP in March', 'Yes, we own everything', 'Wider distribution and playlist reach'],
    ['Marisol Vane', 'Marisol Vane', 'marisol@vane.example', 'Self-released', 'A single next month', 'Yes', 'A team that answers emails'],
    ['I want to speak to a human please'],
  ]
  for (const script of scripts) {
    const session = await audio.operatorAgent.startConversation({ actor: null, orgId, agentId: intake.id, channel: 'web' })
    for (const line of script) {
      const result = await audio.operatorAgent.userTurn(orgId, session.conversation.id, line)
      if (result.ended) break
    }
    const record = await audio.repos.agents.getConversation(orgId, session.conversation.id)
    if (record.status === 'active') await audio.operatorAgent.endConversation(orgId, session.conversation.id, 'demo_complete')
  }

  // Global Release Pack — one project, through transcript review.
  const grBytes = renderWav({ frequency: 200, durationSeconds: 8, seed: seedFromString('harbor-lights-trailer') })
  const pack = await audio.globalRelease.create({
    actor: { userId, orgId, orgRole: 'owner' },
    name: 'Harbor Lights EP — trailer localizations',
    bytes: grBytes,
    filename: 'harbor-lights-trailer.wav',
    sourceLanguage: 'en',
    targetLanguages: ['es', 'de'],
    voiceStrategy: 'approved_narrator',
    rightsConfirmed: true,
  })

  // Campaign Audio project.
  await audio.campaigns.create({
    actor: { userId, orgId, orgRole: 'owner' },
    name: 'Harbor Lights — release announcement',
    templateType: 'release_announcement',
    usageContext: 'social',
    rightsBasis: 'owned_release_assets',
  })

  // Remix Lab project on owned audio.
  const remixBytes = renderWav({ frequency: 120, durationSeconds: 10, seed: seedFromString('harbor-lights-title-track') })
  await audio.remix.create({
    actor: { userId, orgId, orgRole: 'owner' },
    name: 'Harbor Lights — title track versions',
    bytes: remixBytes,
    filename: 'harbor-lights-title-track.wav',
    remixLane: 'stems',
    targetUse: 'social_versions',
    rightsConfirmed: true,
    noImitationConfirmed: true,
  })

  // One verified fictional voice profile (mock provider verifies by default).
  await audio.voiceVault.register({
    actor: { userId, orgId, orgRole: 'owner' },
    ownerName: 'Nova Verge (fictional)',
    profileName: 'Nova Verge — narration voice',
    providerVoiceId: 'mock-voice-novaverge',
    ownerConsentConfirmed: true,
    permittedUses: { internal: true, social: true, commercial: true },
    validUntil: null,
  })

  void pack
  return { seeded: true }
}
