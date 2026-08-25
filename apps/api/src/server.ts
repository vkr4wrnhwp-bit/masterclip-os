import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AppError, asAppError, httpStatusFor, type Logger } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'
import { registerProjectRoutes } from './routes/projects.js'
import { registerRenderRoutes } from './routes/render.js'
import { registerOpsRoutes } from './routes/ops.js'
import { registerAssetRoutes } from './routes/assets.js'
import { registerAudioRoutes } from './routes/audio/index.js'
import { registerLiveLabRoutes } from './routes/live-lab.js'
import { registerSongLabRoutes } from './routes/song-lab/index.js'
import { registerRateLimit, type RateLimitHandle } from './security/rate-limit.js'
import { registerCsrf } from './security/csrf.js'

export const SESSION_COOKIE = 'masterclip_session'

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; orgId: string; email: string; displayName: string; orgRole: string }
  }
}

export interface ServerOptions {
  runtime: Runtime
  /** Directory containing the built web app. Served when present. */
  webRoot?: string
  logger?: Logger
}

/**
 * The HTTP surface.
 *
 * Deliberately thin: it validates, authorizes, reads and writes the database,
 * and enqueues work. No route performs generation, transcoding, or provider
 * polling — those all belong to the worker, which is what makes a render
 * survive the request that started it.
 */
export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { runtime } = opts
  const app = Fastify({
    logger: false,
    // Provider webhooks can carry inline base64 payloads.
    bodyLimit: 32 * 1024 * 1024,
    // Off unless the operator says otherwise: `X-Forwarded-For` is written by
    // the client, so trusting it on a directly-exposed port would let anyone
    // choose their own source address and walk straight through an IP-keyed
    // rate limit.
    trustProxy: runtime.config.TRUST_PROXY,
  })

  await app.register(cookie, {})
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024, files: 8 } })

  // Both run in `onRequest`, ahead of body parsing, so a refused request never
  // reaches the JSON or multipart parsers.
  const rateLimit = registerRateLimit(app, runtime)
  registerCsrf(app, runtime)

  // Webhook signature verification needs the exact bytes that were signed;
  // re-serializing parsed JSON produces different bytes and breaks every HMAC.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8')
    ;(req as FastifyRequest & { rawBody?: string }).rawBody = raw
    if (raw.length === 0) return done(null, {})
    try {
      done(null, JSON.parse(raw))
    } catch (err) {
      done(asAppError(err, 'validation'), undefined)
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    const appError = asAppError(error)
    if (appError.kind === 'internal') runtime.logger.error('api.unhandled', { err: appError })
    else runtime.logger.debug('api.error', { kind: appError.kind, code: appError.code, message: appError.message })
    // Tell a well-behaved client when to come back instead of making it guess.
    if (appError.retryAfterSeconds !== undefined) void reply.header('retry-after', String(appError.retryAfterSeconds))
    void reply.status(httpStatusFor(appError.kind)).send(appError.toJSON())
  })

  app.setNotFoundHandler((request, reply) => {
    // Unknown API paths are 404 JSON; everything else falls through to the SPA.
    if (request.url.startsWith('/api/')) {
      void reply.status(404).send({ error: { kind: 'not_found', code: 'route', message: `no route for ${request.method} ${request.url}` } })
      return
    }
    const indexPath = opts.webRoot ? join(opts.webRoot, 'index.html') : null
    if (indexPath && existsSync(indexPath)) {
      void reply.type('text/html').sendFile('index.html')
      return
    }
    void reply.status(404).send({ error: { kind: 'not_found', code: 'route', message: 'not found' } })
  })

  app.get('/api/health', async () => ({
    ok: true,
    mode: runtime.config.MASTERCLIP_MODE,
    dialect: runtime.db.dialect,
    storage: runtime.storage.name,
    agents: runtime.agents.available,
    // Which build is actually serving. Without this, confirming a deploy meant
    // inferring the version from which routes happened to 404. Empty when the
    // host injects no commit variable — an honest blank, never a guess.
    commit: runtime.config.commit,
    commitShort: runtime.config.commit.slice(0, 7),
    branch: runtime.config.branch,
    time: runtime.clock.isoNow(),
  }))

  await registerOpsRoutes(app, runtime, rateLimit)
  await registerProjectRoutes(app, runtime)
  await registerAssetRoutes(app, runtime)
  await registerRenderRoutes(app, runtime)
  await registerAudioRoutes(app, runtime)
  await registerSongLabRoutes(app, runtime)
  await registerLiveLabRoutes(app, runtime)

  if (opts.webRoot && existsSync(opts.webRoot)) {
    await app.register(fastifyStatic, { root: resolve(opts.webRoot), prefix: '/' })
  }

  return app
}

/** Resolves the session cookie to an authenticated user, or throws 401. */
export async function requireAuth(runtime: Runtime, request: FastifyRequest): Promise<NonNullable<FastifyRequest['auth']>> {
  if (request.auth) return request.auth
  const token = request.cookies[SESSION_COOKIE] ?? bearerToken(request)
  const context = await runtime.auth.resolve(token)
  request.auth = {
    userId: context.user.id,
    orgId: context.user.orgId,
    email: context.user.email,
    displayName: context.user.displayName,
    orgRole: context.user.orgRole,
  }
  return request.auth
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return undefined
}

/** Authorizes access to a project and returns both the user and their role. */
export async function requireProject(
  runtime: Runtime,
  request: FastifyRequest,
  projectId: string,
  minimum: 'viewer' | 'editor' | 'director' | 'producer' = 'viewer',
) {
  const auth = await requireAuth(runtime, request)
  const role = await runtime.auth.requireProjectAccess(
    { id: auth.userId, orgId: auth.orgId, email: auth.email, displayName: auth.displayName, orgRole: auth.orgRole as 'owner' },
    projectId,
    minimum,
  )
  return { auth, role }
}

export function sendError(reply: FastifyReply, error: AppError): void {
  void reply.status(httpStatusFor(error.kind)).send(error.toJSON())
}
