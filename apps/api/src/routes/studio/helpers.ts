import type { FastifyRequest } from 'fastify'
import type { Runtime } from '@masterclip/runtime'
import type { Actor } from '@masterclip/studio-engine'
import type { CollaboratorPermission, StudioCapability, StudioLimit } from '@masterclip/studio-domain'
import { requireAuth } from '../../server.js'

/**
 * Authenticate plus run the Studio gate, in one call.
 *
 * Every Studio route goes through here before it touches data. The frontend
 * hiding a tab is presentation; this is the control.
 *
 * `project` adds the second axis Studio needs beyond the earlier modules: an
 * organization's entitlement says what the org may do, a collaborator's
 * permission says what this person may do on this record, and both are checked.
 */
export async function requireStudio(
  runtime: Runtime,
  request: FastifyRequest,
  capability: StudioCapability,
  opts: {
    minimumRole?: 'member' | 'admin' | 'owner'
    usage?: { limit: StudioLimit; current: number; what: string }
    project?: { id: string; permission: CollaboratorPermission }
  } = {},
): Promise<Actor> {
  const auth = await requireAuth(runtime, request)
  const actor: Actor = {
    userId: auth.userId,
    orgId: auth.orgId,
    orgRole: auth.orgRole,
    email: auth.email,
    displayName: auth.displayName,
  }
  await runtime.studio.access.authorize({ capability, actor, ...opts })
  return actor
}

/** Signed, expiring URL. Audio is never served from a permanent path. */
export async function signedUrlFor(runtime: Runtime, orgId: string, assetId: string | null): Promise<string | null> {
  if (!assetId) return null
  try {
    const { url } = await runtime.audio.assets.signedUrl(orgId, assetId)
    return url
  } catch {
    // A retention sweep may have removed a derived asset. A missing URL is not
    // an error for the page around it.
    return null
  }
}
