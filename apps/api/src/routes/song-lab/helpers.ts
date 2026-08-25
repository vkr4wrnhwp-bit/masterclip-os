import type { FastifyRequest } from 'fastify'
import { forbidden } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'
import type { Actor } from '@masterclip/song-lab-engine'
import type { SongLabCapability, SongLabLimit } from '@masterclip/song-lab-domain'
import { requireAuth } from '../../server.js'

/**
 * Authenticate plus run the Song Lab gate, in one call.
 *
 * Every Song Lab route goes through here before it touches data. The frontend
 * hiding a tab is presentation; this is the control.
 */
export async function requireSongLab(
  runtime: Runtime,
  request: FastifyRequest,
  capability: SongLabCapability,
  opts: { minimumRole?: 'member' | 'admin' | 'owner'; usage?: { limit: SongLabLimit; current: number; what: string } } = {},
): Promise<Actor> {
  const auth = await requireAuth(runtime, request)
  const actor: Actor = { userId: auth.userId, orgId: auth.orgId, orgRole: auth.orgRole }
  await runtime.songLab.access.authorize({ capability, actor, ...opts })
  return actor
}

/** Flagship-only administration (proprietary cohorts, cross-roster views). */
export async function requireSongLabFlagship(runtime: Runtime, request: FastifyRequest): Promise<Actor> {
  const actor = await requireSongLab(runtime, request, 'song_lab.access', { minimumRole: 'admin' })
  if (!(await runtime.songLab.access.isFlagship(actor.orgId))) {
    throw forbidden('this action is restricted to the flagship organization')
  }
  return actor
}
