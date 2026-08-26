import type { FastifyInstance } from 'fastify'
import { z } from 'zod/v4'
import type { Runtime } from '@masterclip/runtime'
import { requireSongLab } from './helpers.js'

/** Lyrics, syllable architecture, title placement and the Chant Finder. */
export async function registerSongLabLyricRoutes(app: FastifyInstance, runtime: Runtime): Promise<void> {
  const songLab = runtime.songLab

  app.get('/api/song-lab/projects/:id/lyrics', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.lyrics')
    const { id } = request.params as { id: string }
    const project = await songLab.repos.projects.get(actor.orgId, id)
    if (!project.currentVersionId) return { lines: [], analysis: null }

    const lines = await songLab.repos.lyrics.list(actor.orgId, project.currentVersionId)
    if (lines.length === 0) {
      // No lyric, no lyric analysis. Not an empty analysis — none at all.
      return { lines: [], analysis: null, message: 'No authorized lyrics are attached to this version.' }
    }
    return { lines, analysis: await songLab.lyrics.analyze(actor, id) }
  })

  app.patch('/api/song-lab/projects/:id/lyrics', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.lyrics')
    const { id } = request.params as { id: string }
    const body = z
      .object({
        source: z.enum(['user_supplied', 'transcribed', 'time_coded', 'vocal_transcript']).default('user_supplied'),
        text: z.string().max(20000).optional(),
        lines: z
          .array(
            z.object({
              text: z.string().min(1).max(500),
              startMs: z.number().int().min(0).nullable().optional(),
              endMs: z.number().int().min(0).nullable().optional(),
              sectionOrderIndex: z.number().int().min(0).nullable().optional(),
            }),
          )
          .optional(),
      })
      .parse(request.body)

    const lines = await songLab.lyrics.setLyrics({
      actor,
      projectId: id,
      source: body.source,
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.lines !== undefined ? { lines: body.lines } : {}),
    })
    return { lines, analysis: await songLab.lyrics.analyze(actor, id) }
  })

  /** A user's title mark is authoritative over any detection. */
  /**
   * Transcribes the lyric off the recording, with timings.
   *
   * Gated on `audio.transcription` as well as Song Lab: transcription is an
   * Audio Intelligence capability with its own retention and zero-retention
   * rules, and starting it from a Song Lab screen does not make it a Song Lab
   * capability.
   */
  app.post('/api/song-lab/projects/:id/lyrics/transcribe', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.lyrics')
    await runtime.audio.access.authorize({ capability: 'audio.transcription', actor })
    const { id } = request.params as { id: string }
    const body = z
      .object({
        // Deliberately explicit: a lyric the artist typed is their own words,
        // and a machine transcript replacing it silently would be a loss.
        replaceUserSupplied: z.boolean().default(false),
        languageCode: z.string().min(2).max(16).optional(),
      })
      .parse(request.body ?? {})
    return songLab.lyricTranscription.request({ actor, projectId: id, ...body })
  })

  app.post('/api/song-lab/projects/:id/lyrics/title', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.lyrics')
    const { id } = request.params as { id: string }
    const body = z.object({ lineIndexes: z.array(z.number().int().min(0)).max(200) }).parse(request.body)
    const lines = await songLab.lyrics.markTitleLines(actor, id, body.lineIndexes)
    return { lines, analysis: await songLab.lyrics.analyze(actor, id) }
  })

  app.post('/api/song-lab/projects/:id/lyrics/hook', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.lyrics')
    const { id } = request.params as { id: string }
    const body = z.object({ lineIndexes: z.array(z.number().int().min(0)).max(200) }).parse(request.body)
    const lines = await songLab.lyrics.markHookLines(actor, id, body.lineIndexes)
    return { lines, analysis: await songLab.lyrics.analyze(actor, id) }
  })

  app.get('/api/song-lab/projects/:id/chant', async (request) => {
    const actor = await requireSongLab(runtime, request, 'song_lab.chant')
    const { id } = request.params as { id: string }
    return { opportunities: await songLab.lyrics.chantOpportunities(actor, id) }
  })
}
