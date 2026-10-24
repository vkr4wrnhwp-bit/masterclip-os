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

export function songMapEvidence(
  analysis: { status?: string; engineVersion?: string; bpm?: number | null; bpmConfidence?: number | null; key?: string | null; keyConfidence?: number | null } | null,
  sections: readonly MapSection[],
) {
  if (!analysis || analysis.status !== 'complete') return { message: 'Not enough information: analysis is missing or unfinished.', sections: [], nextActions: [] }
  const version = analysis.engineVersion || 'unknown analyzer version'
  const bpm = analysis.bpm == null ? 'Not enough information: tempo was not measured.' : `${analysis.bpm} BPM (confidence: ${analysis.bpmConfidence ?? 'not recorded'}; analyzer ${version})`
  const key = !analysis.key ? 'Not enough information: key was not measured.' : `${analysis.key} (confidence: ${analysis.keyConfidence ?? 'not recorded'}; analyzer ${version})`
  return { message: '', tempo: bpm, key, sections: sections.map(s => ({ ...s })), nextActions: [] }
}
