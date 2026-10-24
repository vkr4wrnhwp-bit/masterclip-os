/** Song Map edits are a separate correction layer, never analyzer mutations. */
export interface MapSection {
  id: string
  label: string
  startMs: number
  endMs: number
  confidence: number | null
}

export type MapEdit =
  | { kind: 'rename'; id: string; label: string }
  | { kind: 'boundary'; id: string; endMs: number }
  | { kind: 'merge'; leftId: string; rightId: string; label: string }
  | { kind: 'split'; id: string; atMs: number; newId: string; label: string }

export function applySongMapEdits(original: readonly MapSection[], edits: readonly MapEdit[]): MapSection[] {
  const sections = original.map(s => ({ ...s }))
  const indexOf = (id: string) => sections.findIndex(s => s.id === id)
  for (const edit of edits) {
    if (edit.kind === 'rename') {
      const i = indexOf(edit.id)
      if (i < 0 || !edit.label.trim() || edit.label.length > 80) throw new Error('Invalid section name')
      sections[i]!.label = edit.label.trim()
    } else if (edit.kind === 'boundary') {
      const i = indexOf(edit.id)
      if (i < 0 || i === sections.length - 1) throw new Error('Invalid section boundary')
      const current = sections[i]!, next = sections[i + 1]!
      if (!Number.isFinite(edit.endMs) || edit.endMs <= current.startMs || edit.endMs >= next.endMs)
        throw new Error('Boundary must remain inside adjacent sections')
      current.endMs = edit.endMs
      next.startMs = edit.endMs
    } else if (edit.kind === 'merge') {
      const i = indexOf(edit.leftId)
      if (i < 0 || i + 1 >= sections.length || sections[i + 1]!.id !== edit.rightId)
        throw new Error('Only adjacent sections can be merged')
      if (!edit.label.trim() || edit.label.length > 80) throw new Error('Invalid section name')
      const left = sections[i]!, right = sections[i + 1]!
      sections.splice(i, 2, { ...left, endMs: right.endMs, label: edit.label.trim(), confidence: null })
    } else {
      const i = indexOf(edit.id)
      if (i < 0 || sections.some(s => s.id === edit.newId) || !edit.newId.trim()
          || !edit.label.trim() || edit.label.length > 80) throw new Error('Invalid split')
      const current = sections[i]!
      if (!Number.isFinite(edit.atMs) || edit.atMs <= current.startMs || edit.atMs >= current.endMs)
        throw new Error('Split must fall inside the section')
      const endMs = current.endMs
      current.endMs = edit.atMs
      sections.splice(i + 1, 0, { id: edit.newId, label: edit.label.trim(),
        startMs: edit.atMs, endMs, confidence: null })
    }
  }
  return sections
}

export interface SectionEnergyReading {
  id: string
  label: string
  sectionType: string
  energy: number | null
}
export function songMapEvidence(
  analysis: { status?: string; analysisVersion?: string; engineVersion?: string; bpm?: number | null; bpmConfidence?: number | null; key?: string | null; keyConfidence?: number | null } | null,
  sections: readonly MapSection[],
  readings: readonly SectionEnergyReading[] = [],
) {
  const state = !analysis ? 'missing' : analysis.status === 'failed' ? 'failed'
    : analysis.status === 'complete' ? 'ready' : 'partial'
  if (state !== 'ready') return { state, message: 'Not enough information: analysis is missing, incomplete or failed.',
    sections: [], key: { value: null, confidence: null, analysisVersion: null, note: 'Not sure' },
    tempo: { value: null, confidence: null, analysisVersion: null, note: 'Not sure' }, nextActions: [] }
  const analysisVersion = analysis?.analysisVersion ?? analysis?.engineVersion ?? 'not recorded'
  const confidenceNote = (value: number | null | undefined) =>
    value == null || value < 0.5 ? 'Not sure: confidence is low or missing.' : ''
  const tempo = { value: analysis?.bpm ?? null, confidence: analysis?.bpmConfidence ?? null,
    analysisVersion, note: analysis?.bpm == null ? 'Not enough information: tempo was not measured.' : confidenceNote(analysis?.bpmConfidence) }
  const key = { value: analysis?.key ?? null, confidence: analysis?.keyConfidence ?? null,
    analysisVersion, note: !analysis?.key ? 'Not enough information: key was not measured.' : confidenceNote(analysis?.keyConfidence) }
  const verse = readings.find(r => r.sectionType === 'verse' && r.energy != null && Number.isFinite(r.energy))
  const chorus = readings.find(r => r.sectionType === 'chorus' && r.energy != null && Number.isFinite(r.energy))
  const nextActions: Array<{ text: string; source: string }> = []
  if (verse && chorus && verse.energy !== chorus.energy) {
    const difference = Math.abs(chorus.energy! - verse.energy!)
    nextActions.push({ text: `Your chorus energy reading is ${difference.toFixed(2)} ${chorus.energy! > verse.energy! ? 'higher' : 'lower'} than the verse. Listen to the transition.`,
      source: `From section energy analysis, version ${analysisVersion}` })
  }
  return { state, message: '', tempo, key, sections: sections.map(s => ({ ...s })), nextActions: nextActions.slice(0,3) }
}
