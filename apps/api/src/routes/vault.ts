import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { AppError } from '@masterclip/shared'
import { sanitizeFilename } from '@masterclip/asset-storage'
import type { Runtime } from '@masterclip/runtime'
import { requireAuth, requireProject } from '../server.js'
import { VaultDoor } from '../vault-door.js'
import { storeProjectFile } from './assets.js'

/**
 * "From your Vault" (owner, 2026-10-12: "what we need to create is the pull
 * from vault"). Motion is opened from Street Banker already signed in; the
 * artist's songs are in the main app's Vault, so Motion lists them and brings
 * one into a project through the same store step and the same rights
 * authorization as a file from this computer. Nothing is copied until the
 * artist picks a song and confirms the rights.
 *
 * Only a session Street Banker's signed hand-off opened may ask: it carries the
 * email Street Banker vouched for. A Motion password session gets a plain
 * refusal, so an account made here with someone else's email reads nothing.
 */
export async function registerVaultRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  door: VaultDoor | null = VaultDoor.fromEnv(),
): Promise<void> {
  async function vouched(request: FastifyRequest): Promise<{ email: string; door: VaultDoor }> {
    const auth = await requireAuth(runtime, request)
    if (!door) {
      throw new AppError({ kind: 'provider_unavailable', code: 'vault.off', message: 'The Vault is not switched on for Motion yet.' })
    }
    if (!auth.streetBankerEmail) {
      throw new AppError({ kind: 'forbidden', code: 'vault.not_from_street_banker', message: 'Open Motion from Street Banker to reach your Vault.' })
    }
    return { email: auth.streetBankerEmail, door }
  }

  /** The artist's Vault songs. Motion takes WAV and MP3; the rest are listed as not usable yet. */
  app.get('/api/vault/audio', async (request) => {
    const { email, door: d } = await vouched(request)
    const files = await d.listAudio(email)
    return { files }
  })

  /**
   * One Vault song into a project, with the rights the artist confirms, exactly
   * as an upload would carry them. The same song twice is the one asset.
   */
  app.post('/api/projects/:projectId/vault-import', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const { email, door: d } = await vouched(request)
    const body = z.object({
      fileId: z.string().min(1).max(80),
      rights: z.object({
        owner: z.string().default(''),
        license: z.string().default(''),
        consent: z.enum(['not_applicable', 'unverified', 'authorized', 'revoked']).default('unverified'),
        allowedUse: z.string().default(''),
        notes: z.string().default(''),
        authorized: z.boolean().default(false),
      }).prefault({}),
    }).parse(request.body ?? {})

    // The label is the Vault's own name for the song; the file is fetched by id.
    const listed = (await d.listAudio(email)).find((f) => f.id === body.fileId)
    if (!listed) throw new AppError({ kind: 'not_found', code: 'vault.not_found', message: 'That song is no longer in your Vault.' })
    if (!listed.usable) {
      throw new AppError({ kind: 'validation', code: 'vault.unusable', message: 'Motion takes WAV or MP3. Add a WAV or MP3 of this song to your Vault.' })
    }
    const bytes = await d.download(email, listed.id)
    const name = (listed.label || 'Vault song').replace(/\.(wav|wave|mp3)$/i, '')
    const filename = sanitizeFilename(`${name}.${listed.extension === 'mp3' ? 'mp3' : 'wav'}`)
    const result = await storeProjectFile(runtime, {
      projectId,
      auth,
      fileBuffer: bytes,
      filename,
      fields: {
        rights_owner: body.rights.owner,
        rights_source: `Street Banker Vault: ${listed.label}`,
        rights_license: body.rights.license,
        rights_consent: body.rights.consent,
        rights_allowed_use: body.rights.allowedUse,
        rights_notes: body.rights.notes,
        rights_authorized: body.rights.authorized ? 'true' : 'false',
      },
      metadata: { fromVault: { fileId: listed.id, label: listed.label } },
    })
    return { ...result, vaultFile: { id: listed.id, label: listed.label } }
  })
}
