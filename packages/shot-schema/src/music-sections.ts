import { z } from 'zod/v4'

export const MusicSection = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(60),
  start_seconds: z.number().finite().min(0),
  end_seconds: z.number().finite().positive(),
  kind: z.enum(['intro','verse','pre_chorus','chorus','bridge','outro','instrumental','custom']),
})
export type MusicSection = z.infer<typeof MusicSection>

/** User-authored structural markers, never fabricated lyric/chorus detection. */
export function validateMusicSections(sections: readonly MusicSection[], trackDuration: number): MusicSection[] {
  if (!Number.isFinite(trackDuration) || trackDuration <= 0 || sections.length > 32)
    throw new Error('Invalid track duration or too many sections')
  const clean = sections.map(section => MusicSection.parse(section))
  const used = new Set<string>()
  let end = 0
  for (const section of clean) {
    if (used.has(section.id) || section.start_seconds < end ||
        section.end_seconds <= section.start_seconds ||
        section.end_seconds > trackDuration + .05) {
      throw new Error('Sections must have unique IDs, follow chronological order and stay inside the recording')
    }
    used.add(section.id)
    end = section.end_seconds
  }
  return clean
}

export function sectionAt(sections: readonly MusicSection[], seconds: number): MusicSection | null {
  return sections.find(s => seconds >= s.start_seconds && seconds < s.end_seconds) ?? null
}
