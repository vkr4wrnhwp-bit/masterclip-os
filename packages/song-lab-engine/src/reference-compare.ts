/** Owned-song reference readings only. This is not a mastering target or quality grade. */
export type ReferenceMeasurement = { value: number | null; sourceFile: string; analyzerVersion: string }
export type OwnedReference = {
  songId: string
  ownerId: string
  title: string
  sampleRate: number | null
  metrics: Partial<Record<'low' | 'lowMid' | 'mid' | 'highMid' | 'high' | 'loudness' | 'stereoWidth', ReferenceMeasurement>>
}
const BANDS = [
  ['low', 'low end'], ['lowMid', 'low-middle range'], ['mid', 'middle range'],
  ['highMid', 'high-middle range'], ['high', 'high end'],
  ['loudness', 'measured loudness'], ['stereoWidth', 'stereo width'],
] as const

export function compareOwnedReference(
  ownerId: string, current: OwnedReference, reference: OwnedReference,
) {
  if (current.ownerId !== ownerId || reference.ownerId !== ownerId)
    throw new Error('Song not found')
  if (current.songId === reference.songId)
    throw new Error('Choose another song you own')
  const warnings: string[] = []
  if (current.sampleRate == null || reference.sampleRate == null)
    warnings.push('Not enough information: a file sample rate is missing.')
  else if (current.sampleRate !== reference.sampleRate)
    warnings.push('The songs have different sample rates. Review the comparison carefully.')
  const rows = BANDS.map(([key, label]) => {
    const a = current.metrics[key], b = reference.metrics[key]
    const source = a && b ? {
      currentFile: a.sourceFile, referenceFile: b.sourceFile,
      currentVersion: a.analyzerVersion, referenceVersion: b.analyzerVersion,
    } : null
    if (!a || !b || a.value == null || b.value == null || !Number.isFinite(a.value) || !Number.isFinite(b.value))
      return { key, label, finding: 'Not enough information: this measurement is missing.', source }
    if (a.analyzerVersion !== b.analyzerVersion)
      return { key, label, finding: 'Not enough information: analyzer versions differ.', source }
    const direction = a.value > b.value ? 'more' : a.value < b.value ? 'less' : 'about the same'
    const finding = direction === 'about the same'
      ? `Your new song has about the same ${label} as "${reference.title}" in these readings.`
      : `Your new song has ${direction} ${label} than "${reference.title}" in these readings.`
    return { key, label, finding, source }
  })
  return { referenceSongId: reference.songId, rows, warnings }
}
