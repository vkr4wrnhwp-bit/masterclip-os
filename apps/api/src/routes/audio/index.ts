import type { FastifyInstance } from 'fastify'
import type { Runtime } from '@masterclip/runtime'
import { registerAudioMeetingRoutes } from './meetings.js'
import { registerAudioBriefRoutes } from './briefs.js'
import { registerAudioOperatorRoutes } from './operator.js'
import { registerAudioProjectRoutes } from './projects.js'
import { registerAudioVaultAndSettingsRoutes } from './vault-settings.js'
import { registerAudioAdminRoutes } from './admin.js'
import { registerAudioWebhookRoutes } from './webhooks.js'

export async function registerAudioRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  await registerAudioMeetingRoutes(app, runtime)
  await registerAudioBriefRoutes(app, runtime)
  await registerAudioOperatorRoutes(app, runtime)
  await registerAudioProjectRoutes(app, runtime)
  await registerAudioVaultAndSettingsRoutes(app, runtime)
  await registerAudioAdminRoutes(app, runtime)
  await registerAudioWebhookRoutes(app, runtime)
}
