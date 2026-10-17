import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod/v4'
import { AppError } from '@masterclip/shared'
import { sanitizeFilename } from '@masterclip/asset-storage'
import type { Runtime } from '@masterclip/runtime'
import type { Master } from '@masterclip/domain'
import { requireAuth, requireProject } from '../server.js'
import { DELIVER_TOO_BIG, VAULT_VIDEO_MAX_BYTES, VaultDoor } from '../vault-door.js'
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

  /**
   * Whether "Send to my Vault" can work for this session: the door is set up
   * (SUITE_SSO_SECRET) and Street Banker's hand-off opened the session. The
   * Masters page hides the button when it cannot.
   */
  app.get('/api/vault/status', async (request) => {
    const auth = await requireAuth(runtime, request)
    if (!door) return { connected: false, note: 'Your Vault is not connected to MOTION yet.' }
    if (!auth.streetBankerEmail) return { connected: false, note: 'Open MOTION from Street Banker to reach your Vault.' }
    return { connected: true, note: '' }
  })

  /** One send per master at a time, so a double press never uploads twice. */
  const sending = new Map<string, Promise<MasterVaultResult>>()

  /**
   * "Send to my Vault" (owner, 2026-10-16: "make sure everything saves or
   * uploads to the Vault"). Files a signed-off master's video in the artist's
   * Street Banker Vault through the delivery door. Nothing is auto-promoted to
   * a master (docs/architecture.md); only a master a person signed off, in a
   * project this account directs, goes. The Vault id is kept on the master, so
   * the second press says "Already in your Vault" and sends nothing. A refusal
   * or a Street Banker that does not answer leaves the master as it was.
   */
  app.post('/api/masters/:masterId/vault', async (request) => {
    const { masterId } = request.params as { masterId: string }
    const master = await runtime.renders.getMaster(masterId)
    const { auth } = await requireProject(runtime, request, master.projectId, 'director')
    const { email, door: d } = await vouched(request)

    if (master.vault) {
      return { ok: true, id: master.vault.fileId, label: master.vault.label, deduped: true, already: true }
    }
    const sendKey = `${masterId} ${email}`
    const running = sending.get(sendKey)
    if (running) return running

    const work = (async (): Promise<MasterVaultResult> => {
      await requireSignedOff(runtime, master)
      const asset = await runtime.assets.get(master.masterAssetId ?? master.sourceAssetId)
      if (asset.projectId !== master.projectId) {
        throw new AppError({ kind: 'forbidden', code: 'vault.other_project', message: 'This master’s video belongs to another film.' })
      }
      const extension = videoExtension(asset.filename, asset.mime)
      if (!extension) {
        throw new AppError({ kind: 'validation', code: 'vault.not_video', message: 'Your Vault takes MP4 or MOV video from MOTION. This master is neither, so it was not sent.' })
      }
      // Refused on the record's size before a byte is read or a token is asked for.
      if (Number(asset.bytes) > VAULT_VIDEO_MAX_BYTES) {
        throw new AppError({ kind: 'validation', code: 'vault.too_big', message: DELIVER_TOO_BIG })
      }
      const project = await runtime.projects.get(master.projectId)
      const label = `${project.name.trim() || 'MOTION film'} – ${master.name.trim() || 'Master'}`
      const bytes = await runtime.storage.getBuffer(asset.storageKey)
      const filename = sanitizeFilename(`${label}.${extension}`)
      const delivered = await d.deliver(email, bytes, filename, 'video', label)
      const sentAt = runtime.clock.isoNow()
      await runtime.renders.setMasterVault(master.id, { fileId: delivered.id, label: delivered.label, sentAt })
      await runtime.audit.record({
        orgId: auth.orgId,
        projectId: master.projectId,
        actor: auth.userId,
        action: 'master.sent_to_vault',
        targetType: 'master',
        targetId: master.id,
        data: { vaultFileId: delivered.id, label: delivered.label, deduped: delivered.deduped, assetId: asset.id },
      })
      return { ok: true, id: delivered.id, label: delivered.label, deduped: delivered.deduped, already: delivered.deduped }
    })()
    sending.set(sendKey, work)
    try {
      return await work
    } finally {
      sending.delete(sendKey)
    }
  })
}

interface MasterVaultResult {
  ok: true
  id: string
  label: string
  /** The Vault already held this video (sent before, or added by hand). */
  deduped: boolean
  already: boolean
}

/**
 * Signed off: promoted by a person, not archived, and the output behind it
 * still carries that person's approval (a later reset or reject takes it back).
 */
async function requireSignedOff(runtime: Runtime, master: Master): Promise<void> {
  const refuse = () => {
    throw new AppError({ kind: 'validation', code: 'vault.not_signed_off', message: 'Only a signed-off master goes to your Vault. Approve it first.' })
  }
  if (master.status === 'archived' || !master.approvedBy.trim() || !master.approvedAt.trim()) refuse()
  const review = await runtime.renders.latestReview(master.outputId)
  if (!review || (review.decision !== 'approve' && review.decision !== 'promote')) refuse()
}

function videoExtension(filename: string, mime: string): 'mp4' | 'mov' | null {
  const ext = (filename.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase()
  if (ext === 'mp4' || ext === 'mov') return ext
  if (mime === 'video/mp4') return 'mp4'
  if (mime === 'video/quicktime') return 'mov'
  return null
}
