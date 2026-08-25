import type { FastifyRequest } from 'fastify'
import { AppError, forbidden } from '@masterclip/shared'
import type { Runtime } from '@masterclip/runtime'
import { flagshipOrgId, type Actor } from '@masterclip/audio-engine'
import type { AudioCapability, AudioCapabilitySlot } from '@masterclip/audio-core'
import { requireAuth } from '../../server.js'

export function actorFrom(auth: { userId: string; orgId: string; orgRole: string }): Actor {
  return { userId: auth.userId, orgId: auth.orgId, orgRole: auth.orgRole }
}

/**
 * Authenticate + run the layered audio feature gate in one call. Every audio
 * route goes through here; hiding a button in the frontend is not a control.
 */
export async function requireAudio(
  runtime: Runtime,
  request: FastifyRequest,
  capability: AudioCapability,
  opts: { minimumRole?: 'member' | 'admin' | 'owner'; estimatedCostMicros?: number; slot?: AudioCapabilitySlot } = {},
): Promise<{ actor: Actor; warning: string | null }> {
  const auth = await requireAuth(runtime, request)
  const actor = actorFrom(auth)
  const { warning } = await runtime.audio.access.authorize({ capability, actor, ...opts })
  return { actor, warning }
}

/**
 * Flagship (root) administration: provider credentials, entitlements, budgets,
 * global kill switches. Restricted to owners/admins of the flagship org — the
 * oldest organization on the deployment, which is the Street Banker org by
 * construction of the bootstrap flow.
 */
export async function requireFlagshipAdmin(runtime: Runtime, request: FastifyRequest): Promise<Actor> {
  const auth = await requireAuth(runtime, request)
  if (auth.orgRole !== 'owner' && auth.orgRole !== 'admin') throw forbidden('flagship administration requires an org admin')
  if ((await flagshipOrgId(runtime.db)) !== auth.orgId) {
    throw forbidden('provider administration is restricted to the flagship organization')
  }
  return actorFrom(auth)
}

/** Reads a single uploaded file plus form fields from a multipart request. */
export async function readUpload(request: FastifyRequest): Promise<{ bytes: Uint8Array; filename: string; fields: Record<string, string> }> {
  const parts = request.parts()
  let bytes: Uint8Array | null = null
  let filename = 'upload'
  const fields: Record<string, string> = {}
  for await (const part of parts) {
    if (part.type === 'file') {
      if (bytes) {
        throw new AppError({ kind: 'validation', code: 'audio.too_many_files', message: 'upload one file per request' })
      }
      filename = part.filename ?? 'upload'
      bytes = new Uint8Array(await part.toBuffer())
    } else {
      fields[part.fieldname] = String(part.value)
    }
  }
  if (!bytes) throw new AppError({ kind: 'validation', code: 'audio.no_file', message: 'a file is required' })
  return { bytes, filename, fields }
}

export function parseBool(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'on' || value === 'yes'
}
