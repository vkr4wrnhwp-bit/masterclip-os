import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Runtime } from '@masterclip/runtime'

/**
 * Inbound provider webhooks.
 *
 * No session, no CSRF — authenticity comes exclusively from the provider's
 * HMAC signature verified against the RAW request bytes (captured by the
 * server's content-type parser). Unsigned, mis-signed, or stale deliveries are
 * rejected with 403 before any content is trusted.
 */
export async function registerAudioWebhookRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  app.post('/api/webhooks/elevenlabs', async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? ''
    const signature = request.headers['elevenlabs-signature']
    const result = await runtime.audio.webhooks.receiveElevenLabs(rawBody, typeof signature === 'string' ? signature : null)
    void reply.status(200)
    return { received: true, deduped: result.deduped }
  })
}
