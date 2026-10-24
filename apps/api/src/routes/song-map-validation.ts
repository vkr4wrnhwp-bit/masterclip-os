import { z } from 'zod/v4'

export const songMapEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rename'), id: z.string().min(1), label: z.string().trim().min(1).max(80) }),
  z.object({ kind: z.literal('boundary'), id: z.string().min(1), endMs: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('merge'), leftId: z.string().min(1), rightId: z.string().min(1), label: z.string().trim().min(1).max(80) }),
  z.object({ kind: z.literal('split'), id: z.string().min(1), atMs: z.number().int().nonnegative(), newId: z.string().min(1), label: z.string().trim().min(1).max(80) }),
])
export const songMapSaveSchema = z.object({ edits: z.array(songMapEditSchema).max(200) })
