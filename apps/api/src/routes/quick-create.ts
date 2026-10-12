import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import { AppError, forbidden, newId } from '@masterclip/shared'
import { emptyShot, validateShot, type MusicCue } from '@masterclip/shot-schema'
import type { Asset } from '@masterclip/domain'
import type { Runtime } from '@masterclip/runtime'
import { requireProject } from '../server.js'

/**
 * MOTION-only Quick Create. No V2/Reach/Vault network calls, no render
 * submission, no media rewriting and no cost. The output is a versioned shot
 * draft linked to an already-authorized MOTION audio reference.
 */
const QuickCreateInput = z.object({
  title: z.string().trim().min(1).max(120),
  creativeDirection: z.string().trim().min(8).max(1600),
  audioAssetId: z.string().min(1),
  visualAssetId: z.string().min(1).nullable().default(null),
  startSeconds: z.number().finite().min(0).max(86_400),
  endSeconds: z.number().finite().positive().max(86_400),
  aspectRatio: z.enum(['9:16', '1:1', '4:5', '16:9']).default('9:16'),
  look: z.enum(['performance', 'cinematic', 'editorial', 'atmosphere']).default('cinematic'),
  /** Affirmative per-draft confirmation, NOT permission to publish or spend. */
  promotionalUseAttested: z.literal(true),
  shotId: z.string().min(1).optional(),
})

const LOOK_DIRECTION = {
  performance: 'Grounded performer blocking, realistic body movement and a motivated camera.',
  cinematic: 'Narrative scene, natural optical depth, one dominant motivated light and physically credible shadows.',
  editorial: 'Premium editorial composition, deliberate spatial framing and tangible material texture.',
  atmosphere: 'Environment-led storytelling with clear depth, restrained motion and real practical lighting.',
} as const

function assertCleared(asset: Asset, projectId: string, expected: 'audio' | 'visual', now: number): void {
  // A guessed asset ID must never allow using another tenant's content.
  if (asset.projectId !== projectId) throw forbidden('asset is outside this MOTION project')
  if (expected === 'audio' ? asset.kind !== 'audio' : !['reference_image', 'reference_video'].includes(asset.kind)) {
    throw new AppError({ kind: 'validation', code: 'quick_create.asset_kind', message: `selected ${expected} has the wrong media type` })
  }
  if (!asset.rights.authorized || asset.rights.consent !== 'authorized' || !asset.rights.owner.trim()) {
    throw forbidden('selected media must have a recorded rights owner and affirmative authorization')
  }
  if (asset.rights.expiresAt) {
    const deadline = Date.parse(asset.rights.expiresAt)
    if (!Number.isFinite(deadline) || deadline <= now) throw forbidden('selected media rights have expired or cannot be verified')
  }
}

/** Called by ordinary Shot Builder API routes as well: no alternate entry may
 * introduce a foreign or unapproved audio cue into a versioned shot. */
export async function assertMusicCueAsset(runtime: Runtime, projectId: string, cue: MusicCue): Promise<void> {
  const asset = await runtime.assets.get(cue.asset_id)
  assertCleared(asset, projectId, 'audio', runtime.clock.now())
  if (asset.durationSeconds !== null && cue.end_seconds > asset.durationSeconds + 0.1) {
    throw new AppError({ kind: 'validation', code: 'quick_create.outside_audio', message: 'song moment exceeds the stored audio duration' })
  }
}

export async function registerQuickCreateRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  app.post('/api/projects/:projectId/quick-create', async (request) => {
    const { projectId } = request.params as { projectId: string }
    const { auth } = await requireProject(runtime, request, projectId, 'editor')
    const input = QuickCreateInput.parse(request.body)
    const span = input.endSeconds - input.startSeconds
    if (span < 0.5 || span > 60) {
      throw new AppError({ kind: 'validation', code: 'quick_create.range', message: 'select a song moment between 0.5 and 60 seconds' })
    }

    const cue: MusicCue = {
      asset_id: input.audioAssetId,
      start_seconds: input.startSeconds,
      end_seconds: input.endSeconds,
      creative_look: input.look,
      promotional_use_attested: input.promotionalUseAttested,
    }
    await assertMusicCueAsset(runtime, projectId, cue)

    const visual = input.visualAssetId ? await runtime.assets.get(input.visualAssetId) : null
    if (visual) assertCleared(visual, projectId, 'visual', runtime.clock.now())

    const generationMode = visual
      ? visual.kind === 'reference_video' ? 'video_to_video' : 'image_to_video'
      : 'text_to_video'
    const existingShot = input.shotId ? await runtime.projects.getShot(input.shotId) : null
    if (existingShot && existingShot.projectId !== projectId) throw forbidden('shot is outside this MOTION project')

    // Only Quick Create drafts can be revised here. The professional editor's
    // unrelated shots must never be silently rewritten by the quick workflow.
    const old = existingShot ? (await runtime.projects.currentVersion(existingShot.id)).spec : null
    if (old && !old.music_cue) throw forbidden('only an existing Quick Create draft can be edited here')

    const spec = {
      ...(old ?? emptyShot()),
      shot_id: old?.shot_id || newId('qc', runtime.clock.now()),
      title: input.title,
      narrative_purpose: input.creativeDirection,
      action: `${input.creativeDirection}\nCreative look: ${LOOK_DIRECTION[input.look]}`,
      generation_mode: generationMode,
      routing_profile: generationMode === 'video_to_video' ? 'VIDEO_EDIT' : 'DRAFT_MOTION',
      duration_seconds: Number(span.toFixed(2)),
      aspect_ratio: input.aspectRatio,
      target_resolution: '1080p',
      first_frame_asset: visual?.kind === 'reference_image' ? visual.id : null,
      last_frame_asset: null,
      source_assets: visual?.kind === 'reference_image' ? [visual.id] : [],
      reference_video_assets: visual?.kind === 'reference_video' ? [visual.id] : [],
      music_cue: cue,
      // The song reference remains an editing cue. No audio is represented as
      // embedded until a real, verified media composition operation exists.
      audio_mode: 'none',
      notes: old?.notes || 'Quick Create draft: source audio is NOT mixed into generated video; prepare/review a render separately.',
    }

    const checked = validateShot(spec)
    if (!checked.ok || !checked.shot) {
      throw new AppError({
        kind: 'validation', code: 'quick_create.invalid_shot',
        message: 'Quick Create shot failed canonical validation',
        details: { issues: checked.issues },
      })
    }
    const saved = existingShot
      ? {
          shot: existingShot,
          version: await runtime.projects.addVersion({
            shotId: existingShot.id, spec: checked.shot, createdBy: auth.userId, note: 'updated native song moment',
          }),
        }
      : await runtime.projects.createShot({
          projectId, spec: checked.shot, createdBy: auth.userId, note: 'native MOTION Quick Create draft',
        })

    await runtime.audit.record({
      orgId: auth.orgId,
      projectId,
      actor: auth.userId,
      action: existingShot ? 'quick_create.revised' : 'quick_create.drafted',
      targetType: 'shot',
      targetId: saved.shot.id,
      data: {
        audioAssetId: cue.asset_id,
        visualAssetId: visual?.id ?? null,
        startSeconds: cue.start_seconds,
        endSeconds: cue.end_seconds,
        promotionalUseAttested: true,
        note: 'This attestation does not authorize publishing, spending or voice-model training',
      },
    })

    return {
      shotId: saved.shot.id,
      versionId: saved.version.id,
      status: 'draft' as const,
      audioEmbedded: false,
      rendered: false,
      warnings: checked.issues.filter((issue) => issue.severity === 'warning'),
    }
  })
}
