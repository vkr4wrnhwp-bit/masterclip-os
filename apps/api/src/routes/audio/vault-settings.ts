import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { microsToUsd } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'
import { requireAudio } from './helpers.js'

/** Artist Voice Vault + org-level audio settings, policy, and usage routes. */
export async function registerAudioVaultAndSettingsRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const audio = runtime.audio

  // ----- Artist Voice Vault -------------------------------------------------

  app.get('/api/audio/voice-vault', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.voice_vault')
    return { profiles: await audio.repos.voiceVault.list(actor.orgId) }
  })

  app.post('/api/audio/voice-vault', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.voice_vault_verified_cloning', { minimumRole: 'admin', slot: 'voiceIdentity' })
    const body = z
      .object({
        ownerName: z.string().min(1).max(200),
        profileName: z.string().min(1).max(200),
        providerVoiceId: z.string().min(1).max(200),
        ownerConsentConfirmed: z.boolean(),
        validUntil: z.string().nullable().default(null),
        permittedUses: z
          .object({
            commercial: z.boolean().optional(),
            advertising: z.boolean().optional(),
            dubbing: z.boolean().optional(),
            social: z.boolean().optional(),
            internal: z.boolean().optional(),
          })
          .default({}),
      })
      .parse(request.body)
    const profile = await audio.voiceVault.register({ actor, ...body })
    return { profile }
  })

  app.get('/api/audio/voice-vault/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.voice_vault')
    const { id } = request.params as { id: string }
    const profile = await audio.repos.voiceVault.get(actor.orgId, id)
    const consent = await audio.repos.consents.get(actor.orgId, profile.consentRecordId)
    return { profile, consent }
  })

  app.post('/api/audio/voice-vault/:id/revoke', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.voice_vault', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    const profile = await audio.voiceVault.revoke(actor, id)
    return { profile }
  })

  // ----- Org settings, policy, keyterms, usage ------------------------------

  app.get('/api/audio/settings', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const [policy, settings, entitlements, keyterms] = await Promise.all([
      audio.repos.policy.getPolicy(actor.orgId),
      audio.repos.policy.getSettings(actor.orgId),
      audio.repos.policy.listEntitlements(actor.orgId),
      audio.repos.policy.listKeyterms(actor.orgId),
    ])
    return { policy, settings, entitlements, keyterms }
  })

  app.patch('/api/audio/settings/policy', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence', { minimumRole: 'admin' })
    const body = z
      .object({
        allowAudioUpload: z.boolean().optional(),
        allowMeetingRecording: z.boolean().optional(),
        allowCallRecording: z.boolean().optional(),
        allowTranscription: z.boolean().optional(),
        allowVoiceGeneration: z.boolean().optional(),
        allowDubbing: z.boolean().optional(),
        allowMusicGeneration: z.boolean().optional(),
        allowVoiceCloning: z.boolean().optional(),
        requireZeroRetention: z.boolean().optional(),
        allowDownload: z.boolean().optional(),
        allowExport: z.boolean().optional(),
        requireRecordingConsent: z.boolean().optional(),
        sourceAudioRetentionDays: z.number().int().min(1).nullable().optional(),
        transcriptRetentionDays: z.number().int().min(1).nullable().optional(),
        generatedAudioRetentionDays: z.number().int().min(1).nullable().optional(),
        agentConversationRetentionDays: z.number().int().min(1).nullable().optional(),
      })
      .parse(request.body)
    const policy = await audio.repos.policy.updatePolicy(actor.orgId, body)
    return { policy }
  })

  app.patch('/api/audio/settings', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence', { minimumRole: 'admin' })
    const body = z
      .object({
        protectedNames: z.array(z.string().min(1).max(200)).max(500).optional(),
        defaultProviders: z.record(z.string(), z.string()).optional(),
        whiteLabel: z
          .object({
            agentDisplayName: z.string().max(120).optional(),
            accentColor: z.string().max(32).optional(),
            welcomeMessage: z.string().max(1000).optional(),
            supportEmail: z.string().max(200).optional(),
          })
          .optional(),
        featureToggles: z.record(z.string(), z.boolean()).optional(),
      })
      .parse(request.body)
    const settings = await audio.repos.policy.updateSettings(actor.orgId, body)
    return { settings }
  })

  app.post('/api/audio/settings/keyterms', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const body = z
      .object({
        term: z.string().min(1).max(50),
        category: z.string().min(1).max(40),
        sensitivity: z.enum(['shareable', 'private']).default('shareable'),
      })
      .parse(request.body)
    const id = await audio.repos.policy.addKeyterm(actor.orgId, body, actor.userId)
    return { id }
  })

  app.delete('/api/audio/settings/keyterms/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    await audio.repos.policy.removeKeyterm(actor.orgId, id)
    return { ok: true }
  })

  app.get('/api/audio/usage', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const summary = await audio.repos.usage.summary(actor.orgId)
    const entries = await audio.repos.usage.list(actor.orgId, 100)
    const budgets = await audio.repos.usage.listBudgets(actor.orgId)
    return {
      summary: {
        monthSpendUsd: microsToUsd(summary.monthSpendMicros),
        byOperation: summary.byOperation.map((row) => ({ ...row, usd: microsToUsd(row.micros) })),
      },
      entries,
      budgets,
    }
  })

  app.get('/api/audio/jobs', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    return { jobs: await audio.repos.jobs.list(actor.orgId) }
  })

  app.get('/api/audio/assets/:id/url', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence')
    const { id } = request.params as { id: string }
    return audio.assets.signedUrl(actor.orgId, id)
  })

  app.delete('/api/audio/assets/:id', async (request) => {
    const { actor } = await requireAudio(runtime, request, 'audio.meeting_intelligence', { minimumRole: 'admin' })
    const { id } = request.params as { id: string }
    await audio.assets.deleteAsset(actor.orgId, id, `manual_delete_by_${actor.userId}`)
    return { ok: true }
  })
}
